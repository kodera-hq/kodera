// Actual compiled fixed worker + strict IDB; controlled main oracle, not Core.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@playwright/test'
import { build } from 'vite'

test.describe.configure({ mode: 'serial', retries: 0 })
let server, directory, origin
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const provenance = JSON.parse(await readFile(new URL('../worker-device/provenance.json', import.meta.url), 'utf8'))
  assert.equal(provenance.schema, 'historical-device-worker-bootstrap-v1')
  assert.equal(provenance.freshCombinedNativeBuild, false)
  for (const record of provenance.files) {
    const bytes = await readFile(path.join(root, 'src/features/confidential/native', record.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, 'historical asset drift')
  }
  directory = await mkdtemp(path.join(tmpdir(), 'device-worker-proof-'))
  await build({ configFile: false, root, logLevel: 'error', worker: { format: 'es' },
    build: { outDir: directory, emptyOutDir: false, rollupOptions: {
      input: path.join(root, 'tests/worker-device/index.html'),
    } } })
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const filename = path.resolve(directory, '.' + decodeURIComponent(pathname))
      assert.ok(filename.startsWith(directory + path.sep))
      const body = await readFile(filename)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', filename.endsWith('.wasm') ? 'application/wasm' :
        filename.endsWith('.js') ? 'text/javascript' : 'text/html')
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'")
      response.end(body)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (directory) await rm(directory, { recursive: true, force: true })
})

const cases = [
  'startup-before-principal',
  'create-terminate-restore',
  'prepared-terminate-restore',
  'stale-consumed-start',
  'aborted-record-write',
  'committed-held-completion',
]
for (const name of cases) {
  test(`compiled fixed worker: ${name}`, async ({ page }) => {
    test.setTimeout(30_000)
    const errors = []
    page.on('pageerror', () => errors.push('page-error'))
    await page.goto(`${origin}/tests/worker-device/index.html?case=${encodeURIComponent(name)}`)
    const output = page.locator('output[data-phase="complete"]')
    await output.waitFor({ timeout: 20_000 })
    const text = await output.textContent()
    assert.ok(text && text.length <= 8192)
    const result = JSON.parse(text)
    assert.deepEqual(Object.keys(result).sort(), ['case', 'checks', 'scope', 'version'])
    assert.equal(result.version, 1)
    assert.equal(result.case, name)
    assert.equal(result.scope, 'compiled-worker-real-idb-controlled-main-oracle')
    assert.ok(Object.keys(result.checks).length >= 3)
    assert.ok(Object.values(result.checks).every((value) => value === true))
    assert.deepEqual(errors, [])
  })
}
