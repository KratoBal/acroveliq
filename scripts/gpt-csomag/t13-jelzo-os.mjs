#!/usr/bin/env node
// ANSWERS: Mit kap a masodik modell a T13 otodik osztalyabol, es hany beultetett esetet jelzett a valasza?
//
// The calling agent's side of the T13 fifth-class runner (task research-s7-t13-rokon-hatas; plan v4, 10 T13 and
// 7a 3.-4.; barracuda #331 CHANGES, 39464). It loads the OS build (packages/knowledge-base), so it runs as the
// CALLING AGENT'S OWN USER, never as marveen: an OS checkout is a tree agents can write, and marveen is the widest
// user. The marveen side (src/t13-flag-runner.ts) reads only the data this writes.
//
//   node scripts/gpt-csomag/t13-jelzo-os.mjs bemenet --os <acropora-os, built> --ki <folder>
//     -> <folder>/inputs.json (for marveen: no case id, no polarity, no marker) and <folder>/key.json (stays here)
//   node scripts/gpt-csomag/t13-jelzo-os.mjs pontoz --os <acropora-os, built> --kulcs <key.json> --valasz <answer.txt>
//     -> the OS's scoreFlags on the answer's lines; the report on stdout, score.json beside the key
//
// The answer is read line by line (`<ref> JELEZ` / `<ref> NEM`). A line it cannot read is counted, never guessed,
// and is no verdict: silence flags nothing (7a 3.), so a planted item without a verdict sends the class to manual
// review. A verdict on a ref outside the key, or two on one ref, is an answer of another set: no score.
// Exit: 0 written or scored (MANUAL REVIEW is a result); 1 no result; 2 wrong usage or run as marveen.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERDICT_LINE = /^\s*`?(f\d{2})`?\s+`?(JELEZ|NEM)`?\s*$/u

/** The verdicts the answer states, and the non-empty lines that are none (counted, not guessed). */
export function parseVerdicts(text) {
  const verdicts = []
  const unreadable = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = VERDICT_LINE.exec(line)
    if (m) verdicts.push({ ref: m[1], flagged: m[2] === 'JELEZ' })
    else unreadable.push(line.slice(0, 200))
  }
  return { verdicts, unreadable }
}

/** The OS's knowledge-base build; refuses one without the fifth class (an old checkout or no build). */
export async function loadKnowledgeBase(osDir) {
  const entry = join(osDir, 'packages', 'knowledge-base', 'dist', 'index.js')
  let kb
  try { kb = await import(pathToFileURL(entry).href) } catch (e) { throw new Error(`az OS build nem toltheto be (${entry}): ${e.message}`) }
  for (const name of ['flagInputs', 'scoreFlags', 'formatFlagScore', 'vocabularyV1'])
    if (typeof kb[name] !== 'function') throw new Error(`az OS buildben nincs ${name}: regi ag vagy nincs build`)
  return kb
}

/** Writes inputs.json (world-readable: marveen reads it) and key.json (the agent's own). */
export function writeInputs(kb, dir) {
  const { inputs, key } = kb.flagInputs(kb.vocabularyV1())
  mkdirSync(dir, { recursive: true })
  const inputFile = join(dir, 'inputs.json')
  writeFileSync(inputFile, `${JSON.stringify(inputs, null, 2)}\n`, { mode: 0o644 })
  writeFileSync(join(dir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 })
  return { inputFile, items: inputs.length }
}

/** The score of one answer, or why there is none. */
export function score(kb, key, answer) {
  const { verdicts, unreadable } = parseVerdicts(answer)
  try {
    const s = kb.scoreFlags(key, verdicts)
    return { ok: true, score: s, verdicts, unreadable, report: kb.formatFlagScore(s) }
  } catch (e) {
    return { ok: false, why: `a valasz nem ehhez a keszlethez szol (${e.message})`, verdicts, unreadable }
  }
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv
  if (cmd !== 'bemenet' && cmd !== 'pontoz') return null
  const o = { cmd }
  const allowed = cmd === 'bemenet' ? ['--os', '--ki'] : ['--os', '--kulcs', '--valasz']
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1]) return null
    o[rest[i].slice(2)] = rest[i + 1]
  }
  return allowed.every((f) => o[f.slice(2)]) ? o : null
}

function isInvokedDirectly() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '')
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  const say = (s) => process.stdout.write(`${s}\n`)
  const a = parseArgs(process.argv.slice(2))
  if (!a) {
    process.stderr.write('Hasznalat: t13-jelzo-os.mjs bemenet --os <acropora-os> --ki <mappa> | pontoz --os <acropora-os> --kulcs <key.json> --valasz <answer.txt>\n')
    process.exit(2)
  }
  if (userInfo().username === 'marveen') {
    say('NEM FUTOK marveen-kent: ez a resz az OS buildjet tolti be, a hivo agens sajat felhasznaloja futtassa.')
    process.exit(2)
  }
  try {
    const kb = await loadKnowledgeBase(a.os)
    if (a.cmd === 'bemenet') {
      const r = writeInputs(kb, a.ki)
      say(`bemenet: ${r.inputFile} (${r.items} tetel); a kulcs mellette marad`)
    } else {
      const key = JSON.parse(readFileSync(a.kulcs, 'utf8'))
      const r = score(kb, key, readFileSync(a.valasz, 'utf8'))
      writeFileSync(join(dirname(a.kulcs), 'score.json'), `${JSON.stringify(r, null, 2)}\n`)
      if (!r.ok) { say(`NINCS PONTSZAM: ${r.why}`); process.exit(1) }
      say(r.report)
      if (r.unreadable.length) say(`  ${r.unreadable.length} olvashatatlan valasz-sor (nem itelet: jelzetlennek szamit)`)
    }
  } catch (e) {
    say(`NINCS EREDMENY: ${e.message}`)
    process.exit(1)
  }
}
