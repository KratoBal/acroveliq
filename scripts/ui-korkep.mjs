// ANSWERS: What does every Acropora OS web page look like on stage, at desktop and phone width?
//
// Usage: node scripts/ui-korkep.mjs <routes-file> <out-dir> [email] [password-file]
//   routes-file: one route per line. A line with [param] segments is resolved by opening the
//   parent list page and taking the first link whose path matches the pattern.
// Writes <out-dir>/<slug>-1440.png and -390.png (full page), and index.tsv:
//   route, resolved path, http-ish status (ok | redirect:<to> | no-link | error:<msg>), console errors.
// Stage only: refuses any host without "staging".
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/marveen/marveen/node_modules/playwright");

const [routesFile, outDir, email = "flotta-smoke-admin@acropora.hu", pwFile = "/home/marveen/marveen/store/.stage-os-smoke-admin-password"] = process.argv.slice(2);
if (!routesFile || !outDir) { console.error("usage: ui-korkep.mjs <routes-file> <out-dir> [email] [password-file]"); process.exit(2); }
const WEB = process.env.STAGE_WEB ?? "https://staging.acropora.hu";
if (!/staging/.test(new URL(WEB).hostname)) { console.error("FAIL: not a staging host"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const routes = readFileSync(routesFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const password = readFileSync(pwFile, "utf8").trim();
const idx = join(outDir, "index.tsv");
writeFileSync(idx, "route\tpath\tstatus\tconsole_errors\n");

// Native widgets (datetime-local, file chooser) follow the browser process's LANG, not the
// context locale: without it the shots show en-US dates and "Choose File" (picasso 61440).
const browser = await chromium.launch({ env: { ...process.env, LANG: process.env.SHOT_LANG ?? "hu_HU.UTF-8", LANGUAGE: "hu" } });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: process.env.LOCALE ?? "hu-HU", timezoneId: "Europe/Budapest" });
const login = await ctx.request.post(`${WEB}/api/auth/login/password`, { data: { email, password } });
if (!login.ok()) { console.error(`FAIL: login ${login.status()}`); await browser.close(); process.exit(5); }
// Read-only run (barracuda 41508, 2026-11-03): a logged-in page may fire a non-GET request on
// open, which would WRITE on stage. Abort every non-GET except the session's own auth calls.
let blockedWrites = 0;
await ctx.route("**/*", (route) => {
  const req = route.request();
  const m = req.method();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || /\/api\/auth\//.test(req.url())) return route.continue();
  blockedWrites++;
  console.error(`BLOCKED ${m} ${req.url().slice(0, 140)}`);
  return route.abort();
});
const page = await ctx.newPage();
let errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });

const slug = (r) => (r === "/" ? "root" : r.replace(/^\//, "").replace(/[\/\[\]]+/g, "_"));
const toRegex = (r) => new RegExp("^" + r.replace(/\[[^\]]+\]/g, "[^/?#]+") + "$");

// Nested routes (/x/[id]/szerkesztes, /x/[id]/y/[sub]): resolve the first [param] from its list
// page, then a static tail is appended, and a further [param] is resolved on the concrete prefix
// (its own list page first, then the parent detail page).
async function resolve(route) {
  if (!route.includes("[")) return route;
  const end = route.indexOf("]") + 1;
  const head = route.slice(0, end), tail = route.slice(end);
  if (!tail) return resolveOn(route.slice(0, route.indexOf("/[")) || "/", route);
  const base = await resolveOn(head.slice(0, head.indexOf("/[")) || "/", head);
  if (!base) return null;
  if (!tail.includes("[")) return base + tail;
  const next = base + tail;
  const listPage = next.slice(0, next.indexOf("/["));
  return (await resolveOn(listPage, next)) || (await resolveOn(base, next));
}

async function resolveOn(parent, route) {
  await page.goto(WEB + parent, { waitUntil: "load", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500);
  const re = toRegex(route);
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => new URL(a.href).pathname));
  // a [param] segment also matches static sibling routes (/beszerzes/varhato for /beszerzes/[id]):
  // prefer a link whose last segment carries a digit (an id), fall back to any match
  const matches = hrefs.filter((h) => re.test(h));
  const byLink = matches.find((h) => /\d/.test(h.split("/").pop()));
  if (byLink) return byLink;
  // many list pages navigate on a row click, not an anchor: click the first body row
  const row = await page.$("tbody tr, [role=row][tabindex], [data-row-href]");
  if (!row) return matches[0] || null;
  await Promise.all([page.waitForURL((u) => re.test(new URL(u).pathname), { timeout: 8000 }).catch(() => {}), row.click().catch(() => {})]);
  const p = new URL(page.url()).pathname;
  return re.test(p) ? p : matches[0] || null;
}

let n = 0;
for (const route of routes) {
  n++;
  errs = [];
  let path = null, status = "ok";
  try {
    path = await resolve(route);
    if (!path) { status = "no-link"; appendFileSync(idx, `${route}\t-\t${status}\t0\n`); console.log(`${n}/${routes.length} ${route} no-link`); continue; }
    errs = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WEB + path, { waitUntil: "load", timeout: 30000 }); await page.waitForTimeout(2500);
    const landed = new URL(page.url()).pathname;
    if (landed !== path) status = `redirect:${landed}`;
    // Park the pointer: a hover background read as a wrong active menu item (nautilus 61557).
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(outDir, `${slug(route)}-1440.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(outDir, `${slug(route)}-390.png`), fullPage: true });
  } catch (e) {
    status = `error:${String(e.message).split("\n")[0].slice(0, 80)}`;
  }
  appendFileSync(idx, `${route}\t${path ?? "-"}\t${status}\t${errs.length}\n`);
  console.log(`${n}/${routes.length} ${route} ${status}`);
}
console.error(`blocked non-GET requests: ${blockedWrites}`);
await browser.close();
