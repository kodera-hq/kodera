import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  buildLlmsText,
  developerDocsContent,
  documentationPages,
  exportDocumentationPage,
} from './documentationExport'
import { developerDocsMessages } from './developerDocsMessages'
import { OFFICIAL_EXTENSIONS_CATALOG } from '../extensions/catalog'
const root = resolve(import.meta.dirname, '../../../../..')
it('keeps all generated public guides and llms.txt byte-identical to the rendered content', () => {
  expect(readFileSync(resolve(root, 'apps/web/public/llms.txt'), 'utf8')).toBe(buildLlmsText())
  expect(buildLlmsText()).toMatch(/^# Kodera\n\n> /u)
  for (const locale of ['fr', 'en']) {
    for (const page of documentationPages(locale)) {
      expect(
        readFileSync(
          resolve(root, `apps/web/public/developer-docs/${locale}/${page.id}.md`),
          'utf8'
        )
      ).toBe(exportDocumentationPage(page))
      for (const path of page.sources) expect(existsSync(resolve(root, path)), path).toBe(true)
      expect(new Set(page.sections.map((section) => section.id)).size).toBe(page.sections.length)
    }
  }
})
it('indexes the actual twenty-two reference connectors with existing source paths', () => {
  expect(developerDocsContent.connectors).toHaveLength(22)
  expect(developerDocsContent.connectors.map((connector) => connector.slug).sort()).toEqual(
    OFFICIAL_EXTENSIONS_CATALOG.map((connector) => connector.slug).sort()
  )
  for (const connector of developerDocsContent.connectors)
    expect(existsSync(resolve(root, connector.path)), connector.path).toBe(true)
})
it('pins documented versions to their authoritative repository files', () => {
  const { versions } = developerDocsContent
  expect(
    readFileSync(resolve(root, 'packages/api-contract/core-api.openapi.yaml'), 'utf8')
  ).toContain(`version: ${versions.core}`)
  expect(
    readFileSync(resolve(root, 'packages/api-contract/agent-api.openapi.yaml'), 'utf8')
  ).toContain(`version: ${versions.agent}`)
  expect(readFileSync(resolve(root, 'packages/synapse-policy/pyproject.toml'), 'utf8')).toContain(
    `version = "${versions.policy}"`
  )
  expect(
    JSON.parse(readFileSync(resolve(root, 'packages/extension-sdk/package.json'), 'utf8')).version
  ).toBe(versions.sdk)
  expect(readFileSync(resolve(root, 'apps/web/src/features/sounds/synth.ts'), 'utf8')).toContain(
    'SYNTH_SAMPLE_RATE = 48000'
  )
})
it('keeps both locales structurally complete, with explicit integration limits', () => {
  expect(Object.keys(developerDocsMessages.fr).sort()).toEqual(
    Object.keys(developerDocsMessages.en).sort()
  )
  expect(documentationPages('fr').map((page) => page.id)).toEqual(
    documentationPages('en').map((page) => page.id)
  )
  for (const page of documentationPages('fr'))
    expect(page.sections.map((section) => section.id)).toEqual(
      documentationPages('en')
        .find((other) => other.id === page.id)
        ?.sections.map((section) => section.id)
    )
  expect(buildLlmsText()).toContain('not additional reference connectors')
  expect(buildLlmsText()).toContain('is a local pre-release')
  expect(buildLlmsText()).toContain('availability are not confirmed')
})
