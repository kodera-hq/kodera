import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import '../../../src/i18n'
import {
  ThemeStudioModal,
  CURATED_COMMUNITY_PRESETS,
} from '../../../src/features/appearance/ThemeStudioModal'
import { encodeShareableTheme } from '../../../src/features/appearance/themeCodec'
import { ExtensionsCatalogPanel } from '../../../src/features/extensions/ExtensionsCatalogPanel'
afterEach(() => {
  document.documentElement.style.cssText = ''
})

it('rejects a valid wire code with unreadable colours before changing mode or document tokens', async () => {
  const preset = CURATED_COMMUNITY_PRESETS[0]!
  const encoded = encodeShareableTheme({
    ...preset,
    tokens: { ...preset.tokens, '--c-ink': preset.tokens['--c-page'] },
  })
  if (!encoded.ok) throw new Error('fixture must pass the wire contract')
  const select = vi.fn()
  render(
    <ThemeStudioModal open currentThemeMode="light" onSelectCoreTheme={select} onClose={() => {}} />
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Code de thème à importer' }),
    encoded.code
  )
  await userEvent.click(screen.getByRole('button', { name: 'Importer et appliquer' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('4,5:1')
  expect(select).not.toHaveBeenCalled()
  expect(document.documentElement.style.getPropertyValue('--c-page')).toBe('')
})

it('lets a connector setup choose an available channel while stating that delivery is not activated', async () => {
  render(
    <ExtensionsCatalogPanel
      channels={[{ id: 'general', label: 'general' }]}
      defaultSelectedId="io.kodera.ext.github"
    />
  )
  const selector = screen.getByRole('combobox', { name: 'Salon de destination' })
  await userEvent.selectOptions(selector, 'general')
  expect(selector).toHaveValue('general')
  expect(
    screen.getByText('Ce choix prépare la configuration. Aucune connexion n’est encore activée.')
  ).toBeVisible()
})
