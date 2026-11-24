import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/ticket-mail.sh, the reader token (card ec7b947b, acrobot 60314): the ticket intake gets a
  gmail.readonly token of its own (GMAIL_TICKET_READ_*), so a reading process cannot send. What turns
  these red: the link asking for more than gmail.readonly, or adding the earlier grants; the code taken
  from argv; a wider token written to the reader file; the reader written over the SENDER's file; the
  check calling a token that can send "OK".
*/

const READ = 'https://www.googleapis.com/auth/gmail.readonly'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
let root = ''
const store = () => join(root, 'store')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ticket-mail-olvaso-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  const src = readFileSync(join(process.cwd(), 'scripts', 'ticket-mail.sh'), 'utf8')
  // the replacement is checked first: a changed line must never point the test at the real store
  expect(src).toContain('ROOT=/home/marveen/marveen\n')
  writeFileSync(join(root, 'scripts', 'ticket-mail.sh'), src.replace('ROOT=/home/marveen/marveen\n', `ROOT=${root}\n`))
  // the Google endpoints, by URL and grant; it logs its argv, and the CONTENT of a code@<file> argument
  writeFileSync(join(root, 'bin', 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${root}/argv.log"
u=; w=; grant=
for a in "$@"; do
  case "$a" in
    https://*) u=$a ;;
    %\\{http_code\\}) w=1 ;;
    grant_type=*) grant=\${a#grant_type=} ;;
    code@*) cat "\${a#code@}" >> "${root}/code.log" ;;
  esac
done
case "$u" in
  */token) if [ "$grant" = authorization_code ]; then printf '%s' "$TOKEN_BODY"; else printf '%s' '{"access_token":"ya29.teszt","expires_in":3599}'; fi ;;
  */tokeninfo) printf '%s' "$INFO_BODY" ;;
  */users/me/profile) printf '%s' "$PROF_BODY" ;;
  */messages/send) [ -n "$w" ] && printf '%s' "$SEND_CODE" ;;
esac
`)
  chmodSync(join(root, 'bin', 'curl'), 0o755)
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(store(), { recursive: true, force: true })
  mkdirSync(store(), { recursive: true })
  writeFileSync(join(store(), '.ticket-mail-client-id'), 'kliens-123.apps.googleusercontent.com')
  writeFileSync(join(store(), '.ticket-mail-client-secret'), 'kliens-titok')
  writeFileSync(join(store(), '.ticket-mail-refresh-token'), 'KULDO-TOKEN')
  for (const f of ['argv.log', 'code.log']) rmSync(join(root, f), { force: true })
})

function run(args: string[], env: Record<string, string> = {}, input = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [join(root, 'scripts', 'ticket-mail.sh'), ...args], {
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, ...env },
    }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }))
    child.stdin?.end(input)
  })
}

const readFile = () => join(store(), '.ticket-mail-read-refresh-token')

describe('ticket-mail.sh: the reader token', () => {
  it('the link asks for gmail.readonly only, offline, with consent and the ticket@ hint, and adds no earlier grant', async () => {
    const r = await run(['auth-url-olvaso'])
    expect(r.code).toBe(0)
    const url = new URL(r.out.split('\n')[0])
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toBe(READ)
    expect(url.searchParams.get('client_id')).toBe('kliens-123.apps.googleusercontent.com')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('login_hint')).toBe('ticket@acropora.hu')
    expect(url.searchParams.has('include_granted_scopes')).toBe(false)
  })

  it('the code is never an argument', async () => {
    const r = await run(['auth-code-olvaso', '4/abc'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('NE argumentumkent')
    expect(existsSync(readFile())).toBe(false)
  })

  it('a readonly token from the pasted address bar goes to the reader file (0600); the sender file is untouched; the code is not in argv', async () => {
    const r = await run(['auth-code-olvaso'], { TOKEN_BODY: JSON.stringify({ refresh_token: '1//OLVASO', scope: READ }) },
      'http://localhost:8765/?code=4%2F0Ab-kod&scope=x\n')
    expect(r.code).toBe(0)
    expect(readFileSync(readFile(), 'utf8')).toBe('1//OLVASO')
    expect(statSync(readFile()).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(store(), '.ticket-mail-refresh-token'), 'utf8')).toBe('KULDO-TOKEN')
    expect(readFileSync(join(root, 'code.log'), 'utf8')).toBe('4/0Ab-kod')
    expect(readFileSync(join(root, 'argv.log'), 'utf8')).not.toContain('0Ab-kod')
  })

  it('a token wider than gmail.readonly is not written', async () => {
    const r = await run(['auth-code-olvaso'], { TOKEN_BODY: JSON.stringify({ refresh_token: '1//SZELES', scope: `${READ} ${SEND}` }) }, '4/kod\n')
    expect(r.code).toBe(1)
    expect(r.err).toContain('nem csak gmail.readonly')
    expect(existsSync(readFile())).toBe(false)
  })

  it('no refresh token (an expired or used code) is a FAIL with Google\'s reason', async () => {
    const r = await run(['auth-code-olvaso'], { TOKEN_BODY: JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }) }, '4/kod\n')
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid_grant')
    expect(existsSync(readFile())).toBe(false)
  })

  describe('olvaso-ellenoriz', () => {
    const ok = { INFO_BODY: JSON.stringify({ scope: READ }), PROF_BODY: JSON.stringify({ emailAddress: 'ticket@acropora.hu' }), SEND_CODE: '403' }
    beforeEach(() => writeFileSync(readFile(), '1//OLVASO'))

    it('readonly, ticket@, and a 403 on send: OK, exit 0', async () => {
      const r = await run(['olvaso-ellenoriz'], ok)
      expect(r.code).toBe(0)
      expect(r.out).toContain('OSSZESEN: minden OK')
    })

    it.each([
      ['a token that can send', { INFO_BODY: JSON.stringify({ scope: `${READ} ${SEND}` }), SEND_CODE: '400' }, /HIBA  hatokor[\s\S]*HIBA  kuldes: 400/],
      ['another mailbox', { PROF_BODY: JSON.stringify({ emailAddress: 'info@acropora.hu' }) }, /HIBA  postafiok: info@acropora.hu/],
    ])('%s: HIBA, exit 1', async (_label, override, line) => {
      const r = await run(['olvaso-ellenoriz'], { ...ok, ...override })
      expect(r.code).toBe(1)
      expect(r.out).toMatch(line)
    })

    it('no reader token yet: says the order', async () => {
      rmSync(readFile())
      const r = await run(['olvaso-ellenoriz'], ok)
      expect(r.code).toBe(1)
      expect(r.err).toContain('auth-url-olvaso -> jovahagyas -> auth-code-olvaso')
    })
  })
})
