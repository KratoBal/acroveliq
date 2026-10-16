// The executor image compiles in one stage and runs in another (deploy-executor/Dockerfile).
// With "module": "NodeNext" the compiler picks the output format from the nearest
// package.json at BUILD time (/build/package.json, copied from deploy-executor/build/), and
// node picks the loader from the nearest package.json at RUN time (/app/package.json, copied
// from deploy-executor/). When the two disagree the image builds green and dies on start:
// on 2026-10-16 the first install printed "exports is not defined in ES module scope".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const typeOf = (rel: string): string =>
  (JSON.parse(readFileSync(join(root, rel), 'utf8')) as { type?: string }).type ?? 'commonjs'

describe('deploy executor module format', () => {
  it('compiles in the same module format the runtime loads', () => {
    expect(typeOf('deploy-executor/build/package.json')).toBe(typeOf('deploy-executor/package.json'))
  })

  it('the Dockerfile still copies the two package.json files this test reads', () => {
    const dockerfile = readFileSync(join(root, 'deploy-executor', 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('COPY deploy-executor/build/package.json')
    expect(dockerfile).toContain('COPY deploy-executor/package.json ./package.json')
  })
})
