// docs/specs/00-shell-and-login.md §4.7 and UX audit SH-11: once the session
// had expired, the dialog was still named « Votre session va expirer » over a
// body saying it had expired, and its close control was drawn, took focus and
// did nothing.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { FOCUS_GROUND_ELEVATED } from '@/ui/focusGround'
import { SessionExpiryDialog } from './SessionExpiryDialog'

const session = vi.hoisted(() => ({
  expiring: true,
  remainingS: 90,
  extend: vi.fn(),
  dismiss: vi.fn(),
  signOutNow: vi.fn(),
  signInAgain: vi.fn(),
}))
vi.mock('../auth/sessionExpiry', () => ({ useSessionExpiryDialog: () => session }))

beforeEach(() => {
  session.expiring = true
  session.remainingS = 90
  session.extend.mockReset()
  session.dismiss.mockReset()
  session.signOutNow.mockReset()
  session.signInAgain.mockReset()
})

const names = (buttons: HTMLElement[]) =>
  buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)

describe('while the session is about to expire', () => {
  it('says so, and offers to keep it open, to sign out, or to close', async () => {
    const user = userEvent.setup()
    render(<SessionExpiryDialog />)

    const dialog = screen.getByRole('region', { name: 'Votre session va expirer' })
    // A floating surface on the elevated role, with its edge, and the focus gap painted in it.
    expect(dialog).toHaveClass('bg-c-elevated', 'border-c-border', FOCUS_GROUND_ELEVATED)
    expect(dialog).toHaveAccessibleDescription(
      'Par sécurité, votre session se fermera dans 2 minutes.'
    )
    expect(names(screen.getAllByRole('button'))).toEqual([
      'Fermer',
      'Se déconnecter',
      'Garder la session ouverte',
    ])

    await user.click(screen.getByRole('button', { name: 'Garder la session ouverte' }))
    expect(session.extend).toHaveBeenCalledTimes(1)
    expect(session.signOutNow).not.toHaveBeenCalled()
    expect(session.signInAgain).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }))
    expect(session.signOutNow).toHaveBeenCalledTimes(1)
    expect(session.extend).toHaveBeenCalledTimes(1)
    expect(session.signInAgain).not.toHaveBeenCalled()
  })

  it('dismisses independently of the background renewal', async () => {
    const user = userEvent.setup()
    render(<SessionExpiryDialog />)

    screen.getByRole('button', { name: 'Fermer' }).focus()
    await user.keyboard('{Escape}')
    expect(session.dismiss).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(session.dismiss).toHaveBeenCalledTimes(2)
    expect(session.extend).not.toHaveBeenCalled()
    expect(session.signOutNow).not.toHaveBeenCalled()
  })

  it('announces the countdown at 120 and 30 seconds only', () => {
    const announced = () =>
      document.querySelector('[aria-live="assertive"]')?.textContent ?? 'no assertive region'
    const { rerender } = render(<SessionExpiryDialog />)
    expect(announced()).toBe('')

    for (const [remainingS, text] of [
      [120, 'Déconnexion dans 120 secondes.'],
      [119, ''],
      [30, 'Déconnexion dans 30 secondes.'],
      [29, ''],
    ] as const) {
      session.remainingS = remainingS
      rerender(<SessionExpiryDialog />)
      expect(announced()).toBe(text)
    }
  })
})

