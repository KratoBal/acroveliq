// The card's last measurement against the main branch (T6.5, card b3d8174e).
//
// What turns this red: the state function judging a card by updated_at instead of measured_at; a DIVERGED result that
// expires into "stale" (a measurement that found a difference must not fade); a done card still nagging; a basis with
// no measurement not said; the stamp taking its time from the caller; the stamp moving updated_at (the board's "last
// changed"); the basis replaced when it was not given, or not replaced when it was; an old database (the testing-status
// table recreation copies an explicit column list) losing the new columns or its rows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDatabase, createKanbanCard, getKanbanCard, stampKanbanMeasure, listKanbanCards } from '../db.js'
import { kanbanMeasureState } from '../kanban-measure.js'

const NOW = 1_800_000_000
const H = 3600
const card = (over: Partial<Parameters<typeof kanbanMeasureState>[0]> = {}) => ({
  status: 'planned' as const,
  basis: null,
  measured_at: null,
  measure_result: null,
  ...over,
})

describe('kanbanMeasureState', () => {
  it('no basis and never measured is nothing to say; a basis never measured is said', () => {
    expect(kanbanMeasureState(card(), NOW, 24)).toBe('none')
    expect(kanbanMeasureState(card({ basis: '   ' }), NOW, 24)).toBe('none')
    expect(kanbanMeasureState(card({ basis: 'os:apps/api/src/x.ts' }), NOW, 24)).toBe('unmeasured')
  })

  it('fresh below the threshold, stale at and above it, by measured_at', () => {
    const measured = (hoursAgo: number, result: 'OK' | 'UNKNOWN') =>
      card({ measured_at: NOW - hoursAgo * H, measure_result: result })
    expect(kanbanMeasureState(measured(23.9, 'OK'), NOW, 24)).toBe('fresh')
    expect(kanbanMeasureState(measured(24, 'OK'), NOW, 24)).toBe('stale')
    expect(kanbanMeasureState(measured(100, 'OK'), NOW, 24)).toBe('stale')
    // a different threshold moves the line
    expect(kanbanMeasureState(measured(30, 'OK'), NOW, 48)).toBe('fresh')
  })

  it('a measurement that could not look is unknown while fresh and stale later', () => {
    expect(kanbanMeasureState(card({ measured_at: NOW - H, measure_result: 'UNKNOWN' }), NOW, 24)).toBe('unknown')
    expect(kanbanMeasureState(card({ measured_at: NOW - 30 * H, measure_result: 'UNKNOWN' }), NOW, 24)).toBe('stale')
  })

  it('a divergence stays a divergence whatever its age', () => {
    expect(kanbanMeasureState(card({ measured_at: NOW - H, measure_result: 'DIVERGED' }), NOW, 24)).toBe('diverged')
    expect(kanbanMeasureState(card({ measured_at: NOW - 500 * H, measure_result: 'DIVERGED' }), NOW, 24)).toBe('diverged')
  })

  it('a done card has nothing to say, measured or not', () => {
    expect(kanbanMeasureState(card({ status: 'done', basis: 'x', measured_at: NOW - 500 * H, measure_result: 'DIVERGED' }), NOW, 24)).toBe('none')
  })
})

describe('stampKanbanMeasure', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW * 1000))
  })
  afterEach(() => vi.useRealTimers())

  it('a new card has no measurement; a basis given at creation is kept trimmed', () => {
    createKanbanCard({ id: 'c1', title: 'x', basis: '  os:apps/api/src/a.ts#f  ' })
    createKanbanCard({ id: 'c2', title: 'y' })
    expect(getKanbanCard('c1')).toMatchObject({ basis: 'os:apps/api/src/a.ts#f', measured_at: null, measure_result: null })
    expect(getKanbanCard('c2')?.basis).toBeNull()
  })

  it('the time is the server clock, and updated_at does not move', () => {
    createKanbanCard({ id: 'c1', title: 'x' })
    const before = getKanbanCard('c1')!.updated_at
    vi.setSystemTime(new Date((NOW + 5000) * 1000))
    expect(stampKanbanMeasure('c1', { result: 'OK', note: ' rendben ' })).toBe(true)
    const after = getKanbanCard('c1')!
    expect(after.measured_at).toBe(NOW + 5000)
    expect(after.measure_result).toBe('OK')
    expect(after.measure_note).toBe('rendben')
    expect(after.updated_at).toBe(before)
  })

  it('the basis is replaced only when given: omitted keeps it, an empty one clears it', () => {
    createKanbanCard({ id: 'c1', title: 'x', basis: 'os:a.ts' })
    stampKanbanMeasure('c1', { result: 'OK' })
    expect(getKanbanCard('c1')?.basis).toBe('os:a.ts')
    stampKanbanMeasure('c1', { result: 'DIVERGED', basis: 'os:b.ts#g', note: 'a.ts nincs' })
    expect(getKanbanCard('c1')).toMatchObject({ basis: 'os:b.ts#g', measure_result: 'DIVERGED', measure_note: 'a.ts nincs' })
    stampKanbanMeasure('c1', { result: 'OK', basis: '  ' })
    expect(getKanbanCard('c1')?.basis).toBeNull()
  })

  it('an unknown card is false and writes nothing', () => {
    expect(stampKanbanMeasure('nincs', { result: 'OK' })).toBe(false)
    expect(listKanbanCards()).toEqual([])
  })
})

describe('an old database gets the columns', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-measure-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a table from before the testing status (recreated by the older migration) still ends up with the measurement columns and its rows', () => {
    const file = join(dir, 'old.db')
    const old = new Database(file)
    old.exec(`
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
        assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
      );
      INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('old1', 'régi kártya', 1, 2);
    `)
    old.close()

    initDatabase(file)
    const migrated = getKanbanCard('old1')
    expect(migrated).toMatchObject({ title: 'régi kártya', basis: null, measured_at: null, measure_result: null, measure_note: null })
    expect(stampKanbanMeasure('old1', { result: 'OK', basis: 'os:a.ts' })).toBe(true)
    expect(getKanbanCard('old1')?.basis).toBe('os:a.ts')
  })

  it('initialising twice is harmless (the columns already exist)', () => {
    const file = join(dir, 'twice.db')
    initDatabase(file)
    createKanbanCard({ id: 'c1', title: 'x', basis: 'os:a.ts' })
    initDatabase(file)
    expect(getKanbanCard('c1')?.basis).toBe('os:a.ts')
  })
})
