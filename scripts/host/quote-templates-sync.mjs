// quote-templates-sync: the program behind the fleet-gate operation of the same
// name. Installed root-owned as /usr/local/lib/fleet-gate/quote-templates-sync.mjs
// and run by the gate inside the production API container:
//
//   docker exec -i -w /app -e APPLY=0|1 <api container> node --input-type=module -e "<this file>"
//
// The gate hands this file over as the -e argument; stdin holds DATA only: the
// templates and snippets as JSON, {"templates":[...],"snippets":[...]}. The caller
// cannot send code, and the input is checked with the image's own editor rules
// before anything is read from the database.
//
// What it may do, and nothing else (docs/fleet-gate.md, "quote-templates-sync"):
//   - add a template or a snippet whose name does not exist yet;
//   - replace the blocks of a template that still holds the seed text word for
//     word (the IMAGE's DEFAULT_QUOTE_TEMPLATES, never the caller's: a caller
//     naming the "seed" could overwrite any template it can read);
//   - leave everything else alone: a matching row, a row someone edited, a name
//     held by more than one row. No delete, no other table but the audit log.
// Without APPLY=1 it only prints the plan. The writes are one transaction, every
// row re-read inside it; after it the plan runs again and must find nothing to do.
//
// Exit: 0 done (or plan printed), 1 the re-measure still finds work or a write
// failed (nothing written then), 3 the input was refused (nothing read or written).
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APPLY = process.env.APPLY === "1";
const MAX_TEMPLATES = 50;
const MAX_SNIPPETS = 100;
const PRICE_DISPLAYS = ["NET", "GROSS", "BOTH"];

const refuse = (reason) => {
  process.stderr.write(`HIBAS BEMENET, semmit nem irtam: ${reason}\n`);
  process.exit(3);
};

// the image's own rules: the same functions the template editor and the seed CLI use
const quotes = (file) => import(pathToFileURL(join(process.cwd(), "dist", "quotes", file)).href);
const { templateBody } = await quotes("quote-templates.service.js");
const { SNIPPET_KINDS, snippetMilestones } = await quotes("quote-snippets.service.js");
const { textInput, richTextInput } = await quotes("quote-editor-input.js");
const { DEFAULT_QUOTE_TEMPLATES } = await quotes("quote-template-defaults.js");
const { prisma } = await import("@acropora/database");

const canon = (v) =>
  Array.isArray(v)
    ? "[" + v.map(canon).join(",") + "]"
    : v && typeof v === "object"
      ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
      : JSON.stringify(v ?? null);

const message = (e) => (e instanceof Error ? e.message : String(e));
const exactKeys = (o, keys, where) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) refuse(`${where}: nem objektum`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in o));
  if (extra.length || missing.length)
    refuse(`${where}: ${extra.length ? "ismeretlen mezo " + extra.join(", ") : ""}${extra.length && missing.length ? "; " : ""}${missing.length ? "hianyzo mezo " + missing.join(", ") : ""}`);
};

/** The input, every field through the editor's rules; refused as a whole on the first error. */
function checkInput(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    refuse(`nem JSON (${message(e)})`);
  }
  exactKeys(input, ["templates", "snippets"], "a bemenet");
  if (!Array.isArray(input.templates) || !Array.isArray(input.snippets)) refuse("a templates es a snippets lista");
  if (input.templates.length > MAX_TEMPLATES) refuse(`legfeljebb ${MAX_TEMPLATES} sablon`);
  if (input.snippets.length > MAX_SNIPPETS) refuse(`legfeljebb ${MAX_SNIPPETS} reszlet`);
  const templates = input.templates.map((t, i) => {
    const where = `${i + 1}. sablon`;
    exactKeys(t, ["name", "priceDisplay", "defaultValidityDays", "blocks", "milestones"], where);
    try {
      const name = textInput(t.name, "Név", 120);
      if (!PRICE_DISPLAYS.includes(t.priceDisplay)) throw new Error("Érvénytelen ár-megjelenítés.");
      const days = t.defaultValidityDays;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365)
        throw new Error("Az alapértelmezett érvényesség 1 és 365 nap közötti egész szám.");
      return { name, priceDisplay: t.priceDisplay, defaultValidityDays: days, ...templateBody(t) };
    } catch (e) {
      refuse(`${where}: ${message(e)}`);
    }
  });
  const snippets = input.snippets.map((s, i) => {
    const where = `${i + 1}. reszlet`;
    exactKeys(s, ["name", "kind", "content", "milestones"], where);
    try {
      const name = textInput(s.name, "Név", 120);
      if (!SNIPPET_KINDS.includes(s.kind)) throw new Error("Ismeretlen szövegrészlet-típus.");
      const milestones = snippetMilestones(s.kind, s.milestones);
      return { name, kind: s.kind, content: richTextInput(s.content), milestones: Array.isArray(milestones) ? milestones : null };
    } catch (e) {
      refuse(`${where}: ${message(e)}`);
    }
  });
  const dup = (list) => list.map((x) => x.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dup(templates).length) refuse(`ketszer szereplo sablonnev: ${[...new Set(dup(templates))].join(", ")}`);
  if (dup(snippets).length) refuse(`ketszer szereplo reszletnev: ${[...new Set(dup(snippets))].join(", ")}`);
  return { templates, snippets };
}

const seedBlocks = new Map(
  DEFAULT_QUOTE_TEMPLATES.map((t) => [t.name.trim(), canon(templateBody(t).blocks)]),
);
const sameTemplate = (row, t) =>
  row.priceDisplay === t.priceDisplay &&
  row.defaultValidityDays === t.defaultValidityDays &&
  canon(row.blocks) === canon(t.blocks) &&
  canon(row.milestones) === canon(t.milestones);
