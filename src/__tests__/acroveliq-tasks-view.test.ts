// The Feladatkezelés V1 page (task feladatkezeles-v1-frontend; Balázs's decision B,
// 2026-10-14 10:12:09 UTC, msg 1559871429544120323), run for real: the AcrovelIQ section of
// web/app.js in a bare vm context, with a fake fetch. WHAT TURNS THIS RED:
//   - the new task is not one POST to /api/task-actions with the form's Idempotency-Key, or
//     the same form sends a second key;
//   - an action is not one POST to /api/task-actions/<id>, or one outside the four reaches fetch;
//   - the page offers a pause over running work, a reassign after the hand-out, or anything
//     on an ended task; or hides resume on a paused one;
//   - a paused task is not shown paused when a review came after the pause;
//   - the phases break on a task whose hand-out wrote no `assigned`;
//   - a title is not escaped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const SECTION = APP.slice(APP.indexOf('// === AcrovelIQ (read-only view, task acroveliq-vp-v1) ==='))
const ESCAPE = APP.slice(APP.indexOf('function escapeHtml('), APP.indexOf('\n}\n', APP.indexOf('function escapeHtml(')) + 3)

interface Allowed { ended: boolean; paused: boolean; working: boolean; priority: boolean; assign: boolean; pause: boolean; resume: boolean }
interface View {
  aqRenderTasks: (data: unknown) => string
  aqTaskManage: (data: unknown, task: unknown, f: unknown, items: unknown[]) => string
  aqTaskAllowed: (task: unknown, items: unknown[]) => Allowed
  aqPhases: (items: unknown[], task: unknown) => string
  aqStatusPill: (t: unknown) => string
  aqTaskRow: (t: unknown) => string
  aqTaskWrite: (id: string | null, body: unknown, key?: string) => Promise<{ ok: boolean; status?: number; error?: string; value?: any }>
  aqNewKey: () => string
  aqGroupOf: (t: unknown) => string
  aqTaskSaveClick: (id: string) => Promise<void>
  AQ_KIND: Record<string, string>
  aqState: Record<string, any>
}

function load(fetchImpl: (url: string, init?: any) => Promise<unknown> = async () => ({ ok: true, json: async () => ({}) })) {
  const calls: Array<{ url: string; init: any }> = []
  const context = vm.createContext({
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => {
        let text = ''
        return {
          set textContent(v: unknown) { text = String(v) },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
        }
      },
    },
    fetch: async (url: string, init?: any) => {
      calls.push({ url, init })
      return fetchImpl(url, init)
    },
    console,
  })
  vm.runInContext(`${ESCAPE}\n${SECTION}\n;globalThis.__view = { aqRenderTasks, aqTaskManage, aqTaskAllowed, aqPhases, aqStatusPill, aqTaskRow, aqTaskWrite, aqNewKey, aqGroupOf, aqTaskSaveClick, AQ_KIND, aqState }`, context)
  return { view: (context as unknown as { __view: View }).__view, calls }
}

const now = Math.floor(Date.now() / 1000)
const task = (over: Record<string, unknown> = {}) => ({
  id: 't-1', title: 'Feladat', assignee: 'murena', reviewer: null, priority: 'normal', last_kind: null, last_at: now - 600,
  paused: false, busy: false, waits_on: 'murena', ...over,
})
const ev = (kind: string, at = 1) => ({ source: 'event', kind, at, actor: 'x', ref: null, data: null })
const data = (tasks: unknown[] = [task()]) => ({
  tasks, team: [{ name: 'acrobot' }, { name: 'murena' }], errors: { tasks: { ok: true } },
})

