import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/*
  The host executor (the no-command-line plan, point C) is Python, and its guard is scripts/__tests__/hosti-vegrehajto.test.py.
  The CI workflow lists the Python guards one by one and a workflow file is not this agent's to edit, so `npm test` runs it
  from here: the same file, the same exit code, and a floor under the number of checks so that a guard which quietly runs
  nothing turns red. WHAT TURNS THIS RED: any check of the Python file failing, or the file printing fewer than 150 checks.
  The units and the script are checked in the second block, from their text.
*/

const root = process.cwd()
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

describe('hosti-vegrehajto.py and its guard', () => {
  it('the Python guard passes, with all its checks', async () => {
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(
        'python3',
        ['-B', join(root, 'scripts', '__tests__', 'hosti-vegrehajto.test.py')],
        { timeout: 120_000, maxBuffer: 10_000_000 },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, text: stdout + stderr }),
      )
    })
    const failed = out.text.split('\n').filter((l) => l.includes('[FAIL]'))
    expect(failed).toEqual([])
    expect(out.text).toContain('0 failed')
    expect((out.text.match(/\[PASS\]/g) ?? []).length).toBeGreaterThanOrEqual(150)
    expect(out.code).toBe(0)
  }, 150_000)
})

describe('the systemd units', () => {
  const socket = code(read('scripts', 'host', 'hosti-vegrehajto.socket'))
  const service = code(read('scripts', 'host', 'hosti-vegrehajto@.service'))

  it('the socket is a Unix node 0660 root:fleet, one process per connection, no network port', () => {
    expect(socket).toMatch(/^ListenStream=\/run\/hosti-vegrehajto\/sock$/m)
    expect(socket).toMatch(/^SocketUser=root$/m)
    expect(socket).toMatch(/^SocketGroup=fleet$/m)
    expect(socket).toMatch(/^SocketMode=0660$/m)
    expect(socket).toMatch(/^Accept=yes$/m)
    // no TCP or UDP listener of any shape
    expect(socket).not.toMatch(/^Listen(Datagram|SequentialPacket)=/m)
    expect(socket).not.toMatch(/^ListenStream=(\d|\[|0\.0\.0\.0|127\.)/m)
    expect(socket).not.toMatch(/FreeBind|Transparent|IPAddress/)
  })

  it("the service is root, narrowed, and its life is not tied to the client's", () => {
    for (const must of [
      /^ExecStart=\/usr\/local\/sbin\/hosti-vegrehajto serve$/m,
      /^StandardInput=socket$/m,
      /^User=root$/m,
      /^Restart=no$/m,
      /^KillMode=control-group$/m,
      /^TimeoutStopSec=60$/m,
      /^RuntimeMaxSec=3600$/m,
      /^NoNewPrivileges=yes$/m,
      /^ProtectHome=yes$/m,
      /^PrivateTmp=yes$/m,
      /^ProtectSystem=strict$/m,
    ]) {
      expect(service).toMatch(must)
    }
    // the writable paths: the state, the docker socket, and the clones' whole directories (.git included)
    const rw = [...service.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1]!.split(/\s+/))
    expect(rw.sort()).toEqual(['-/opt/levelkozvetito/src', '-/opt/vegrehajto/src', '/run/docker.sock', '/var/lib/hosti-vegrehajto'])
    // nothing that would end the work when the client leaves, and nothing that restarts it by itself
    expect(service).not.toMatch(/^(KillMode=process|Restart=(on|always)|BindsTo=|PartOf=)/m)
  })

  it('neither unit names a container path, the fleet tree, or a mount', () => {
    for (const text of [socket, service]) {
      expect(text).not.toMatch(/marveen-docker|docker\.sock:|BindPaths|Bind=/)
    }
  })
})

describe('scripts/hosti-vegrehajto.sh', () => {
  const sh = read('scripts', 'hosti-vegrehajto.sh')
  it("goes only through the gate's three ops, with the executor's own category", () => {
    const body = code(sh)
    expect([...body.matchAll(/gate (hosti-[a-z]+)/g)].map((m) => m[1]).sort()).toEqual([
      'hosti-allapot',
      'hosti-allapot',
      'hosti-kerj',
      'hosti-vegrehajt',
    ])
    expect(body).toContain("CATEGORY='hosti_vegrehajt'")
    // no other remote word, no docker, no sudo
    expect(body).not.toMatch(/\bdocker\b|\bsudo\b/)
  })
})

describe('the operating sheet', () => {
  it('HOSTI-INSTALL-SHA: the sha256 -c lines Balázs runs are the sha256 of the files in this tree', () => {
    const doc = read('docs', 'hosti-vegrehajto.md')
    const sha = (rel: string) =>
      createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex')
    const files = [
      'scripts/host/hosti-vegrehajto.py',
      'scripts/host/hosti-kliens.py',
      'scripts/host/hosti-vegrehajto.socket',
      'scripts/host/hosti-vegrehajto@.service',
    ]
    expect(files.map((f) => doc.includes(`echo '${sha(f)}  ${f}' | sha256sum -c`))).toEqual([true, true, true, true])
  })

  it('names the checks the plan asked for: the mount measurement, the uid decision, the EROFS note, the excluded', () => {
    const doc = read('docs', 'hosti-vegrehajto.md')
    for (const wanted of [
      'grep -c hosti-vegrehajto',
      '660 root:fleet',
      'EROFS',
      'the host executor itself and the gate',
      "by the peer's **UID**",
      '**never** runs prune, rmi or image rm',
    ]) {
      expect(doc, wanted).toContain(wanted)
    }
    expect(read('docs', 'fleet-gate.md')).toContain('`hosti-kerj <projekt> <ige> <commit\\|-> <kero>`')
  })
})
