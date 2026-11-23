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
  // acrobot 57807: the CHECK replaced under the same name on a table with rows stops (it may narrow), the other four pass
  it('MIGRACIO-KAPU-MAI-OT: four of the five migrations of 2026-11-20 pass; the CHECK swap stops', () => {
    const names = readdirSync(FIXTURES).sort()
    const got = Object.fromEntries(names.map((n) => {
      const r = gate(readFileSync(join(FIXTURES, n), 'utf-8'))
      return [n, { code: r.code, rules: rules(r.out) }]
    }))
    expect(got, 'MIGRACIO-KAPU-MAI-OT').toEqual({
      '20261118230000_gls_cod_webshop_parcel.sql': { code: 0, rules: [] },
      '20261119060000_stripe_settlement.sql': { code: 0, rules: [] },
      '20261119100000_worksheet_follows_job_assignees.sql': { code: 0, rules: [] },
      '20261119150000_service_job_linked_worksheets.sql': { code: 0, rules: [] },
      '20261119160000_service_job_event_kind_linked_check.sql': { code: 1, rules: ['ADD CONSTRAINT on an existing table'] },
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
      // acrobot 57807: a CHECK replaced under the same name may narrow, and fail on the rows
      constraintSwap: 'ALTER TABLE "P"\n  DROP CONSTRAINT "P_kind_check";\nALTER TABLE "P"\n  ADD CONSTRAINT "P_kind_check" CHECK ("a" IS NOT NULL);',
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
      constraintSwap: { code: 1, rules: ['ADD CONSTRAINT on an existing table'] },
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
      // the swap passes only NOT VALID (acrobot 57807)
      constraintSwapNotValid: 'ALTER TABLE "P"\n  DROP CONSTRAINT "P_kind_check";\nALTER TABLE "P"\n  ADD CONSTRAINT "P_kind_check" CHECK ("a" IS NOT NULL) NOT VALID;',
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
  // The script runs as written, from a copy of the scripts folder whose agent-msg.sh and daily-log.sh are stand-ins
  // (a stop of a live run must not reach acrobot from a test). curl, ssh and sudo are stand-ins on PATH. curl answers
  // from a folder (host/path, the query dropped) and logs every call; a PATCH (a pin) answers {}, a POST (a deploy)
  // answers a deployment and moves the production /health to what the world says comes after it. ssh answers the
  // psql-ro line; sudo is the token broker.
  const S = 'a'.repeat(40)
  const P = 'b'.repeat(40)
  const GH = 'api.github.com/repos/KratoBal/acropora-os'
  const ENVS = '162.55.216.28:8000/api/v1/applications/t9gxx94ecwekwruxngps5i6v/envs'
  const MIG = 'packages/database/prisma/migrations/20261120000000_x/migration.sql'
  const COOLIFY = '162.55.216.28:8000/api/v1'
  const APPS = { api: 't9gxx94ecwekwruxngps5i6v', web: 'dnt6jzza68wnuamvi93whn28', partner: 'iknrqjk9xeyydc5fibrk5tbp' }
  type World = {
    web?: string | null
    eles?: string
    onMain?: string
    migration?: string
    migrationStatus?: string
    envPatch?: string
    envKeys?: string[]
    savedKeys?: string[] | null
    accepted?: string[] // the lines of kapcsolo-elfogadva.txt: NAME<TAB>the decision
    medusa?: string
    savedMedusa?: string | null
    live?: boolean // the real run: pins, deploys (into the stand-ins); default --nez
    pinRead?: { api?: string; web?: string; partner?: string } // what Coolify returns for git_commit_sha
    webAfter?: string | null // the production web's /health commit after its deploy
  }
  let n = 0
  const run = (w: World = {}) => {
    const dir = join(root, `vilag-${(n += 1)}`)
    // every answer is <host>/<path>/_body, so a path and a longer one under it (applications/<uuid>, .../envs) both fit
    const put = (rel: string, body: unknown) => {
      mkdirSync(join(dir, 'net', rel), { recursive: true })
      writeFileSync(join(dir, 'net', rel, '_body'), typeof body === 'string' ? body : JSON.stringify(body))
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
    const pinned = w.live ? S : 'HEAD'
    for (const [app, uuid] of Object.entries(APPS)) put(`${COOLIFY}/applications/${uuid}`, { uuid, git_commit_sha: w.pinRead?.[app as keyof typeof APPS] ?? pinned })
    put(`${COOLIFY}/deployments/dep-1`, { status: 'finished' })
    // after a deploy: the production API runs S, the web says what the world says
    const after = join(dir, 'after')
    mkdirSync(join(after, 'api.acropora.hu', 'health'), { recursive: true })
    mkdirSync(join(after, 'app.acropora.hu', 'health'), { recursive: true })
    writeFileSync(join(after, 'api.acropora.hu', 'health', '_body'), JSON.stringify({ application: { commit: S } }))
    writeFileSync(join(after, 'app.acropora.hu', 'health', '_body'), JSON.stringify({ application: { commit: w.webAfter === undefined ? S : w.webAfter } }))
    const allapot = join(dir, 'allapot')
    mkdirSync(allapot, { recursive: true })
    const savedKeys = w.savedKeys === undefined ? ['MEDUSA_PROJECTION_SCHEDULE_ENABLED'] : w.savedKeys
    if (savedKeys) writeFileSync(join(allapot, 'env-kulcsok.txt'), savedKeys.map((k) => `${k}\n`).join(''))
    if (w.accepted) writeFileSync(join(allapot, 'kapcsolo-elfogadva.txt'), w.accepted.map((l) => `${l}\n`).join(''))
    const savedMedusa = w.savedMedusa === undefined ? '1|2026-09-04T16:02:00.000' : w.savedMedusa
    if (savedMedusa) writeFileSync(join(allapot, 'medusa-ref.txt'), `${savedMedusa}\n`)

    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const calls = join(dir, 'calls.txt')
    // the scripts folder, copied: the script reads its gate, its token library and its host keys next to itself
    const scripts = join(dir, 'scripts')
    mkdirSync(join(scripts, 'lib'), { recursive: true })
    mkdirSync(join(scripts, 'host'), { recursive: true })
    for (const f of ['eles-napi-felhozas.sh', 'lib/migracio_kapu.py', 'lib/github-token.sh', 'host/known_hosts'])
      writeFileSync(join(scripts, f), readFileSync(join(process.cwd(), 'scripts', f)))
    for (const f of ['agent-msg.sh', 'daily-log.sh']) writeFileSync(join(scripts, f), `echo "${f} $*" >> '${calls}'\n`)
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
m=GET; u=
while [ $# -gt 0 ]; do case "$1" in -X) m=$2; shift 2;; -H|-d|--max-time) shift 2;; http*) u=$1; shift;; *) shift;; esac; done
echo "$m $u" >> '${calls}'
case "$m" in
  PATCH) echo '{}'; exit 0;;
  POST) cp -r '${after}/.' '${join(dir, 'net')}/'; echo '{"deployments":[{"deployment_uuid":"dep-1"}]}'; exit 0;;
esac
f='${join(dir, 'net')}/'$(printf '%s' "\${u#*://}" | sed 's/?.*//')
[ -f "$f/_body" ] && cat "$f/_body"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\ncat > /dev/null\necho "ssh $*" >> '${calls}'\necho 'medusa_ref|${w.medusa ?? '1|2026-09-04T16:02:00.000'}'\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash\necho fake-gh-token\n`, { mode: 0o755 })
    const log = join(dir, 'log.txt')
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELES_FELHOZAS_LOG: log, ELES_FELHOZAS_ALLAPOT: allapot }
    delete env.FLEET_GITHUB_APP
    const r = spawnSync('bash', [join(scripts, 'eles-napi-felhozas.sh'), ...(w.live ? [] : ['--nez'])], { env, encoding: 'utf-8' })
    const lines = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : ['']
    const callLines = existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n') : []
    return {
      code: r.status,
      last: lines[lines.length - 1].replace(/^\S+ \S+ /, ''),
      writes: callLines.filter((l) => /^(POST|PATCH) /.test(l)).length,
      calls: callLines.map((l) => l.replace(/^(\w+) https?:\/\/[^/]+\/api\/v1\//, '$1 ').replace(/^(\w+) https?:\/\//, '$1 ')),
      allapot,
      leaked: readFileSync(log, 'utf-8').includes('TITOK-ERTEK') || r.stdout.includes('TITOK-ERTEK'),
      log: existsSync(log) ? readFileSync(log, 'utf-8') : '',
    }
  }
  const brief = (r: ReturnType<typeof run>) => ({ code: r.code, last: r.last })
  const s12 = S.slice(0, 12)

  it('ELES-FELHOZAS-ATMEGY: every gate open: --nez says what it would deploy, writes nothing, and no env value reaches the log', () => {
    const r = run({ envPatch: '@@ -1,2 +1,3 @@\n MEDUSA_A=false\n+MEDUSA_NEW=false\n+# STRIPE_SETTLEMENT_SYNC_ENABLED=true is Balazs\'s call\n' })
    expect({ ...brief(r), writes: r.writes, leaked: r.leaked, medusa: readFileSync(join(r.allapot, 'medusa-ref.txt'), 'utf-8') }, 'ELES-FELHOZAS-ATMEGY').toEqual({
      code: 0,
      last: `--nez: itt telepitene ${s12}-t (api, web, partner); a rogzites most: api=HEAD web=HEAD partner=HEAD`,
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

  // A SWITCH BALAZS ALREADY TURNED ON is named in store/eles-felhozas/kapcsolo-elfogadva.txt (NAME, a tab, the decision): it no longer
  // stops the rollout, it is logged with its decision (the live script's branch, brought to main; acrobot 59592). WHAT TURNS IT RED:
  // a listed switch still stopping; an unlisted one beside it passing; a name that only starts the same accepted.
  it('ELES-FELHOZAS-KAPCSOLO-ELFOGADVA: an accepted switch passes and is logged; an unlisted one still stops, a prefix is not a match', () => {
    const flip = (name: string) => `@@ -1 +1 @@\n-${name}=false\n+${name}=true\n`
    const accepted = run({ envPatch: flip('GLS_STATUS_SYNC_ENABLED'), accepted: ['GLS_STATUS_SYNC_ENABLED\tBalazs 2026-11-20, Eldontendo 1573'] })
    const two = run({
      envPatch: '@@ -1,2 +1,2 @@\n-GLS_STATUS_SYNC_ENABLED=0\n-WEBSHOP_GIFT_CARDS=0\n+GLS_STATUS_SYNC_ENABLED=1\n+WEBSHOP_GIFT_CARDS=1\n',
      accepted: ['GLS_STATUS_SYNC_ENABLED\tBalazs 2026-11-20'],
    })
    // a LONGER listed name that starts with the switch's name is another switch, not this one
    const prefix = run({ envPatch: flip('GLS_STATUS_SYNC_ENABLED'), accepted: ['GLS_STATUS_SYNC_ENABLED_V2\tegy masik kapcsolo'] })
    expect(
      {
        acceptedCode: accepted.code,
        acceptedLogged: accepted.log.includes('kapcsolo elfogadva: GLS_STATUS_SYNC_ENABLED (Balazs 2026-11-20, Eldontendo 1573)'),
        two: brief(two),
        prefix: brief(prefix).code,
      },
      'ELES-FELHOZAS-KAPCSOLO-ELFOGADVA',
    ).toEqual({
      acceptedCode: 0,
      acceptedLogged: true,
      two: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: WEBSHOP_GIFT_CARDS, Balazs szava kell (elfogadas: a nev es a dontes sora a store/eles-felhozas/kapcsolo-elfogadva.txt fajlba)' },
      prefix: 1,
    })
  })

  it('ELES-FELHOZAS-KAPCSOLO: a switch turned on in .env.production.example, or a new MEDUSA_/STRIPE_/WEBSHOP_ key in production, stops', () => {
    const saveKeys = run({ savedKeys: null })
    expect(
      {
        flipped: brief(run({ envPatch: '@@ -1 +1 @@\n-MEDUSA_ENSURE_BRAND_COLLECTIONS=false\n+MEDUSA_ENSURE_BRAND_COLLECTIONS=true\n' })),
        newOn: brief(run({ envPatch: '@@ -1 +1,2 @@\n A=1\n+WEBSHOP_GIFT_CARDS=on\n' })),
        oneOn: brief(run({ envPatch: '@@ -1 +1 @@\n-GLS_STATUS_SYNC_ENABLED=0\n+GLS_STATUS_SYNC_ENABLED=1\n' })),
        keyVersion: run({ envPatch: '@@ -1 +1,2 @@\n A=1\n+STRIPE_CREDENTIAL_ACTIVE_KEY_VERSION=1\n' }).code,
        alreadyOn: run({ envPatch: '@@ -1 +1 @@\n-MEDUSA_PROJECT_BARCODES=true\n+MEDUSA_PROJECT_BARCODES=true \n' }).code,
        newKey: brief(run({ envKeys: ['MEDUSA_PROJECTION_SCHEDULE_ENABLED', 'STRIPE_SETTLEMENT_SYNC_ENABLED', 'OTHER_FLAG'] })),
        removedKey: run({ envKeys: [] }).code,
        firstRun: { ...brief(saveKeys), saved: readFileSync(join(saveKeys.allapot, 'env-kulcsok.txt'), 'utf-8'), leaked: saveKeys.leaked },
      },
      'ELES-FELHOZAS-KAPCSOLO',
    ).toEqual({
      flipped: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: MEDUSA_ENSURE_BRAND_COLLECTIONS, Balazs szava kell (elfogadas: a nev es a dontes sora a store/eles-felhozas/kapcsolo-elfogadva.txt fajlba)' },
      newOn: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: WEBSHOP_GIFT_CARDS, Balazs szava kell (elfogadas: a nev es a dontes sora a store/eles-felhozas/kapcsolo-elfogadva.txt fajlba)' },
      oneOn: { code: 1, last: 'MEGALLT: a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: GLS_STATUS_SYNC_ENABLED, Balazs szava kell (elfogadas: a nev es a dontes sora a store/eles-felhozas/kapcsolo-elfogadva.txt fajlba)' },
      keyVersion: 0,
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

  it('ELES-FELHOZAS-ROGZITES: a pin that did not take stops before any deploy and unpins; --nez stops if the pin cannot be read', () => {
    const pins = ['api', 'web', 'partner'].map((a) => `PATCH applications/${APPS[a as keyof typeof APPS]}`)
    const webHead = run({ live: true, pinRead: { web: 'HEAD' } })
    const unreadable = run({ live: true, pinRead: { partner: '' } })
    expect(
      {
        webHead: { ...brief(webHead), deploys: webHead.calls.filter((c) => c.startsWith('POST')).length, patches: webHead.calls.filter((c) => c.startsWith('PATCH')) },
        unreadable: { ...brief(unreadable), deploys: unreadable.calls.filter((c) => c.startsWith('POST')).length },
        told: webHead.calls.filter((c) => /^(agent-msg|daily-log)\.sh/.test(c)).length,
        nezUnreadable: brief(run({ pinRead: { api: '' } })),
      },
      'ELES-FELHOZAS-ROGZITES',
    ).toEqual({
      webHead: {
        code: 1,
        last: `MEGALLT: a(z) web rogzitese nem sikerult (git_commit_sha=HEAD, nem ${s12}); semmi nem telepult`,
        deploys: 0,
        // three pins to S, then three unpins to HEAD
        patches: [...pins, ...pins],
      },
      unreadable: { code: 1, last: `MEGALLT: a(z) partner rogzitese nem sikerult (git_commit_sha=olvashatatlan, nem ${s12}); semmi nem telepult`, deploys: 0 },
      told: 2,
      nezUnreadable: { code: 1, last: 'MEGALLT: a Coolify nem adja vissza a(z) api git_commit_sha mezojet: a rogzites nem volna ellenorizheto' },
    })
  })

  it('ELES-FELHOZAS-TELEPIT: pinned and read back: api, then web, then partner; a web that names another commit, or none, stops before the partner', () => {
    const ok = run({ live: true })
    const webOther = run({ live: true, webAfter: 'c'.repeat(40) })
    const webSilent = run({ live: true, webAfter: null })
    const deploys = (r: ReturnType<typeof run>) => r.calls.filter((c) => c.startsWith('POST')).map((c) => c.replace(/^POST deploy\?uuid=/, ''))
    expect(
      {
        ok: { ...brief(ok), deploys: deploys(ok), unpinned: ok.calls.filter((c) => c.startsWith('PATCH')).length },
        webOther: { ...brief(webOther), deploys: deploys(webOther) },
        webSilent: { ...brief(webSilent), deploys: deploys(webSilent) },
      },
      'ELES-FELHOZAS-TELEPIT',
    ).toEqual({
      ok: { code: 0, last: `KESZ: az eles OS ${P.slice(0, 12)} -> ${s12} (3 commit, 1 migracio)`, deploys: [APPS.api, APPS.web, APPS.partner], unpinned: 6 },
      webOther: {
        code: 1,
        last: `MEGALLT: a web telepites utan az eles web /health commit cccccccccccccccccccccccccccccccccccccccc, nem ${s12} (az API mar ${s12}, a partner nem telepult)`,
        deploys: [APPS.api, APPS.web],
      },
      webSilent: {
        code: 1,
        last: `MEGALLT: a web telepites utan az eles web /health commit ures, nem ${s12} (az API mar ${s12}, a partner nem telepult)`,
        deploys: [APPS.api, APPS.web],
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
