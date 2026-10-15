#!/usr/bin/env node
// docs/FIGMA-MAP.md validator for the AcrovelIQ web page (the same shape as the Acropora OS one).
//
// What it checks, row by row:
//   - the table header is exactly the seven columns;
//   - the node cell is `[a:b](https://www.figma.com/design/<file>?node-id=a-b)`, the id and the link agree,
//     and the file key is the one in the document's "Figma file" line;
//   - a route `acroveliq/<view>` names a `data-aq-view="<view>"` that exists in web/index.html;
//   - a component names a function that exists in web/app.js (`function x(` or `async function x(`);
//   - a row with a route or component carries "Utoljára egyeztetve" as `YYYY-MM-DD · <commit>`;
//   - a node appears on one row only (a copied row that kept its node would map one frame twice);
//   - EVERY table whose first header cell starts with "Figma" has exactly the seven columns: a
//     misspelt header would otherwise make the whole table silently not a mapping table, and the
//     minimum below only catches that while the map is small (barracuda, #206 review).
// What it does NOT check: that the function is the RIGHT one for that design, or that the screen
// still matches the design. That is the review's job, and the "Utoljára egyeztetve" date says when.
//
// It fails on an empty parse too (fewer rows or references than the map holds today), so a
// broken table cannot pass as a clean one.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

const HEADER = ['Figma Page / Section', 'Node', 'App', 'Route pattern', 'Component area', 'Utoljára egyeztetve', 'Megjegyzés']
const SKIPPED = new Set(['', '—', '-', 'nincs'])
const MIN_ROWS = 20
const MIN_COMPONENT_REFS = 6

const markdown = read('docs/FIGMA-MAP.md')
const indexHtml = read('web/index.html')
const appJs = read('web/app.js')

const views = new Set([...indexHtml.matchAll(/data-aq-view="([a-z0-9-]+)"/g)].map((m) => m[1]))
const fileKey = /Figma file: \[[^\]]*\]\(https:\/\/www\.figma\.com\/design\/([A-Za-z0-9]+)\)/.exec(markdown)?.[1]

const errors = []
if (!fileKey) errors.push('no "Figma file: [...](https://www.figma.com/design/<key>)" line')

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const refs = (value) => value.split('<br>').map((r) => r.trim().replace(/^`|`$/g, '')).filter((r) => !SKIPPED.has(r))

let rows = 0
let componentRefs = 0
let header = null
const seenNodes = new Map()
for (const [index, line] of markdown.split(/\r?\n/).entries()) {
  const where = `docs/FIGMA-MAP.md:${index + 1}`
  if (!line.trim().startsWith('|')) {
    header = null
    continue
  }
  const row = cells(line)
  if (row.every((c) => /^:?-+:?$/.test(c))) continue
  if (header === null) {
    header = row
    if (/^figma/i.test(row[0]) && row.join('|') !== HEADER.join('|')) {
      errors.push(`${where}: the header is not the seven columns: ${row.join(' | ')}`)
    }
    continue
  }
  if (header[0] !== 'Figma Page / Section') continue
  rows += 1
  const [, node, , route, component, checked] = row

  const nodeMatch = /^\[(\d+):(\d+)\]\(https:\/\/www\.figma\.com\/design\/([A-Za-z0-9]+)\?node-id=(\d+)-(\d+)\)$/.exec(node)
  if (!nodeMatch) errors.push(`${where}: node cell is not [a:b](https://www.figma.com/design/<key>?node-id=a-b): ${node}`)
  else {
    const [, a, b, key, la, lb] = nodeMatch
    if (a !== la || b !== lb) errors.push(`${where}: node ${a}:${b} links to ${la}-${lb}`)
    const id = `${a}:${b}`
    if (seenNodes.has(id)) errors.push(`${where}: node ${id} is already mapped on line ${seenNodes.get(id)}`)
    else seenNodes.set(id, index + 1)
    if (fileKey && key !== fileKey) errors.push(`${where}: node links to file ${key}, the document names ${fileKey}`)
  }

  for (const r of refs(route)) {
    const view = /^acroveliq\/([a-z0-9-]+)$/.exec(r)?.[1]
    if (!view) errors.push(`${where}: route is not acroveliq/<view>: ${r}`)
    else if (!views.has(view)) errors.push(`${where}: no data-aq-view="${view}" in web/index.html`)
  }
  const components = refs(component)
  for (const fn of components) {
    componentRefs += 1
    if (!/^[A-Za-z_$][\w$]*$/.test(fn)) errors.push(`${where}: component is not a function name: ${fn}`)
    else if (!new RegExp(`(^|\\n)\\s*(async\\s+)?function ${fn.replace(/\$/g, '\\$')}\\(`).test(appJs)) {
      errors.push(`${where}: no function ${fn}( in web/app.js`)
    }
  }
  if (refs(route).length + components.length > 0 && !/^\d{4}-\d{2}-\d{2} · [0-9a-f]{7,40}$/.test(checked)) {
    errors.push(`${where}: a mapped row needs "Utoljára egyeztetve" as YYYY-MM-DD · <commit>, got: ${checked}`)
  }
}

if (rows < MIN_ROWS) errors.push(`only ${rows} mapping rows parsed (expected at least ${MIN_ROWS})`)
if (componentRefs < MIN_COMPONENT_REFS) errors.push(`only ${componentRefs} component references parsed (expected at least ${MIN_COMPONENT_REFS})`)

if (errors.length) {
  for (const e of errors) console.error(`FIGMA-MAP: ${e}`)
  process.exit(1)
}
console.log(`FIGMA-MAP ok: ${rows} rows, ${componentRefs} component references, ${views.size} views in web/index.html`)
