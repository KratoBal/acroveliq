// scripts/szamla-level-hiany.sh (acrobot 57841, Balazs 2026-11-20): the invoice mails of info@ and balazs@ that the
// production collection missed. WHAT TURNS THIS RED: a mail with a PDF the collection stored not said to be in order;
// a PDF the collection never saw (or saw under the other mailbox) not said to need a Drive upload; a mail without a PDF
// not giving its invoice or login link, or giving it with its query (a one-time key); a subject holding " | " or a
// security tag shifting the columns; a non-hex id reaching the SQL; a refused table not named with its columns.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'szamla-hiany-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = (text: string) => `<untrusted source="gmail">${text}</untrusted>`
const mail = (id: string, from: string, subject: string, att = '', date = 'Thu, 19 Nov 2026 10:00:00 +0100') =>
  `${id} | ${env(date)} | ${env(from)} | ${env(subject)} | ${att ? env(att) : ''}`
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toUTCString()

type World = {
  info?: string[]
  balazs?: string[]
  bodies?: Record<string, string>
  db?: string // what psql-ro prints
  gcalFails?: boolean
}
let n = 0
const run = (w: World, nap?: string) => {
  const dir = join(root, `vilag-${(n += 1)}`)
  const scripts = join(dir, 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  mkdirSync(join(scripts, 'host'), { recursive: true })
  for (const f of ['szamla-level-hiany.sh', 'lib/untrusted_envelope.py', 'host/known_hosts'])
    writeFileSync(join(scripts, f), readFileSync(join(process.cwd(), 'scripts', f)))
  const calls = join(dir, 'calls.txt')
  const fx = join(dir, 'fx')
  mkdirSync(join(fx, 'body'), { recursive: true })
  writeFileSync(join(fx, 'info.txt'), [`talalat: ${(w.info ?? []).length}`, ...(w.info ?? [])].join('\n') + '\n')
  writeFileSync(join(fx, 'balazs.txt'), [`talalat: ${(w.balazs ?? []).length}`, ...(w.balazs ?? [])].join('\n') + '\n')
  for (const [id, body] of Object.entries(w.bodies ?? {})) writeFileSync(join(fx, 'body', id), body)
  // the stand-in gcal.sh: search answers per account, fetch writes the body the world gives
  writeFileSync(
    join(scripts, 'gcal.sh'),
    `echo "gcal $GC_ACCOUNT $1" >> '${calls}'
${w.gcalFails ? 'echo "HTTP 401: invalid_grant" >&2; exit 1' : ''}
case "$1" in
  search) printf '%s\\n' "$2" > '${join(dir, 'query.txt')}'; cat '${fx}'/"$GC_ACCOUNT".txt;;
  fetch) [ -f '${fx}/body/'"$2" ] || exit 1; mkdir -p "$3/$2"; cp '${fx}/body/'"$2" "$3/$2/body.txt"; echo "$3/$2/body.txt";;
esac
`,
  )
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\ncat > '${join(dir, 'sql.txt')}'\necho "ssh" >> '${calls}'\ncat '${join(dir, 'db.txt')}'\n`, { mode: 0o755 })
  writeFileSync(join(dir, 'db.txt'), w.db ?? 'vege|0\n')
  const r = spawnSync('bash', [join(scripts, 'szamla-level-hiany.sh'), ...(nap ? [nap] : [])], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf-8',
  })
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf-8') : '')
  return { code: r.status, out: r.stdout, err: r.stderr, sql: read('sql.txt'), query: read('query.txt'), calls: read('calls.txt').trim().split('\n') }
}
// the columns after the enveloped ones, read from the right: a subject may hold " | ", so a plain split would shift
const tail = (out: string, id: string) => out.split('\n').find((l) => l.startsWith(`info@ | ${id} | `) || l.startsWith(`balazs@ | ${id} | `))?.match(/ \| (PDF van|PDF nincs) \| (OS latta [^|]*) \| (.*)$/)
const advice = (out: string, id: string) => tail(out, id)?.[3]
const osCol = (out: string, id: string) => tail(out, id)?.[2]

describe('szamla-level-hiany.sh', () => {
  it('SZAMLA-HIANY-JAVASLAT: stored is in order, unseen PDF goes to Drive, no PDF gives the link without its query', () => {
    const r = run({
      info: [
        mail('aaaa0001', 'Szallito Kft <szamla@szallito.hu>', 'Számla 2026/123', 'SZ-2026-123.PDF'),
        mail('aaaa0002', 'Masik <info@masik.hu>', 'Invoice INV-77', 'inv77.pdf;feltetelek.docx'),
        mail('aaaa0003', 'Portal <noreply@portal.hu>', 'Új számlája érkezett | 2026/11 [[SECURITY_TAG_REMOVED_ab12cd34]]'),
        mail('aaaa0004', 'Harmadik <x@harmadik.hu>', 'Díjbekérő', 'dijbekero.pdf'),
        mail('aaaa0005', 'Negyedik <y@negyedik.hu>', 'Rechnung', ''),
        // barracuda, #389: a key in the path, a password in the user part
        mail('aaaa0006', 'Otodik <z@otodik.hu>', 'Számla letöltés'),
        mail('aaaa0007', 'Hatodik <w@hatodik.hu>', 'Invoice ready'),
        // younger than two hours: the hourly collection has not had its round yet; older, or no readable date, has
        mail('aaaa0008', 'Hetedik <v@hetedik.hu>', 'Számla', 'friss.pdf', ago(30)),
        mail('aaaa0009', 'Nyolcadik <u@nyolcadik.hu>', 'Számla', 'regi.pdf', ago(180)),
        mail('aaaa000a', 'Kilencedik <t@kilencedik.hu>', 'Számla', 'rossz-datum.pdf', 'nem datum'),
      ],
      balazs: [
        mail('bbbb0001', 'Bolt <bolt@bolt.hu>', 'E-számla', 'e-szamla.pdf'),
        mail('bbbb0002', 'Acropora <info@acropora.hu>', 'Számla kiállítva', 'sajat.pdf'),
      ],
      bodies: {
        aaaa0003:
          'Leiratkozas: https://portal.hu/unsubscribe?u=1\nKovess minket: https://facebook.com/portal\nA szamla: https://portal.hu/ugyfel/szamlak/letoltes?token=EGYSZERI-KULCS#top.\n',
        aaaa0005: 'Csak szoveg, link nelkul.\n',
        aaaa0006: 'Letoltes: https://szamla.otodik.hu/invoice/download/UTVONAL-KULCS-77.pdf\n',
        aaaa0007: 'Belepes: https://ugyfel:JELSZO-99@portal.hatodik.hu:8443/login\n',
      },
      db: [
        'item|INFO_MAIL|aaaa0001|STORED|',
        'item|INFO_MAIL|aaaa0004|UNMATCHED|NUMBER_UNREADABLE',
        // seen under the OTHER mailbox: not this message of balazs@
        'item|INFO_MAIL|bbbb0001|STORED|',
        'item|BALAZS_MAIL|bbbb0002|OWN_INVOICE|',
        'vege|0',
        '',
      ].join('\n'),
    })
    const ids = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006', 'aaaa0007', 'aaaa0008', 'aaaa0009', 'aaaa000a', 'bbbb0001', 'bbbb0002']
    expect(
      {
        code: r.code,
        advice: Object.fromEntries(ids.map((id) => [id, advice(r.out, id)])),
        os: Object.fromEntries(['aaaa0001', 'aaaa0002', 'aaaa0004', 'bbbb0001', 'bbbb0002'].map((id) => [id, osCol(r.out, id)])),
        pdfCol: tail(r.out, 'aaaa0003')?.[1],
        keyLeaked: ['EGYSZERI-KULCS', 'UTVONAL-KULCS', 'JELSZO-99', 'ugyfel:', '/ugyfel/szamlak'].filter((k) => r.out.includes(k)),
        summary: r.out.trim().split('\n').pop(),
        // fetch only for the two mails without a PDF
        fetched: r.calls.filter((c) => c.endsWith(' fetch')),
      },
      'SZAMLA-HIANY-JAVASLAT',
    ).toEqual({
      code: 0,
      advice: {
        aaaa0001: 'rendben',
        aaaa0002: 'Drive-ba toltendo',
        aaaa0003: `belepes kell: ${env('https://portal.hu')}`,
        aaaa0004: 'ember nezze: az OS latta, de nem tarolta',
        aaaa0005: 'ember nezze: nincs PDF es nincs link',
        aaaa0006: `belepes kell: ${env('https://szamla.otodik.hu')}`,
        aaaa0007: `belepes kell: ${env('https://portal.hatodik.hu')}`,
        aaaa0008: 'varja az OS-gyujtest',
        aaaa0009: 'Drive-ba toltendo',
        aaaa000a: 'Drive-ba toltendo',
        bbbb0001: 'Drive-ba toltendo',
        bbbb0002: 'rendben (sajat kimeno szamla)',
      },
      os: {
        aaaa0001: 'OS latta igen (STORED)',
        aaaa0002: 'OS latta nem',
        aaaa0004: 'OS latta igen (UNMATCHED/NUMBER_UNREADABLE)',
        bbbb0001: 'OS latta nem',
        bbbb0002: 'OS latta igen (OWN_INVOICE)',
      },
      pdfCol: 'PDF nincs',
      keyLeaked: [],
      summary: '# 12 level (Drive-ba toltendo 4, belepes kell 3, ember nezze 2, rendben 1, rendben (sajat kimeno szamla) 1, varja az OS-gyujtest 1)',
      fetched: ['gcal info fetch', 'gcal info fetch', 'gcal info fetch', 'gcal info fetch'],
    })
  })

  it('SZAMLA-HIANY-ZAJ: GitHub and newsletter senders are skipped and counted; a github.com link is never a login; a future date is not fresh', () => {
    const r = run({
      info: [
        mail('cccc0001', 'GitHub <notifications@github.com>', 'Re: [KratoBal/acropora-os] invoice export (PR #2700)'),
        mail('cccc0002', 'Aquarioom <hello@newsletter.aquarioom.com>', 'Novemberi akciók, számla nélkül', 'katalogus.pdf'),
        // the nearest look-alikes stay: another domain that only ends in "github.com", and "newsletter" before the @
        mail('cccc0003', 'Bolt <noreply@notgithub.com>', 'Számla', 'sz.pdf'),
        mail('cccc0004', 'Bolt <newsletter@bolt.hu>', 'E-számla', 'e.pdf'),
        mail('cccc0005', 'Szolgaltato <x@szolg.hu>', 'Számla elérhető'),
        mail('cccc0006', 'Jovo <j@jovo.hu>', 'Számla', 'jovo.pdf', new Date(Date.now() + 3 * 3600_000).toUTCString()),
      ],
      bodies: { cccc0005: 'A szamla a GitHub-on: https://github.com/szolg/szamlak/releases/download/x.pdf\n' },
    })
    expect(
      {
        code: r.code,
        listed: ['cccc0001', 'cccc0002', 'cccc0003', 'cccc0004', 'cccc0005', 'cccc0006'].filter((id) => advice(r.out, id) !== undefined),
        advice: Object.fromEntries(['cccc0003', 'cccc0004', 'cccc0005', 'cccc0006'].map((id) => [id, advice(r.out, id)])),
        summary: r.out.trim().split('\n').pop(),
      },
      'SZAMLA-HIANY-ZAJ',
    ).toEqual({
      code: 0,
      listed: ['cccc0003', 'cccc0004', 'cccc0005', 'cccc0006'],
      advice: {
        cccc0003: 'Drive-ba toltendo',
        cccc0004: 'Drive-ba toltendo',
        cccc0005: 'ember nezze: nincs PDF es nincs link',
        cccc0006: 'Drive-ba toltendo',
      },
      summary: '# 4 level (Drive-ba toltendo 3, ember nezze 1); kihagyva 2 ertesito/hirlevel',
    })
  })

  it('SZAMLA-HIANY-FORRAS: the query, the SQL (hex ids only, no file name), a refused table named with its columns, a failed mailbox', () => {
    const ok = run({ info: [mail('aaaa0001', 'a', 'Számla', 'x.pdf'), "x');DROP | rossz sor"] }, '3')
    const refused = run({ info: [mail('aaaa0001', 'a', 'Számla', 'x.pdf')], db: 'ERROR:  permission denied for table InvoiceCollectionItem\n' })
    const gcal = run({ gcalFails: true })
    const empty = run({})
    // the relay's search line: id | date | from | subject, no attachment column
    const relay = run({ info: [`aaaa0009 | ${env('d')} | ${env('f')} | ${env('Számla')}`] })
    expect(
      {
        query: ok.query.trim(),
        sqlIds: ok.sql.match(/IN \(([^)]*)\);/)?.[1],
        sqlNoFile: !ok.sql.includes('fileName'),
        refused: { code: refused.code, err: refused.err.trim() },
        gcal: { code: gcal.code, err: gcal.err.trim() },
        empty: { code: empty.code, out: empty.out.trim(), ssh: empty.calls.includes('ssh') },
        badNap: run({}, 'x; rm').code,
        relay: { code: relay.code, said: relay.err.startsWith('HIBA: a(z) info@ keresese ismeretlen alaku sort adott (nincs melleklet-oszlop'), out: relay.out },
      },
      'SZAMLA-HIANY-FORRAS',
    ).toEqual({
      query:
        '(szamla OR számla OR invoice OR Rechnung OR dijbekero OR díjbekérő OR proforma OR szamlaertesito OR számlaértesítő OR e-szamla OR e-számla) newer_than:3d -in:sent -in:drafts -in:chats',
      sqlIds: "'aaaa0001'",
      sqlNoFile: true,
      refused: {
        code: 2,
        err: 'HIBA: a fleet_ro nem olvashatja az eles "InvoiceCollectionItem" tablat (oszlopok: source, externalId, verdict, reason); ehhez kell SELECT jog. A valasz: ERROR:  permission denied for table InvoiceCollectionItem',
      },
      gcal: { code: 2, err: 'HIBA: a(z) info@ fiok levelei nem olvashatok (gcal.sh search): HTTP 401: invalid_grant' },
      empty: { code: 0, out: '# 0 level (nincs szamla-jellegu level)', ssh: false },
      badNap: 2,
      // the report is not printed half
      relay: { code: 2, said: true, out: '' },
    })
  })
})
