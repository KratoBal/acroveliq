// B20b (task b20b-coolify2-tailnet): the executor gets its own Tailscale identity through a
// sidecar, and its own hardening does not move. WHAT TURNS THIS RED:
//   - the executor loses read_only, cap_drop ALL, no-new-privileges or uid 10001, gains a capability,
//     a device, a port or its own network, or shares a namespace other than the sidecar's;
//   - the sidecar gains a capability beyond NET_ADMIN, a device beyond the tun, a port, privileged,
//     the docker socket or a host path;
//   - the sidecar runs in userspace mode, takes the tailnet's DNS, advertises routes or an exit node,
//     accepts routes, uses an exit node, or comes up without its tag;
//   - the auth key is not a file secret under /opt/vegrehajto/titkok, or the image has no pinned value.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const raw = readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'compose.yaml'), 'utf8')
const code = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

/** The text of one top-level section's child block (two-space indent), comments removed. */
function block(section: string, name: string): string {
  const lines = code.split('\n')
  const start = lines.indexOf(`${section}:`)
  expect(start, `top-level ${section}`).toBeGreaterThanOrEqual(0)
  const out: string[] = []
  let inside = false
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    if (/^ {2}\S/.test(l)) {
      inside = l === `  ${name}:`
      continue
    }
    if (inside) out.push(l)
  }
  return out.join('\n')
}

function services(): string[] {
  const lines = code.split('\n')
  const start = lines.indexOf('services:')
  const names: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    const m = /^ {2}([a-z][a-z0-9-]*):$/.exec(l)
    if (m) names.push(m[1]!)
  }
  return names
}

describe('deploy-executor compose: the Tailscale sidecar (B20b)', () => {
  it('exactly two services: the sidecar and the executor', () => {
    expect(services().sort()).toEqual(['ts', 'vegrehajto'])
  })

  it('the executor keeps its hardening and shares only the sidecar namespace', () => {
    const v = block('services', 'vegrehajto')
    for (const must of [/^ {4}read_only: true$/m, /^ {4}cap_drop:\n {6}- ALL$/m, /- no-new-privileges:true/, /^ {4}user: "10001:10001"$/m, /^ {4}network_mode: service:ts$/m]) {
      expect(v).toMatch(must)
    }
    for (const never of [/^ {4}networks:/m, /^ {4}ports:/m, /^ {4}cap_add:/m, /^ {4}devices:/m, /privileged/, /docker\.sock/, /^ {4}hostname:/m]) {
      expect(v).not.toMatch(never)
    }
  })

  it('the sidecar holds NET_ADMIN and the tun device, nothing more', () => {
    const t = block('services', 'ts')
    expect(t).toMatch(/^ {4}cap_add:\n {6}- NET_ADMIN\n {4}\S/m)
    expect(t).toMatch(/^ {4}devices:\n {6}- \/dev\/net\/tun:\/dev\/net\/tun\n {4}\S/m)
    expect(t).toMatch(/- no-new-privileges:true/)
    expect(t).toMatch(/^ {4}image: \$\{VEGREHAJTO_TS_IMAGE:\?/m)
    for (const never of [/^ {4}ports:/m, /privileged/, /docker\.sock/, /\/opt\/marveen-docker/, /\/home\/marveen/, /type: bind/, /network_mode/, /pid: host/]) {
      expect(t).not.toMatch(never)
    }
  })

  it('kernel mode, own DNS kept, its tag, no routes in or out, no exit node', () => {
    const t = block('services', 'ts')
    expect(t).toMatch(/^ {6}TS_USERSPACE: "false"$/m)
    expect(t).toMatch(/^ {6}TS_ACCEPT_DNS: "false"$/m)
    expect(t).toMatch(/^ {6}TS_AUTHKEY: file:\/run\/secrets\/ts-authkey$/m)
    expect(t).toMatch(/^ {6}TS_AUTH_ONCE: "true"$/m)
    const extra = /^ {6}TS_EXTRA_ARGS: (.*)$/m.exec(t)?.[1] ?? ''
    expect(extra.split(/\s+/)).toContain('--advertise-tags=tag:vegrehajto')
    expect(extra.split(/\s+/)).toContain('--accept-routes=false')
    for (const never of [/--advertise-routes/, /--advertise-exit-node/, /--exit-node=\S/, /--accept-routes(?!=false)/, /--ssh/]) {
      expect(extra).not.toMatch(never)
    }
  })

  it('the fleet keeps calling http://vegrehajto:8787: the alias is on the internal network', () => {
    const t = block('services', 'ts')
    expect(t).toMatch(/^ {6}hivas:\n {8}aliases:\n {10}- vegrehajto$/m)
    expect(block('networks', 'hivas')).toMatch(/^ {4}internal: true$/m)
  })

  it('the auth key is a file secret beside the others, and the state a named volume', () => {
    expect(block('secrets', 'ts-authkey')).toMatch(/^ {4}file: \/opt\/vegrehajto\/titkok\/ts-authkey$/m)
    expect(block('services', 'ts')).toMatch(/^ {4}secrets:\n {6}- ts-authkey$/m)
    expect(block('services', 'vegrehajto')).not.toMatch(/ts-authkey/)
    expect(block('volumes', 'ts-allapot')).toMatch(/^ {4}name: vegrehajto-ts-allapot$/m)
  })
})
