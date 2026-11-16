import { defineConfig, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
const executable = chromium.executablePath()
if (!process.env.WASM_PROOF_ROOT || !process.env.PLAYWRIGHT_BROWSERS_PATH ||
  fs.realpathSync(executable) !== executable || !executable.startsWith(path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep))
  throw new Error('managed executable path')

export default defineConfig({
  testDir: '.', testMatch: ['browser-device.spec.mjs', 'http-device.spec.mjs'], fullyParallel: false,
  forbidOnly: true, retries: 0, workers: 1, timeout: 30000, globalTimeout: 240000,
  reporter: 'json', outputDir: process.env.WASM_PROOF_ROOT + '/browser-output',
  use: { browserName: 'chromium', headless: true, launchOptions: { executablePath: executable }, trace: 'off', video: 'off',
    screenshot: 'off', locale: 'en-US', serviceWorkers: 'block' },
})
