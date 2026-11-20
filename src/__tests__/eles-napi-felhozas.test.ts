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
    }
    const got = Object.fromEntries(Object.entries(cases).map(([k, sql]) => {
      const r = gate(sql)
      return [k, { code: r.code, rules: rules(r.out) }]
    }))
    expect(got, 'MIGRACIO-KAPU-MEGALL').toEqual({
      dropColumn: { code: 1, rules: ['DROP TABLE/COLUMN/TYPE/SCHEMA'] },
      dropColumnNoKeyword: { code: 1, rules: ['DROP column (no COLUMN keyword)'] },
      dropTable: { code: 1, rules: ['DROP TABLE/COLUMN/TYPE/SCHEMA'] },
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
    })
  })

  it('MIGRACIO-KAPU-KOZELI-ATMEGY: the nearest additive look-alikes pass', () => {
    const cases: Record<string, string> = {
      keywordInIdentifier: 'CREATE TABLE "P" ("ordersTruncated" BOOLEAN NOT NULL DEFAULT false, "renamedAt" TIMESTAMP(3));',
      keywordInComment: '-- RENAMED on the way in; DROP COLUMN later\n/* UPDATE "P" */\nCOMMENT ON COLUMN "P"."a" IS \'DROP TABLE, RENAME\';',
      onUpdateCascade: 'ALTER TABLE "L" ADD CONSTRAINT "L_p_fkey" FOREIGN KEY ("p") REFERENCES "P"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      loosen: 'ALTER TABLE "P" ALTER COLUMN "a" DROP NOT NULL, ALTER COLUMN "b" DROP DEFAULT;',
      addNotNullWithDefault: 'ALTER TABLE "P" ADD COLUMN "c" INTEGER NOT NULL DEFAULT 0;',
      dropPlainIndex: 'DROP INDEX "P_a_idx";',
      constraintSwap: 'ALTER TABLE "P"\n  DROP CONSTRAINT "P_kind_check";\nALTER TABLE "P"\n  ADD CONSTRAINT "P_kind_check" CHECK ("a" IS NOT NULL);',
      enumAddValue: 'ALTER TYPE "Kind" ADD VALUE \'NEW\';',
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
  // curl reads file:// the same way, so /health is a file here and no server or network is involved
  const health = (dir: string, commit: string | null) => {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'health'), JSON.stringify({ application: { status: 'ok', commit } }))
    return `file://${join(root, dir)}`
  }
  const S = 'a'.repeat(40)
  const P = 'b'.repeat(40)
  const run = (web: string | null, eles = P) => {
    const log = join(root, `log-${Math.random().toString(36).slice(2)}.txt`)
    const env = {
      ...process.env,
      ELES_FELHOZAS_TESZT_API: health('tapi', S),
      ELES_FELHOZAS_TESZT_WEB: health(`tweb-${web}`, web),
      ELES_FELHOZAS_ELES_API: health(`eapi-${eles}`, eles),
      ELES_FELHOZAS_LOG: log,
    }
    // --nez: a stop is logged only, nothing is sent; and it never deploys
    const r = spawnSync('bash', [SCRIPT, '--nez'], { env, encoding: 'utf-8' })
    return { code: r.status, last: readFileSync(log, 'utf-8').trim().split('\n').pop()!.replace(/^\S+ \S+ /, '') }
  }

  it('ELES-FELHOZAS-WEB-KAPU: the test web on another commit, or silent about it, stops; nothing to bring up exits 0', () => {
    expect(
      { webSilent: run(null), webOther: run('c'.repeat(40)), same: run(null, S) },
      'ELES-FELHOZAS-WEB-KAPU',
    ).toEqual({
      webSilent: {
        code: 1,
        last: `MEGALLT: a teszt web /health nem mondja meg a commitjat (RELEASE_COMMIT_SHA nincs a kornyezeteben), igy nem tudni, hogy a web is ${S.slice(0, 12)}-n all`,
      },
      webOther: { code: 1, last: `MEGALLT: a teszt web commitja cccccccccccc, a teszt API-e ${S.slice(0, 12)}: a ket teszt alkalmazas nem ugyanazt futtatja` },
      same: { code: 0, last: 'nincs mit felhozni (az eles = a teszt)' },
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
