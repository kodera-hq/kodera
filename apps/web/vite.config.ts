import { createReadStream, readFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { SUPPORT_EMAIL } from './src/app/supportContact'

const MOCK_SERVICE_WORKER_SOURCE = fileURLToPath(
  new URL('./msw/mockServiceWorker.js', import.meta.url)
)

/**
 * `msw`'s service worker script lives at `msw/mockServiceWorker.js`, not
 * under `public/`: Vite copies everything in `publicDir` to the dist root on
 * every build regardless of mode, which is how this file used to ship in a
 * production build even after the mock identity provider and MSW's own
 * module code were excluded (`scripts/check-production-bundle.sh`'s
 * `mockServiceWorker.js` dist-root check catches a regression back to this).
 * This plugin copies it in only when the build is a mock build — the same
 * `VITE_ENABLE_MSW=1 VITE_AUTH_MODE=mock` condition `src/main.tsx` and
 * `src/app/routeTree.ts` gate the rest of the mock path on.
 *
 * Read from `process.env` directly rather than `import.meta.env`: this file
 * runs in Node as build configuration and is never bundled into the client,
 * so there is no static-replacement / dead-code-elimination concern here —
 * that concern is specific to code that ships to the browser (see the
 * comments in `src/main.tsx` and `src/app/routeTree.ts` for why those two
 * read the literal condition instead of calling into `src/config.ts`).
 *
 * `configureServer` covers `npm run dev`; `writeBundle` covers `vite build`
 * (what `npm run build`, `npm run test:e2e`'s `webServer` and
 * `scripts/check-production-bundle.sh` all run).
 */
function mockServiceWorkerPlugin(): Plugin {
  const mockBuildEnabled = (): boolean =>
    process.env.VITE_ENABLE_MSW === '1' && process.env.VITE_AUTH_MODE === 'mock'

  return {
    name: 'kodera-mock-service-worker',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/mockServiceWorker.js' || !mockBuildEnabled()) {
          next()
          return
        }
        res.setHeader('Content-Type', 'text/javascript')
        createReadStream(MOCK_SERVICE_WORKER_SOURCE).pipe(res)
      })
    },
    async writeBundle(options) {
      if (!mockBuildEnabled()) return
      const outDir = options.dir ?? 'dist'
      await copyFile(MOCK_SERVICE_WORKER_SOURCE, join(outDir, 'mockServiceWorker.js'))
    },
  }
}

const ENTRY_MODULE_ID = fileURLToPath(new URL('./src/entry-bootstrap.ts', import.meta.url))
const MAIN_MODULE_ID = fileURLToPath(new URL('./src/main.tsx', import.meta.url))
const HTML_MODULE_ID = fileURLToPath(new URL('./index.html', import.meta.url))
const RECOVERY_KEYS = [
  'console.entry.recovery.title',
  'console.entry.recovery.body',
  'console.entry.recovery.restart',
  'console.entry.recovery.support',
] as const

interface EntryBootstrapGraph {
  entryModuleId: string
  htmlEntryModuleId: string
  modules: readonly { id: string; renderedLength: number }[]
  imports: readonly string[]
  css: readonly string[]
  code: string
  mainModuleId: string
  mainFile: string
  dynamicImports: readonly string[]
  mainModules: readonly string[]
}

export function assertEntryBootstrapGraph(graph: EntryBootstrapGraph): void {
  const allowed = new Set([
    graph.entryModuleId,
    '\0vite/preload-helper.js',
    '\0vite/modulepreload-polyfill.js',
  ])
  if (
    graph.modules.filter((module) => module.id === graph.entryModuleId).length !== 1 ||
    new Set(graph.modules.map((module) => module.id)).size !== graph.modules.length
  ) {
    throw Error('ENTRY_MODULE_IDENTITY_INVALID')
  }
  for (const module of graph.modules) {
    if (
      !Number.isSafeInteger(module.renderedLength) ||
      module.renderedLength < 0 ||
      !(
        allowed.has(module.id) ||
        (module.id === graph.htmlEntryModuleId && module.renderedLength === 0)
      )
    ) {
      throw Error('ENTRY_UNEXPECTED_EXECUTING_MODULE')
    }
  }
  if (
    graph.imports.length !== 0 ||
    graph.css.length !== 0 ||
    Buffer.byteLength(graph.code) === 0 ||
    Buffer.byteLength(graph.code) > 16_384
  ) {
    throw Error('ENTRY_NOT_SELF_CONTAINED')
  }
  if (
    graph.dynamicImports.length !== 1 ||
    graph.dynamicImports[0] !== graph.mainFile ||
    !graph.mainModules.includes(graph.mainModuleId)
  ) {
    throw Error('ENTRY_DYNAMIC_MAIN_IDENTITY_INVALID')
  }
}

