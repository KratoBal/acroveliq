// B29 step 1 (task b29-1-engedelylista): the main agent's strict profile draft. It acts on nothing
// until an agent is assigned it (step 4, the owner's word). WHAT TURNS THIS RED:
//   - a general command (cat, curl, python3 -/-c, bash -c, sed -i, node -e, sudo, git without a
//     named script) on the allow list: it reads or writes anything the user can (plan 4);
//   - an allowed script that does not exist in scripts/ (a typo would silently ask every time);
//   - the secret paths, WebFetch, WebSearch or CronCreate not denied;
//   - the mode not strict, or a write path outside exchange/ and the scratchpad.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const prof = JSON.parse(readFileSync(join(ROOT, 'templates', 'profiles', 'fo-agens.json'), 'utf8')) as {
  id: string
  permissionMode: string
  filesystem: { allow: string[]; deny: string[]; directories: string[] }
}
const allow = prof.filesystem.allow
const deny = prof.filesystem.deny

describe('fo-agens profile (B29 step 1)', () => {
  it('is strict and named fo-agens', () => {
    expect(prof.id).toBe('fo-agens')
    expect(prof.permissionMode).toBe('strict')
  })

  it('no general command is allowed', () => {
    const general = /^Bash\((cat|curl|bash -c|sed -i|sed:|python3 -c|python3 -[^I]|python3 -:|node|npx|npm|sudo|git |git:|ssh|rm|cp|mv|chmod|tmux|env|awk|for|until|while)/
    expect(allow.filter((a) => general.test(a))).toEqual([])
    expect(allow.filter((a) => a === 'Bash(python3:*)' || a === 'Bash(bash:*)' || a.startsWith('Bash(*'))).toEqual([])
  })

  it('no executing or writing gate comes back through a named tool (barracuda, #225 review)', () => {
    // each runs any command or writes any file through an allowed name: futtat.sh run, git-auth.sh
    // (any git subcommand, -c alias), find (-exec, -delete), sed (e, w, -n -i), uniq and sort -o
    // (an output file), echo and printf (a redirection), and the writing verbs of three scripts
    const gates = [
      /futtat\.sh(?! (olvas|keres):)/,
      /git-auth\.sh/,
      /^Bash\(find[ :]/,
      /^Bash\(sed[ :]/,
      /^Bash\((uniq|sort|echo|printf)[ :]/,
      /gcal\.sh(?! (check|events|mail|search|fetch):)/,
      /kirakat-telepites\.sh(?! (allapot|naplo):)/,
      /skill-kozos-token-csere\.py/,
      /titok-jog-figyelo\.py/,
    ]
    expect(allow.filter((a) => gates.some((g) => g.test(a)))).toEqual([])
  })

  it('every allowed script exists in scripts/', () => {
    const missing = allow
      .map((a) => /^Bash\((?:bash|python3(?: -I)?) (?:\$\{HOME\}\/marveen\/)?(scripts\/[A-Za-z0-9_.-]+\.(?:sh|py))(?: [a-z-]+)?:\*\)$/.exec(a)?.[1])
      .filter((s): s is string => !!s && !existsSync(join(ROOT, s)))
    expect(missing).toEqual([])
  })

  it('the secrets, the web tools and self-scheduling are denied', () => {
    for (const d of ['Read(${HOME}/marveen/store/.*)', 'Read(${HOME}/marveen/store/tokens/**)', 'Read(${HOME}/marveen/.env)', 'Read(${HOME}/.ssh/**)', 'WebFetch', 'WebSearch', 'CronCreate', 'Bash(cat:*)', 'Bash(curl:*)', 'Bash(sudo:*)']) {
      expect(deny).toContain(d)
    }
    expect(allow).not.toContain('WebFetch')
    expect(allow).not.toContain('WebSearch')
  })

  it('writes only to exchange/ and the scratchpad', () => {
    const writes = allow.filter((a) => /^(Write|Edit)\(/.test(a))
    expect(writes.every((w) => /^(Write|Edit)\((\$\{HOME\}\/marveen\/exchange\/\*\*|\/tmp\/claude-\*\/\*\*)\)$/.test(w))).toBe(true)
  })
})
