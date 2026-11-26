#!/usr/bin/env node
// Render a local HTML file and write a screenshot next to it.
//
// This exists so a design agent can SEE its own work. Before this, an agent could
// write HTML and CSS but never look at the result, which is not designing, it is
// typing blind.
//
// Deliberately narrow: it takes a file path in, writes an image out, and does
// nothing else. The agent's profile allows this one script rather than `node`,
// because `node` would let it read anything its user can read and open sockets.
//
//   node scripts/design-shot.js <input.html> [output.png] [width] [height]
//
// Defaults: 1440x900 desktop. Pass 390 844 for a phone.
// Full-page by default, so a long product page comes back whole, not cropped.

const path = require('path')
const fs = require('fs')

const BROWSERS = '/home/marveen/marveen/.playwright-browsers'
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || BROWSERS

const [, , inArg, outArg, wArg, hArg] = process.argv

if (!inArg) {
  console.error('usage: node scripts/design-shot.js <input.html> [output.png] [width] [height]')
  process.exit(2)
}

const input = path.resolve(inArg)
if (!fs.existsSync(input)) {
  console.error(`FAIL: nincs ilyen fajl: ${input}`)
  process.exit(1)
}

const output = path.resolve(outArg || input.replace(/\.html?$/i, '') + '.png')
const width = Number(wArg) || 1440
const height = Number(hArg) || 900

const { chromium } = require('/home/marveen/marveen/node_modules/playwright')

;(async () => {
  // The container lacks the chrome system libs (libnspr4, libnss3, ...); they are unpacked in
  // marveen's home, reachable by full path for the fleet group (/home/marveen is 0710 fleet).
  // Without this every launch fails with "Target page, context or browser has been closed".
  const LIBS = "/home/marveen/.local/chromelibs/usr/lib/x86_64-linux-gnu"
  const ld = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
  const browser = await chromium.launch({ env: { ...process.env, LD_LIBRARY_PATH: ld, LANG: "hu_HU.UTF-8", LANGUAGE: "hu" } })
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    })

    // Collect the page's own complaints. A screenshot that looks fine can still be
    // hiding a font that never loaded or an image that 404'd, and the picture will
    // not say so.
    const problems = []
    page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`) })
    page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
    page.on('requestfailed', r => problems.push(`nem toltodott be: ${r.url()}`))

    await page.goto('file://' + input, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts && document.fonts.ready)
    await page.screenshot({ path: output, fullPage: true })

    const { w, h } = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }))

    console.log(`KESZ: ${output}`)
    console.log(`nezet: ${width}x${height} | a lap teljes merete: ${w}x${h}`)

    // A page wider than its viewport means horizontal scrolling, which is a layout
    // bug on every screen and an unusable page on a phone. Say it out loud: the
    // screenshot alone would not reveal it.
    if (w > width + 1) {
      console.log(`FIGYELEM: a lap SZELESEBB a nezetnel (${w} > ${width}), vagyis vizszintesen gorgetheto.`)
    }
    if (problems.length) {
      console.log(`FIGYELEM: ${problems.length} betoltesi vagy szkript-hiba:`)
      for (const p of problems.slice(0, 10)) console.log('  ' + p)
    } else {
      console.log('betoltesi hiba: nincs')
    }
  } finally {
    await browser.close()
  }
})().catch(e => {
  console.error('FAIL: ' + String(e).split('\n')[0])
  process.exit(1)
})
