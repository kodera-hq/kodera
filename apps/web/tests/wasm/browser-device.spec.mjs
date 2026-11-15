import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startFixture } from './fixtures/serve.mjs'

const cases = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
if (!Array.isArray(cases) || cases.length !== 50 || new Set(cases).size !== cases.length ||
  cases.some((name) => !/^[a-z-]+$/.test(name))) throw new Error('closed case inventory')
let fixture

test.beforeAll(async () => { fixture = await startFixture() })
test.afterAll(async () => { await fixture?.close() })
for (const name of cases) {
  test('device: ' + name, async ({ page, request, browser }) => {
    if (name === 'closed-routes') {
      for (const route of ['/private-source', '/.env.fixture', '/native/', '/storage/local-state.ts', '/fixture/unknown.mjs']) {
        const response = await request.get(fixture.origin + route)
        expect(response.status()).toBe(404)
        expect(await response.text()).toBe('refused')
      }
      return
    }
    const address = (name === 'csp-control' ? fixture.controlOrigin : fixture.origin) + '/?case=' + name
    const response = await page.goto(address)
    expect(response.status()).toBe(200)
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    const csp = response.headers()['content-security-policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp.includes('wasm-unsafe-eval')).toBe(name === 'csp-control')
    expect(csp.includes("'unsafe-eval'")).toBe(false)
    expect(csp.includes("'unsafe-inline'")).toBe(false)
    await expect(page.locator('output[data-phase=complete]')).toBeVisible()
    const result = JSON.parse(await page.locator('output').textContent())
    expect(result).toEqual({ status: 'passed', case: name })
    // Public runner/browser provenance only; no raw page/worker/storage snapshot.
    if (name === 'create') {
      const executable = browser.browserType().executablePath()
      const cap = 512 * 1024 * 1024
      if (fs.realpathSync(executable) !== executable || !executable.startsWith(path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep) ||
        !fs.lstatSync(executable).isFile() || fs.statSync(executable).size > cap) throw new Error('managed browser executable')
      const descriptor = fs.openSync(executable, 'r'), hash = crypto.createHash('sha256'), chunk = Buffer.alloc(65536)
      try { let count; while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count)) }
      finally { fs.closeSync(descriptor) }
      fs.writeFileSync(path.join(process.env.WASM_PROOF_ROOT, 'browser-provenance.json'), JSON.stringify({
        version: browser.version(), executable, executableSha256: hash.digest('hex'), managedFixture: true,
      }) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ phase: 'managed-browser', version: browser.version() }))
    }
  })
}
