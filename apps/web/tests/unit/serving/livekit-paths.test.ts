// @vitest-environment node
// The CSP names LiveKit by path (`server/static.mjs`, ADR-0012): a bare `wss://*.{matrix domain}`
// would also match `https:` to every path of every host under the domain. The paths are the ones
// the installed livekit-client builds; this test runs the SDK's own URL builders, taken from its
// shipped bundle, and holds the server's list to what they produce, so an upgrade that moves a
// path fails here rather than in a member's browser.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageDirectory = dirname(
  dirname(createRequire(import.meta.url).resolve('livekit-client'))
)
const bundle = readFileSync(join(packageDirectory, 'dist/livekit-client.esm.mjs'), 'utf8')
const BUILDERS = [
  'toWebsocketUrl',
  'toHttpUrl',
  'ensureTrailingSlash',
  'appendUrlPath',
  'createV0RtcUrl',
  'createRtcUrl',
  'createValidateUrl',
] as const

/** A top-level function of the bundle, by name: its declaration up to its closing brace. */
function declaration(name: string): string {
  const pattern = new RegExp(`(?:^|\\n|\\})function ${name}\\(`, 'g')
  const matches = [...bundle.matchAll(pattern)]
  expect(matches, name).toHaveLength(1)
  const start = bundle.indexOf(`function ${name}(`, matches[0]!.index)
  const end = bundle.indexOf('\n}', start)
  expect(end, name).toBeGreaterThan(start)
  return bundle.slice(start, end + 2)
}

type Builders = {
  createRtcUrl: (url: string, params: URLSearchParams, useV0Path?: boolean) => URL
  createValidateUrl: (rtcWsUrl: string) => URL
}

function builders(): Builders {
  // The lockfile's own dependency, which the Console already runs, in a context with `URL` alone.
  const source = BUILDERS.map(declaration).join('\n')
  return runInNewContext(`${source}\n({ createRtcUrl, createValidateUrl })`, {
    URL,
  }) as Builders
}

function serverPaths(): string[] {
  const server = readFileSync(resolve('server/static.mjs'), 'utf8')
  const literal = /const LIVEKIT_PATHS = \[([^\]]*)\]/.exec(server)
  expect(literal).not.toBeNull()
  return [...literal![1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!)
}

describe("LiveKit's paths in the CSP", () => {
  it('are exactly the signalling and validation URLs the SDK builds', () => {
    const { createRtcUrl, createValidateUrl } = builders()
    const params = new URLSearchParams({ access_token: 'fixture' })
    const opened = new Set<string>()
    for (const useV0Path of [false, true]) {
      const rtc = createRtcUrl('wss://acme-sa.kodera.fixture.test', params, useV0Path)
      expect(rtc.protocol).toBe('wss:')
      expect(rtc.host).toBe('acme-sa.kodera.fixture.test')
      const validate = createValidateUrl(rtc.toString())
      // Over HTTP: what a `wss` source admits under CSP Level 3 scheme matching.
      expect(validate.protocol).toBe('https:')
      expect(validate.host).toBe('acme-sa.kodera.fixture.test')
      opened.add(rtc.pathname).add(validate.pathname)
    }
    expect([...opened].sort()).toEqual(serverPaths().sort())
  })

  it('assume the server URL has no path, as the room-access call requires', () => {
    const { createRtcUrl } = builders()
    // With a path, every URL moves under it, and none of the CSP's sources would match.
    expect(
      createRtcUrl('wss://acme-sa.kodera.fixture.test/livekit', new URLSearchParams()).pathname
    ).toBe('/livekit/rtc/v1')
  })
})
