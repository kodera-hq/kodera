import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ToastProvider } from '@/ui/Toast/Toast'
import { AppsCard } from './AppsCard'
import type { TenantApp } from './AppsCard'

const visio: TenantApp = {
  code: 'visio',
  name: 'Visio',
  url: 'https://visio.acme.fr',
  default_url: 'https://acme.visio.kodera.io',
  custom_domain: 'visio.acme.fr',
  state: 'live',
  version: '1.4',
}

function renderCard(apps: TenantApp[]) {
  return render(
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <AppsCard apps={apps} />
    </ToastProvider>
  )
}

describe('AppsCard', () => {
  it('does not invent a version, fallback or application when Core omits them', () => {
    const { default_url: _fallback, version: _version, ...minimal } = visio
    const { unmount } = renderCard([minimal])
    const card = screen.getByRole('region', { name: 'Visio' })
    expect(within(card).queryByText(/Version|Secours/)).toBeNull()
    expect(within(card).getAllByRole('button', { name: 'Copier' })).toHaveLength(1)
    unmount()
    renderCard([])
    expect(screen.queryByRole('region', { name: 'Visio' })).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('gives each application its own named card with the served version', () => {
    renderCard([visio, { ...visio, code: 'docs', name: 'Docs', version: null }])
    const card = screen.getByRole('region', { name: 'Visio' })
    expect(within(card).getByRole('heading', { name: 'Visio' })).toBeVisible()
    expect(within(card).getByText('Version 1.4')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Docs' })).queryByText(/Version/)).toBeNull()
  })

  it.each([
    ['pending', 'En préparation'],
    ['live', 'Opérationnel'],
    ['degraded', 'Service perturbé'],
    ['unavailable', 'Indisponible'],
    ['maintenance', 'En maintenance'],
  ] as const)('describes the served %s state in words', (state, label) => {
    renderCard([{ ...visio, state }])
    expect(within(screen.getByRole('region', { name: 'Visio' })).getByText(label)).toBeVisible()
  })

  it.each(['unexpected', 'toString', '__proto__', undefined, null, ['live'], { toString: null }])(
    'keeps addresses usable when the server returns an unrecognized state %s',
    (state) => {
      renderCard([{ ...visio, state } as unknown as TenantApp])
      const card = screen.getByRole('region', { name: 'Visio' })
      expect(within(card).getByText('État inconnu')).toBeVisible()
      expect(within(card).queryByText('Opérationnel')).toBeNull()
      expect(within(card).getByText(visio.url)).toBeVisible()
      expect(within(card).getByText(visio.default_url!)).toBeVisible()
      expect(within(card).getByRole('link')).toHaveAttribute('href', visio.url)
      expect(within(card).getAllByRole('button', { name: 'Copier' })).toHaveLength(2)
    }
  )

  it('shows both the primary and the fallback address, the fallback labelled "Secours"', () => {
    renderCard([visio])
    expect(screen.getByText('https://visio.acme.fr')).toBeInTheDocument()
    expect(screen.getByText('https://acme.visio.kodera.io')).toBeInTheDocument()
    expect(screen.getByText('Secours', { exact: false })).toBeInTheDocument()
  })

  it('copies an address to the clipboard and confirms it', async () => {
    // `userEvent.setup()` installs its own clipboard stub, so the mock must
    // be defined AFTER it runs — defined earlier, `setup()` overwrites it
    // and the component ends up calling userEvent's own function, which
    // `toHaveBeenCalledWith` correctly refuses to treat as a spy.
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
    renderCard([visio])

    const copyButtons = screen.getAllByRole('button', { name: 'Copier' })
    await user.click(copyButtons[0] as HTMLElement)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://visio.acme.fr')
    expect(await screen.findByText('Copié')).toBeInTheDocument()
  })

  it('opens the app in a new tab with an accessible name that says so', () => {
    renderCard([visio])
    const openLink = screen.getByRole('link', { name: /nouvel onglet/ })
    expect(openLink).toHaveAttribute('href', 'https://visio.acme.fr')
    expect(openLink).toHaveAttribute('target', '_blank')
    expect(openLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders every app it is given', () => {
    const docs: TenantApp = { ...visio, code: 'docs', name: 'Docs', url: 'https://docs.acme.fr' }
    renderCard([visio, docs])
    expect(screen.getByText('https://visio.acme.fr')).toBeInTheDocument()
    expect(screen.getByText('https://docs.acme.fr')).toBeInTheDocument()
  })
})

it('does not confirm a changed address when an old clipboard promise resolves', async () => {
  const user = userEvent.setup()
  let resolve!: () => void
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  const wrapper = (url: string) => (
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <AppsCard apps={[{ ...visio, url }]} />
    </ToastProvider>
  )
  const { rerender } = render(wrapper('https://old.example.test'))
  await user.click(screen.getAllByRole('button', { name: 'Copier' })[0]!)
  rerender(wrapper('https://new.example.test'))
  await act(async () => {
    resolve()
  })
  expect(screen.queryByText('Copié')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})
