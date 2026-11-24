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

it('lazy-loads Boost and VIP panels under Suspense and dispatches Core API checkout when organisationId is provided', async () => {
  vi.stubEnv('VITE_CORE_API_URL', 'https://api.kodera.invalid/api/v1')
  const user = userEvent.setup()
  const navigatedUrls: string[] = []
  const orgId = '00000000-0000-7000-8000-000000000099'
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/workspace/monetization/boosts/checkout')) {
      return new Response(
        JSON.stringify({
          boost_grant_id: '00000000-0000-7000-8000-000000000021',
          invoice_id: '00000000-0000-7000-8000-000000000022',
          invoice_number: 'KODERA-2026-00001',
          vat_regime: 'fr_standard',
          vat_rate_bp: 2000,
          net_amount_minor: 2900,
          vat_amount_minor: 580,
          gross_amount_minor: 3480,
          checkout_session_id: 'cs_fake_000001',
          checkout_url: 'https://pay.fake.invalid/checkout/cs_fake_000001',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response(
      JSON.stringify({
        workspace_id: '00000000-0000-7000-8000-000000000010',
        boost_packs: [],
        hosting_credits: [],
        vip_tiers: [],
        connect_account: null,
        dac7_summary: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  })
  try {
    render(
      <HostingOfferPanel
        initiallyExpanded
        monetizationInitiallyExpanded
        organisationId={orgId}
        onNavigateExternalUrl={(url) => navigatedUrls.push(url)}
      />
    )
    const boostButton = await screen.findByRole('button', {
      name: /Régler et activer le Boost sur le Web/,
    })
    const checkboxes = await screen.findAllByRole('checkbox')
    await user.click(checkboxes[0]!)
    await user.click(boostButton)
    await vi.waitFor(() => {
      expect(navigatedUrls).toContain('https://pay.fake.invalid/checkout/cs_fake_000001')
    })
  } finally {
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  }
})
