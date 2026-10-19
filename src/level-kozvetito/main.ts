// The relay's entry point in its own container (plan v2).
//   LEVELKOZVETITO_CONFIG  the root-owned settings file, mounted read-only (default /etc/levelkozvetito/config.json)
//   LEVELKOZVETITO_PORT    the port on the internal network (default 8788)
// The OAuth client and the refresh tokens come from the files the settings name (compose secrets under
// /run/secrets); none is read from the environment, so `docker inspect` never shows one.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseRelayConfig } from './config.js'
import { googleRest } from './google.js'
import { createRelayServer } from './http.js'
import { fileLedger } from './ledger.js'
import { WRITE_URL_SHAPES } from './modify.js'
import { MailRelay, type LogFields } from './relay.js'
import { SecretStore } from './secret-store.js'
import { SecretService } from './titok.js'

function secret(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (value === '' || /\s/.test(value)) throw new Error(`secret file ${path} is empty or has whitespace`)
  return value
}

function main(): void {
  const config = parseRelayConfig(JSON.parse(readFileSync(process.env['LEVELKOZVETITO_CONFIG'] ?? '/etc/levelkozvetito/config.json', 'utf8')))
  // With a secret store named in the settings the client secret is read at the moment of use (pointer, then version,
  // then the compose secret as version 0), so a new value is taken without a restart; without one it is read once.
  const store = config.secretStoreDir
    ? new SecretStore({ dir: config.secretStoreDir, legacy: { 'oauth-client-secret': config.oauthClientSecretFile } })
    : null
  // fail fast: a damaged pointer or a missing active version keeps the relay from starting, not from answering wrongly later
  store?.read('oauth-client-secret')
  const google = googleRest({
    clientId: secret(config.oauthClientIdFile),
    clientSecret: store ? () => store.read('oauth-client-secret') : secret(config.oauthClientSecretFile),
    refreshTokens: { info: secret(config.accounts.info.refreshTokenFile), balazs: secret(config.accounts.balazs.refreshTokenFile) },
    // the only two shapes a POST may take: create one of the five labels, change the labels of one message
    writeShapes: WRITE_URL_SHAPES,
  })
  const logFile = join(config.stateDir, 'naplo.jsonl')
  // one JSON line per call, on stdout and in the state volume; the line never carries mail content
  const log = (fields: LogFields): void => {
    const line = `${JSON.stringify(fields)}\n`
    process.stdout.write(line)
    try {
      appendFileSync(logFile, line, { mode: 0o600 })
    } catch {
      // the stdout line stands; a full or missing state volume must not stop a read
    }
  }
  const port = Number(process.env['LEVELKOZVETITO_PORT'] ?? '8788')
  const relay = new MailRelay({ config, google, log, ledger: fileLedger(join(config.stateDir, 'archivalt.jsonl')) })
  const secrets = store ? new SecretService({ config, google, store, log }) : undefined
  createRelayServer(relay, secrets).listen(port, '0.0.0.0', () => {
    log({ at: new Date().toISOString(), event: 'listening', port, callers: config.callers.length, secretWriters: config.secretWriters.length })
  })
}

try {
  main()
} catch (err) {
  process.stderr.write(`${JSON.stringify({ event: 'start_failed', error: err instanceof Error ? err.message : 'unknown' })}\n`)
  process.exit(1)
}
