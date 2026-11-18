import { stdout } from 'node:process'
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

/** Browser call logs and assertion diffs can contain a one-use URL or input value. */
export default class ReceiptReporter implements Reporter {
  onTestEnd(_test: TestCase, result: TestResult) {
    const markers = result.errors.flatMap(
      (error) => error.message?.match(/\b(?:R[13456]|A11Y|WAVE2|SURFACES)_[A-Z_]+\b/g) ?? []
    )
    stdout.write(
      `Wave 2: ${result.status}${markers.length ? ` (${[...new Set(markers)].join(', ')})` : ''}\n`
    )
  }
  onError() {
    stdout.write('Wave 2: WAVE2_RUNNER_ERROR\n')
  }
}
