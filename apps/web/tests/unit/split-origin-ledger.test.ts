// @vitest-environment node
//
// Refusal self-test of the split-origin ledger (`tests/e2e/split-origin/ledger.ts`): the browser
// harness is only as good as the check it applies, so every kind of leak it exists to catch is
// fed to it here and must be reported, and the routes of a real-identity community run must not.

import { describe, expect, it } from 'vitest'
import { splitOriginViolations, type SplitOrigins } from '../e2e/split-origin/ledger'

const ORIGINS: SplitOrigins = {
  spa: 'https://community.example.org',
  api: 'https://api.example.org',
  auth: 'https://auth.example.org',
  matrix: 'https://matrix.community.example.org',
  livekit: 'wss://livekit.community.example.org',
}

const check = (...urls: string[]) =>
  splitOriginViolations(
    urls.map((url) => ({ url })),
    ORIGINS
  )

describe('the split-origin ledger', () => {
  it('admits every route of a real-identity community run', () => {
    expect(
      check(
        'https://community.example.org/community/workspace',
        'https://community.example.org/src/main.tsx',
        'https://community.example.org/.well-known/matrix/client',
        'https://community.example.org/auth/callback?code=c&state=s',
        'https://community.example.org/espace/callback?state=s',
        'https://auth.example.org/realms/community/.well-known/openid-configuration',
        'https://auth.example.org/realms/community/protocol/openid-connect/token',
        'https://api.example.org/api/v1/me',
        'https://api.example.org/api/v1/community/support/tickets',
        'https://matrix.community.example.org/_matrix/client/v3/login',
        'https://matrix.community.example.org/_matrix/client/v3/login/sso/redirect?redirectUrl=x',
        'https://matrix.community.example.org/_kodera/rooms/token',
        'wss://livekit.community.example.org/rtc/v1?access_token=t',
        'https://livekit.community.example.org/rtc/v1/validate?access_token=t',
        'data:image/png;base64,AAAA'
      )
    ).toEqual([])
  })

  it('reports a relative backend call that reached the static origin', () => {
    expect(
      check(
        'https://community.example.org/api/v1/me',
        'https://community.example.org/_matrix/client/v3/sync',
        'https://community.example.org/_kodera/rooms/token',
        'https://community.example.org/_synapse/client/oidc/callback',
        'https://community.example.org/realms/community/protocol/openid-connect/token'
      )
    ).toEqual([
      'same-origin backend call: /api/v1/me',
      'same-origin backend call: /_matrix/client/v3/sync',
      'same-origin backend call: /_kodera/rooms/token',
      'same-origin backend call: /_synapse/client/oidc/callback',
      'same-origin backend call: /realms/community/protocol/openid-connect/token',
    ])
  })

  it('reports an origin outside the map, including look-alikes and other ports or schemes', () => {
    expect(
      check(
        'https://elsewhere.example.org/api/v1/me',
        'https://api.example.org.attacker.test/api/v1/me',
        'https://api.example.org:8443/api/v1/me',
        'http://api.example.org/api/v1/me',
        'wss://media.community.example.org/rtc'
      )
    ).toEqual([
      'disallowed origin: https://elsewhere.example.org/api/v1/me',
      'disallowed origin: https://api.example.org.attacker.test/api/v1/me',
      'disallowed origin: https://api.example.org:8443/api/v1/me',
      'disallowed origin: http://api.example.org/api/v1/me',
      'disallowed origin: wss://media.community.example.org/rtc',
    ])
  })

  it('reports a backend origin asked for a path it does not serve', () => {
    expect(
      check(
        'https://matrix.community.example.org/_matrix/federation/v1/version',
        'https://matrix.community.example.org/_matrix/key/v2/server',
        'https://matrix.community.example.org/api/v1/me',
        'https://api.example.org/agent/heartbeat',
        'https://api.example.org/_matrix/client/v3/login',
        'wss://livekit.community.example.org/other'
      )
    ).toEqual([
      'misrouted path on matrix: /_matrix/federation/v1/version',
      'misrouted path on matrix: /_matrix/key/v2/server',
      'misrouted path on matrix: /api/v1/me',
      'misrouted path on api: /agent/heartbeat',
      'misrouted path on api: /_matrix/client/v3/login',
      'misrouted path on livekit: /other',
    ])
  })
})
