import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { HostingOfferPanel, publicMigrationConfiguration } from './HostingOfferPanel'
afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})
it('defaults missing hosting mode and can export an optional workspace summary', async () => {
  const user = userEvent.setup()
  const create = vi.fn(() => 'blob:configuration')
  URL.createObjectURL = create
  URL.revokeObjectURL = vi.fn()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(
    <HostingOfferPanel
      initiallyExpanded
      organisation="Sample workspace"
      workspace={{ channels: [{ name: 'general', kind: 'text' }] }}
    />
  )
  expect(screen.getByText(/Mode actuel/)).toHaveTextContent('Community')
  await user.click(screen.getByRole('button', { name: /Exporter/ }))
  expect(create).toHaveBeenCalledOnce()
  expect(click).toHaveBeenCalledOnce()
  expect(
    publicMigrationConfiguration({ channels: [{ name: 'general', kind: 'text' }] })
  ).toMatchObject({ channels: [{ name: 'general', kind: 'text' }], enabledConnectors: [] })
})
it.each(['fr', 'en'])('creates a human-readable migration request in %s', async (language) => {
  await act(async () => {
    await i18n.changeLanguage(language)
  })
  render(
    <HostingOfferPanel
      initiallyExpanded
      organisation="Sample workspace"
      workspace={{ channels: [{ name: 'general', kind: 'text' }], enabledConnectors: ['calendar'] }}
    />
  )
  const link = screen.getByRole('link', {
    name: language === 'fr' ? /migration assistée/ : /assisted migration/,
  })
  const url = new URL(link.getAttribute('href')!)
  expect(url.searchParams.get('subject')).toContain(
    language === 'fr' ? 'demande de migration assistée' : 'assisted hosting migration'
  )
  expect(url.searchParams.get('body')).toContain(language === 'fr' ? 'Bonjour' : 'Hello')
  expect(url.searchParams.get('body')).toContain('Sample workspace')
  expect(url.searchParams.get('body')).toContain('general')
  expect(url.searchParams.get('body')).not.toContain('{')
  expect(url.searchParams.get('body')).not.toContain('undefined')
})
it('still renders a useful export and request without workspace metadata', () => {
  render(<HostingOfferPanel initiallyExpanded />)
  expect(screen.getByRole('button', { name: /Exporter/ })).toBeEnabled()
  const link = screen.getByRole('link', { name: /migration assistée/ })
  expect(new URL(link.getAttribute('href')!).searchParams.get('body')).toContain('Non précisé')
})
