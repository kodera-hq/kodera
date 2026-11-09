// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertEntryBootstrapGraph, renderEntryRecovery } from '../../../vite.config'

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
})
