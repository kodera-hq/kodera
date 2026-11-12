import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { SUPPORT_EMAIL } from './src/app/supportContact'
import { ENTRY_NAMESPACES, ORGANISATION_NAMESPACES } from './src/i18n/namespaces'

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

/**
 * The three libraries only a signed-in workspace runs. None of them may be part of what a visitor
 * downloads before signing in: the route tree fetches the workspace on demand
 * (`src/app/routeTree.ts`), the identity SDK is fetched by the adapter (`src/auth/oidcSdk.ts`),
 * and `scripts/check-bundle-budget.mjs` fails a build where one of them is reachable from the
 * entry by static imports.
 */
const DEFERRED_VENDORS = {
  'matrix-js-sdk': 'vendor-matrix',
  'livekit-client': 'vendor-livekit',
  'oidc-client-ts': 'vendor-oidc',
} as const

/** Every package the given ones depend on, directly or not, by name; the given ones excluded. */
function dependenciesOf(packages: readonly string[]): Set<string> {
  const found = new Set<string>()
  const visit = (name: string, from: string): void => {
    // Node's own lookup, by hand: `require.resolve` refuses a package whose `exports` map does
    // not list `package.json`.
    for (let directory = from; ; directory = dirname(directory)) {
      const manifest = join(directory, 'node_modules', name, 'package.json')
      if (existsSync(manifest)) {
        const { dependencies = {}, optionalDependencies = {} } = JSON.parse(
          readFileSync(manifest, 'utf8')
        ) as Record<string, Record<string, string> | undefined>
        for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies })) {
          if (found.has(dependency) || packages.includes(dependency)) continue
          found.add(dependency)
          visit(dependency, dirname(manifest))
        }
        return
      }
      if (directory === dirname(directory)) throw Error(`DEFERRED_VENDOR_NOT_INSTALLED: ${name}`)
    }
  }
  for (const name of packages) visit(name, fileURLToPath(new URL('.', import.meta.url)))
  return found
}

/**
 * Each of the three in a file of its own, and what they depend on in files beside them, so that
 * no one download is the whole workspace: the per-chunk budget of the same script is on each.
 * A library alone in its file is also a file that changes only when the library does.
 *
 * Two properties make this safe, and the budget script refuses a build that loses either:
 *
 * - Nothing the entry needs ends up in one of these files. A group takes modules by package name
 *   only (`includeDependenciesRecursively: false`): taking a library's dependencies wholesale
 *   moved the dynamic-import helper, which the bootstrap must carry itself, into the Matrix file.
 * - No two files import each other. The dependencies are grouped by which lazy routes reach them
 *   (`entriesAware`), as the bundler groups everything else: a dependency only the workspace
 *   reaches sits beside the workspace's code, never inside it, where the library that needs it
 *   and the code that needs the library would otherwise import each other's file in a cycle, and
 *   run in an order nobody chose.
 */
function deferredVendorGroups() {
  const dependencies = dependenciesOf(Object.keys(DEFERRED_VENDORS))
  const packageOf = (id: string): string | undefined =>
    /.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)?.[1]?.replace('\\', '/')
  return [
    {
      name: (id: string): string | null => {
        const name = packageOf(id)
        if (name === undefined) return null
        if (Object.hasOwn(DEFERRED_VENDORS, name)) {
          return DEFERRED_VENDORS[name as keyof typeof DEFERRED_VENDORS]
        }
        return dependencies.has(name) ? 'vendor-workspace' : null
      },
      entriesAware: true,
      includeDependenciesRecursively: false,
    },
  ]
}

/**
 * Everything the application imports statically, in one file.
 *
 * The bootstrap reaches the application through one dynamic import (`src/entry-bootstrap.ts`),
 * so the bundler sees the application as one lazy root among many and files each module by the
 * exact set of lazy roots that reach it. A module the application and three areas share then
 * lands in a file of its own, and so does one it shares with four: the more lazy routes there
 * are, the more files the sign-in page fetches, for code it needs whichever route comes next.
 * Nothing is fetched before the application is, so none of that distinction is worth a request.
 *
 * This names the application's static closure once the module graph is complete, and the group
 * below puts it in one file. The application module itself stays out of it: the bootstrap's
 * dynamic import must lead to the file that holds `src/main.tsx`
 * (`assertEntryBootstrapGraph`). So do the helpers the bundler supplies: the bootstrap carries
 * the dynamic-import ones itself, and the bundler keeps its runtime in a file of its own
 * whatever a group says.
 *
 * The cost, measured: a module the application imports and only a lazy route uses — a library's
 * re-export it never calls — comes along, about 2 kB gzip in all. The sign-in page fetches four
 * script files for it instead of six in a production build and seventeen in a mock one.
 */
