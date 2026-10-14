// Projektek V1, the page (task t-20261014-acroveliiq-projektkezeles-d3f1, PR B; Balázs's approval,
// variant A, 2026-10-14 13:11:32 UTC). The AcrovelIQ section of web/app.js in a bare vm context,
// with a fake fetch. WHAT TURNS THIS RED:
//   - the project filter is the page's, not the server's: no ?project= on the task list or on
//     open-matters, or one when "Mind" is selected;
//   - the new-task form sends without a project, or does not offer the registry's projects;
//   - a task whose stored project the registry does not know vanishes or looks like a known one;
//   - the wide project does not say it holds the older, mixed tasks, or another project says it;
//   - a project name reaches the page unescaped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const SECTION = APP.slice(APP.indexOf('// === AcrovelIQ (read-only view, task acroveliq-vp-v1) ==='))
const ESCAPE = APP.slice(APP.indexOf('function escapeHtml('), APP.indexOf('\n}\n', APP.indexOf('function escapeHtml(')) + 3)

interface View {
  aqLoadData: () => Promise<{ projects: unknown[] }>
  aqRenderTasks: (data: unknown) => string
  aqTaskRow: (t: unknown) => string
  aqProjectPill: (data: unknown, t: unknown) => string
  aqLegacyNote: (data: unknown) => string
  aqTaskCreateClick: () => Promise<void>
  aqState: Record<string, any>
}

function load(answer: (url: string) => unknown = () => []) {
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
      return { ok: true, status: 200, json: async () => answer(url) }
    },
    console,
  })
  vm.runInContext(`${ESCAPE}\n${SECTION}\n;globalThis.__view = { aqLoadData, aqRenderTasks, aqTaskRow, aqProjectPill, aqLegacyNote, aqTaskCreateClick, aqState }`, context)
  return { view: (context as unknown as { __view: View }).__view, calls }
}

const PROJECTS = [
  { id: 'acropora', name: 'Flotta és közös', repos: [], aliases: [], legacy_mixed: true },
  { id: 'os', name: 'Acropora OS', repos: [], aliases: [], legacy_mixed: false },
  { id: 'reefclub', name: '<b>Reef</b>', repos: [], aliases: [], legacy_mixed: false },
]
const task = (over: Record<string, unknown> = {}) => ({
  id: 't-1', title: 'Feladat', assignee: 'murena', reviewer: null, priority: 'normal', last_kind: null, last_at: 1,
  paused: false, busy: false, closed: false, waits_on: 'murena', project: 'os', project_id: 'os', ...over,
})
const data = (tasks: unknown[] = [task()]) => ({ tasks, team: [{ name: 'murena' }], errors: { tasks: { ok: true } }, projects: PROJECTS })

describe('Projektek V1 page', () => {
  it('PROJ-VIEW-SERVER: a selected project goes to the server on the task list and on open-matters; "Mind" sends none', async () => {
    const { view, calls } = load((url) => (url.startsWith('/api/projects') ? PROJECTS : []))
    view.aqState.project = 'os'
    const d = await view.aqLoadData()
    const selected = calls.map((c) => c.url)
    calls.length = 0
    view.aqState.project = ''
    await view.aqLoadData()
    const all = calls.map((c) => c.url)
    expect([selected.includes('/api/tasks?project=os'), selected.includes('/api/open-matters?project=os'), selected.includes('/api/projects'), d.projects.length]).toEqual([true, true, true, 3])
    expect([all.includes('/api/tasks'), all.includes('/api/open-matters'), all.some((u) => u.includes('project='))]).toEqual([true, true, false])
  })

  it('PROJ-VIEW-FORM: the form asks for a project from the registry, the selected one as the default; without one nothing is sent', async () => {
    const { view, calls } = load(() => ({ task: { id: 't-uj' } }))
    view.aqState.data = data()
    view.aqState.form = { key: 'kulcs-0001', project: '', title: 'x', goal: 'y', assignee: '', priority: 'normal', brief_ref: '' }
    const html = view.aqRenderTasks(data())
    expect(html).toContain('Projekt (kötelező)')
    expect(html).toContain('<option value="" selected>Válassz projektet</option>')
    expect(html).toContain('<option value="os">Acropora OS</option>')
    expect(html).toContain('&lt;b&gt;Reef&lt;/b&gt;')
    await view.aqTaskCreateClick()
    // and the refusal does not leave the page busy (the buttons would stay disabled)
    expect([calls.filter((c) => c.init && c.init.method === 'POST').length, view.aqState.taskMsg.text, view.aqState.taskBusy])
      .toEqual([0, 'Válassz projektet: új feladat csak projekttel jöhet létre.', false])
    view.aqState.form.project = 'os'
    await view.aqTaskCreateClick()
    const post = calls.find((c) => c.init && c.init.method === 'POST')
    expect([post?.url, JSON.parse(post?.init.body ?? '{}').project]).toEqual(['/api/task-actions', 'os'])
  })

  it('PROJ-VIEW-UNKNOWN: a stored value the registry does not know is marked in "Mind", a known one shows its name; a filtered view drops the pill', () => {
    const { view } = load()
    view.aqState.data = data()
    expect(view.aqProjectPill(data(), task())).toContain('Acropora OS')
    expect(view.aqProjectPill(data(), task({ project: 'webshop', project_id: null }))).toContain('Ismeretlen projekt: webshop')
    view.aqState.project = ''
    expect(view.aqTaskRow(task({ project: 'webshop', project_id: null }))).toContain('Ismeretlen projekt: webshop')
    view.aqState.project = 'os'
    expect(view.aqTaskRow(task())).not.toContain('aq-pill-grey">Acropora OS')
  })

  it('PROJ-VIEW-LEGACY: Flotta és közös says it holds the older, mixed tasks; another project does not', () => {
    const { view } = load()
    view.aqState.project = 'acropora'
    expect(view.aqLegacyNote(data())).toContain('korábbi, vegyes besorolású feladatokat is tartalmaz')
    view.aqState.project = 'os'
    expect(view.aqLegacyNote(data())).toBe('')
    view.aqState.project = ''
    expect(view.aqLegacyNote(data())).toBe('')
  })
})
