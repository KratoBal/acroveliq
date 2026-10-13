import { describe, it, expect } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { buildTtsDirective } from '../web/voice-directive.js'

// The voice reply directive used to embed the SHARED dashboard token, so its
// route was the session's only and the agents' own hook got 403 under
// enforcement (acrovelIQ P0-1). It now carries no token: the command reads the
// caller's own at run time, through the same resolver as the helpers.
describe('buildTtsDirective carries no token', () => {
  const directive = buildTtsDirective({ chatId: '12345', stateDir: '/tmp/state', voiceModel: 'hu_HU-imre-medium' })

  it('VOICE-NOTOKEN: the only Authorization value is read at run time from the resolved file, through a file descriptor', () => {
    expect((directive ?? '').match(/Bearer/g)).toHaveLength(1)
    expect(directive, 'VOICE-NOTOKEN').toContain(`-H @<(printf 'Authorization: Bearer %s\\n' "$(cat "$TOKEN_FILE")") -d @-`)
  })

  it('VOICE-RESOLVER: the token file comes from the helpers\' resolver for this install', () => {
    expect(directive).toContain(`. '${PROJECT_ROOT}/scripts/lib/dashboard-token.sh'; TOKEN_FILE="$(dashboard_token_file '${PROJECT_ROOT}')"`)
  })

  it('VOICE-NOFILE: built without reading any token file (it used to be null without one)', () => {
    expect(directive).not.toBeNull()
  })
})
