import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { UserBlock } from './UserBlock'

describe('UserBlock', () => {
  it('names the person and their role in the trigger', () => {
    render(
      <UserBlock user={{ displayName: 'Henri Duflot', role: 'org_admin' }} onSignOut={() => {}} />
    )
    expect(screen.getByText('Henri Duflot')).toBeInTheDocument()
    expect(screen.getByText('Administratrice / Administrateur')).toBeInTheDocument()
  })

  it('shows the member role label for a non-admin', () => {
    render(<UserBlock user={{ displayName: 'Sam Petit', role: 'member' }} onSignOut={() => {}} />)
    expect(screen.getByText('Membre')).toBeInTheDocument()
  })

  it('calls onSignOut when "Se déconnecter" is chosen from the menu', async () => {
    const user = userEvent.setup()
    const onSignOut = vi.fn()
    render(
      <UserBlock user={{ displayName: 'Henri Duflot', role: 'org_admin' }} onSignOut={onSignOut} />
    )

    await user.click(screen.getByRole('button', { name: /Henri Duflot/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Se déconnecter' }))

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('opens the security placeholder place from « Sécurité et connexion »', async () => {
    const user = userEvent.setup()
    const onOpenPlace = vi.fn()
    render(
      <UserBlock
        user={{ displayName: 'Henri Duflot', role: 'org_admin' }}
        onSignOut={() => {}}
        onOpenPlace={onOpenPlace}
      />
    )

    await user.click(screen.getByRole('button', { name: /Henri Duflot/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Sécurité et connexion' }))

    expect(onOpenPlace).toHaveBeenCalledWith('/$org/security')
  })

  it('opens the Apparence page from « Apparence », right after « Sécurité et connexion »', async () => {
    const user = userEvent.setup()
    const onOpenPlace = vi.fn()
    render(
      <UserBlock
        user={{ displayName: 'Henri Duflot', role: 'org_admin' }}
        onSignOut={() => {}}
        onOpenPlace={onOpenPlace}
      />
    )

    await user.click(screen.getByRole('button', { name: /Henri Duflot/ }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Sécurité et connexion',
      'Apparence',
      'Langue',
      'Se déconnecter',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Apparence' }))

    expect(onOpenPlace).toHaveBeenCalledWith('/$org/appearance')
  })
})
