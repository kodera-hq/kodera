// A production build served by `server/static.mjs`, the server a deployment runs, so a spec
// meets the real Content-Security-Policy instead of `vite preview`'s none. Support code, no
// assertions (docs/dev/TESTING.md §2).
//
// The build runs the mock identity provider and MSW (ADR-0007), as the default suite does, with
// the Core API and the provider on fixture origins the policy names: the worker answers them, and
// nothing leaves the machine.

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const WEB = resolve(import.meta.dirname, '../../..')
const VITE = [
  join(WEB, 'node_modules/vite/bin/vite.js'),
  join(WEB, '../../node_modules/vite/bin/vite.js'),
].find((candidate) => existsSync(candidate))!

export const CORE_ORIGIN = 'https://api.fixture.test'
export const PROVIDER_ORIGIN = 'https://id.fixture.test'

export interface StrictStaticServer {
  readonly origin: string
  close(): Promise<void>
}

function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => child.once('close', () => done()))
}

/** Builds the console in mock mode into a temporary directory and serves it under the strict policy. */
export async function startStrictStaticServer(): Promise<StrictStaticServer> {
  const root = await mkdtemp(join(tmpdir(), 'kodera-strict-style-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))
  )
  await run(process.execPath, [VITE, 'build', '--outDir', join(root, 'dist')], {
    cwd: WEB,
    env: {
      ...env,
      VITE_ENABLE_MSW: '1',
      VITE_AUTH_MODE: 'mock',
      VITE_OIDC_CLIENT_ID: 'console',
      VITE_MOCK_UNSERVED: '1',
      VITE_TENANT_DOMAIN: 'kodera.io',
      VITE_FIRST_OWNER_JOURNEY: '0',
      VITE_CORE_API_URL: `${CORE_ORIGIN}/api/v1`,
      VITE_KEYCLOAK_URL: PROVIDER_ORIGIN,
      NODE_OPTIONS: '--max-old-space-size=1536',
    },
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const server = spawn(
    process.execPath,
    [
      join(WEB, 'server/static.mjs'),
      '--root',
      join(root, 'dist'),
      '--port',
      '0',
      '--prefix',
      '/',
      '--claim-path',
      '/claim',
      '--core-origin',
      CORE_ORIGIN,
      '--provider-origin',
      PROVIDER_ORIGIN,
      '--matrix-domain',
      'kodera.invalid',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const exited = closed(server)
  const origin = await new Promise<string>((done, fail) => {
    let output = ''
    const timer = setTimeout(() => fail(Error('Strict server readiness timeout')), 5000)
    server.once('error', fail)
    server.once('close', () => fail(Error('Strict server exited before readiness')))
    server.stderr!.on('data', (chunk: Buffer) => fail(Error(`Strict server: ${String(chunk)}`)))
    server.stdout!.on('data', (chunk: Buffer) => {
      output += String(chunk)
      if (!output.includes('\n')) return
      clearTimeout(timer)
      try {
        const ready = JSON.parse(output.trim()) as { host: string; port: number }
        if (ready.host !== '127.0.0.1' || !Number.isInteger(ready.port)) {
          fail(Error('Nonlocal strict server'))
          return
        }
        done(`http://127.0.0.1:${ready.port}`)
      } catch {
        fail(Error('Invalid strict server readiness'))
      }
    })
  }).catch(async (error: unknown) => {
    server.kill('SIGKILL')
    await exited
    await rm(root, { recursive: true, force: true })
    throw error
  })
  return {
    origin,
    async close() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
      await exited
      await rm(root, { recursive: true, force: true })
    },
  }
}
