import { resolve } from 'node:path'

/** Isolated oracle checks need no React transforms, application setup, MSW or service stack. */
export default {
  root: resolve(import.meta.dirname, '../..'),
  envDir: false,
  test: {
    environment: 'jsdom',
    include: ['tests/unit/wave2-oracles.test.ts'],
    setupFiles: [],
    restoreMocks: true,
    fsModuleCache: false,
  },
}
