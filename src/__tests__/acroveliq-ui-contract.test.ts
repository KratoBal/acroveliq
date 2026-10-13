// String-contract guard for the read-only AcrovelIQ page (task acroveliq-vp-v1;
// the house idiom of approvals-ui-contract.test.ts). WHAT TURNS THIS RED:
//   - the sidebar link, the page shell or the router hook is gone;
//   - the page sends anything but a GET: Balázs's decision is that the surface
//     hands out, restarts and approves nothing (17:51:01 UTC, msg 1559624518904061984);
//   - it stops reading one of its five sources, or invents demo data;
//   - "Döntéseim" stops showing the three /api/open-matters groups with their source,
//     an empty group without saying so, or an unreachable source as an empty list.
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

  it('is read only: no request but a GET, no other method named at all', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    // every fetch goes through aqGet, and aqGet passes no options
    expect(SECTION.match(/fetch\(/g)).toEqual(['fetch('])
    expect(SECTION).toContain('const res = await fetch(url)\n')
    expect(SECTION).not.toMatch(/method\s*:|'(POST|PUT|PATCH|DELETE)'|"(POST|PUT|PATCH|DELETE)"/)
  })

  it('reads the five measured sources and the per-task timeline', () => {
    for (const url of ["'/api/tasks'", "'/api/agents'", "'/api/agents/activity'", "'/api/messages/backlog'", "'/api/open-matters'", "'/timeline'"])
      expect(SECTION).toContain(url)
  })

  it('Döntéseim lists the three open-matters groups with their source, and no sample data is shipped', () => {
    const START_D = SECTION.indexOf('function aqRenderDecisions(')
    const D = SECTION.slice(START_D, SECTION.indexOf('\n}\n', START_D))
    expect(START_D).toBeGreaterThan(0)
    for (const field of ['it.decisions', 'it.balazs_questions', 'it.owes']) expect(D).toContain(field)
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
