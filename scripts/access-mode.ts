#!/usr/bin/env tsx
// ANSWERS: Hogyan állítom át az ACCESS_MODE-ot EGY nevesített, naplózott lépésben, és hogyan lépek vissza?
//
//   npx tsx scripts/access-mode.ts allapot
//   npx tsx scripts/access-mode.ts atallit legacy-szukitett --engedely "<Discord üzenet azonosító vagy kártya-komment>" [--szaraz]
//   npx tsx scripts/access-mode.ts atallit kikenyszerit --engedely "<...>" [--szaraz]
//   npx tsx scripts/access-mode.ts vissza --ok "<miért>" [--szaraz]
//
// A lépés (src/web/access-mode-switch.ts): a terv (három állás, egyszerre egy lépés, jóváhagyás hivatkozással,
// két egymás utáni tiszta napi preflight), a `.env` egyetlen sora, egy JSON-sor a store/access-mode.log-ba,
// a vezérlőpult újraindítása, olvasó próbák (a FUTÓ állást és a fő ágens fix útjait mérik), és bukott próbánál
// azonnali visszalépés `naplo`-ra. A visszalépés CÉLZOTT: `naplo`-ra megy, nem "kikapcsolásra" (olyan állás
// nincs). A telepítés Balázs külön jóváhagyása; ez a szkript nem dönt helyette, csak megköveteli a hivatkozást.
// A `--szaraz` a tervnél megáll. Az `allapot` csak olvas.
//
// Kilépési kód: 0 rendben; 1 megtagadva vagy bukott (a kimenet megnevezi); 2 rossz használat.

import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, WEB_PORT } from '../src/config.js'
import {
  modeFromStatuses, modeInEnv, parseHistory, probesFor, PROBE_UNRULED_PATH, runSwitch,
  type Probe, type SwitchDeps, type SwitchRecord,
} from '../src/web/access-mode-switch.js'
import { localDay } from '../src/web/auth-principals.js'

const ENV_FILE = join(PROJECT_ROOT, '.env')
const HISTORY_FILE = join(PROJECT_ROOT, 'store', 'access-preflight', 'napi.tortenet')
const LOG_FILE = join(PROJECT_ROOT, 'store', 'access-mode.log')
const BASE = `http://127.0.0.1:${process.env['MARVEEN_WEB_PORT'] ?? WEB_PORT}`
const RESTART_WAIT_MS = 90_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(name)

function usage(): never {
  process.stderr.write('Használat: access-mode.ts allapot | atallit <naplo|legacy-szukitett|kikenyszerit> --engedely "<hivatkozás>" [--szaraz] | vissza --ok "<ok>" [--szaraz]\n')
  process.exit(2)
}

function tokenOf(caller: 'L' | 'A'): string {
  const file = caller === 'L' ? join(PROJECT_ROOT, 'store', '.dashboard-token') : join(PROJECT_ROOT, 'store', 'tokens', `${MAIN_AGENT_ID}.token`)
  return readFileSync(file, 'utf-8').trim()
}

async function probe(p: Probe): Promise<number> {
  try {
    const res = await fetch(`${BASE}${p.path}`, { headers: { Authorization: `Bearer ${tokenOf(p.caller)}` }, signal: AbortSignal.timeout(15_000) })
    return res.status
  } catch {
    return 0
  }
}

async function dashboardAnswers(): Promise<boolean> {
  return (await probe({ name: 'up', caller: 'A', path: '/api/agents', expected: 200 })) === 200
}

async function restart(): Promise<boolean> {
  const r = spawnSync('supervisorctl', ['restart', 'dashboard'], { encoding: 'utf-8', timeout: 60_000 })
  process.stdout.write(`supervisorctl restart dashboard: ${r.status === 0 ? 'ok' : `kilépés ${r.status}`}\n`)
  const until = Date.now() + RESTART_WAIT_MS
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (await dashboardAnswers()) return true
  }
  return false
}

function writeEnv(text: string): void {
  // atomic, same mode as the file it replaces: a half-written .env would take every setting with it
  const mode = existsSync(ENV_FILE) ? statSync(ENV_FILE).mode & 0o777 : 0o600
  const tmp = `${ENV_FILE}.tmp-access-mode`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, ENV_FILE)
}

function record(entry: SwitchRecord): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true, mode: 0o700 })
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 })
}

const deps: SwitchDeps = {
  now: () => Math.floor(Date.now() / 1000),
  today: () => localDay(Math.floor(Date.now() / 1000)),
  readEnv: () => (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : ''),
  writeEnv,
  readHistory: () => (existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, 'utf-8') : ''),
  record,
  restart,
  probe,
}

async function allapot(): Promise<number> {
  const env = modeInEnv(deps.readEnv())
  process.stdout.write(`.env: ${env.raw === undefined ? '(nincs sor, tehát naplo)' : `ACCESS_MODE=${env.raw}`} -> ${env.mode}${env.problem ? `  FIGYELEM: ${env.problem}` : ''}\n`)
  // the RUNNING mode, measured: the dashboard reads the setting once at start
  const forL = await probe({ name: 'L', caller: 'L', path: PROBE_UNRULED_PATH, expected: 0 })
  const forA = await probe({ name: 'A', caller: 'A', path: PROBE_UNRULED_PATH, expected: 0 })
  const running = modeFromStatuses(forL, forA)
  process.stdout.write(`futó állás (mérve): ${running ?? `NEM ÉRTELMEZHETŐ (közös token ${forL}, fő ágens ${forA})`}${running && running !== env.mode ? `  ELTÉR a .env-től: újraindítás még nem történt, vagy a .env más` : ''}\n`)
  const history = parseHistory(deps.readHistory()).slice(-3)
  process.stdout.write(history.length ? `napi preflight (utolsó ${history.length}):\n${history.map((h) => `  ${new Date(h.ts * 1000).toISOString()} ${h.verdict}`).join('\n')}\n` : 'napi preflight: nincs előzmény (napi.tortenet)\n')
  if (existsSync(LOG_FILE)) {
    const last = readFileSync(LOG_FILE, 'utf-8').trim().split('\n').slice(-3)
    process.stdout.write(`utolsó átállítások (store/access-mode.log):\n${last.map((l) => `  ${l}`).join('\n')}\n`)
  }
  const probeList = probesFor(running ?? env.mode, deps.today())
  process.stdout.write(`olvasó próbák, amit az átállítás utána fut: ${probeList.map((p) => `${p.caller} ${p.path} -> ${p.expected}`).join('; ')}\n`)
  return running === env.mode && running !== null ? 0 : 1
}

async function main(): Promise<number> {
  const verb = process.argv[2]
  if (verb === 'allapot') return allapot()
  if (verb !== 'atallit' && verb !== 'vissza') usage()
  const to = verb === 'vissza' ? 'naplo' : process.argv[3]
  if (!to || to.startsWith('--')) usage()
  const outcome = await runSwitch(
    { to, approval: arg('--engedely'), reason: verb === 'vissza' ? arg('--ok') : undefined, dryRun: has('--szaraz') },
    deps,
  )
  process.stdout.write(outcome.lines.map((l) => `${l}\n`).join(''))
  return outcome.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`access-mode: ${String(err)}\n`)
    process.exit(1)
  },
)
