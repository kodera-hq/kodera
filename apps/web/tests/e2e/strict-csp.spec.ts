import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import type { Browser, BrowserServer, BrowserContext, Page } from '@playwright/test'

const run = promisify(execFile)
let root: string
let server: ChildProcess | undefined
let serverClosed: Promise<unknown> | undefined
let browserServer: BrowserServer | undefined
let browser: Browser | undefined
let origin: string
const closedBrowsers: number[] = []

test.beforeAll(async ({ playwright }, info) => {
  test.setTimeout(180_000)
  root = await mkdtemp(join(tmpdir(), 'kodera-strict-csp-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))
  )
  await run(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(root, 'dist')],
    {
      env: {
        ...env,
        VITE_AUTH_MODE: 'oidc',
        VITE_ENABLE_MSW: '0',
        VITE_FIRST_OWNER_JOURNEY: '0',
        VITE_CORE_API_URL: 'https://api.fixture.test/api/v1',
        VITE_KEYCLOAK_URL: 'https://id.fixture.test',
        VITE_OIDC_CLIENT_ID: 'console',
        NODE_OPTIONS: '--max-old-space-size=1536',
        RAYON_NUM_THREADS: '1',
        TOKIO_WORKER_THREADS: '1',
        UV_THREADPOOL_SIZE: '1',
      },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  )
  server = spawn(
    process.execPath,
    [
      resolve('server/static.mjs'),
      '--root',
      join(root, 'dist'),
      '--port',
      '0',
      '--prefix',
      '/',
      '--claim-path',
      '/claim',
      '--core-origin',
      'https://api.fixture.test',
      '--provider-origin',
      'https://id.fixture.test',
      '--matrix-domain',
      'kodera.invalid',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  serverClosed = terminal(server)
  server.on('error', () => {})
  origin = await new Promise<string>((done, fail) => {
    const child = server!
    let output = ''
    let settled = false
    const finish = (error?: Error, address?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('error', onError)
      child.off('close', onClose)
      child.stdout!.off('data', onData)
      child.stderr!.off('data', onDiagnostics)
      if (error) fail(error)
      else done(address!)
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(Error('Strict server exited before readiness'))
    const onDiagnostics = (chunk: Buffer) => {
      if (chunk.length > 0) finish(Error('Strict server emitted unexpected diagnostics'))
    }
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 16384) {
        finish(Error('Strict server output exceeded bound'))
        return
      }
      if (!output.includes('\n')) return
      try {
        const ready = JSON.parse(output.trim()) as { host: string; port: number }
        if (ready.host !== '127.0.0.1' || !Number.isInteger(ready.port)) {
          finish(Error('Nonlocal strict server'))
          return
        }
        finish(undefined, `http://127.0.0.1:${ready.port}`)
      } catch {
        finish(Error('Invalid strict server readiness'))
      }
    }
    const timer = setTimeout(() => finish(Error('Strict server readiness timeout')), 5000)
    child.once('error', onError)
    child.once('close', onClose)
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onDiagnostics)
  })
  browserServer = await playwright.chromium.launchServer({
    headless: true,
    ...info.project.use.launchOptions,
  })
  const pid = browserServer.process().pid
  if (pid === undefined) throw Error('Browser ownership acknowledgement missing')
  await writeFile(join(root, 'browser-pid.json'), JSON.stringify({ pid }))
  browser = await playwright.chromium.connect(browserServer.wsEndpoint())
})

async function bounded<T>(action: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(() => fail(Error(label)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function terminal(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => child.once('close', () => done()))
}

test.afterAll(async () => {
  const failures: unknown[] = []
  const child = browserServer?.process()
  const browserTerminal = child === undefined ? undefined : terminal(child)
  try {
    await bounded(browser?.close() ?? Promise.resolve(), 'Browser connection close timeout')
  } catch (error) {
    failures.push(error)
  }
  if (browserServer !== undefined && child !== undefined) {
    try {
      await bounded(browserServer.close(), 'Browser server close timeout')
    } catch (error) {
      failures.push(error)
      try {
        await bounded(browserServer.kill(), 'Browser kill timeout')
      } catch (failure) {
        failures.push(failure)
      }
    }
    try {
      await bounded(browserTerminal!, 'Browser terminal acknowledgement timeout')
      if (child.pid !== undefined) closedBrowsers.push(child.pid)
    } catch (error) {
      failures.push(error)
    }
  }
  if (server !== undefined) {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    try {
      await bounded(serverClosed!, 'Strict server close timeout')
    } catch (error) {
      failures.push(error)
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
      try {
        await bounded(serverClosed!, 'Strict server terminal acknowledgement timeout')
      } catch (failure) {
        failures.push(failure)
      }
    }
  }
  if (root !== undefined) {
    await writeFile(
      join(root, 'cleanup.json'),
      JSON.stringify({
        browserClosed: closedBrowsers,
        serverPid: server?.pid,
        serverClosed:
          server === undefined
            ? 'not-started'
            : server.exitCode !== null || server.signalCode !== null,
        qualified: failures.length === 0,
      })
    )
    if (process.env['KODERA_CSP_RETAIN'] !== '1' && failures.length === 0)
      await rm(root, { recursive: true, force: true })
  }
  if (failures.length) throw new AggregateError(failures, 'Strict CSP fixture cleanup failed')
})

async function violations(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))
    )
    return (window as unknown as { __cspEvents: Array<{ directive: string; blocked: string }> })
      .__cspEvents
  })
}

