// scripts/eles-napi-felhozas.sh, the daily production rollout of Acropora OS (Balazs, 2026-11-20), and its migration gate
// scripts/lib/migracio_kapu.py. WHAT TURNS THIS RED: one of the five migrations that went to production on 2026-11-20
// stopping the gate (the old grep stopped stripe_settlement on the identifier "ordersTruncated"); an unsafe migration
// passing it (DROP COLUMN, RENAME, SET NOT NULL, UPDATE, and the shapes the old grep missed: a statement over two lines,
// DROP without COLUMN, ADD COLUMN NOT NULL without DEFAULT, a DROP CONSTRAINT not added back); a keyword in a comment,
// a string or an identifier stopping it; the rollout going on when the test web runs another commit than the test
// API, or does not say which; the cron line missing.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'eles-napi-felhozas.sh')
const GATE = join(process.cwd(), 'scripts', 'lib', 'migracio_kapu.py')
const FIXTURES = join(process.cwd(), 'scripts', '__tests__', 'fixtures', 'migracio-kapu')
const root = mkdtempSync(join(tmpdir(), 'eles-felhozas-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const gate = (sql: string) => {
  const f = join(root, `m-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(f, sql)
  const r = spawnSync('python3', ['-B', GATE, f], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout.replaceAll(`${f}: `, '') }
}
// only the rule names, so a statement's text does not decide the comparison
const rules = (out: string) => out.trim().split('\n').filter(Boolean).map((l) => l.split(': ')[0])

describe('migracio_kapu.py', () => {
  it('MIGRACIO-KAPU-MAI-OT: the five migrations of 2026-11-20 pass, the DROP CONSTRAINT + ADD CONSTRAINT swap among them', () => {
    const names = readdirSync(FIXTURES).sort()
    const got = Object.fromEntries(names.map((n) => [n, gate(readFileSync(join(FIXTURES, n), 'utf-8'))]))
    expect(got, 'MIGRACIO-KAPU-MAI-OT').toEqual({
      '20261118230000_gls_cod_webshop_parcel.sql': { code: 0, out: '' },
      '20261119060000_stripe_settlement.sql': { code: 0, out: '' },
      '20261119100000_worksheet_follows_job_assignees.sql': { code: 0, out: '' },
      '20261119150000_service_job_linked_worksheets.sql': { code: 0, out: '' },
      '20261119160000_service_job_event_kind_linked_check.sql': { code: 0, out: '' },
    })
  })

  it('MIGRACIO-KAPU-MEGALL: every unsafe shape stops, with the rule that stopped it', () => {
    const cases: Record<string, string> = {
      dropColumn: 'ALTER TABLE "Order" DROP COLUMN "note";',
      dropColumnNoKeyword: 'ALTER TABLE "Order"\n  DROP "note";',
      dropTable: 'DROP TABLE "Legacy";',
      rename: 'ALTER TABLE "Order" RENAME COLUMN "note" TO "remark";',
      setNotNull: 'ALTER TABLE "Order"\n  ALTER COLUMN "note" SET NOT NULL;',
      alterType: 'ALTER TABLE "Order" ALTER COLUMN "note" SET DATA TYPE VARCHAR(20);',
      update: 'UPDATE "Order" SET "note" = \'x\' WHERE "note" IS NULL;',
      updateIndented: 'CREATE INDEX "a_idx" ON "Order"("note");   UPDATE "Order" SET "note" = NULL;',
      updateWith: 'WITH t AS (SELECT "id" FROM "Order") UPDATE "Order" SET "note" = NULL FROM t;',
      deleteFrom: 'DELETE FROM "Order" WHERE "id" = \'1\';',
      truncate: 'TRUNCATE "Order";',
      addNotNullNoDefault: 'ALTER TABLE "Order" ADD COLUMN "a" TEXT, ADD COLUMN "b" DECIMAL(19,4) NOT NULL;',
      dropConstraintAlone: 'ALTER TABLE "Order" DROP CONSTRAINT "Order_customerId_fkey";',
      dropUniqueIndex: 'DROP INDEX "Order_number_key";',
      dollarBlock: 'DO $$ BEGIN DELETE FROM "Order"; END $$;',
      // barracuda, #387: it can fail on the rows an existing table has
      checkOnExisting: 'ALTER TABLE "Order" ADD CONSTRAINT "Order_n_check" CHECK ("n" > 0);',
      fkOnExistingColumn: 'ALTER TABLE "Order" ADD CONSTRAINT "Order_c_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id");',
      uniqueIndexOnExisting: 'CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");',
      // a new column WITH a default holds the same value in every row: a unique index on it fails at the second row
      uniqueIndexOnDefaulted: 'ALTER TABLE "Order" ADD COLUMN "code" TEXT DEFAULT \'x\'; CREATE UNIQUE INDEX "Order_code_idx" ON "Order"("code");',
      // an expression key cannot be told to be NULL
      uniqueExpressionOnNew: 'ALTER TABLE "Order" ADD COLUMN "slug" TEXT; CREATE UNIQUE INDEX "Order_slug_idx" ON "Order"(lower("slug"));',
      // barracuda, #387: no data goes, an older reader or a row-level rule does
      dropView: 'DROP VIEW "WorksheetLatestVersion";',
      dropPolicy: 'DROP POLICY "own_rows" ON "Order";',
      dropFunction: 'DROP FUNCTION IF EXISTS "redeem"(text);',
    }
    const got = Object.fromEntries(Object.entries(cases).map(([k, sql]) => {
      const r = gate(sql)
      return [k, { code: r.code, rules: rules(r.out) }]
    }))
    expect(got, 'MIGRACIO-KAPU-MEGALL').toEqual({
      dropColumn: { code: 1, rules: ['DROP of a schema object'] },
      dropColumnNoKeyword: { code: 1, rules: ['DROP column (no COLUMN keyword)'] },
      dropTable: { code: 1, rules: ['DROP of a schema object'] },
      rename: { code: 1, rules: ['RENAME'] },
      setNotNull: { code: 1, rules: ['SET NOT NULL'] },
      alterType: { code: 1, rules: ['ALTER COLUMN ... TYPE'] },
      update: { code: 1, rules: ['UPDATE'] },
      updateIndented: { code: 1, rules: ['UPDATE'] },
      updateWith: { code: 1, rules: ['UPDATE'] },
      deleteFrom: { code: 1, rules: ['DELETE FROM'] },
      truncate: { code: 1, rules: ['TRUNCATE'] },
      addNotNullNoDefault: { code: 1, rules: ['ADD COLUMN NOT NULL without DEFAULT'] },
      dropConstraintAlone: { code: 1, rules: ['DROP CONSTRAINT not added back'] },
      dropUniqueIndex: { code: 1, rules: ['DROP unique index'] },
      // the block is split at its inner ';': the statement inside is read too, and both ends name the block
      dollarBlock: { code: 1, rules: ['DELETE FROM', 'dollar-quoted block', 'dollar-quoted block'] },
      checkOnExisting: { code: 1, rules: ['ADD CONSTRAINT on an existing table'] },
      fkOnExistingColumn: { code: 1, rules: ['ADD CONSTRAINT on an existing table'] },
      uniqueIndexOnExisting: { code: 1, rules: ['CREATE UNIQUE INDEX on an existing table'] },
      uniqueIndexOnDefaulted: { code: 1, rules: ['CREATE UNIQUE INDEX on an existing table'] },
      uniqueExpressionOnNew: { code: 1, rules: ['CREATE UNIQUE INDEX on an existing table'] },
      dropView: { code: 1, rules: ['DROP of a schema object'] },
      dropPolicy: { code: 1, rules: ['DROP of a schema object'] },
      dropFunction: { code: 1, rules: ['DROP of a schema object'] },
    })
  })

  it('MIGRACIO-KAPU-KOZELI-ATMEGY: the nearest additive look-alikes pass', () => {
    const cases: Record<string, string> = {
      keywordInIdentifier: 'CREATE TABLE "P" ("ordersTruncated" BOOLEAN NOT NULL DEFAULT false, "renamedAt" TIMESTAMP(3));',
      keywordInComment: '-- RENAMED on the way in; DROP COLUMN later\n/* UPDATE "P" */\nCOMMENT ON COLUMN "P"."a" IS \'DROP TABLE, RENAME\';',
      onUpdateCascade: 'ALTER TABLE "L" ADD COLUMN "p" TEXT; ALTER TABLE "L" ADD CONSTRAINT "L_p_fkey" FOREIGN KEY ("p") REFERENCES "P"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      loosen: 'ALTER TABLE "P" ALTER COLUMN "a" DROP NOT NULL, ALTER COLUMN "b" DROP DEFAULT;',
      addNotNullWithDefault: 'ALTER TABLE "P" ADD COLUMN "c" INTEGER NOT NULL DEFAULT 0;',
      dropPlainIndex: 'DROP INDEX "P_a_idx";',
      constraintSwap: 'ALTER TABLE "P"\n  DROP CONSTRAINT "P_kind_check";\nALTER TABLE "P"\n  ADD CONSTRAINT "P_kind_check" CHECK ("a" IS NOT NULL);',
      enumAddValue: 'ALTER TYPE "Kind" ADD VALUE \'NEW\';',
      // Prisma's new optional relation: the key column is new and NULL in every existing row
      fkOnNewColumn: 'ALTER TABLE "User" ADD COLUMN "customerId" TEXT;\nALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      uniqueIndexOnNewColumn: 'ALTER TABLE "Order" ADD COLUMN "slug" TEXT;\nCREATE UNIQUE INDEX "Order_slug_key" ON "Order"("slug");',
      uniqueIndexOnNewTable: 'CREATE TABLE "N" ("id" TEXT NOT NULL, "k" TEXT);\nCREATE UNIQUE INDEX "N_k_key" ON "N"("k");\nALTER TABLE "N" ADD CONSTRAINT "N_id_check" CHECK ("id" <> \'\');',
      notValid: 'ALTER TABLE "Order" ADD CONSTRAINT "Order_n_check" CHECK ("n" > 0) NOT VALID;',
      dropPlainIndexAndDefault: 'DROP INDEX "Order_note_idx"; ALTER TABLE "Order" ALTER COLUMN "note" DROP DEFAULT;',
    }
    const got = Object.fromEntries(Object.entries(cases).map(([k, sql]) => [k, gate(sql)]))
    expect(got, 'MIGRACIO-KAPU-KOZELI-ATMEGY').toEqual(Object.fromEntries(Object.keys(cases).map((k) => [k, { code: 0, out: '' }])))
  })

  it('MIGRACIO-KAPU-URES: an empty or missing file is exit 2, not a pass', () => {
    const missing = spawnSync('python3', ['-B', GATE, join(root, 'nincs.sql')], { encoding: 'utf-8' }).status
    expect({ empty: gate('  \n').code, missing }, 'MIGRACIO-KAPU-URES').toEqual({ empty: 2, missing: 2 })
  })
})

describe('eles-napi-felhozas.sh', () => {
  // The script runs as written: curl, ssh and sudo are stand-ins on PATH. curl answers from a folder (host/path, the
  // query dropped) and logs every call; a POST or a PATCH (a pin or a deploy) is logged and answers {}. ssh answers
  // the psql-ro line; sudo is the token broker. --nez: a stop is logged only, nothing is sent, and it never deploys.
  const S = 'a'.repeat(40)
  const P = 'b'.repeat(40)
  const GH = 'api.github.com/repos/KratoBal/acropora-os'
  const ENVS = '162.55.216.28:8000/api/v1/applications/t9gxx94ecwekwruxngps5i6v/envs'
  const MIG = 'packages/database/prisma/migrations/20261120000000_x/migration.sql'
  type World = {
    web?: string | null
    eles?: string
    onMain?: string
    migration?: string
    migrationStatus?: string
    envPatch?: string
    envKeys?: string[]
    savedKeys?: string[] | null
    medusa?: string
    savedMedusa?: string | null
  }
  let n = 0
  const run = (w: World = {}) => {
    const dir = join(root, `vilag-${(n += 1)}`)
    const put = (rel: string, body: unknown) => {
      mkdirSync(join(dir, 'net', rel, '..'), { recursive: true })
      writeFileSync(join(dir, 'net', rel), typeof body === 'string' ? body : JSON.stringify(body))
    }
    const web = w.web === undefined ? S : w.web
    put('api-staging.acropora.hu/health', { application: { commit: S } })
    put('staging.acropora.hu/health', { application: { commit: web } })
    put('api.acropora.hu/health', { application: { commit: w.eles ?? P } })
    const files: object[] = [{ filename: MIG, status: w.migrationStatus ?? 'added' }]
    if (w.envPatch !== undefined) files.push({ filename: '.env.production.example', status: 'modified', patch: w.envPatch })
    put(`${GH}/compare/${P}...${S}`, { status: 'ahead', ahead_by: 3, behind_by: 0, files })
    put(`${GH}/compare/main...${S}`, { status: w.onMain ?? 'behind' })
    put(`${GH}/commits/${S}/check-runs`, { check_runs: [{ name: 'verify', conclusion: 'success', started_at: '2026-11-20T05:00:00Z' }] })
    put(`${GH}/contents/${MIG}`, w.migration ?? 'ALTER TABLE "Order" ADD COLUMN "note" TEXT;\n')
    put(ENVS, (w.envKeys ?? ['MEDUSA_PROJECTION_SCHEDULE_ENABLED']).map((key) => ({ key, value: 'TITOK-ERTEK' })))
    const allapot = join(dir, 'allapot')
    mkdirSync(allapot, { recursive: true })
    const savedKeys = w.savedKeys === undefined ? ['MEDUSA_PROJECTION_SCHEDULE_ENABLED'] : w.savedKeys
    if (savedKeys) writeFileSync(join(allapot, 'env-kulcsok.txt'), savedKeys.map((k) => `${k}\n`).join(''))
    const savedMedusa = w.savedMedusa === undefined ? '1|2026-09-04T16:02:00.000' : w.savedMedusa
    if (savedMedusa) writeFileSync(join(allapot, 'medusa-ref.txt'), `${savedMedusa}\n`)

    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const calls = join(dir, 'calls.txt')
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
m=GET; u=
while [ $# -gt 0 ]; do case "$1" in -X) m=$2; shift 2;; -H|-d|--max-time) shift 2;; http*) u=$1; shift;; *) shift;; esac; done
echo "$m $u" >> '${calls}'
case "$m" in POST|PATCH) echo '{}'; exit 0;; esac
f='${join(dir, 'net')}/'$(printf '%s' "\${u#*://}" | sed 's/?.*//')
[ -f "$f" ] && cat "$f"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\ncat > /dev/null\necho "ssh $*" >> '${calls}'\necho 'medusa_ref|${w.medusa ?? '1|2026-09-04T16:02:00.000'}'\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash\necho fake-gh-token\n`, { mode: 0o755 })
    const log = join(dir, 'log.txt')
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELES_FELHOZAS_LOG: log, ELES_FELHOZAS_ALLAPOT: allapot }
    delete env.FLEET_GITHUB_APP
    const r = spawnSync('bash', [SCRIPT, '--nez'], { env, encoding: 'utf-8' })
    const lines = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : ['']
    const callLines = existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n') : []
    return {
      code: r.status,
      last: lines[lines.length - 1].replace(/^\S+ \S+ /, ''),
      writes: callLines.filter((l) => /^(POST|PATCH) /.test(l)).length,
      allapot,
      leaked: readFileSync(log, 'utf-8').includes('TITOK-ERTEK') || r.stdout.includes('TITOK-ERTEK'),
    }
  }
  const brief = (r: ReturnType<typeof run>) => ({ code: r.code, last: r.last })
  const s12 = S.slice(0, 12)

  it('ELES-FELHOZAS-ATMEGY: every gate open: --nez says what it would deploy, writes nothing, and no env value reaches the log', () => {
    const r = run({ envPatch: '@@ -1,2 +1,3 @@\n MEDUSA_A=false\n+MEDUSA_NEW=false\n+# STRIPE_SETTLEMENT_SYNC_ENABLED=true is Balazs\'s call\n' })
    expect({ ...brief(r), writes: r.writes, leaked: r.leaked, medusa: readFileSync(join(r.allapot, 'medusa-ref.txt'), 'utf-8') }, 'ELES-FELHOZAS-ATMEGY').toEqual({
      code: 0,
      last: `--nez: itt telepitene ${s12}-t (api, web, partner)`,
      writes: 0,
      leaked: false,
      medusa: '1|2026-09-04T16:02:00.000\n',
    })
  })

  it('ELES-FELHOZAS-WEB-KAPU: the test web on another commit, or silent about it, stops; nothing to bring up exits 0', () => {
    expect({ webSilent: brief(run({ web: null })), webOther: brief(run({ web: 'c'.repeat(40) })), same: brief(run({ eles: S })) }, 'ELES-FELHOZAS-WEB-KAPU').toEqual({
      webSilent: {
        code: 1,
        last: `MEGALLT: a teszt web /health nem mondja meg a commitjat (RELEASE_COMMIT_SHA nincs a kornyezeteben), igy nem tudni, hogy a web is ${s12}-n all`,
      },
      webOther: { code: 1, last: `MEGALLT: a teszt web commitja cccccccccccc, a teszt API-e ${s12}: a ket teszt alkalmazas nem ugyanazt futtatja` },
      same: { code: 0, last: 'nincs mit felhozni (az eles = a teszt)' },
    })
  })

  it('ELES-FELHOZAS-MAIN-KAPU: a test pinned to a PR head (ahead or diverged of main) stops; the main head passes', () => {
    const msg = (st: string) => `MEGALLT: a teszt commitja ${s12} NINCS a fo agon (compare main...S = ${st}): a teszt egy PR-agra van rogzitve`
    expect(
      { prHead: brief(run({ onMain: 'ahead' })), diverged: brief(run({ onMain: 'diverged' })), mainHead: run({ onMain: 'identical' }).code, onMainBehind: run({ onMain: 'behind' }).code },
      'ELES-FELHOZAS-MAIN-KAPU',
    ).toEqual({ prHead: { code: 1, last: msg('ahead') }, diverged: { code: 1, last: msg('diverged') }, mainHead: 0, onMainBehind: 0 })
  })

  it('ELES-FELHOZAS-MIGRACIO: the gate stops an unsafe migration from the script, and a changed applied migration stops', () => {
    expect(
      { drop: brief(run({ migration: 'DROP VIEW "WorksheetLatestVersion";\n' })), changed: brief(run({ migrationStatus: 'modified' })) },
      'ELES-FELHOZAS-MIGRACIO',
    ).toEqual({
      drop: { code: 1, last: `MEGALLT: nem bovito migracio, ember nezze meg: ${MIG} :: DROP of a schema object: DROP VIEW "ID"` },
      changed: { code: 1, last: `MEGALLT: egy mar letezo migracios fajl valtozott, ember nezze meg: modified ${MIG}` },
    })
  })

  it('ELES-FELHOZAS-KAPCSOLO: a switch turned on in .env.production.example, or a new MEDUSA_/STRIPE_/WEBSHOP_ key in production, stops', () => {
    const saveKeys = run({ savedKeys: null })
    expect(
      {
        flipped: brief(run({ envPatch: '@@ -1 +1 @@\n-MEDUSA_ENSURE_BRAND_COLLECTIONS=false\n+MEDUSA_ENSURE_BRAND_COLLECTIONS=true\n' })),
        newOn: brief(run({ envPatch: '@@ -1 +1,2 @@\n A=1\n+WEBSHOP_GIFT_CARDS=on\n' })),
        alreadyOn: run({ envPatch: '@@ -1 +1 @@\n-MEDUSA_PROJECT_BARCODES=true\n+MEDUSA_PROJECT_BARCODES=true \n' }).code,
        newKey: brief(run({ envKeys: ['MEDUSA_PROJECTION_SCHEDULE_ENABLED', 'STRIPE_SETTLEMENT_SYNC_ENABLED', 'OTHER_FLAG'] })),
        removedKey: run({ envKeys: [] }).code,
        firstRun: { ...brief(saveKeys), saved: readFileSync(join(saveKeys.allapot, 'env-kulcsok.txt'), 'utf-8'), leaked: saveKeys.leaked },
      },
      'ELES-FELHOZAS-KAPCSOLO',
    ).toEqual({
      flipped: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: MEDUSA_ENSURE_BRAND_COLLECTIONS, Balazs szava kell' },
      newOn: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: WEBSHOP_GIFT_CARDS, Balazs szava kell' },
      alreadyOn: 0,
      newKey: {
        code: 1,
        last: 'MEGALLT: uj kulcs az eles API kornyezeteben: STRIPE_SETTLEMENT_SYNC_ENABLED. Ha Balazs jovahagyta, a nevet egy sorba ird a store/eles-felhozas/env-kulcsok.txt vegere',
      },
      removedKey: 0,
      firstRun: {
        code: 1,
        last: 'MEGALLT: nem volt mentett eles kulcslista; most mentve (1 kulcs: MEDUSA_PROJECTION_SCHEDULE_ENABLED), a kovetkezo futas ehhez mer',
        saved: 'MEDUSA_PROJECTION_SCHEDULE_ENABLED\n',
        leaked: false,
      },
    })
  })

  it('ELES-FELHOZAS-MEDUSA: more MEDUSA rows or a later lastSyncedAt in production stops; the same or fewer passes and is saved', () => {
    const was = '1|2026-09-04T16:02:00.000'
    const fewer = run({ medusa: '0|-' })
    const first = run({ savedMedusa: null })
    expect(
      {
        moreRows: brief(run({ medusa: '2|2026-09-04T16:02:00.000' })),
        laterSync: brief(run({ medusa: '1|2026-11-20T05:31:00.000' })),
        firstSync: run({ savedMedusa: '0|-', medusa: '0|2026-11-20T05:31:00.000' }).code,
        fewer: { code: fewer.code, saved: readFileSync(join(fewer.allapot, 'medusa-ref.txt'), 'utf-8') },
        first: { ...brief(first), saved: readFileSync(join(first.allapot, 'medusa-ref.txt'), 'utf-8') },
      },
      'ELES-FELHOZAS-MEDUSA',
    ).toEqual({
      moreRows: {
        code: 1,
        last: `MEGALLT: az eles OS vetit a Medusaba: ExternalReference MEDUSA ${was} -> 2|2026-09-04T16:02:00.000 (sorok|max lastSyncedAt). Balazs szava kell; ha jovahagyta, a store/eles-felhozas/medusa-ref.txt tartalma legyen: 2|2026-09-04T16:02:00.000`,
      },
      laterSync: {
        code: 1,
        last: `MEGALLT: az eles OS vetit a Medusaba: ExternalReference MEDUSA ${was} -> 1|2026-11-20T05:31:00.000 (sorok|max lastSyncedAt). Balazs szava kell; ha jovahagyta, a store/eles-felhozas/medusa-ref.txt tartalma legyen: 1|2026-11-20T05:31:00.000`,
      },
      firstSync: 1,
      fewer: { code: 0, saved: '0|-\n' },
      first: {
        code: 1,
        last: `MEGALLT: nem volt mentett eles Medusa-vetites allapot; most mentve (${was}: sorok|max lastSyncedAt), a kovetkezo futas ehhez mer`,
        saved: `${was}\n`,
      },
    })
  })

  it('MARVEEN-CRON-ELES-FELHOZAS: the rollout runs daily at 05:30 from marveen.cron, and calls the gate in the repo', () => {
    const live = readFileSync(join(process.cwd(), 'scripts', 'crontab', 'marveen.cron'), 'utf-8')
      .split('\n')
      .filter((l) => l.includes('eles-napi-felhozas.sh') && !l.startsWith('#'))
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(
      { live, script: existsSync(SCRIPT), callsGate: src.includes('"$HERE/lib/migracio_kapu.py"'), gate: existsSync(GATE) },
      'MARVEEN-CRON-ELES-FELHOZAS',
    ).toEqual({
      live: ['30 5 * * * /home/marveen/marveen/scripts/eles-napi-felhozas.sh >>/home/marveen/marveen/store/eles-napi-felhozas-cron.log 2>&1'],
      script: true,
      callsGate: true,
      gate: true,
    })
  })
})