const sameSnippet = (row, s) =>
  row.kind === s.kind && canon(row.content) === canon(s.content) && canon(row.milestones) === canon(s.milestones);
const holdsSeed = (row, t) =>
  !row.archivedAt && seedBlocks.get(t.name) === canon(row.blocks) && sameTemplate({ ...row, blocks: t.blocks }, t);

async function plan(db, input) {
  const steps = [];
  const report = [];
  for (const t of input.templates) {
    const rows = await db.quoteTemplate.findMany({ where: { name: t.name } });
    if (rows.length === 0) {
      steps.push({ op: "createTemplate", t });
      report.push(`sablon  ${t.name}: HIANYZIK, felveszem`);
    } else if (rows.length > 1) report.push(`sablon  ${t.name}: ${rows.length} sor ezzel a nevvel, NEM nyulok hozza`);
    else if (sameTemplate(rows[0], t)) report.push(`sablon  ${t.name}: megvan, egyezik${rows[0].archivedAt ? " (ARCHIVALT)" : ""}`);
    else if (holdsSeed(rows[0], t)) {
      steps.push({ op: "updateBlocks", id: rows[0].id, t });
      report.push(`sablon  ${t.name}: az alapszoveg all, a kapott szovegre frissitem`);
    } else report.push(`sablon  ${t.name}: ELTER, es nem az alapszoveg (kezzel szerkesztettek?), NEM nyulok hozza`);
  }
  for (const s of input.snippets) {
    const rows = await db.quoteSnippet.findMany({ where: { name: s.name } });
    if (rows.length === 0) {
      steps.push({ op: "createSnippet", s });
      report.push(`reszlet ${s.name}: HIANYZIK, felveszem`);
    } else if (rows.length === 1 && sameSnippet(rows[0], s)) report.push(`reszlet ${s.name}: megvan, egyezik`);
    else report.push(`reszlet ${s.name}: ${rows.length} sor, ELTER, NEM nyulok hozza`);
  }
  return { steps, report };
}

const audit = (tx, action, entityType, entityId, metadata) =>
  tx.auditLog.create({ data: { action, entityType, entityId, userId: null, metadata: { ...metadata, source: "fleet-gate quote-templates-sync" } } });

async function write(input, steps) {
  await prisma.$transaction(async (tx) => {
    for (const st of steps) {
      if (st.op === "createTemplate") {
        if (await tx.quoteTemplate.count({ where: { name: st.t.name } }))
          throw new Error(`${st.t.name}: a terv ota felvettek egy ilyen nevu sablont, semmit nem irtam`);
        const row = await tx.quoteTemplate.create({
          data: { name: st.t.name, priceDisplay: st.t.priceDisplay, defaultValidityDays: st.t.defaultValidityDays, blocks: st.t.blocks, milestones: st.t.milestones },
        });
        await audit(tx, "quote_template.created", "QuoteTemplate", row.id, { blockCount: st.t.blocks.length });
      }
      if (st.op === "updateBlocks") {
        const cur = await tx.quoteTemplate.findUnique({ where: { id: st.id } });
        if (!cur || !holdsSeed(cur, st.t))
          throw new Error(`${st.t.name}: a sor a terv ota megvaltozott, semmit nem irtam`);
        await tx.quoteTemplate.update({ where: { id: st.id }, data: { blocks: st.t.blocks } });
        await audit(tx, "quote_template.updated", "QuoteTemplate", st.id, { blockCount: st.t.blocks.length, replaced: "seed blocks" });
      }
      if (st.op === "createSnippet") {
        if (await tx.quoteSnippet.count({ where: { name: st.s.name } }))
          throw new Error(`${st.s.name}: a terv ota felvettek egy ilyen nevu reszletet, semmit nem irtam`);
        const row = await tx.quoteSnippet.create({
          data: { name: st.s.name, kind: st.s.kind, content: st.s.content, ...(st.s.milestones ? { milestones: st.s.milestones } : {}) },
        });
        await audit(tx, "quote_snippet.created", "QuoteSnippet", row.id, { kind: st.s.kind });
      }
    }
  });
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = checkInput(raw);

try {
  console.log(`ELOTTE: ${await prisma.quoteTemplate.count()} sablon, ${await prisma.quoteSnippet.count()} reszlet`);
  const { steps, report } = await plan(prisma, input);
  report.forEach((l) => console.log(l));
  if (!APPLY) console.log(`${steps.length} irast vegeznek (probafutas; irni az apply muvelettel).`);
  else {
    await write(input, steps);
    console.log(`${steps.length} iras kesz. VISSZAMERES:`);
    const after = await plan(prisma, input);
    after.report.forEach((l) => console.log("  " + l));
    const names = await prisma.quoteTemplate.findMany({ select: { name: true } });
    const counts = names.reduce((m, r) => ((m[r.name] = (m[r.name] || 0) + 1), m), {});
    const dup = Object.entries(counts).filter(([, n]) => n > 1);
    console.log(`UTANA: ${names.length} sablon, ${await prisma.quoteSnippet.count()} reszlet; duplikalt sablonnev: ${dup.length ? dup.map(([n, c]) => n + " x" + c).join(", ") : "nincs"}`);
    if (after.steps.length) process.exitCode = 1;
  }
} catch (e) {
  process.stderr.write(`HIBA: ${message(e)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
