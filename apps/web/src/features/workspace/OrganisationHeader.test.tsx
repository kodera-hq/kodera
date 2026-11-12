// The organisation at the head of the workspace's channel column (docs/specs/11-workspace.md
// §4.1): drawn alone, or as the switch to the person's other organisations.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { OrganisationSwitchContext } from '../../app/organisationSwitch'
import type { OrganisationSwitch } from '../../app/organisationSwitch'
import { OrganisationHeader } from './OrganisationHeader'

function withSwitch(value: OrganisationSwitch | undefined, children: ReactNode) {
  return (
    <OrganisationSwitchContext.Provider value={value}>
      {children}
    </OrganisationSwitchContext.Provider>
  )
}

const ACME = { slug: 'acme-sa', name: 'ACME Construction', current: true }
const BETA = { slug: 'beta-btp', name: 'Beta BTP', current: false }

describe('OrganisationHeader', () => {
  it('draws the initials and the name without the slug, with the initials out of the reading order', () => {
    render(<OrganisationHeader name="ACME Construction" slug="acme-sa" />)

    expect(screen.getByText('ACME Construction')).toBeInTheDocument()
    expect(screen.queryByText('acme-sa')).toBeNull()
    expect(screen.getByText('AC')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers workspace actions even for a single organisation', () => {
    render(
      withSwitch(
        { memberships: [ACME], onSwitch: vi.fn() },
        <OrganisationHeader name="ACME Construction" slug="acme-sa" />
      )
    )
    expect(
      screen.getByRole('button', { name: 'ACME Construction, changer d’organisation' })
    ).toBeInTheDocument()
  })

  it('opens the other organisations and switches to the one chosen', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    render(
      withSwitch(
        { memberships: [ACME, BETA], onSwitch },
        <OrganisationHeader name="ACME Construction" slug="acme-sa" />
      )
    )

    await user.click(
      screen.getByRole('button', { name: 'ACME Construction, changer d’organisation' })
    )
    // Radix names the menu after the button that opened it.
    expect(
      screen.getByRole('menu', { name: 'ACME Construction, changer d’organisation' })
    ).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /ACME Construction/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await user.click(screen.getByRole('menuitemradio', { name: /Beta BTP/ }))
    expect(onSwitch).toHaveBeenCalledWith('beta-btp')
  })
})

it('shows community initials and domain and dispatches the same actions as the rail menu', async () => {
  const user = userEvent.setup()
  const listener = vi.fn()
  window.addEventListener('kodera:workspace-command', listener)
  render(
    withSwitch(
      {
        memberships: [{ slug: 'community', name: 'Kodera Community', current: true }],
        onSwitch: vi.fn(),
      },
      <OrganisationHeader name="Kodera Community" slug="community" />
    )
  )
  expect(screen.getByText('KC')).toBeInTheDocument()
  expect(screen.getByText('community.kodera.io')).toHaveClass('text-xs', 'text-c-ink-3')
  await user.click(screen.getByRole('button', { name: /Kodera Community/ }))
  expect(screen.queryByRole('menuitemradio', { name: 'Noir OLED' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('menuitem', { name: 'Réglages de l’espace…' }))
  expect(listener.mock.calls[0]?.[0].detail).toBe('settings')
  window.removeEventListener('kodera:workspace-command', listener)
})

it('names the community by the deployment’s own base domain', () => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'example.org')
  try {
    render(<OrganisationHeader name="Kodera Community" slug="community" />)
    expect(screen.getByText('community.example.org')).toBeInTheDocument()
    expect(screen.queryByText('community.kodera.io')).toBeNull()
  } finally {
    vi.unstubAllEnvs()
  }
})
