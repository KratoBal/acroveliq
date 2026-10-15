// The dashboard's GitHub token (src/github-token.ts), the owner token's retirement, PR 2
// (docs/fleet-github.md). WHAT TURNS THIS RED:
//   - the switch off not giving the owner token file's content, or an empty or missing file passing as a token;
//   - the switch on not asking the broker for exactly `token <owner/repo> olvas`, or a refusal or an
//     empty answer passing as a token (an empty Authorization header is a silent unauthenticated call);
//   - a malformed repository or an unknown role reaching the broker;
//   - the broker asked on every call (the kept token), or a kept token outliving 45 minutes;
//   - the two dashboard checks sending one repository's token to another repository;
//   - a dashboard source file reading store/.github-token directly, outside the known list.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { forgetGithubTokens, githubToken, githubTokenPlaces, readTokenSource, type GithubRole } from '../github-token.js'
import { githubMergeProbe } from '../task-usage.js'
import { githubProbe } from '../task-handoff.js'

const saved = { ...githubTokenPlaces }
let dir = ''
let calls = ''
let owner = ''
let clock = 1_000_000

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-token-'))
  calls = join(dir, 'calls')
  owner = join(dir, 'owner-token')
  const broker = join(dir, 'broker')
  writeFileSync(broker, [
    '#!/bin/sh',
    `printf "%s\\n" "$*" >> ${calls}`,
    'case "$2" in KratoBal/refused) exit 10 ;; KratoBal/empty) exit 0 ;; esac',
    'printf "APP-%s-%s\\n" "$2" "$3"', ''].join('\n'))
  chmodSync(broker, 0o755)
  Object.assign(githubTokenPlaces, { ownerFile: owner, broker, sudo: [], now: () => clock })
})

afterEach(() => {
  forgetGithubTokens()
  if (existsSync(calls)) unlinkSync(calls)
})

afterAll(() => {
  Object.assign(githubTokenPlaces, saved)
  rmSync(dir, { recursive: true, force: true })
})

const on = (v: boolean) => { githubTokenPlaces.switchOn = () => v }
const brokerCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [])

describe('switch off: the owner token file', () => {
  it('gives the file, and an empty or missing file is no token', async () => {
    on(false)
    writeFileSync(owner, 'OWNER-TOKEN\n')
    expect(await githubToken('KratoBal/acroveliq', 'olvas')).toBe('OWNER-TOKEN')
    expect(brokerCalls()).toEqual([])
    writeFileSync(owner, '')
    expect(await githubToken('KratoBal/acroveliq', 'olvas')).toBeNull()
    unlinkSync(owner)
    expect(await githubToken('KratoBal/acroveliq', 'olvas')).toBeNull()
  })
})

describe('switch on: the broker', () => {
  it('asks for exactly the repository and the role', async () => {
    on(true)
    expect(await githubToken('KratoBal/acroveliq', 'olvas')).toBe('APP-KratoBal/acroveliq-olvas')
    expect(brokerCalls()).toEqual(['token KratoBal/acroveliq olvas'])
  })

  it('a refusal and an empty answer are no token, and are not kept', async () => {
    on(true)
    expect(await githubToken('KratoBal/refused', 'olvas')).toBeNull()
    expect(await githubToken('KratoBal/empty', 'olvas')).toBeNull()
    expect(await githubToken('KratoBal/refused', 'olvas')).toBeNull()
    expect(brokerCalls()).toHaveLength(3)
  })

  it('a malformed repository or an unknown role never reaches the broker', async () => {
    on(true)
    expect(await githubToken('acroveliq', 'olvas')).toBeNull()
    expect(await githubToken('KratoBal/acroveliq; id', 'olvas')).toBeNull()
    expect(await githubToken('KratoBal/acroveliq', 'admin' as GithubRole)).toBeNull()
    expect(brokerCalls()).toEqual([])
  })

  it('keeps a token per repository for 45 minutes, not longer', async () => {
    on(true)
    await readTokenSource('KratoBal/acroveliq')
    await readTokenSource('KratoBal/acroveliq')
    await readTokenSource('KratoBal/acropora-os')
    expect(brokerCalls()).toEqual(['token KratoBal/acroveliq olvas', 'token KratoBal/acropora-os olvas'])
    clock += 45 * 60 * 1000
    await readTokenSource('KratoBal/acroveliq')
    expect(brokerCalls()).toHaveLength(3)
  })
})

describe('the dashboard checks ask per repository', () => {
  const seen: Array<[string, string | null]> = []
  const fakeFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push([url, init?.headers?.Authorization ?? null])
    return new Response(JSON.stringify({ merged: true, merge_commit_sha: 'a'.repeat(40), status: 'identical', state: 'closed', head: { sha: 'b' } }), { status: 200 })
  }) as unknown as typeof fetch
  const source = async (repo: string) => (repo === 'KratoBal/none' ? null : `TOKEN-FOR-${repo}`)

  it('the merge check and the handoff check send each repository its own token', async () => {
    seen.length = 0
    await githubMergeProbe(source, fakeFetch).pullRequest('KratoBal/acroveliq', 1)
    await githubMergeProbe(source, fakeFetch).onMain('KratoBal/acropora-os', 'a'.repeat(40))
    await githubProbe(source, fakeFetch).pullRequest('KratoBal/ai-agent', 2)
    expect(seen).toEqual([
      ['https://api.github.com/repos/KratoBal/acroveliq/pulls/1', 'Bearer TOKEN-FOR-KratoBal/acroveliq'],
      [`https://api.github.com/repos/KratoBal/acropora-os/compare/main...${'a'.repeat(40)}`, 'Bearer TOKEN-FOR-KratoBal/acropora-os'],
      ['https://api.github.com/repos/KratoBal/ai-agent/pulls/2', 'Bearer TOKEN-FOR-KratoBal/ai-agent'],
    ])
  })

  it('no token is "not measurable", and GitHub is not called', async () => {
    seen.length = 0
    expect(await githubMergeProbe(source, fakeFetch).pullRequest('KratoBal/none', 1)).toBeUndefined()
    expect(await githubProbe(source, fakeFetch).pullRequest('KratoBal/none', 1)).toBeUndefined()
    expect(seen).toEqual([])
  })
})

describe('who still names the owner token file in the dashboard source', () => {
  it('only the helper and the GPT package secret list', () => {
    const known = new Set([
      'github-token.ts', // the switch-off branch
      'gpt-package.ts', // a VALUE to keep out of GPT packages, not a reader for GitHub; a missing file is nothing to compare
    ])
    const src = join(__dirname, '..')
    const found = new Set<string>()
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); continue }
        if (!f.endsWith('.ts')) continue
        const code = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        if (code.some((l) => l.includes('.github-token'))) found.add(relative(src, p))
      }
    }
    walk(src)
    expect([...found].filter((f) => !known.has(f)).sort()).toEqual([])
    expect([...known].filter((f) => !found.has(f)).sort()).toEqual([])
  })
})
