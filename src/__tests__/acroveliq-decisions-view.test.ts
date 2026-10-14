// The Döntéseim V1 view (task dontesek-v1-frontend; Balázs's decision B, 2026-10-14
// 08:52:26 UTC, msg 1559851364950220852), run for real: the AcrovelIQ section of
// web/app.js in a bare vm context, with a fake fetch. WHAT TURNS THIS RED:
//   - a waiting decision does not show its summary, reason, consequence, task and
//     requester, or its three buttons;
//   - a missing field is filled with invented text instead of "nincs megadva";
//   - the Discord-answered, the expired and the recent rows are not in their own groups;
//   - a decided or expired row offers the buttons, or "Megbeszélést kérek" stays
//     clickable on a row already marked for discussion;
//   - the text of a row is not escaped;
//   - the write is not one POST to /api/decisions/<id> with {action}, or an action
//     outside the three reaches fetch.
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
  aqRenderDecisions: (data: unknown) => string
  aqDecide: (id: string, action: string) => Promise<{ ok: boolean; status?: number; error?: string }>
  aqState: Record<string, unknown>
}

function load(fetchImpl: (url: string, init?: unknown) => Promise<unknown> = async () => ({ ok: true, json: async () => ({}) })) {
  const calls: Array<{ url: string; init: unknown }> = []
  const context = vm.createContext({
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      // what a browser does for escapeHtml: textContent in, innerHTML out (& < > escaped)
      createElement: () => {
        let text = ''
        return {
          set textContent(v: unknown) { text = String(v) },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
        }
      },
    },
    fetch: async (url: string, init?: unknown) => {
      calls.push({ url, init })
      return fetchImpl(url, init)
    },
    console,
  })
  vm.runInContext(`${ESCAPE}\n${SECTION}\n;globalThis.__view = { aqRenderDecisions, aqDecide, aqState }`, context)
  return { view: (context as unknown as { __view: View }).__view, calls }
}

const now = Math.floor(Date.now() / 1000)
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, requested_by: 'acrobot', task_id: 'feladat-1', summary: `Összefoglaló ${id}`, reason: `Indok ${id}`,
  consequence: `Következmény ${id}`, status: 'pending', requested_at: now - 3600, timeout_at: now + 86400,
  resolved_at: null, resolved_by: null, discuss_requested_at: null, discord_message: null, ...over,
})
const data = (dontes: Record<string, unknown>) => ({
  errors: { openMatters: { ok: true } },
  items: {
    owes: [], decisions: [], balazs_questions: [],
    dontes: { pending: [], discuss: [], discord_replied: [], expired: [], recent: [], recent_discord: [], ...dontes },
  },
})

describe('Döntéseim V1 view', () => {
  it('DEC-VIEW-WAITING: a waiting decision with its details and the three actions', () => {
    const { view } = load()
    const html = view.aqRenderDecisions(data({ pending: [row('d1')] }))
    for (const text of ['Összefoglaló d1', 'Indok d1', 'Ha jóváhagyod: Következmény d1', 'data-aq-task="feladat-1"', 'Kérte: acrobot', 'Vár rád',
      '1 döntés vár rád', 'Éles jóváhagyás csak hiteles kapcsolaton át', 'Egyéb nyitott ügyek'])
      expect(html, text).toContain(text)
    const actions = [...html.matchAll(/data-aq-decide="(\w+)" data-aq-id="d1"(?: disabled)?>/g)].map((m) => m[1])
    expect(actions).toEqual(['approve', 'reject', 'discuss'])
    expect(html).not.toMatch(/data-aq-decide="\w+" data-aq-id="d1" disabled/)
  })

  it('DEC-VIEW-NOT-GIVEN: a missing field says so, and a row text is escaped', () => {
    const { view } = load()
    const html = view.aqRenderDecisions(data({ pending: [row('d2', { reason: null, consequence: '', task_id: null, summary: '<img src=x onerror=1>' })] }))
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html.match(/nincs megadva/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('DEC-VIEW-GROUPS: Discord-answered, expired and recent rows stand in their own groups; only open rows get buttons', () => {
    const { view } = load()
    const d = data({
      discuss: [row('talk', { discuss_requested_at: now - 60 })],
      discord_replied: [row('dc', { discord_message: '1559851364950220852' })],
      expired: [row('old', { status: 'timeout', resolved_at: now - 100 })],
      recent: [row('done', { status: 'approved', resolved_at: now - 50, resolved_by: 'Balazs' })],
      recent_discord: [{ task: 'feladat-2', handoff: 7, what: 'B változat', quote: 'Döntésem: B', discord_messages: ['1559851364950220852'], at: now - 10 }],
    })
    const html = view.aqRenderDecisions(d)
    for (const text of ['Megbeszélésre vár', 'Discordon válaszoltál, megerősítésre vár · 1', 'Lejárt, döntés nélkül · 1', 'Legutóbbi döntéseid · 2', 'B változat', 'Jóváhagyva'])
      expect(html, text).toContain(text)
    // the first waiting row is selected: discussion already asked, so that button waits
    expect(html).toContain('data-aq-decide="discuss" data-aq-id="talk" disabled')
    expect(html).toContain('data-aq-decide="approve" data-aq-id="talk">')

    view.aqState.decision = 'done'
    const decided = view.aqRenderDecisions(d)
    expect(decided).not.toContain('data-aq-decide=')
    expect(decided).toContain('Eldöntve:')
    view.aqState.decision = 'old'
    expect(view.aqRenderDecisions(d)).not.toContain('data-aq-decide=')
  })

  it('DEC-VIEW-DISCORD-LINK: the answer opens on Discord when the server gave a discord.com link; anything else stays an id', () => {
    const { view } = load()
    const link = 'https://discord.com/channels/1538520890822885418/1540270627926183997/1559851364950220852'
    const html = view.aqRenderDecisions(data({ discord_replied: [row('dc', { discord_message: '1559851364950220852', discord_url: link })] }))
    expect(html).toContain(`<a href="${link}" target="_blank" rel="noreferrer">a válaszod megnyitása a Discordon</a>`)
    const bad = view.aqRenderDecisions(data({ discord_replied: [row('dc', { discord_message: '1559851364950220852', discord_url: 'javascript:alert(1)' })] }))
    expect(bad).not.toContain('<a href=')
    expect(bad).toContain('Discordon válaszoltál: üzenet 1559851364950220852')
  })

  it('DEC-VIEW-EMPTY: nothing waiting says so, an unreachable source is not an empty list', () => {
    const { view } = load()
    expect(view.aqRenderDecisions(data({}))).toContain('Most egy döntés sem vár rád.')
    expect(view.aqRenderDecisions({ errors: { openMatters: { ok: false, error: 'HTTP 403' } }, items: null }))
      .toContain('Ez nem azt jelenti, hogy nincs döntésre váró ügy.')
  })

  it('DEC-VIEW-WRITE: one POST to /api/decisions/<id> with {action}; an unknown action never reaches fetch', async () => {
    const { view, calls } = load(async () => ({ ok: false, status: 403, json: async () => ({ error: 'owner session only' }) }))
    const out = await view.aqDecide('a/b', 'approve')
    const refused = await view.aqDecide('a/b', 'delete')
    expect([calls.map((c) => [c.url, JSON.stringify(c.init)]), out, refused.ok]).toEqual([
      [['/api/decisions/a%2Fb', JSON.stringify({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"approve"}' })]],
      { ok: false, status: 403, error: 'owner session only' },
      false,
    ])
  })
})
