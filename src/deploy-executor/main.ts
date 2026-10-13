// The executor's entry point in its own container (SB1 three-changes 1).
//   VEGREHAJTO_CONFIG  the root-owned settings file, mounted read-only
//                      (default /etc/vegrehajto/config.json)
//   VEGREHAJTO_PORT    the port on the internal network (default 8787)
// Secrets come from the files the settings name (compose secrets under
// /run/secrets); none of them is read from the environment, so `docker
// inspect` and the process environment never show one.
import { readFileSync } from 'node:fs'

import { parseExecutorConfig } from './config.js'
import { DeployExecutor } from './executor.js'
import { createExecutorServer } from './http.js'
import { RequestStore } from './store.js'
import { coolifyRest, discordRest, githubRest, readSecretFile } from './transports.js'
import { assertHungarianDates } from './verify-approval.js'

async function main(): Promise<void> {
  assertHungarianDates()
  const config = parseExecutorConfig(JSON.parse(readFileSync(process.env['VEGREHAJTO_CONFIG'] ?? '/etc/vegrehajto/config.json', 'utf8')))
  const hosts = Object.fromEntries(
    Object.entries(config.coolifyHosts).map(([name, h]) => [name, { coolifyApiUrl: h.coolifyApiUrl, token: readSecretFile(h.coolifyTokenFile) }]),
  )
  const executor = new DeployExecutor({
    config,
    store: new RequestStore(config.stateDir),
    discord: discordRest(readSecretFile(config.discord.tokenFile)),
    github: githubRest(readSecretFile(config.github.tokenFile)),
    coolify: coolifyRest(hosts),
  })
  const recovered = await executor.recover()
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'recovered', ...recovered })}\n`)
  const port = Number(process.env['VEGREHAJTO_PORT'] ?? '8787')
  createExecutorServer(executor).listen(port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'listening', port, apps: config.apps.length })}\n`)
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'start_failed', error: err instanceof Error ? err.message : 'unknown' })}\n`)
  process.exit(1)
})
