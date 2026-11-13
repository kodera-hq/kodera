import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // As in vite.config.ts: the suite runs the scroll lock the browser runs.
      'react-style-singleton': fileURLToPath(
        new URL('./src/ui/csp/styleSingleton.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // `.tsx` as well as `.ts`: the hub shipped `include: ['src/**/*.test.ts']`
    // and every component test it later added was silently never run.
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.{ts,tsx}'],
    // No `passWithNoTests`. A suite that finds nothing must be loud, not green.
    setupFiles: ['tests/setup.ts'],
    // The suite runs against MSW, which answers every contract operation, so by default it shows the
    // screens Core does not serve yet, like the end-to-end suite (docs/dev/CAPABILITIES.md). The
    // pilot's own tests stub both back to '' and prove each one hidden.
    // Mind the default when adding a gate: one keyed on `VITE_ENABLE_MSW` alone is open here, so
    // its test must stub the variable it reads, as every existing reader's test does.
    env: { VITE_ENABLE_MSW: '1', VITE_MOCK_UNSERVED: '1' },
    restoreMocks: true,
    // The collaboration wire suite runs the real yjs_collab server, which has its own locked
    // install. Inlined, its imports resolved partly from the web workspace: two prosemirror-model
    // copies, whose schemas do not recognise each other. Node loads it as production does.
    server: { deps: { external: [/\/apps\/server\/yjs_collab\//] } },
  },
})
