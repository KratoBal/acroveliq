// scripts/host/quote-templates-sync.mjs, the program behind the fleet-gate
// operation, run for real in node the way the gate runs it (-e, data on stdin),
// in a directory that stands in for the API image: fake dist/quotes rule modules
// and a fake @acropora/database whose state lives in a JSON file. WHAT TURNS
// THIS RED:
//   - input with an unknown or missing field, a broken template, a duplicate
//     name, or too many rows gets past the check, or reaches the database;
//   - an existing row is touched when it matches, was edited, is archived or
//     shares its name with another row;
//   - a template whose blocks still hold the seed text is NOT updated, or the
//     "seed" is taken from the caller instead of the image;
//   - plan writes; apply writes outside one transaction, writes no audit row,
//     or keeps writing when a row changed after the plan;
//   - a second apply finds anything to do.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const PROGRAM = readFileSync(join(process.cwd(), 'scripts', 'host', 'quote-templates-sync.mjs'), 'utf-8')
const root = mkdtempSync(join(tmpdir(), 'quote-sync-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const block = (kind: string, title: string, text: string | null) => ({ kind, title, content: text === null ? null : doc(text), keepWithNext: false, startOnNewPage: false })
const SEED_BLOCKS = [block('TEXT', 'Bevezető', 'Alapszöveg.'), block('SUMMARY', 'Összesítés', null)]
const MILESTONES = [{ label: 'Előleg', percent: '50' }, { label: 'Átadáskor', percent: '50' }]

// the image's rule modules, reduced to what the program relies on: they
// normalise (a block without keepWithNext gets false) and they throw on bad input
const RULES = {
  'quote-editor-input.js': `
export function textInput(value, field, max) {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) throw new Error(field + ": kötelező.");
  if (t.length > max) throw new Error(field + ": legfeljebb " + max + " karakter.");
  return t;
}
export function richTextInput(value) {
  if (!value || value.type !== "doc" || !Array.isArray(value.content)) throw new Error("Hibás szöveg.");
  return value;
}`,
  'quote-templates.service.js': `
import { richTextInput } from "./quote-editor-input.js";
export function templateBody(input) {
  if (!Array.isArray(input.blocks) || !input.blocks.length) throw new Error("A sablonnak blokk kell.");
  if (!Array.isArray(input.milestones)) throw new Error("A mérföldkövek listája hiányzik.");
  return {
    blocks: input.blocks.map((b) => {
      if (!["TEXT", "SECTION", "OPTIONS", "SUMMARY", "TERMS"].includes(b.kind)) throw new Error("Ismeretlen blokk: " + b.kind);
      return { kind: b.kind, title: b.title ?? null, content: b.content ? richTextInput(b.content) : null, keepWithNext: b.keepWithNext === true, startOnNewPage: b.startOnNewPage === true };
    }),
    milestones: input.milestones.map((m) => ({ label: m.label, percent: String(Number(m.percent)) })),
  };
}`,
  'quote-snippets.service.js': `
export const SNIPPET_KINDS = ["INTRO", "TEXT", "DELIVERY", "WARRANTY", "PAYMENT"];
export const DB_NULL = { dbNull: true };
export function snippetMilestones(kind, list) {
  if (kind !== "PAYMENT") {
    if (list !== undefined && list !== null) throw new Error("Mérföldkövet csak fizetési feltétel szövegrészlet tartalmazhat.");
    return DB_NULL;
  }
  if (!Array.isArray(list) || !list.length) throw new Error("A fizetési feltétel szövegrészlethez mérföldkövek kellenek.");
  return list.map((m) => ({ label: m.label, percent: String(m.percent) }));
}`,
  'quote-template-defaults.js': `
export const DEFAULT_QUOTE_TEMPLATES = [
  { name: "Alap sablon", priceDisplay: "GROSS", defaultValidityDays: 30, blocks: ${JSON.stringify(SEED_BLOCKS.map(({ keepWithNext, ...b }) => b))}, milestones: ${JSON.stringify(MILESTONES)} },
];`,
}

// the database: the state in $FAKE_DB, read at start, written back on
// $disconnect; a transaction works on a copy and commits only if it returns.
// FAKE_TOUCH_IN_TX=<template id> edits that row as the transaction starts (a
// change after the plan). Every call is logged to $FAKE_DB.calls.
const DATABASE = `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const file = process.env.FAKE_DB;
let state = JSON.parse(readFileSync(file, "utf-8"));
const log = (m) => appendFileSync(file + ".calls", m + "\\n");
let n = 0;
const match = (row, where) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
const table = (get, name) => ({
  findMany: async (q = {}) => { log(name + ".findMany"); return get()[name].filter((r) => match(r, q.where)).map((r) => structuredClone(r)); },
  findUnique: async (q) => { log(name + ".findUnique"); const r = get()[name].find((r) => r.id === q.where.id); return r ? structuredClone(r) : null; },
  count: async (q = {}) => { log(name + ".count"); return get()[name].filter((r) => match(r, q.where)).length; },
  create: async ({ data }) => { log(name + ".create"); const row = { id: name + "-" + ++n, archivedAt: null, milestones: null, ...structuredClone(data) }; get()[name].push(row); return structuredClone(row); },
  update: async ({ where, data }) => { log(name + ".update"); const row = get()[name].find((r) => r.id === where.id); Object.assign(row, structuredClone(data)); return structuredClone(row); },
});
export const Prisma = { sql: (strings, ...values) => ({ text: strings.join("?"), values }) };
// the raw read the program locks with: only the one statement it may send
const queryRaw = (get) => async (q) => {
  const locked = 'SELECT "archivedAt", "blocks", "milestones", "priceDisplay", "defaultValidityDays" FROM "QuoteTemplate" WHERE "id" = ? FOR UPDATE';
  log("$queryRaw " + (q.text.endsWith(" FOR UPDATE") ? "FOR UPDATE" : "UNLOCKED"));
  if (q.text !== locked) throw new Error("unexpected raw query: " + q.text);
  return get().quoteTemplate.filter((r) => r.id === q.values[0]).map((r) => structuredClone(r));
};
const client = (get) => ({ quoteTemplate: table(get, "quoteTemplate"), quoteSnippet: table(get, "quoteSnippet"), auditLog: table(get, "auditLog"), $queryRaw: queryRaw(get) });
export const prisma = {
  ...client(() => state),
  $transaction: async (fn) => {
    log("$transaction");
    const copy = structuredClone(state);
    if (process.env.FAKE_TOUCH_IN_TX) copy.quoteTemplate.find((r) => r.id === process.env.FAKE_TOUCH_IN_TX).blocks[0].title = "Átírva";
    const result = await fn(client(() => copy));
    state = copy;
    return result;
  },
  $disconnect: async () => writeFileSync(file, JSON.stringify(state)),
};`

interface Row {
  id: string
  name: string
  [k: string]: unknown
}
interface State {
  quoteTemplate: Row[]
  quoteSnippet: Row[]
  auditLog: Array<Record<string, unknown>>
}

function image() {
  const dir = mkdtempSync(join(root, 'app-'))
  mkdirSync(join(dir, 'dist', 'quotes'), { recursive: true })
  for (const [name, text] of Object.entries(RULES)) writeFileSync(join(dir, 'dist', 'quotes', name), text)
  const pkg = join(dir, 'node_modules', '@acropora', 'database')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@acropora/database', type: 'module', exports: './index.js' }))
  writeFileSync(join(pkg, 'index.js'), DATABASE)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  const db = join(dir, 'db.json')
  const run = (state: State, input: unknown, apply: boolean, extra: Record<string, string> = {}) => {
    writeFileSync(db, JSON.stringify(state))
    rmSync(`${db}.calls`, { force: true })
    const r = spawnSync('node', ['--input-type=module', '-e', PROGRAM], {
      cwd: dir,
      env: { PATH: process.env.PATH, FAKE_DB: db, APPLY: apply ? '1' : '0', ...extra },
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf-8',
    })
    const calls = existsSync(`${db}.calls`) ? readFileSync(`${db}.calls`, 'utf-8').trim().split('\n').filter(Boolean) : []
    return { code: r.status, out: r.stdout, err: r.stderr, calls, state: JSON.parse(readFileSync(db, 'utf-8')) as State }
  }
  return { run }
}

const seedRow = (over: Partial<Row> = {}): Row => ({
  id: 'seed-1',
  name: 'Alap sablon',
  priceDisplay: 'GROSS',
  defaultValidityDays: 30,
  blocks: SEED_BLOCKS,
  milestones: MILESTONES,
  archivedAt: null,
  ...over,
})
const edited = [block('TEXT', 'Bevezető', 'A teszten szerkesztett szöveg.'), block('SUMMARY', 'Összesítés', null)]
const template = (name: string, blocks = edited) => ({ name, priceDisplay: 'GROSS', defaultValidityDays: 30, blocks, milestones: MILESTONES })
const snippet = { name: 'Szállítási feltételek', kind: 'DELIVERY', content: doc('30 munkanap'), milestones: null }
const empty = (): State => ({ quoteTemplate: [], quoteSnippet: [], auditLog: [] })
const writes = (calls: string[]) => calls.filter((c) => /\.(create|update)$/.test(c))
const sha = (input: unknown) => createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')

describe('quote-templates-sync: the input', () => {
  it('QTS-INPUT: anything but the exact shape, valid by the image\'s rules, is refused whole, before the database', () => {
    const app = image()
    const refused = [
      'nem json',
      { templates: [] }, // snippets missing
      { templates: [], snippets: [], sql: 'drop table' }, // an unknown key
      { templates: [template('Alap sablon')], snippets: [], seedDefaults: { 'Alap sablon': edited } }, // the seed is the image's, not the caller's
      { templates: [{ ...template('Új'), id: 'x' }], snippets: [] }, // a field the caller may not set
      { templates: [{ ...template('Új'), createdById: 'u' }], snippets: [] },
      { templates: [template('Új', [block('SCRIPT', 'x', 'y')])], snippets: [] }, // the image's block rule
      { templates: [{ ...template('Új'), priceDisplay: 'FREE' }], snippets: [] },
      { templates: [{ ...template('Új'), defaultValidityDays: 0 }], snippets: [] },
      { templates: [template('  ')], snippets: [] },
      { templates: [template('Új'), template('Új ')], snippets: [] }, // the same name after trimming
      { templates: [], snippets: [{ ...snippet, kind: 'SHELL' }] },
      { templates: [], snippets: [{ ...snippet, milestones: MILESTONES }] }, // only PAYMENT carries milestones
      { templates: [], snippets: [{ ...snippet, content: { type: 'html' } }] },
      { templates: Array.from({ length: 51 }, (_, i) => template(`T${i}`)), snippets: [] },
    ]
    const results = refused.map((input) => {
      const r = app.run(empty(), input, true)
      return `${r.code} calls=${r.calls.length} ${r.err.startsWith('HIBAS BEMENET') ? 'ok' : r.err}`
    })
    expect(results, 'QTS-INPUT').toEqual(Array(refused.length).fill('3 calls=0 ok'))
  })
})

describe('quote-templates-sync: plan and apply', () => {
  const state = (): State => ({
    quoteTemplate: [
      seedRow(), // untouched seed: its blocks may be replaced
      { ...seedRow({ id: 'same-1', name: 'Szerviz' }), blocks: edited }, // already the same
      seedRow({ id: 'hand-1', name: 'Kézi', blocks: [block('TEXT', 'Bevezető', 'Valaki átírta.')] }), // edited by hand
      seedRow({ id: 'dup-1', name: 'Kettő' }),
      seedRow({ id: 'dup-2', name: 'Kettő' }),
    ],
    quoteSnippet: [],
    auditLog: [],
  })
  const input = {
    templates: [template('Alap sablon'), template('Szerviz'), template('Kézi'), template('Kettő'), template('Angol')],
    snippets: [snippet],
  }

  it('QTS-PLAN: the plan says what it would do and writes nothing', () => {
    const r = image().run(state(), input, false)
    expect([r.code, writes(r.calls), r.calls.includes('$transaction'), r.out.trim().split('\n')], 'QTS-PLAN').toEqual([
      0,
      [],
      false,
      [
        `BEMENET sha256: ${sha(input)}`,
        'ELOTTE: 5 sablon, 0 reszlet',
        'sablon  Alap sablon: az alapszoveg all, a kapott szovegre frissitem',
        'sablon  Szerviz: megvan, egyezik',
        'sablon  Kézi: ELTER, es nem az alapszoveg (kezzel szerkesztettek?), NEM nyulok hozza',
        'sablon  Kettő: 2 sor ezzel a nevvel, NEM nyulok hozza',
        'sablon  Angol: HIANYZIK, felveszem',
        'reszlet Szállítási feltételek: HIANYZIK, felveszem',
        '3 irast vegeznek (probafutas; irni az apply muvelettel).',
      ],
    ])
  })

  it('QTS-APPLY: adds the missing, replaces the untouched seed, leaves the rest, one transaction with audit rows; a second apply has nothing to do', () => {
    const app = image()
    const r = app.run(state(), input, true)
    const byId = (s: State, id: string) => s.quoteTemplate.find((t) => t.id === id)!
    const again = app.run(r.state, input, true)
    expect(
      [
        r.code,
        r.calls.filter((c) => c === '$transaction').length,
        writes(r.calls),
        byId(r.state, 'seed-1').blocks,
        [byId(r.state, 'hand-1').blocks, byId(r.state, 'dup-1').blocks, byId(r.state, 'dup-2').blocks],
        r.state.quoteTemplate.find((t) => t.name === 'Angol')?.blocks,
        r.state.quoteSnippet.map((s) => [s.name, s.kind, s.milestones]),
        r.state.auditLog.map((a) => [a.action, a.userId, (a.metadata as Record<string, unknown>).source, (a.metadata as Record<string, unknown>).inputSha256 === sha(input)]),
        // the seed row is re-read under the editor's lock, right before its update, and not without it
        [r.calls.indexOf('$queryRaw FOR UPDATE') === r.calls.indexOf('quoteTemplate.update') - 1, r.calls.filter((c) => c.startsWith('$queryRaw') || c === 'quoteTemplate.findUnique')],
        r.out.trim().split('\n').at(-1),
        [again.code, writes(again.calls), again.out.includes('0 iras kesz')],
      ],
      'QTS-APPLY',
    ).toEqual([
      0,
      1,
      ['quoteTemplate.update', 'auditLog.create', 'quoteTemplate.create', 'auditLog.create', 'quoteSnippet.create', 'auditLog.create'],
      edited,
      [[block('TEXT', 'Bevezető', 'Valaki átírta.')], SEED_BLOCKS, SEED_BLOCKS],
      edited,
      [['Szállítási feltételek', 'DELIVERY', null]],
      [
        ['quote_template.updated', null, 'fleet-gate quote-templates-sync', true],
        ['quote_template.created', null, 'fleet-gate quote-templates-sync', true],
        ['quote_snippet.created', null, 'fleet-gate quote-templates-sync', true],
      ],
      [true, ['$queryRaw FOR UPDATE']],
      'UTANA: 6 sablon, 1 reszlet; duplikalt sablonnev: Kettő x2',
      [0, [], true],
    ])
  })

  it('QTS-SEED-IS-THE-IMAGES: a row holding the caller\'s idea of a seed, or an archived seed, is not replaced', () => {
    const app = image()
    // the row's blocks are what the caller might claim as "seed", but the image's seed differs
    const notSeed = app.run({ ...empty(), quoteTemplate: [seedRow({ blocks: [block('TEXT', 'Bevezető', 'Más alap.')] })] }, { templates: [template('Alap sablon')], snippets: [] }, true)
    const archived = app.run({ ...empty(), quoteTemplate: [seedRow({ archivedAt: '2026-10-01T00:00:00.000Z' })] }, { templates: [template('Alap sablon')], snippets: [] }, true)
    expect([notSeed.code, writes(notSeed.calls), archived.code, writes(archived.calls)], 'QTS-SEED-IS-THE-IMAGES').toEqual([0, [], 0, []])
  })

  it('QTS-UTF8: a long Hungarian text arrives whole across stdin chunks, and its sha256 is the bytes\' one', () => {
    // 70 000 two-byte letters: over node's 64 KiB stdin chunk, so letters fall across chunk edges
    const long = { ...snippet, content: doc('ő'.repeat(70_000)) }
    const input = { templates: [], snippets: [long] }
    const r = image().run(empty(), input, true)
    expect([r.code, r.out.split('\n')[0], JSON.stringify(r.state.quoteSnippet[0]?.content) === JSON.stringify(long.content)], 'QTS-UTF8').toEqual([
      0, `BEMENET sha256: ${sha(input)}`, true,
    ])
  })

  it('QTS-CHANGED-AFTER-PLAN: a row changed between the plan and the write stops the whole transaction', () => {
    // the create of Angol comes first, so a rollback is visible
    const r = image().run(state(), { ...input, templates: [template('Angol'), ...input.templates.filter((t) => t.name !== 'Angol')] }, true, { FAKE_TOUCH_IN_TX: 'seed-1' })
    expect(
      [r.code, r.err.includes('a terv ota megvaltozott'), r.state.quoteTemplate.length, r.state.quoteSnippet.length, r.state.auditLog.length, r.state.quoteTemplate[0]!.blocks],
      'QTS-CHANGED-AFTER-PLAN',
    ).toEqual([1, true, 5, 0, 0, SEED_BLOCKS])
  })
})
