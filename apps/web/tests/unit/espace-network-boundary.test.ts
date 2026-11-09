// @vitest-environment node

// The ESLint half of the browser boundary (messaging-pilot design §2.7): `fetch` stays Core's,
// through the generated client, with the workspace's homeserver as the one named exception (its
// client-server API, the room-access call on its origin, and its discovery), matrix-js-sdk stays behind Espace's
// store, and livekit-client behind Espace's audio call. Each rule is proven to fire where it should, and
// to stay quiet only in the files it exempts. The CSP's `connect-src` is the boundary the
// browser enforces; this one catches the plain forms before review.

import { ESLint } from 'eslint'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const lint = new ESLint({ cwd: root, fix: false })

// ESLint's first run loads the whole config and its plugins: seconds on a cold machine. Paid
// here, so no test's own timeout carries it.
beforeAll(async () => {
  await lint.lintText('export {}\n', { filePath: `${root}src/features/warm-up.ts` })
}, 60_000)

const network = [
  "export const a = () => fetch('https://elsewhere.example/')",
  "export const b = () => globalThis.fetch('https://elsewhere.example/')",
  "export const c = () => window.fetch('https://elsewhere.example/')",
  "export const d = () => self.fetch('https://elsewhere.example/')",
].join('\n')
const sdk = "import { createClient } from 'matrix-js-sdk'\nexport const e = createClient"
const livekit = "import { Room } from 'livekit-client'\nexport const f = Room"

async function rulesFired(source: string, path: string): Promise<(string | null)[]> {
  const [result] = await lint.lintText(source, { filePath: `${root}${path}` })
  return result!.messages.filter((message) => message.severity === 2).map((m) => m.ruleId)
}

describe('fetch in the browser bundle', () => {
  it('is refused in every form the rules know, anywhere in src/ but the homeserver files', async () => {
    for (const path of [
      'src/features/order/probe.ts',
      'src/auth/oidc-probe.ts',
      // The audio call itself reaches LiveKit through the SDK, never through fetch.
      'src/features/espace/audio/call.ts',
      'src/features/espace/audio/probe.ts',
      // Beside the resolver, not the resolver: the exemption names one file.
      'src/features/espace/homeserver-probe.ts',
      'src/features/workspace/OpenEspace.tsx',
    ]) {
      expect(await rulesFired(network, path), path).toEqual([
        'no-restricted-globals',
        'no-restricted-properties',
        'no-restricted-properties',
        'no-restricted-properties',
      ])
    }
  })

  it("is allowed in Espace's sign-in, store, room-access call and discovery, which call the homeserver", async () => {
    for (const path of [
      'src/auth/matrix.ts',
      'src/features/espace/matrix/probe.ts',
      'src/features/espace/audio/roomAccess.ts',
      'src/features/espace/homeserver.ts',
    ]) {
      expect(await rulesFired(network, path), path).toEqual([])
    }
  })
})

describe('matrix-js-sdk', () => {
  it("is refused outside Espace's store, and allowed inside it", async () => {
    expect(await rulesFired(sdk, 'src/features/espace/Screen.tsx')).toEqual([
      'no-restricted-imports',
    ])
    expect(await rulesFired(sdk, 'src/auth/matrix-probe.ts')).toEqual(['no-restricted-imports'])
    expect(await rulesFired(sdk, 'src/features/espace/matrix/probe.ts')).toEqual([])
    expect(await rulesFired(sdk, 'src/features/espace/audio/call.ts')).toEqual([
      'no-restricted-imports',
    ])
  })
})

describe('livekit-client', () => {
  it("is refused outside Espace's audio call, and allowed inside it", async () => {
    for (const path of [
      'src/features/espace/Screen.tsx',
      'src/features/espace/EspaceLiveView.tsx',
      'src/features/espace/matrix/store.ts',
      'src/ui/AudioDock/AudioDock.tsx',
    ]) {
      expect(await rulesFired(livekit, path), path).toEqual(['no-restricted-imports'])
    }
    expect(await rulesFired(livekit, 'src/features/espace/audio/call.ts')).toEqual([])
    expect(await rulesFired(livekit, 'src/features/espace/audio/probe.test.ts')).toEqual([])
  })
})