async function openPublicPage(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    unexpected.push(new URL(route.request().url()).origin)
    return route.abort()
  })
  await page.addInitScript(() => {
    const events: Array<{ directive: string; blocked: string }> = []
    Object.defineProperty(window, '__cspEvents', { value: events })
    document.addEventListener('securitypolicyviolation', (event) =>
      events.push({ directive: event.effectiveDirective, blocked: event.blockedURI })
    )
  })
  const response = await page.goto(`${origin}/login`)
  const policy = response?.headers()['content-security-policy'] ?? ''
  expect(policy).toContain("font-src 'self'")
  expect(policy).toMatch(/(?:^|;\s*)script-src 'self'(?:;|$)/)
  expect(policy).not.toContain('unsafe-eval')
  expect(policy).not.toContain('data:')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Se connecter à votre console' })
  ).toBeVisible()
  await expect(page.getByLabel('Adresse e-mail')).toBeVisible()
  expect(unexpected).toEqual([])
  return unexpected
}

test('strict CSP loads every bundled font face from real files', async () => {
  const context = await browser!.newContext({ locale: 'fr-FR' })
  try {
    const page = await context.newPage()
    const unexpected = await openPublicPage(context, page)
    const fonts = await page.evaluate(async () => {
      const faces: FontFace[] = []
      document.fonts.forEach((face) => faces.push(face))
      return Promise.all(
        faces.map(async (face) => {
          try {
            await face.load()
            return { family: face.family, loaded: face.status === 'loaded' }
          } catch {
            return { family: face.family, loaded: false }
          }
        })
      )
    })
    expect(fonts.length).toBeGreaterThan(5)
    expect(fonts.filter((face) => !face.loaded)).toEqual([])
    expect(fonts.some((face) => face.family.includes('Plus Jakarta Sans'))).toBe(true)
    expect(fonts.some((face) => face.family.includes('IBM Plex Mono'))).toBe(true)
    expect((await violations(page)).filter((event) => event.directive === 'font-src')).toEqual([])
    expect(unexpected).toEqual([])
  } finally {
    await context.close()
  }
})

test('strict CSP app starts without an evaluation probe violation', async () => {
  const context = await browser!.newContext({ locale: 'fr-FR' })
  try {
    const page = await context.newPage()
    const unexpected = await openPublicPage(context, page)
    const evalEvents = (await violations(page)).filter(
      (event) => event.blocked === 'eval' || event.directive === 'script-src'
    )
    expect(evalEvents).toEqual([])
    expect(unexpected).toEqual([])
  } finally {
    await context.close()
  }
})
