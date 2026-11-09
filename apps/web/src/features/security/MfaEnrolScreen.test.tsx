import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

const signOut = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ signOut }) }))
afterEach(() => vi.unstubAllEnvs())

describe('real MFA enrollment remains unavailable', () => {
  it('focuses truthful guidance and offers no simulated enrollment controls', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    const { MfaEnrolScreen } = await import('./MfaEnrolScreen')
    const onEnrolled = vi.fn()
    const { container } = render(
      <MfaEnrolScreen accountEmail="synthetic@example.test" onEnrolled={onEnrolled} />
    )
    expect(
      screen.getByRole('heading', { name: 'Double authentification requise', level: 1 })
    ).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Son activation n’est pas encore disponible dans cette console.'
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Se déconnecter' }))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(onEnrolled).not.toHaveBeenCalled()
  })
})
