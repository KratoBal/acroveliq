// The secret form on the Vault page (task parancssor-f-titok-urlap, contract v2 section 2.9), read from its source.
// WHAT TURNS THIS RED: the typed value still in the field when the request goes out (or kept anywhere in the
// browser: storage, the console, the page text); the answer put into the page as markup; a form that is not a password
// field; a request to a path the backend does not serve; a button without its element.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')
const APP = read('web', 'app.js')
const HTML = read('web', 'index.html')

const start = APP.indexOf(';(function wireRelaySecret() {')
const end = APP.indexOf('// --- Env var modal for GitHub repo install ---')
const BLOCK = APP.slice(start, end)

describe("the secret form's script", () => {
  it('finds its block (the control for every check below)', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(BLOCK).toContain('/api/titok-urlap/oauth-client-secret/')
  })

  it('clears the field BEFORE the request is sent, so the value is gone from the page while the relay tries it at Google', () => {
    const clear = BLOCK.indexOf("input.value = ''")
    const sendCall = BLOCK.indexOf("await send('ir', value)")
    expect(clear).toBeGreaterThan(-1)
    expect(sendCall).toBeGreaterThan(clear)
  })

  it('keeps the value nowhere: no storage, no console, no cookie, no URL, no markup from the answer', () => {
    expect(BLOCK).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./)
    expect(BLOCK).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/)
    // the value goes in a request BODY only: never in a query string or a path
    expect(BLOCK).not.toMatch(/\?ertek=|\+\s*value|`[^`]*\$\{value\}[^`]*`/)
    expect(BLOCK).toContain('status.textContent = text')
  })

  it('shows the length, the version and the state, as text', () => {
    expect(BLOCK).toContain('out.hossz')
    expect(BLOCK).toContain('out.verzio')
  })

  it('the paths it calls are the ones the backend serves, and nothing else is called', () => {
    const route = read('src', 'web', 'routes', 'titok-urlap.ts')
    const matcher = /const PATH = \/\^(.*)\$\//.exec(route)![1]!
    for (const verb of ['ir', 'lezar', 'visszaall']) {
      expect(new RegExp(`^${matcher}$`).test(`/api/titok-urlap/oauth-client-secret/${verb}`), verb).toBe(true)
      expect(BLOCK).toContain(`'${verb}'`)
    }
    expect([...BLOCK.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1]!.trim())).toEqual(['BASE + verb'])
  })

  it('asks for a confirmation before the two actions that change what is active', () => {
    expect(BLOCK.match(/confirm\(/g)).toHaveLength(2)
  })
})

describe("the secret form's markup", () => {
  it('has every element the script looks up', () => {
    for (const id of ['relaySecretValue', 'relaySecretSend', 'relaySecretRollback', 'relaySecretClose', 'relaySecretStatus']) {
      expect(HTML, id).toContain(`id="${id}"`)
      expect(BLOCK, id).toContain(`'${id}'`)
    }
  })

  it("the value field is a password field that the browser is told not to fill or remember, capped at the relay's limit", () => {
    const tag = /<input[^>]*id="relaySecretValue"[^>]*>/.exec(HTML)![0]
    expect(tag).toContain('type="password"')
    expect(tag).toContain('autocomplete="new-password"')
    expect(tag).toContain('maxlength="512"')
  })

  it('the rotation buttons start hidden: there is nothing to close before a write', () => {
    expect(/<button[^>]*id="relaySecretRollback"[^>]*hidden/.test(HTML)).toBe(true)
    expect(/<button[^>]*id="relaySecretClose"[^>]*hidden/.test(HTML)).toBe(true)
  })
})
