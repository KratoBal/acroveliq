import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteInTree, atomicWriteFileSync, agentTreeRootOf } from '../web/atomic-write.js'
import { PROJECT_ROOT } from '../config.js'

// B45 B2-3: the router writes into an agent's tree, which the agent owns. A link
// the agent plants there must not redirect the router's write into ANOTHER tree,
// whether the write is plain or tmp+rename (barracuda review of #47: a symlinked
// `.claude` redirected every settings.json write). Real symlinks on scratch trees;
// `victim` stands for the other agent's file.
let T: string
let tree: string
let victim: string
beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), 'b45-tree-'))
  tree = join(T, 'agents', 'barracuda')
  mkdirSync(join(tree, '.claude'), { recursive: true })
  mkdirSync(join(tree, 'skills'), { recursive: true })
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

  it('a symlinked .claude pointing into another tree: refused, the other settings.json untouched', () => {
    rmSync(join(tree, '.claude'), { recursive: true })
    symlinkSync(join(T, 'agents', 'murena', '.claude'), join(tree, '.claude'))
    expect(() => atomicWriteInTree(tree, join(tree, '.claude', 'settings.json'), 'X')).toThrow(/outside/)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
    expect(readdirSync(join(T, 'agents', 'murena', '.claude')).sort()).toEqual(['agents', 'settings.json'])
  })

  it('a deeper symlinked directory pointing into another tree: refused', () => {
    const victimDir = join(T, 'agents', 'murena', '.claude', 'agents')
    symlinkSync(victimDir, join(tree, '.claude', 'agents'))
    expect(() => atomicWriteInTree(tree, join(tree, '.claude', 'agents', 'quarantine-reader.md'), 'X')).toThrow(/outside/)
    expect(readdirSync(victimDir)).toEqual([])
  })

  it('a symlink that stays inside the same tree (.claude/skills -> ../skills): allowed', () => {
    symlinkSync('../skills', join(tree, '.claude', 'skills'))
    atomicWriteInTree(tree, join(tree, '.claude', 'skills', 'SKILL.md'), 'S')
    expect(readFileSync(join(tree, 'skills', 'SKILL.md'), 'utf-8')).toBe('S')
  })

  it('a path outside the root (../): refused', () => {
    expect(() => atomicWriteInTree(tree, join(tree, '..', 'murena', '.claude', 'settings.json'), 'X')).toThrow(/not inside/)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })

  it('the root itself is a symlink: refused', () => {
    const linkRoot = join(T, 'agents', 'link-to-murena')
    symlinkSync(join(T, 'agents', 'murena'), linkRoot)
    expect(() => atomicWriteInTree(linkRoot, join(linkRoot, '.claude', 'settings.json'), 'X')).toThrow(/symlink/)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })
})

describe('agentTreeRootOf', () => {
  it('a path inside agents/<name>/ maps to that tree, everything else to null', () => {
    const base = join(T, 'agents')
    expect(agentTreeRootOf(join(base, 'barracuda', '.claude', 'settings.json'), base)).toBe(join(base, 'barracuda'))
    expect(agentTreeRootOf(join(base, 'barracuda'), base)).toBeNull()
    expect(agentTreeRootOf(join(T, 'store', 'x.json'), base)).toBeNull()
    expect(agentTreeRootOf(join(base, '..', 'store', 'x.json'), base)).toBeNull()
  })
})

// The central path: EVERY atomicWriteFileSync under <PROJECT_ROOT>/agents/<name>/
// is checked, so a call site cannot forget it. Uses a throwaway agent dir under the
// real base; removes it (and the base, if this test created it).
describe('atomicWriteFileSync under the real agents base', () => {
  it('a symlinked .claude into another tree is refused by atomicWriteFileSync itself', () => {
    const base = join(PROJECT_ROOT, 'agents')
    const hadBase = existsSync(base)
    const name = `__b45test_${process.pid}_${Date.now()}`
    const own = join(base, name)
    try {
      mkdirSync(own, { recursive: true })
      symlinkSync(join(T, 'agents', 'murena', '.claude'), join(own, '.claude'))
      expect(() => atomicWriteFileSync(join(own, '.claude', 'settings.json'), 'X')).toThrow(/outside/)
      expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
      rmSync(join(own, '.claude'))
      mkdirSync(join(own, '.claude'))
      atomicWriteFileSync(join(own, '.claude', 'settings.json'), 'OK')
      expect(readFileSync(join(own, '.claude', 'settings.json'), 'utf-8')).toBe('OK')
    } finally {
      rmSync(own, { recursive: true, force: true })
      if (!hadBase) rmSync(base, { recursive: true, force: true })
    }
  })
})