describe('once the session has expired', () => {
  beforeEach(() => {
    session.remainingS = 0
  })

  it('is named for what happened and leaves one action, with no close control', () => {
    render(<SessionExpiryDialog />)

    const dialog = screen.getByRole('dialog', { name: 'Votre session a expiré' })
    // The body says what to do. It does not say the title a second time, and it
    // promises nothing about what was typed: that is not kept yet.
    expect(dialog).toHaveAccessibleDescription('Reconnectez-vous pour continuer.')
    expect(screen.queryByRole('dialog', { name: 'Votre session va expirer' })).toBeNull()
    expect(names(screen.getAllByRole('button'))).toEqual(['Se reconnecter'])
    expect(screen.getByRole('button', { name: 'Se reconnecter' })).toHaveFocus()
  })

  it('stays open on Escape and on a press outside: signing in again is the only way on', async () => {
    const user = userEvent.setup()
    render(<SessionExpiryDialog />)

    await user.keyboard('{Escape}')
    // A press outside lands on the overlay, drawn just before the dialog's frame.
    const overlay = screen.getByRole('dialog').parentElement!.previousElementSibling!
    await user.pointer({ keys: '[MouseLeft]', target: overlay })

    expect(screen.getByRole('dialog', { name: 'Votre session a expiré' })).toBeInTheDocument()
    expect(session.extend).not.toHaveBeenCalled()
    expect(session.signInAgain).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Se reconnecter' }))
    expect(session.signInAgain).toHaveBeenCalledTimes(1)
  })

  it('moves focus to « Se reconnecter » when it expires while the dialog is open', async () => {
    session.remainingS = 5
    const { rerender } = render(<SessionExpiryDialog />)
    // The warning does not move focus; the person may choose its close action.
    screen.getByRole('button', { name: 'Fermer' }).focus()
    expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus()

    session.remainingS = 0
    rerender(<SessionExpiryDialog />)

    expect(screen.queryByRole('button', { name: 'Fermer' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Se reconnecter' })).toHaveFocus()
  })
})

it('draws nothing while the session is in no danger', () => {
  session.expiring = false
  render(<SessionExpiryDialog />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

describe('approved nonmodal warning', () => {
  function Background() {
    return (
      <>
        <label>
          Draft
          <input />
        </label>
        <button>Next field</button>
        <SessionExpiryDialog />
      </>
    )
  }

  it('preserves background focus, typing, Tab and pointer editing without renewal', async () => {
    const user = userEvent.setup()
    session.expiring = false
    const { rerender } = render(<Background />)
    const input = screen.getByLabelText('Draft')
    await user.click(input)
    await user.type(input, 'unsent')
    session.expiring = true
    rerender(<Background />)
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'Votre session va expirer' })).toBeVisible()
    await user.type(input, ' draft')
    expect(input).toHaveValue('unsent draft')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Next field' })).toHaveFocus()
    await user.click(input)
    await user.keyboard('{Escape}')
    expect(input).toHaveFocus()
    expect(session.dismiss).toHaveBeenCalledTimes(1)
    expect(session.extend).not.toHaveBeenCalled()
  })

  it('returns an explicitly focused warning action to the connected editor on renewal', async () => {
    const user = userEvent.setup()
    session.expiring = false
    const { rerender } = render(<Background />)
    const input = screen.getByLabelText('Draft')
    await user.click(input)
    session.expiring = true
    rerender(<Background />)
    await user.click(screen.getByRole('button', { name: 'Garder la session ouverte' }))
    session.expiring = false
    rerender(<Background />)
    expect(input).toHaveFocus()
  })

  it('does not move a newer background focus when the warning disappears', async () => {
    const user = userEvent.setup()
    session.expiring = false
    const { rerender } = render(<Background />)
    await user.click(screen.getByLabelText('Draft'))
    session.expiring = true
    rerender(<Background />)
    const next = screen.getByRole('button', { name: 'Next field' })
    await user.click(next)
    session.expiring = false
    rerender(<Background />)
    expect(next).toHaveFocus()
  })

  it('moves focus only at expiry and confines it to reconnect', async () => {
    const user = userEvent.setup()
    session.expiring = false
    const { rerender } = render(<Background />)
    const input = screen.getByLabelText('Draft')
    await user.click(input)
    session.expiring = true
    session.remainingS = 5
    rerender(<Background />)
    expect(input).toHaveFocus()
    session.remainingS = 0
    rerender(<Background />)
    const reconnect = screen.getByRole('button', { name: 'Se reconnecter' })
    expect(reconnect).toHaveFocus()
    await user.tab()
    expect(reconnect).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(session.extend).not.toHaveBeenCalled()
  })
})
