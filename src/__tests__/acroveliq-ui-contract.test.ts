// String-contract guard for the read-only AcrovelIQ page (task acroveliq-vp-v1;
// the house idiom of approvals-ui-contract.test.ts). WHAT TURNS THIS RED:
//   - the sidebar link, the page shell or the router hook is gone;
//   - the page sends anything but GETs and the ONE write of Balázs's decision B
//     (2026-10-14 08:52:26 UTC, msg 1559851364950220852): POST /api/decisions/:id with one
//     of the three actions; no PATCH, PUT or DELETE, no other POST, no other action;
//   - it stops reading one of its five sources, or invents demo data;
//   - "Döntéseim" stops showing the decision rows (Dontéseim V1: waiting, Discord-
//     answered, expired, recent) with their details and three actions, or the three
//     earlier /api/open-matters groups with their source, an empty group without saying
//     so, or an unreachable source as an empty list.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

const START = APP.indexOf('// === AcrovelIQ (read-only view, task acroveliq-vp-v1) ===')
const SECTION = START >= 0 ? APP.slice(START) : ''

describe('AcrovelIQ UI wiring', () => {
  it('sidebar link, page shell and router hook exist', () => {
    expect(HTML).toContain('data-page="acroveliq"')
    expect(HTML).toContain('id="acroveliqPage"')
    // deferred: the section's consts are declared at the end of app.js, after the boot-time router
    expect(APP).toContain("if (pageId === 'acroveliq') setTimeout(loadAcroveliq, 0)")
    expect(SECTION).toMatch(/async function loadAcroveliq\(/)
  })

  it('reads with GETs and writes only the decision and the task actions: one POST each, to their own routes', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    // three fetches: aqGet (no options), aqDecide and aqTaskWrite
    expect(SECTION.match(/fetch\(/g)).toEqual(['fetch(', 'fetch(', 'fetch('])
    expect(SECTION).toContain('const res = await fetch(url)\n')
    const DEC = SECTION.slice(SECTION.indexOf('async function aqDecide('), SECTION.indexOf('\n}\n', SECTION.indexOf('async function aqDecide(')))
    expect(DEC).toContain("fetch('/api/decisions/' + encodeURIComponent(id), {")
    expect(DEC).toContain("method: 'POST'")
    expect(DEC).toContain('body: JSON.stringify({ action })')
    // an action outside the three is refused before any request
    expect(DEC).toContain('Object.prototype.hasOwnProperty.call(AQ_DECISION_ACTIONS, action)')
    expect(SECTION).toContain("const AQ_DECISION_ACTIONS = { approve: 'Jóváhagyom', reject: 'Elutasítom', discuss: 'Megbeszélést kérek' }")
    // the task write (Feladatkezelés V1, decision B): /api/task-actions with the form's key,
    // or /api/task-actions/<id> with one of the four actions, refused before any request otherwise
    const TW = SECTION.slice(SECTION.indexOf('async function aqTaskWrite('), SECTION.indexOf('\n}\n', SECTION.indexOf('async function aqTaskWrite(')))
    expect(TW).toContain("fetch(id ? '/api/task-actions/' + encodeURIComponent(id) : '/api/task-actions', {")
    expect(TW).toContain('Object.prototype.hasOwnProperty.call(AQ_TASK_ACTIONS, body && body.action)')
    expect(TW).toContain("headers['Idempotency-Key'] = key")
    expect(SECTION).toContain("const AQ_TASK_ACTIONS = { assign: 'Felelős', priority: 'Prioritás', pause: 'Szünet', resume: 'Folytatás' }")
    // nowhere else a method, and no other verb at all
    expect(SECTION.match(/method\s*:/g)).toEqual(['method:', 'method:'])
    expect(SECTION).not.toMatch(/'(PUT|PATCH|DELETE)'|"(PUT|PATCH|DELETE)"/)
    expect(SECTION.match(/'POST'/g)).toEqual(["'POST'", "'POST'"])
  })

  it('reads the five measured sources and the per-task timeline', () => {
    for (const url of ["'/api/tasks'", "'/api/agents'", "'/api/agents/activity'", "'/api/messages/backlog'", "'/api/open-matters'", "'/timeline'"])
      expect(SECTION).toContain(url)
  })

  it('Döntéseim lists the decision rows and the three open-matters groups with their source, and no sample data is shipped', () => {
    const START_D = SECTION.indexOf('function aqRenderDecisions(')
    const D = SECTION.slice(START_D, SECTION.indexOf('\n}\n', START_D))
    expect(START_D).toBeGreaterThan(0)
    for (const field of ['it.decisions', 'it.balazs_questions', 'it.owes', 'it.dontes',
      'dt.pending', 'dt.discuss', 'dt.discord_replied', 'dt.expired', 'dt.recent', 'dt.recent_discord']) expect(D).toContain(field)
    // each group names its source, and says it when it is empty
    for (const text of ['kulcsszó: dontesre-var', 'kulcsszó: acrobot-tartozik', 'címzettje (from) Balázs',
      'Most egy hot emlék sem visel dontesre-var', 'Most egy hot emlék sem visel acrobot-tartozik', 'sincs olyan kérdés'])
      expect(D).toContain(text)
    // an unreachable source is not an empty list
    expect(D).toContain('Ez nem azt jelenti, hogy nincs döntésre váró ügy.')
    expect(SECTION).toContain("html = aqRenderDecisions(d)")
    expect(SECTION).not.toContain('Ehhez még nincs adatforrás')
    expect(SECTION).not.toMatch(/MINTAADAT|DEMO ADAT|PÉLDA/i)
  })
})
