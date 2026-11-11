import { render, screen } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrandIcon, BRAND_ICONS } from './BrandIcon'
import { EXTENSION_BRANDS } from '@/features/extensions/extensionBrand'
import { OFFICIAL_EXTENSIONS_CATALOG } from '@/features/extensions/catalog'

describe('self-hosted connector marks', () => {
  for (const theme of ['light', 'dark', 'black']) {
    it(`keeps labeled and decorative marks accessible in ${theme}`, () => {
      const { container, rerender } = render(
        <div data-theme={theme}>
          {Object.keys(BRAND_ICONS).map((name) => (
            <BrandIcon key={name} name={name as keyof typeof BRAND_ICONS} />
          ))}
        </div>
      )
      for (const { label } of Object.values(BRAND_ICONS)) {
        expect(screen.getByRole('img', { name: label })).toBeVisible()
      }
      expect(container.querySelector('[style]')).toBeNull()
      for (const image of container.querySelectorAll('img')) {
        expect(image.src).not.toMatch(/^https?:\/\/(?!localhost)/)
      }
      rerender(<BrandIcon name="figma" decorative />)
      expect(screen.queryByRole('img')).toBeNull()
      expect(container.querySelector('img')).toHaveAttribute('alt', '')
    })
  }

  it('maps every catalog connector and names generic reference connectors honestly', () => {
    for (const extension of OFFICIAL_EXTENSIONS_CATALOG) {
      expect(EXTENSION_BRANDS[extension.id]).toBeDefined()
    }
    render(<BrandIcon name="webhook" />)
    expect(screen.getByRole('img', { name: 'webhook' })).toBeVisible()
    expect(EXTENSION_BRANDS['io.kodera.ext.docs-collab-announcer']).toBe('documents')
  })

  it('ships inert SVGs with preserved multicolor geometry and dark-ink backing', () => {
    const directory = resolve(process.cwd(), 'src/ui/icons/brands')
    for (const filename of readdirSync(directory)) {
      const svg = readFileSync(`${directory}/${filename}`, 'utf8')
      expect(svg).not.toMatch(
        /<(?:script|style|foreignObject)\b|\sstyle=|\son\w+=|(?:href|src)=["']https?:/i
      )
      expect(svg).toContain('<svg')
    }
    const figma = readFileSync(`${directory}/figma.svg`, 'utf8')
    expect(new Set(figma.match(/#[\da-f]{6}/gi)).size).toBe(5)
    for (const name of ['github', 'sentry', 'frameio']) {
      expect(readFileSync(`${directory}/${name}.svg`, 'utf8')).toContain('<rect ')
    }
  })
})