export function renderEntryRecovery(messages: unknown, supportEmail: string): string {
  if (
    messages === null ||
    typeof messages !== 'object' ||
    Array.isArray(messages) ||
    supportEmail.trim() === '' ||
    /[{}]/.test(supportEmail)
  ) {
    throw Error('ENTRY_RECOVERY_INPUT_INVALID')
  }
  const escape = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  const text = RECOVERY_KEYS.map((key) => {
    const value: unknown = Object.getOwnPropertyDescriptor(messages, key)?.value
    if (typeof value !== 'string' || value.trim() === '')
      throw Error('ENTRY_RECOVERY_MESSAGE_MISSING')
    // Consume the real generated i18next syntax, never import the i18n runtime.
    const projected = value.replaceAll('{{email}}', supportEmail)
    if (/[{}]/.test(projected)) throw Error('ENTRY_RECOVERY_UNRESOLVED_PLACEHOLDER')
    return escape(projected)
  })
  return (
    '<template id="entry-recovery"><section role="alert" aria-labelledby="entry-recovery-title">' +
    RECOVERY_KEYS.map((key, index) =>
      index === 0
        ? `<h1 id="entry-recovery-title" data-message-key="${key}">${text[index]}</h1>`
        : `<p data-message-key="${key}">${text[index]}</p>`
    ).join('') +
    '</section></template>'
  )
}

function entryBootstrapPlugin(): Plugin {
  return {
    name: 'kodera-entry-bootstrap',
    enforce: 'post',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const marker = '<!-- ENTRY_RECOVERY -->'
        if (html.split(marker).length !== 2) throw Error('ENTRY_RECOVERY_MARKER_INVALID')
        const messages: unknown = JSON.parse(
          readFileSync(new URL('./src/i18n/fr.json', import.meta.url), 'utf8')
        )
        return html.replace(marker, renderEntryRecovery(messages, SUPPORT_EMAIL))
      },
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((chunk) => chunk.type === 'chunk')
      const entries = chunks.filter((chunk) => Object.hasOwn(chunk.modules, ENTRY_MODULE_ID))
      const mains = chunks.filter((chunk) => Object.hasOwn(chunk.modules, MAIN_MODULE_ID))
      if (entries.length !== 1 || mains.length !== 1) throw Error('ENTRY_BUILD_MAPPING_INVALID')
      const entry = entries[0]
      const main = mains[0]
      if (
        entry === undefined ||
        main === undefined ||
        !entry.isEntry ||
        entry.viteMetadata === undefined
      ) {
        throw Error('ENTRY_CHUNK_METADATA_MISSING')
      }
      assertEntryBootstrapGraph({
        entryModuleId: ENTRY_MODULE_ID,
        htmlEntryModuleId: HTML_MODULE_ID,
        modules: Object.entries(entry.modules).map(([id, module]) => ({
          id,
          renderedLength: module.renderedLength,
        })),
        imports: entry.imports,
        css: [...entry.viteMetadata.importedCss],
        code: entry.code,
        mainModuleId: MAIN_MODULE_ID,
        mainFile: main.fileName,
        dynamicImports: entry.dynamicImports,
        mainModules: Object.keys(main.modules),
      })
    },
  }
}

export default defineConfig({
  // The strict server permits same-origin files, never data URLs.
  build: { assetsInlineLimit: 0 },
  // Tailwind 4 through its Vite plugin, which resolves `src/index.css`'s
  // `@import`s itself and rebases the font files' relative `url()`s. The
  // PostCSS plugin loses the source file of the rules Vite's own `@import`
  // inlining hands it, and every self-hosted font URL then fails to resolve.
  plugins: [tailwindcss(), react(), mockServiceWorkerPlugin(), entryBootstrapPlugin()],
  resolve: {
    // Mirrors `paths` in tsconfig.json. The two have to agree: TypeScript
    // resolves `@/…` on its own, so an alias missing here typechecks fine and
    // fails only at bundle time.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
    // The v1 smoke's local run (tests/smoke/README.md): Core answers no CORS preflight, because
    // it is served on the Console's own origin, so a preview against a local Core forwards
    // `/api` to it. Unset, nothing is forwarded. Not a VITE_ value: it never reaches the bundle.
    ...(process.env['PREVIEW_CORE_ORIGIN']
      ? { proxy: { '/api': { target: process.env['PREVIEW_CORE_ORIGIN'] } } }
      : {}),
  },
})
