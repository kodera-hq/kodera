import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Failed assertions can generate implicit ARIA context even with screenshots/traces disabled. */
export default async function teardown() {
  await rm(resolve(import.meta.dirname, '../../test-results/wave2'), {
    recursive: true,
    force: true,
  })
}
