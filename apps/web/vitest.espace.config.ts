import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Espace's client against the real Synapse and LiveKit of tests/espace/stack
// (docs/dev/ESPACE_STACK.md): run after `bin/up.sh`, by the `espace` CI job. Not part of
// `npm run test`, whose suite needs no server.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/espace/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One homeserver: the files run one after another.
    fileParallelism: false,
  },
})
