// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import application, {
  assertEntryBootstrapGraph,
  normalizeViteModuleId,
  renderEntryRecovery,
} from '../../../vite.config'

const entryModuleId = '/synthetic/repo/src/entry-bootstrap.ts'
const mainModuleId = '/synthetic/repo/src/main.tsx'
const htmlEntryModuleId = '/synthetic/repo/index.html'
const entryModule = { id: entryModuleId, renderedLength: 100 }
const pristine = {
  entryModuleId,
  htmlEntryModuleId,
  modules: [
    entryModule,
    { id: '\0vite/preload-helper.js', renderedLength: 100 },
    { id: '\0vite/modulepreload-polyfill.js', renderedLength: 100 },
    { id: htmlEntryModuleId, renderedLength: 0 },
  ],
  imports: [],
  css: [],
  code: '/* synthetic graph fixture only */',
  mainModuleId,
  mainFile: 'assets/main-fixture.js',
  dynamicImports: ['assets/main-fixture.js'],
  mainModules: [mainModuleId],
}
const keys = [
  'console.entry.recovery.title',
  'console.entry.recovery.body',
  'console.entry.recovery.restart',
  'console.entry.recovery.support',
] as const
const messages: Record<string, unknown> = {
  [keys[0]]: 'Synthetic unresolved heading',
  [keys[1]]: 'Synthetic unresolved body',
  [keys[2]]: 'Synthetic original invitation instruction',
  [keys[3]]: 'Synthetic support {{email}}',
}

describe('Real build-hook guards have finite refusal controls', { concurrent: false }, () => {
  it('permits the entry and the two exact optional Vite helpers only', () => {
    expect(() => assertEntryBootstrapGraph(pristine)).not.toThrow()
    expect(() => assertEntryBootstrapGraph({ ...pristine, modules: [entryModule] })).not.toThrow()
  })

  it.each([
    { modules: [entryModule, { id: mainModuleId, renderedLength: 100 }] },
    { modules: [entryModule, { id: '/synthetic/repo/src/i18n/fr.json', renderedLength: 100 }] },
    {
      modules: [
        entryModule,
        { id: '/synthetic/repo/node_modules/oidc-client-ts/index.js', renderedLength: 100 },
      ],
    },
    { modules: [entryModule, { id: '\0unexpected-helper.js', renderedLength: 0 }] },
    {
      modules: [
        entryModule,
        { id: '\0vite/modulepreload-polyfill.js?unexpected', renderedLength: 0 },
      ],
    },
    { modules: [entryModule, { id: htmlEntryModuleId, renderedLength: 1 }] },
    { modules: [entryModule, { id: htmlEntryModuleId + '?unexpected', renderedLength: 0 }] },
    { imports: ['catalogue-shared.js'] },
    { css: ['entry.css'] },
    { modules: [] },
    { code: 'x'.repeat(16_385) },
    { dynamicImports: [] },
    { dynamicImports: ['assets/unrelated.js'] },
    { mainModules: ['/synthetic/repo/src/unrelated.ts'] },
  ])('refuses changed build metadata %# and restores pristine', (change) => {
    expect(() => assertEntryBootstrapGraph({ ...pristine, ...change })).toThrow()
    expect(() => assertEntryBootstrapGraph(pristine)).not.toThrow()
  })

  it('projects only escaped catalogue text and the canonical support input', () => {
    const html = renderEntryRecovery(
      { ...messages, [keys[1]]: '</template><script>synthetic()</script>&"' },
      'help@example.invalid'
    )
    expect(html).toContain('help@example.invalid')
    expect(html).toContain('&lt;/template&gt;&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('{email}')
    for (const key of keys) expect(html).toContain(`data-message-key="${key}"`)
    expect(html).not.toContain('href=')
  })

  it.each([
    undefined,
    null,
    '',
    { unexpected: 'object' },
    'Unresolved {unknown}',
    'Unresolved {{unknown}}',
  ])('refuses invalid catalogue field %# and restores pristine', (value) => {
    expect(() =>
      renderEntryRecovery({ ...messages, [keys[1]]: value }, 'help@example.invalid')
    ).toThrow()
    expect(() => renderEntryRecovery(messages, 'help@example.invalid')).not.toThrow()
  })

  it('normalizes Windows backslash Vite module IDs while preserving virtual module sentinels', async () => {
    expect(normalizeViteModuleId('D:\\a\\kodera\\kodera\\apps\\web\\src\\entry-bootstrap.ts')).toBe(
      'D:/a/kodera/kodera/apps/web/src/entry-bootstrap.ts'
    )
    expect(normalizeViteModuleId('\0vite/preload-helper.js')).toBe('\0vite/preload-helper.js')

    const plugins = (await Promise.all(application.plugins ?? [])).flat()
    const guard = plugins.find(
      (plugin) =>
        plugin &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'kodera-entry-bootstrap'
    )
    if (
      !guard ||
      typeof guard !== 'object' ||
      !('generateBundle' in guard) ||
      !guard.generateBundle
    ) {
      throw Error('APP_BUNDLE_GUARD_MISSING')
    }
    const handler =
      typeof guard.generateBundle === 'function'
        ? guard.generateBundle
        : guard.generateBundle.handler

    const realEntryWin = fileURLToPath(
      new URL('../../../src/entry-bootstrap.ts', import.meta.url)
    ).replaceAll('/', '\\')
    const realMainPosix = normalizeViteModuleId(
      fileURLToPath(new URL('../../../src/main.tsx', import.meta.url))
    )
    const realHtmlWin = fileURLToPath(new URL('../../../index.html', import.meta.url)).replaceAll(
      '/',
      '\\'
    )

    const windowsMixedBundle = {
      'assets/index-entry.js': {
        type: 'chunk',
        isEntry: true,
        fileName: 'assets/index-entry.js',
        code: 'import("./main-app.js")',
        imports: [],
        dynamicImports: ['assets/main-app.js'],
        viteMetadata: { importedCss: new Set<string>(), importedAssets: new Set<string>() },
        modules: {
          [realEntryWin]: { renderedLength: 42 },
          [realHtmlWin]: { renderedLength: 0 },
          '\0vite/preload-helper.js': { renderedLength: 18 },
        },
      },
      'assets/main-app.js': {
        type: 'chunk',
        isEntry: false,
        fileName: 'assets/main-app.js',
        code: 'console.log("app")',
        imports: [],
        dynamicImports: [],
        viteMetadata: { importedCss: new Set<string>(), importedAssets: new Set<string>() },
        modules: {
          [realMainPosix]: { renderedLength: 128 },
        },
      },
    }

    expect(() => Reflect.apply(handler, {}, [{}, windowsMixedBundle, false])).not.toThrow()
  })
})
