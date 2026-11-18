import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'
import type * as Playwright from '@playwright/test'
import { guard } from './oracles/shared'

export interface Account {
  username: string
  email: string
  password: string
  totpBase32: string
}
const assertionsPackage = '@playwright/test'
const usedSteps = new Map<string, number>()

/** Independently admitted accounts must never reuse a one-time code in the same step. */
export async function throughKeycloak(page: Page, account: Account): Promise<void> {
  const { expect } = (await import(/* @vite-ignore */ assertionsPackage)) as typeof Playwright
  try {
    const username = page.locator('#username')
    const password = page.locator('#password')
    await expect(password.or(username).first()).toBeVisible()
    if (await username.isVisible()) await username.fill(account.username)
    if (await password.isVisible()) {
      await password.fill(account.password)
      await page.locator('#kc-login').click()
    }
    const otp = page.locator('#otp')
    const next = await Promise.race([
      otp.waitFor().then(() => 'otp'),
      page
        .locator('#totp')
        .waitFor()
        .then(() => 'configure'),
      page.waitForURL((url) => !url.pathname.includes('/realms/')).then(() => 'done'),
    ])
    guard(next !== 'configure', 'WAVE2_AUTH_CONFIG_REQUIRED')
    if (next !== 'otp') return
    const stepNow = () => Math.floor(Date.now() / 30_000)
    await expect
      .poll(() => usedSteps.get(account.totpBase32) !== stepNow(), {
        timeout: 35_000,
        message: 'WAVE2_AUTH_STEP_PENDING',
      })
      .toBe(true)
    const step = stepNow()
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const char of account.totpBase32.replace(/[\s=]/g, '').toUpperCase()) {
      const index = alphabet.indexOf(char)
      guard(index >= 0, 'WAVE2_AUTH_BASE32')
      bits += index.toString(2).padStart(5, '0')
    }
    const bytes = bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []
    guard(bytes.length > 0, 'WAVE2_AUTH_BASE32')
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
    const offset = digest[digest.length - 1]! & 0x0f
    const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
    usedSteps.set(account.totpBase32, step)
    await otp.fill(code)
    await page.locator('#kc-login').click()
  } catch {
    throw new Error('WAVE2_AUTH_FAILED')
  }
}
