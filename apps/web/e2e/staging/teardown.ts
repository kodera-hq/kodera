// Removes the run's temporary output directory (playwright.config.ts), failed run or not, and
// never any other path (output-dir.ts).
import { rmSync } from 'node:fs'
import { isWalkOutputDir, OUTPUT_DIR_VARIABLE } from './output-dir'

export default function teardown(): void {
  const dir = process.env[OUTPUT_DIR_VARIABLE]
  if (isWalkOutputDir(dir)) rmSync(dir, { recursive: true, force: true })
}
