// scripts/host/fleet-gate.sh (security register B8), run for real in bash with
// stub binaries in place of docker, df, uptime, apt-check and logger. WHAT
// TURNS THIS RED:
//   - a listed operation does not run, or runs with other arguments than the
//     fixed ones (a psql-ro without the read-only PGOPTIONS, a dump of another
//     database);
//   - anything else gets through: a shell, `docker run`, `docker exec ... sh`,
//     a `;`, `$(...)`, a backtick, `&&`, a pipe, an unlisted container or
//     database, an operation of the other host, extra arguments, a backslash
//     in psql-ro's SQL, an unknown host;
//   - a refused command reaches docker at all, or leaves no log line;
//   - env-get shows a variable other than its two, or a value of another;
//   - backup-put overwrites, or writes outside tavoli/; backup-get reads
//     outside the listed backups;
//   - a caller script (the ones the fleet runs over the key) still sends a raw
//     docker or df command, or sends one the gate would refuse on its host.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const GATE = join(process.cwd(), 'scripts', 'host', 'fleet-gate.sh')
const root = mkdtempSync(join(tmpdir(), 'fleet-gate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const PROD = 'acropora-prod-01'
const STAGE = 'acropora-ai-stage-01'
const OS_DB = 'iwm34jaqp9xmwb72qkrqkwhy'
const AI_DB = 'cpnjvtte02yakzs9vb0jffky'
const API = 't9gxx94ecwekwruxngps5i6v'

/** One case's world: stubs that log every call, a backup root, a document store. */
function world(host: string) {
  const dir = mkdtempSync(join(root, 'w-'))
  const log = join(dir, 'calls.log')
  const sql = join(dir, 'sql.txt')
  const store = join(dir, 'store')
  mkdirSync(join(store, 'document-store', 'a'), { recursive: true })
  writeFileSync(join(store, 'document-store', 'a', '1.pdf'), 'x')
  writeFileSync(join(store, 'document-store', '2.pdf'), 'y')
  const stub = (name: string, body: string) => {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/bash\nprintf '%s' "${name}" >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }
  const docker = stub(
    'docker',
    `case "$*" in
  "ps --format {{.Names}}") printf '%s\\n' ${OS_DB}-163020 ${AI_DB}-091011 ${API}-120000 coolify-db xdfswedgxuehokvymhjotpfs-1 ;;
  "ps -a --format {{.Names}}") printf '%s\\n' restore-proba-ai-old coolify-db ;;
  "ps --format {{.Names}}|{{.Image}}|{{.Status}}") echo "${OS_DB}-163020|img|Up" ;;
  *" pg_dump "*) printf 'DUMPDATA' ;;
  *" pg_restore --list"|*" pg_restore -l") cat > /dev/null; printf '1; a\\n2; b\\n3; c\\n' ;;
  *" pg_restore --no-owner "*) cat > /dev/null ;;
  *" tar -C /data -cf - document-store") tar -C "${store}" -cf - document-store ;;
  *" find /data/document-store -type f") find "${store}/document-store" -type f ;;
  "exec ${API}-120000 env") printf '%s\\n' MEDUSA_ADMIN_URL=https://admin.example SECRET_KEY=titkos-ertek MEDUSA_PROJECTION_SCHEDULE_ENABLED=true ;;
  *" psql -X -q "*) cat > "${sql}"; echo sor ;;
  *" pg_isready "*) exit 0 ;;
  *" -Atc "*) echo "conversations=1 messages=2 answer_ratings=3" ;;
  "run -d "*|"rm -f "*|"system df"*|"builder prune -f"|"image prune -a -f --filter until=2h") echo ok ;;
  *) echo "UNEXPECTED" >&2; exit 99 ;;
esac`,
  )
  const env = join(dir, 'test.env')
  writeFileSync(
    env,
    [
      `HOST=${host}`,
      `DOCKER=${docker}`,
      `DF=${stub('df', 'echo df-out')}`,
      `UPTIME=${stub('uptime', 'echo up')}`,
      `APT_CHECK=${stub('apt-check', 'echo "0 updates"')}`,
      `LOGGER=${stub('logger', ':')}`,
      `REBOOT_FILE=${join(dir, 'reboot-required')}`,
      `BACKUP_ROOT=${join(dir, 'backups')}`,
    ].join('\n') + '\n',
  )
  const run = (command: string | undefined, input = '') => {
    const r = spawnSync('bash', [GATE, '--test-env', env], {
      env: command === undefined ? { PATH: process.env.PATH } : { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command },
      // the output is read as latin1, so binary input goes back byte for byte
      input: Buffer.from(input, 'latin1'),
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []
    writeFileSync(log, '')
    return { code: r.status, out: r.stdout.toString('latin1'), err: r.stderr.toString(), calls }
  }
  return { dir, run, sql, backups: join(dir, 'backups') }
}

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex')
const ZEROS = '0'.repeat(64)

const today = () => {
  const r = spawnSync('date', ['+%F'], { encoding: 'utf-8' })
  return r.stdout.trim()
}

describe('fleet-gate: what passes', () => {
  it('GATE-ALLOW: every listed operation runs with its fixed arguments, and only those', () => {
    const p = world(PROD)
    const s = world(STAGE)
    const docker = (calls: string[]) => calls.filter((c) => c.startsWith('docker'))
    const cases: Array<[ReturnType<typeof world>, string, string]> = [
      [p, 'ps', 'docker [ps] [--format] [{{.Names}}|{{.Image}}|{{.Status}}]'],
      [p, 'system-df', 'docker [system] [df]'],
      [p, 'system-df --format', 'docker [system] [df] [--format] [{{.Type}}|{{.Size}}|{{.Reclaimable}}]'],
      [p, 'builder-prune', 'docker [builder] [prune] [-f]'],
      [s, 'image-prune-2h', 'docker [image] [prune] [-a] [-f] [--filter] [until=2h]'],
      [p, `pg-dump ${OS_DB} acropora acropora`, `docker [exec] [${OS_DB}-163020] [pg_dump] [-Fc] [-U] [acropora] [-d] [acropora]`],
      [p, `pg-dump xdfswedgxuehokvymhjotpfs medusa postgres`, `docker [exec] [xdfswedgxuehokvymhjotpfs-1] [pg_dump] [-Fc] [-U] [postgres] [-d] [medusa]`],
      [s, `pg-restore-list ${AI_DB}`, `docker [exec] [-i] [${AI_DB}-091011] [pg_restore] [-l]`],
      [p, 'docstore-tar', `docker [exec] [${API}-120000] [tar] [-C] [/data] [-cf] [-] [document-store]`],
    ]
    const wrong: string[] = []
    for (const [w, command, expected] of cases) {
      const r = w.run(command)
      const last = docker(r.calls).at(-1)
      if (r.code !== 0 || last !== expected) wrong.push(`${command}: code ${r.code}, ${last}`)
    }
    const df = p.run('df')
    const dfp = p.run('df -P')
    const up = p.run('uptime')
    const apt = p.run('apt-check')
    expect(
      [wrong, df.calls, dfp.calls.at(-1), up.out.trim(), apt.calls.at(-1)],
      'GATE-ALLOW',
    ).toEqual([
      [],
      [expect.stringContaining('allow host=acropora-prod-01 op=df'), 'df [-h] [/] [/var/lib/docker]'],
      'df [-P] [/] [/var/lib/docker]',
      'up',
      'apt-check [--human-readable]',
    ])
  })

  it('GATE-PSQL-RO: SQL on stdin, the read-only default set, the format from a fixed list', () => {
    const p = world(PROD)
    const s = world(STAGE)
    const plain = p.run(`psql-ro ${OS_DB} acropora acropora`, 'select 1;')
    const sentSql = readFileSync(p.sql, 'utf-8')
    const spaced = p.run(`psql-ro ${OS_DB} acropora acropora tuples-spaced-pipe`, 'select 1;')
    const call = (r: { calls: string[] }) => r.calls.find((c) => c.startsWith('docker [exec]'))
    expect([plain.code, plain.out.trim(), sentSql, call(plain), call(spaced), s.run('psql-ro coolify-db coolify coolify tuples', 'select 1;').code], 'GATE-PSQL-RO').toEqual([
      0,
      'sor',
      'select 1;\n',
      `docker [exec] [-i] [-e] [PGOPTIONS=-c default_transaction_read_only=on] [${OS_DB}-163020] [psql] [-X] [-q] [-v] [ON_ERROR_STOP=1] [-U] [acropora] [-d] [acropora]`,
      `docker [exec] [-i] [-e] [PGOPTIONS=-c default_transaction_read_only=on] [${OS_DB}-163020] [psql] [-X] [-q] [-v] [ON_ERROR_STOP=1] [-U] [acropora] [-d] [acropora] [-tA] [-F] [ | ]`,
      2, // the Coolify database is not a psql-ro target: writing it is root on the host
    ])
  })

  it('GATE-COOLIFY: the two Coolify reads are named, their SQL is the gate\'s, and the uuid is the only argument', () => {
    const s = world(STAGE)
    const uuid = '6sbolw7oedo5sdffhpswdoyt'
    const list = s.run(`coolify-deployments ${uuid}`)
    const log = s.run(`coolify-deploy-log ${uuid}`)
    const call = (r: { calls: string[] }) => r.calls.find((c) => c.startsWith('docker [exec]'))
    const refused = ['coolify-deployments abc', `coolify-deployments ${uuid.toUpperCase()}`, `coolify-deploy-log ${uuid} x`].map((c) => s.run(c).code)
    expect(
      [
        list.code,
        call(list)?.includes(`[-e] [PGOPTIONS=-c default_transaction_read_only=on] [coolify-db] [psql]`),
        call(list)?.includes(`where uuid='${uuid}')`),
        call(log)?.endsWith(`[select logs from application_deployment_queues where deployment_uuid='${uuid}']`),
        refused,
        world(PROD).run(`coolify-deployments ${uuid}`).code,
      ],
      'GATE-COOLIFY',
    ).toEqual([0, true, true, true, [2, 2, 2], 2])
  })

  it('GATE-ENV-GET: only the two named variables of the api container, values of nothing else', () => {
    const r = world(PROD).run('env-get')
    expect([r.code, r.out.trim().split('\n'), r.out.includes('titkos')], 'GATE-ENV-GET').toEqual([
      0,
      ['MEDUSA_ADMIN_URL=https://admin.example', 'MEDUSA_PROJECTION_SCHEDULE_ENABLED=true'],
      false,
    ])
  })

  it('GATE-REBOOT-AND-COUNT: reboot-required reads the file; docstore-count counts files without a shell in the container', () => {
    const w = world(PROD)
    const no = w.run('reboot-required')
    writeFileSync(join(w.dir, 'reboot-required'), '*** System restart required ***\n')
    writeFileSync(join(w.dir, 'reboot-required.pkgs'), 'linux-image\n')
    const yes = w.run('reboot-required')
    const count = w.run('docstore-count')
    expect([no.out, yes.out, count.out.trim(), count.calls.some((c) => c.includes('[sh]'))], 'GATE-REBOOT-AND-COUNT').toEqual([
      'NEM\n', 'IGEN\nlinux-image\n', '2', false,
    ])
  })

  it('GATE-RESTORE-PROBE: on the stage host a throwaway container takes the dump, answers the fixed count and is removed', () => {
    const r = world(STAGE).run('restore-probe', 'DUMP')
    const steps = r.calls.filter((c) => c.startsWith('docker')).map((c) => c.split(' ').slice(1, 3).join(' '))
    const run = r.calls.find((c) => c.startsWith('docker [run]')) ?? ''
    expect(
      [r.code, r.out.trim(), steps[0], steps.includes('[rm] [-f]'), steps.at(-1), ['[--network] [none]', '[--memory] [1g]', '[--cpus] [1]', '[--pull] [never]'].map((o) => run.includes(o))],
      'GATE-RESTORE-PROBE',
    ).toEqual([0, 'conversations=1 messages=2 answer_ratings=3', '[ps] [-a]', true, '[rm] [-f]', [true, true, true, true]])
  })

  it('GATE-BACKUP: backup-db and backup-docstore write and verify; get hands out a listed backup; put stores once, under tavoli/', () => {
    const p = world(PROD)
    const s = world(STAGE)
    const day = today()
    const db = p.run(`backup-db ${OS_DB} acropora acropora`)
    const docs = p.run('backup-docstore')
    const got = p.run(`backup-get dump acropora ${day}`)
    const sum = p.run(`backup-sum dump acropora ${day}`)
    const [hash, bytes] = sum.out.trim().split(' ')
    const put = s.run(`backup-put dump acropora ${day} ${hash}`, got.out)
    const again = s.run(`backup-put dump acropora ${day} ${sha('MASIK')}`, 'MASIK')
    const stored = readFileSync(join(s.backups, 'tavoli', 'acropora', `${day}.dump`), 'utf-8')
    const docsGot = p.run(`backup-get docstore ${day}`)
    const docsPut = s.run(`backup-put docstore ${day} ${sha(docsGot.out)}`, docsGot.out)
    const old = s.run(`backup-put dump acropora 2026-01-01 ${sha('x')}`, 'x') // only today or yesterday
    const leftovers = spawnSync('find', [s.backups, '-name', '*.part*'], { encoding: 'utf-8' }).stdout.trim()
    expect(
      [db.code, db.out.trim(), docs.code, docs.out.trim().split(' ').slice(2), got.out, [hash, bytes], put.code, again.code, stored, docsPut.code, old.code, leftovers],
      'GATE-BACKUP',
    ).toEqual([0, 'acropora 8 3', 0, ['2', '2'], 'DUMPDATA', [sha('DUMPDATA'), '8'], 0, 2, 'DUMPDATA', 0, 2, ''])
  })

  it('GATE-BACKUP-INTACT: a copy whose sha256 is not the source\'s (cut off halfway, or another file) is thrown away, and the right one can still come', () => {
    const s = world(STAGE)
    const day = today()
    const full = 'TELJES-MENTES-TARTALMA'
    const cut = s.run(`backup-put dump acropora ${day} ${sha(full)}`, full.slice(0, 7)) // the get died halfway
    const target = join(s.backups, 'tavoli', 'acropora', `${day}.dump`)
    const afterCut = existsSync(target)
    const right = s.run(`backup-put dump acropora ${day} ${sha(full)}`, full)
    const leftovers = spawnSync('find', [s.backups, '-name', '*.part*'], { encoding: 'utf-8' }).stdout.trim()
    expect([cut.code, cut.err.includes('csonka'), afterCut, right.code, readFileSync(target, 'utf-8'), leftovers], 'GATE-BACKUP-INTACT').toEqual([
      1, true, false, 0, full, '',
    ])
  })

  it('GATE-BACKUP-SPACE: a put is refused when the disk would keep less than twice the size limit free', () => {
    const s = world(STAGE)
    writeFileSync(join(s.dir, 'test.env'), readFileSync(join(s.dir, 'test.env'), 'utf-8') + 'BACKUP_MAX_BYTES=$((1024 * 1024 * 1024 * 1024 * 1024))\n')
    expect(s.run(`backup-put dump acropora ${today()} ${sha('x')}`, 'x').code, 'GATE-BACKUP-SPACE').toBe(2)
  })

  it('GATE-BACKUP-PRUNE: dumps older than 14 days and document archives older than 7 go, the rest stays', () => {
    const w = world(PROD)
    const old = (rel: string, days: number) => {
      const file = join(w.backups, rel)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'x')
      spawnSync('touch', ['-d', `${days} days ago`, file])
      return file
    }
    const files = [
      old('acropora/2026-09-01.dump', 20),
      old('acropora/2026-10-05.dump', 7),
      old('dokumentumok/2026-10-01.tar.gz', 10),
      old('dokumentumok/2026-10-08.tar.gz', 3),
      old('tavoli/acropora_ai/2026-09-02.dump', 20),
    ]
    const r = w.run('backup-prune')
    expect([r.code, files.map(existsSync)], 'GATE-BACKUP-PRUNE').toEqual([0, [false, true, false, true, false]])
  })
})

describe('fleet-gate: what does not pass', () => {
  it('GATE-DENY: shells, docker itself, metacharacters, other targets, the other host\'s operations and extra arguments are refused before docker is called', () => {
    const p = world(PROD)
    const s = world(STAGE)
    const refused: Array<[ReturnType<typeof world>, string | undefined, string?]> = [
      [p, undefined],
      [p, ''],
      [p, 'docker info'],
      [p, 'docker run -v /:/host alpine sh'],
      [p, 'bash'],
      [p, 'sh -c id'],
      [p, `docker exec ${OS_DB} sh`],
      [p, 'ps; id'],
      [p, 'ps $(id)'],
      [p, 'ps `id`'],
      [p, 'ps && id'],
      [p, 'ps | sh'],
      [p, 'ps > /tmp/x'],
      [p, 'ps\nbash'], // read takes only the first line: the filter is what refuses the rest
      [p, 'ps\tid'],
      [p, 'ps -a'],
      [p, 'system-df -v'],
      [p, 'df /etc'],
      [p, `psql-ro ${OS_DB} postgres postgres`, 'select 1;'],
      [p, 'psql-ro idegen-kontener acropora acropora', 'select 1;'],
      [p, `psql-ro ${OS_DB} acropora acropora html`, 'select 1;'],
      [p, `psql-ro ${OS_DB} acropora acropora`, '\\! id'],
      [p, `psql-ro ${OS_DB} acropora acropora`, 'select 1 \\g /tmp/x'],
      [p, `pg-dump ${OS_DB} acropora postgres`],
      [p, `pg-dump ${AI_DB} acropora_ai acropora_ai`], // the AI database is the other host's
      [p, 'image-prune-2h'], // stage only
      [p, 'restore-probe'], // stage only
      [s, 'env-get'], // prod only
      [s, 'docstore-tar'],
      [p, 'backup-get dump acropora ../../etc/passwd'],
      [p, 'backup-get dump nincs 2026-10-12'],
      [p, `backup-put dump acropora 2026-10-12 ${ZEROS}`, 'x'], // prod receives only the AI dump
      [p, `backup-put dump acropora_ai nem-datum ${ZEROS}`, 'x'], // the name is the date, and only a date
      [s, `backup-put dump acropora ${today()}`, 'x'], // no expected sha256
      [s, `backup-put dump acropora ${today()} ${'A'.repeat(64)}`, 'x'], // not lower-case hex
      [s, `backup-put dump acropora ${today()} abc`, 'x'], // not 64 long
      [s, `backup-sum dump acropora ${today()}`], // stage hands out only the AI dump
      [p, 'env-names x'],
      [s, 'psql-ro coolify-db coolify coolify', 'select 1;'],
      [p, 'x'.repeat(201)],
    ]
    const wrong: string[] = []
    for (const [w, command, input] of refused) {
      const r = w.run(command, input ?? '')
      const dockerCalls = r.calls.filter((c) => c.startsWith('docker') && !c.startsWith('docker [ps] [--format] [{{.Names}}]'))
      const logged = r.calls.some((c) => c.startsWith('logger') && c.includes('deny'))
      if (r.code !== 2 || dockerCalls.length > 0 || !logged || !r.err.includes('elutasítva'))
        wrong.push(`${String(command).slice(0, 40)}: code ${r.code}, docker ${dockerCalls.length}, logged ${logged}`)
    }
    expect(wrong, 'GATE-DENY').toEqual([])
  })

  it('GATE-OVERRIDE-TEST-ONLY: a host table function from the environment is ignored without --test-env', () => {
    const r = spawnSync('bash', [GATE], {
      env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: 'uptime', 'BASH_FUNC_host_config_override%%': '() { OPS="uptime"; }' },
    })
    expect(r.status, 'GATE-OVERRIDE-TEST-ONLY').toBe(2)
  })

  it('GATE-UNKNOWN-HOST: on a host the gate does not know, nothing passes', () => {
    const w = world('valami-mas-gep')
    expect([w.run('ps').code, w.run('uptime').code], 'GATE-UNKNOWN-HOST').toEqual([2, 2])
  })
})

describe('fleet-gate: the callers', () => {
  const callers = [
    'scripts/eles-verziok.sh',
    'scripts/jev/build_known.py',
    'scripts/kirakat-telepites.sh',
    'scripts/lemez-allapot.sh',
    'scripts/precheck/stage-gyorsitotar.sh',
    'scripts/szamla-dupla-ellenorzo.sh',
    'scripts/ai-db-nas-mentes.sh',
    'scripts/visszaallitasi-proba.sh',
  ]
  const text = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8')

  it('GATE-CALLERS-NO-RAW: no caller sends docker or df itself any more (comments aside)', () => {
    const raw = callers.flatMap((file) =>
      text(file)
        .split('\n')
        .map((line, i) => [i + 1, line.split(' #')[0]!] as const)
        .filter(([, code]) => !/^\s*#/.test(code) && !/^\s*echo /.test(code) && /docker (exec|ps|system|run|builder|image)|["'](df) -/.test(code))
        .map(([n, code]) => `${file}:${n}: ${code.trim()}`),
    )
    expect(raw, 'GATE-CALLERS-NO-RAW').toEqual([])
  })

  it('GATE-CALLERS-PASS: every command a caller sends passes the gate on the host it goes to', () => {
    // [the caller, the host, the command it sends, text the caller must hold for it]
    const sent: Array<[string, string, string, string]> = [
      ['scripts/eles-verziok.sh', PROD, 'ps', '  ps 2>&1'],
      ['scripts/jev/build_known.py', PROD, `psql-ro ${OS_DB} acropora acropora tuples-pipe`, '"psql-ro", CONTAINER, "acropora", "acropora", "tuples-pipe"'],
      ['scripts/kirakat-telepites.sh', STAGE, 'coolify-deployments 6sbolw7oedo5sdffhpswdoyt', 'coolify-deployments "$UUID_APP"'],
      ['scripts/kirakat-telepites.sh', STAGE, 'coolify-deploy-log 6sbolw7oedo5sdffhpswdoyt', 'coolify-deploy-log "$2"'],
      ['scripts/lemez-allapot.sh', PROD, 'df', 'prod df'],
      ['scripts/lemez-allapot.sh', PROD, 'system-df', 'prod system-df'],
      ['scripts/lemez-allapot.sh', STAGE, 'df', 'stage df'],
      ['scripts/lemez-allapot.sh', STAGE, 'system-df', 'stage system-df'],
      ['scripts/lemez-allapot.sh', STAGE, 'builder-prune', 'builder-prune'],
      ['scripts/precheck/stage-gyorsitotar.sh', STAGE, 'df -P', 'gate df -P'],
      ['scripts/precheck/stage-gyorsitotar.sh', STAGE, 'system-df --format', 'gate system-df --format'],
      ['scripts/szamla-dupla-ellenorzo.sh', PROD, `psql-ro ${OS_DB} acropora acropora tuples-spaced-pipe`, `psql-ro ${OS_DB} acropora acropora tuples-spaced-pipe`],
      ['scripts/ai-db-nas-mentes.sh', STAGE, `pg-dump ${AI_DB} acropora_ai acropora_ai`, 'pg-dump "$AI_CONTAINER" "$AI_DB_NAME" "$AI_DB_USER"'],
      ['scripts/ai-db-nas-mentes.sh', STAGE, `pg-restore-list ${AI_DB}`, 'pg-restore-list "$AI_CONTAINER"'],
      ['scripts/visszaallitasi-proba.sh', STAGE, 'restore-probe', 'sssh restore-probe'],
      ['scripts/visszaallitasi-proba.sh', STAGE, `psql-ro ${AI_DB} acropora_ai acropora_ai tuples`, 'sssh psql-ro "$AI_LIVE" acropora_ai acropora_ai tuples'],
    ]
    const worlds: Record<string, ReturnType<typeof world>> = { [PROD]: world(PROD), [STAGE]: world(STAGE) }
    const wrong: string[] = []
    for (const [file, host, command, held] of sent) {
      if (!text(file).includes(held)) wrong.push(`${file}: does not hold ${held}`)
      const r = worlds[host]!.run(command, 'select 1;')
      if (r.code !== 0) wrong.push(`${file} on ${host}: ${command} -> ${r.code} ${r.err.trim()}`)
    }
    expect(wrong, 'GATE-CALLERS-PASS').toEqual([])
  })
})
