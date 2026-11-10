import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { registerInteractiveDemo } from '@/app/interactiveDemo'
import { createLocalWorkspaceStore } from '@/mocks/demo/workspaceStore'
import { buildCallbackUrl, MockIdpAuthorizePage } from '@/auth/mock-idp'

describe('buildCallbackUrl', () => {
  it('carries the mock code and the state back to redirect_uri', () => {
    const url = buildCallbackUrl(
      `?realm=acme-sa&redirect_uri=${encodeURIComponent(window.location.origin)}%2Fauth%2Fcallback&state=abc123`
    )
    expect(url).toBe(
      `${window.location.origin}/auth/callback?code=mock-authorization-code&state=abc123`
    )
  })

  it('carries no state when none was given', () => {
    const url = buildCallbackUrl(
      `?realm=acme-sa&redirect_uri=${encodeURIComponent(window.location.origin)}%2Fauth%2Fcallback`
    )
    expect(url).toBe(`${window.location.origin}/auth/callback?code=mock-authorization-code`)
  })

  it('is undefined without a redirect_uri — nothing to send the code back to', () => {
    expect(buildCallbackUrl('?realm=acme-sa')).toBeUndefined()
  })
})

describe('MockIdpAuthorizePage', () => {
  afterEach(() => registerInteractiveDemo(undefined))

  it.each(['demo', 'silent'])(
    'automatically completes %s authorization without a click',
    (mode) => {
      registerInteractiveDemo({ slug: 'community', createStore: createLocalWorkspaceStore })
      const navigate = vi.fn()
      render(
        <MockIdpAuthorizePage
          search={`?realm=community&redirect_uri=${encodeURIComponent(window.location.origin)}%2Fauth%2Fcallback&state=automatic${mode === 'silent' ? '&prompt=none' : ''}`}
          navigate={navigate}
        />
      )
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        `${window.location.origin}/auth/callback?code=mock-authorization-code&state=automatic`
      )
      expect(screen.queryByRole('button', { name: 'Continuer' })).not.toBeInTheDocument()
    }
  )

  it('names the realm and hands back the code on "Continuer"', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    render(
      <MockIdpAuthorizePage
        search={`?realm=acme-sa&redirect_uri=${encodeURIComponent(window.location.origin)}%2Fauth%2Fcallback&state=abc123`}
        navigate={navigate}
      />
    )

    expect(screen.getByRole('heading', { name: 'Continuer vers acme-sa' })).toBeInTheDocument()

    expect(navigate).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Continuer' }))

    expect(navigate).toHaveBeenCalledWith(
      `${window.location.origin}/auth/callback?code=mock-authorization-code&state=abc123`
    )
  })
})

it.each([
  'https://foreign.example/auth/callback',
  'javascript:alert(1)',
  'not a URL',
  `${window.location.origin}/other`,
  `${window.location.origin}/auth/callback/extra`,
  `${window.location.origin}/auth/callback#fragment`,
])('refuses mock callback %s', (target) => {
  expect(buildCallbackUrl(`?redirect_uri=${encodeURIComponent(target)}`)).toBeUndefined()
})
it('admits the same-origin protected callback', () => {
  const target = `${window.location.origin}/auth/claim-callback`
  expect(buildCallbackUrl(`?redirect_uri=${encodeURIComponent(target)}`)).toBe(
    `${target}?code=mock-authorization-code`
  )
})
