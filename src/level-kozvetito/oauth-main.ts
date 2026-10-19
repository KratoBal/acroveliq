// The consent command, a one-off container the owner runs (README, "Consent"). Two steps:
//   node oauth-main.js url  <info|balazs>        prints the consent address, remembers its `state`
//   node oauth-main.js code <info|balazs> -      reads the pasted address (or code) from STDIN, stores the token
// The token is written to the account's refreshTokenFile (a path in the settings) mode 0400, owned by the relay's
// user, through a temp file and a rename (token-file.ts: root without DAC_OVERRIDE cannot open that file for writing);
// it is never printed. The OAuth client comes from the same compose secrets as the relay.
// The `state` of a consent is kept NEXT TO the token file, in the root-owned secrets directory: root writes and deletes there as
// the directory's owner, with no capability. The relay's state volume (10003, 0700) would need DAC_OVERRIDE for that.
import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ACCOUNTS, parseRelayConfig, type AccountId } from './config.js'
import { codeFrom, consentUrl, exchangeCode, OauthError } from './oauth.js'
import { SecretStore } from './secret-store.js'
import { replaceTokenFile } from './token-file.js'

function secret(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (value === '' || /\s/.test(value)) throw new OauthError(`secret file ${path} is empty or has whitespace`)
  return value
}

async function main(): Promise<void> {
  const [verb, accountArg, input] = process.argv.slice(2)
  const account = ACCOUNTS.find((a) => a === accountArg) as AccountId | undefined
  if ((verb !== 'url' && verb !== 'code') || !account) throw new OauthError('usage: oauth-main.js url|code <info|balazs> [-]')
  const config = parseRelayConfig(JSON.parse(readFileSync(process.env['LEVELKOZVETITO_CONFIG'] ?? '/etc/levelkozvetito/config.json', 'utf8')))
  const clientId = secret(config.oauthClientIdFile)
  const target = config.accounts[account].refreshTokenFile
  const stateFile = join(dirname(target), `oauth-state-${account}`)

  if (verb === 'url') {
    const state = randomBytes(16).toString('hex')
    writeFileSync(stateFile, state, { mode: 0o600 })
    process.stdout.write(`${consentUrl(clientId, account, state)}\n`)
    return
  }

  if (input !== '-') throw new OauthError('the pasted address comes on STDIN: `code <account> - < file`')
  const pasted = readFileSync(0, 'utf8')
  const code = codeFrom(pasted, readFileSync(stateFile, 'utf8').trim())
  // the same reader as the relay: with a secret store the ACTIVE client secret, so a consent after a rotation uses it
  const clientSecret = config.secretStoreDir
    ? new SecretStore({ dir: config.secretStoreDir, legacy: { 'oauth-client-secret': config.oauthClientSecretFile } }).read('oauth-client-secret')
    : secret(config.oauthClientSecretFile)
  const token = await exchangeCode({ clientId, clientSecret, code, account })
  // a re-consent replaces the token on purpose: the file is swapped for a new one (token-file.ts), never opened for writing
  const uid = Number(process.env['LEVELKOZVETITO_SECRET_UID'] ?? '10003')
  replaceTokenFile(target, token, uid)
  // the code is single-use and so is the state: a second paste of the same address finds nothing to match
  unlinkSync(stateFile)
  process.stdout.write(`OK the refresh token of ${account} is stored (mode 0400, uid ${uid}); it is not shown\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`FAIL ${err instanceof Error ? err.message : 'unknown'}\n`)
  process.exit(1)
})