function applicationClosure(): { plugin: Plugin; has: (id: string) => boolean } {
  const closure = new Set<string>()
  return {
    has: (id) => closure.has(id),
    plugin: {
      name: 'kodera-application-closure',
      apply: 'build',
      buildEnd() {
        closure.clear()
        const queue = [...(this.getModuleInfo(MAIN_MODULE_ID)?.importedIds ?? [])]
        for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
          if (closure.has(id) || id.startsWith('\0')) continue
          closure.add(id)
          queue.push(...(this.getModuleInfo(id)?.importedIds ?? []))
        }
      },
    },
  }
}

const application = applicationClosure()

const CATALOGUE = /[\\/]src[\\/]i18n[\\/]catalogues[\\/](fr|en)[\\/]([a-z]+)\.json$/

/**
 * The catalogues that are always asked for together, in one file per locale: the six namespaces
 * of the organisation layout, and the entry namespaces of a language other than the default
 * (the default's are part of the application). The runtime still asks for each namespace by
 * name (`src/i18n/index.ts`); the six requests are answered by one file. Every other namespace
 * stays a file of its own, fetched with the one area that reads it.
 */
function catalogueBundle(id: string): string | null {
  const [, locale, namespace] = CATALOGUE.exec(id) ?? []
  if (locale === undefined || namespace === undefined) return null
  const within = (list: readonly string[]) => list.includes(namespace)
  if (within(ORGANISATION_NAMESPACES)) return `i18n-${locale}-console`
  return within(ENTRY_NAMESPACES) ? `i18n-${locale}-app` : null
}

/** A deferred file is named for what it carries: `route-people-…`, `i18n-fr-people-…`. */
function chunkFileName(chunk: { name: string; facadeModuleId?: string | null }): string {
  // The bundler names a vendor file after its group and every lazy route that reaches it.
  const [vendor = ''] = chunk.name.split('~')
  if (vendor.startsWith('vendor-')) return `assets/${vendor}-[hash].js`
  const id = chunk.facadeModuleId ?? ''
  const catalogue = CATALOGUE.exec(id)
  if (catalogue !== null) return `assets/i18n-${catalogue[1]}-${catalogue[2]}-[hash].js`
  const area = /[\\/]src[\\/]features[\\/]([a-z-]+)[\\/]routes?\.tsx$/.exec(id)
  if (area !== null) return `assets/route-${area[1]}-[hash].js`
  return 'assets/[name]-[hash].js'
}

export default defineConfig({
  build: {
    // The strict server permits same-origin files, never data URLs.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        chunkFileNames: chunkFileName,
        codeSplitting: {
          groups: [
            {
              name: 'app',
              test: application.has,
              priority: 30,
              includeDependenciesRecursively: false,
            },
            { name: catalogueBundle, priority: 20, includeDependenciesRecursively: false },
            // What the lazy routes have in common and the application does not import: the
            // organisation layout every area hangs below, and the pieces three areas or more
            // use — a table, a select, a status pill. Filed strictly by which routes reach it,
            // each piece is a file of a few hundred bytes and a request of its own, a dozen of
            // them for one page; here they are one file, fetched with the layout.
            //
            // Three, not two: whatever such a module imports is reached by at least the same
            // routes, so it is in this file too (or in the application's), and the file imports
            // nothing a route owns. A module only two areas share stays between those two — the
            // theme editor is one, and is larger than everything in here together.
            //
            // Ahead of the vendor groups, so that a small library a workspace vendor and the
            // layout both use is here, with the layout, and not a file of its own beside it.
            {
              name: 'console',
              test: (id: string) => !id.startsWith('\0'),
              minShareCount: 3,
              priority: 10,
              includeDependenciesRecursively: false,
            },
            ...deferredVendorGroups(),
          ],
        },
      },
    },
  },
  // Tailwind 4 through its Vite plugin, which resolves `src/index.css`'s
  // `@import`s itself and rebases the font files' relative `url()`s. The
  // PostCSS plugin loses the source file of the rules Vite's own `@import`
  // inlining hands it, and every self-hosted font URL then fails to resolve.
  plugins: [
    tailwindcss(),
    react(),
    mockServiceWorkerPlugin(),
    entryBootstrapPlugin(),
    application.plugin,
  ],
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
