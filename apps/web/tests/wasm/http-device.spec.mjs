// Contract tests are written before the native HTTP actor implementation.
// The managed server must explicitly admit the worker asset before execution.
import { test, expect } from '@playwright/test'
import { startFixture } from './fixtures/serve.mjs'

const cases = [
  'http-flow', 'http-profile', 'http-restart', 'http-prepare-restart',
  'http-registration-unknown', 'http-publication-unknown', 'http-recovery-spent',
  'http-wrong-signing-key', 'http-wrong-reference', 'http-wrong-correlation',
  'http-ack-native', 'http-ack-host', 'http-ack-record', 'http-ack-sealed',
  'http-ack-manifest', 'http-ack-legacy', 'http-lost-store-ack', 'http-close-cas',
  'http-second-package', 'http-missing-manifest', 'http-wrong-native-generation',
  'http-cell-expired', 'http-forged-outcome', 'http-request-id',
  'http-live-retry', 'http-clock-rollback', 'http-clock-monotonic-expired', 'http-clock-nonfinite',
  'http-abort-admission', 'http-abort-publication', 'http-admission-store-unknown', 'http-publication-store-unknown',
  'http-preparation-body-mutation',
  'http-outcome-symbol', 'http-close-outcome-descriptor',
]
let fixture
test.beforeAll(async () => { fixture = await startFixture() })
test.afterAll(async () => { await fixture?.close() })
for (const mode of cases) {
  test('device HTTP: ' + mode, async ({ page }) => {
    const response = await page.goto(fixture.origin + '/?httpCase=' + mode)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-security-policy']).not.toContain('wasm-unsafe-eval')
    await expect(page.locator('output[data-phase=complete]')).toBeVisible()
    const result = JSON.parse(await page.locator('output').textContent())
    expect(result).toEqual({ status: 'passed', case: mode, hostOracleOnly: true })
  })
}
