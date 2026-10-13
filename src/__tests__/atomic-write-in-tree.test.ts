import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteInTree } from '../web/atomic-write.js'

// B45 B2-3: the router writes into an agent's tree, which the agent owns. A link
// the agent plants there must not redirect the router's write into ANOTHER tree.
// Real symlinks on a scratch tree; `victim` stands for the other agent's file.
let T: string
let tree: string
let victim: string
beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), 'b45-tree-'))
  tree = join(T, 'agents', 'barracuda')
  mkdirSync(join(tree, '.claude'), { recursive: true })
  mkdirSync(join(T, 'agents', 'murena', '.claude', 'agents'), { recursive: true })
  victim = join(T, 'agents', 'murena', '.claude', 'settings.json')
  writeFileSync(victim, 'MURENA')
})
afterEach(() => rmSync(T, { recursive: true, force: true }))

describe('atomicWriteInTree', () => {
  it('plain path: writes the file', () => {
    atomicWriteInTree(tree, join(tree, '.claude', 'settings.json'), 'OK')
    expect(readFileSync(join(tree, '.claude', 'settings.json'), 'utf-8')).toBe('OK')
  })

  it('final component is a symlink: the LINK is replaced, the other tree is untouched', () => {
    const p = join(tree, '.claude', 'settings.json')
    symlinkSync(victim, p)
    atomicWriteInTree(tree, p, 'BARRACUDA')
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe('BARRACUDA')
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })

  it('an intermediate directory is a symlink: refused, nothing written there', () => {
    const victimDir = join(T, 'agents', 'murena', '.claude', 'agents')
    symlinkSync(victimDir, join(tree, '.claude', 'agents'))
    expect(() => atomicWriteInTree(tree, join(tree, '.claude', 'agents', 'quarantine-reader.md'), 'X')).toThrow(/not a plain directory/)
    expect(readdirSync(victimDir)).toEqual([])
  })

  it('a path outside the root (../): refused', () => {
    expect(() => atomicWriteInTree(tree, join(tree, '..', 'murena', '.claude', 'settings.json'), 'X')).toThrow(/not inside/)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })

  it('the root itself is a symlink: refused', () => {
    const linkRoot = join(T, 'agents', 'link-to-murena')
    symlinkSync(join(T, 'agents', 'murena'), linkRoot)
    expect(() => atomicWriteInTree(linkRoot, join(linkRoot, '.claude', 'settings.json'), 'X')).toThrow(/not a plain directory/)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })
})