describe('Feladatkezelés V1 page', () => {
  it('TASK-VIEW-CREATE: one POST to /api/task-actions with the form\'s key; the same form keeps its key', async () => {
    const { view, calls } = load(async () => ({ ok: true, json: async () => ({ task: { id: 't-uj' } }) }))
    const key = view.aqNewKey()
    expect(key.length).toBeGreaterThanOrEqual(8)
    await view.aqTaskWrite(null, { title: 'Új', goal: 'cél', assignee: null, priority: 'high' }, key)
    await view.aqTaskWrite(null, { title: 'Új', goal: 'cél', assignee: null, priority: 'high' }, key)
    expect(calls.map((c) => [c.url, c.init.method, c.init.headers['Idempotency-Key'], JSON.parse(c.init.body).priority])).toEqual([
      ['/api/task-actions', 'POST', key, 'high'], ['/api/task-actions', 'POST', key, 'high'],
    ])
    // no key, no request
    expect((await view.aqTaskWrite(null, { title: 'x' })).ok).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('TASK-VIEW-ACTION: one POST to /api/task-actions/<id> per action, no key; an unknown action never reaches fetch', async () => {
    const { view, calls } = load()
    for (const action of ['assign', 'priority', 'pause', 'resume']) await view.aqTaskWrite('t/1', { action })
    expect((await view.aqTaskWrite('t-1', { action: 'restart' })).ok).toBe(false)
    expect((await view.aqTaskWrite('t-1', { action: 'constructor' })).ok).toBe(false)
    expect(calls.map((c) => [c.url, c.init.method, c.init.headers['Idempotency-Key'], JSON.parse(c.init.body).action])).toEqual([
      ['/api/task-actions/t%2F1', 'POST', undefined, 'assign'], ['/api/task-actions/t%2F1', 'POST', undefined, 'priority'],
      ['/api/task-actions/t%2F1', 'POST', undefined, 'pause'], ['/api/task-actions/t%2F1', 'POST', undefined, 'resume'],
    ])
  })

  it('TASK-VIEW-ALLOWED: the page offers what the server allows', () => {
    const { view } = load()
    const can = (t: Record<string, unknown>, items: unknown[] = []) => view.aqTaskAllowed(task(t), items)
    const pick = (a: Allowed) => [a.pause, a.resume, a.assign, a.priority]
    // [pause, resume, assign, priority]
    expect(pick(can({ last_kind: null }))).toEqual([true, false, true, true])
    expect(pick(can({ last_kind: 'started' }, [ev('started')]))).toEqual([false, false, false, true])
    expect(pick(can({ last_kind: 'fix_started' }, [ev('started'), ev('review_requested'), ev('fix_started')]))).toEqual([false, false, false, true])
    // assigned: before the session pausable, with the assignee's session not
    expect(pick(can({ last_kind: 'assigned' }, [ev('assigned')]))).toEqual([true, false, false, true])
    expect(pick(can({ last_kind: 'assigned' }, [ev('assigned'), { source: 'session', agent: 'murena', at: 2 }]))).toEqual([false, false, false, true])
    expect(pick(can({ last_kind: 'review_requested' }, [ev('started'), ev('review_requested')]))).toEqual([true, false, false, true])
    // paused: resume, and the assignee may change; a resume then opens assign until the next hand-out
    expect(pick(can({ last_kind: 'paused', paused: true }, [ev('assigned'), ev('paused')]))).toEqual([false, true, true, true])
    expect(pick(can({ last_kind: 'resumed' }, [ev('assigned'), ev('paused'), ev('resumed')]))).toEqual([true, false, true, true])
    expect(pick(can({ last_kind: 'done', closed: true }, [ev('done')]))).toEqual([false, false, false, false])
  })

  it('TASK-VIEW-MANAGE: the buttons follow the state; a paused task shows resume, a running one a disabled pause and why', () => {
    const { view } = load()
    const paused = view.aqTaskManage(data(), task({ last_kind: 'review_requested', paused: true }), { priority: 'normal', assignee: 'murena' }, [ev('review_requested'), ev('paused')])
    expect(paused).toContain('data-aq-act="resume" data-aq-id="t-1">Folytatás')
    expect(paused).not.toContain('data-aq-act="pause"')
    const running = view.aqTaskManage(data(), task({ last_kind: 'started' }), { priority: 'normal', assignee: 'murena' }, [ev('started')])
    expect(running).toMatch(/data-aq-act="pause" data-aq-id="t-1" disabled>Szünet/)
    expect(running).toContain('a szünet nem szakíthat meg futó munkát')
    expect(running).toMatch(/data-aq-edit="assignee" data-aq-id="t-1" disabled/)
    expect(running).not.toMatch(/data-aq-edit="priority" data-aq-id="t-1" disabled/)
    // nothing changed yet: Mentés is off
    expect(running).toMatch(/data-aq-save data-aq-id="t-1" disabled>Mentés/)
    expect(running).toContain('Ágenst innen nem indítunk')
  })

  it('TASK-VIEW-CLOSED: the Lezárt group is exactly the server\'s closed, for every kind the page knows (barracuda, #116)', () => {
    const { view } = load()
    const kinds = Object.keys(view.AQ_KIND)
    expect(kinds.length).toBeGreaterThanOrEqual(17)
    for (const k of kinds) {
      expect(view.aqGroupOf(task({ last_kind: k, closed: false })), `${k} open`).not.toBe('closed')
      expect(view.aqGroupOf(task({ last_kind: k, closed: true })), `${k} closed`).toBe('closed')
    }
    // the two measured disagreements: coord_close is not the task's end, merged is closed when the server says so
    expect([view.aqGroupOf(task({ last_kind: 'coord_close' })), view.aqGroupOf(task({ last_kind: 'merged', closed: true }))]).toEqual(['active', 'closed'])
  })

  it('TASK-VIEW-SAVE: a select only edits; Mentés writes what changed, priority before assignee, and nothing else', async () => {
    const { view, calls } = load(async () => ({ ok: true, json: async () => ({}) }))
    view.aqState.data = data([task({ priority: 'normal', assignee: 'murena' })])
    view.aqState.edit = { id: 't-1', priority: 'normal', assignee: '' }
    await view.aqTaskSaveClick('t-1')
    const writes = calls.filter((c) => c.init && c.init.method === 'POST').map((c) => [c.url, JSON.parse(c.init.body)])
    expect(writes).toEqual([['/api/task-actions/t-1', { action: 'assign', assignee: null }]])
    // no edit, no write
    calls.length = 0
    view.aqState.data = data([task()])
    await view.aqTaskSaveClick('t-1')
    expect(calls.filter((c) => c.init && c.init.method === 'POST')).toEqual([])
    // the page has no select that writes on change
    expect(SECTION).not.toContain('data-aq-set')
  })

  it('TASK-VIEW-PAUSED: a paused task is shown paused even when a review came after the pause', () => {
    const { view } = load()
    expect(view.aqStatusPill(task({ last_kind: 'verdict', paused: true }))).toContain('Szünetel')
    expect(view.aqStatusPill(task({ last_kind: 'owner_action', assignee: null }))).toContain('Kiosztásra vár (acrobot)')
    expect(view.aqStatusPill(task({ last_kind: 'resumed' }))).toContain('Kiadásra vár')
    const html = view.aqRenderTasks(data([task({ id: 'a', last_kind: 'verdict', paused: true }), task({ id: 'b', last_kind: 'started' })]))
    expect(html).toContain('Szünetel · 1')
    expect(html).toContain('Folyamatban · 1')
  })

  it('TASK-VIEW-PHASES: a hand-out with no assigned still reads as handed out and working', () => {
    const { view } = load()
    const html = view.aqPhases([ev('started'), ev('review_requested')], task({ last_kind: 'review_requested' }))
    const on = [...html.matchAll(/aq-phase aq-phase-on">([^<]+)</g)].map((m) => m[1])
    expect(on).toEqual(['Létrehozva', 'Kiosztva', 'Folyamatban', 'Ellenőrzés'])
    // the started alone carries it (no later event to lean on)
    const only = view.aqPhases([ev('started')], task({ last_kind: 'started' }))
    expect([...only.matchAll(/aq-phase aq-phase-on">([^<]+)</g)].map((m) => m[1])).toEqual(['Létrehozva', 'Kiosztva', 'Folyamatban'])
    expect(view.aqPhases([ev('started'), ev('paused')], task({ last_kind: 'paused', paused: true }))).toContain('Szünetel')
  })

  it('TASK-VIEW-ROW: priority as the tag, whom it waits on and since when, the title escaped', () => {
    const { view } = load()
    const html = view.aqTaskRow(task({ title: '<b>x</b>', priority: 'urgent', waits_on: 'barracuda', last_kind: 'review_requested' }))
    expect(html).toContain('aq-prio-urgent">Sürgős<')
    expect(html).toContain('vár: barracuda, 10 perce')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
    expect(view.aqTaskRow(task({ assignee: null }))).toContain('Acrobot osztja ki')
  })

  it('TASK-VIEW-FORM: the form shows what was typed, escaped, and the agents as assignees', () => {
    const { view } = load()
    view.aqState.form = { key: 'kulcs-0001', title: '"><script>', goal: 'cél', assignee: 'murena', priority: 'urgent', brief_ref: '' }
    const html = view.aqRenderTasks(data())
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"')
    expect(html).toContain('<option value="murena" selected>murena</option>')
    expect(html).toContain('<option value="">Acrobot osztja ki</option>')
    expect(html).toContain('<option value="urgent" selected>Sürgős</option>')
    expect(html).toContain('data-aq-form-submit')
    view.aqState.form = null
    expect(view.aqRenderTasks(data())).toContain('data-aq-new>Új feladat')
  })
})
