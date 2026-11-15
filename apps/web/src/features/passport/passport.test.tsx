import { createHash } from 'node:crypto'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTokenProvider } from '../../api/client'
import { coreApiUrl } from '../../config'
import i18n from '../../i18n'
import { resetIdempotencyStore } from '../../mocks/generated/handlers'
import { server } from '../../mocks/server'
import {
  generatePassportPkcePair,
  listPassportWorkspaces,
  normalizePassportEmailInput,
  PassportMagicLinkForm,
  PassportWorkspaceSwitcher,
} from './index'
import type { PassportWorkspaceEntry } from './index'

const WORKSPACES_FIXTURE: readonly PassportWorkspaceEntry[] = [
  {
    organisation_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab785',
    organisation_slug: 'acme-org',
    organisation_name: 'Acme SAS',
    realm: 'acme-org',
    issuer: 'https://id.kodera.io/realms/acme-org',
    membership_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab786',
    role: 'org_owner',
    workspace_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab787',
    default_urls: {},
    active: true,
  },
  {
    organisation_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab799',
    organisation_slug: 'bravo-org',
    organisation_name: 'Bravo Studio',
    realm: 'bravo-org',
    issuer: 'https://id.kodera.io/realms/bravo-org',
    membership_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab798',
    role: 'org_admin',
    workspace_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab797',
    default_urls: {},
    active: false,
  },
]

const BASE = 'https://core.test/api/v1'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

beforeEach(async () => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(() => undefined)
  await i18n.changeLanguage('fr')
})

afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
})

afterAll(() => {
  server.close()
})

describe('Kodera Passport client helpers', () => {
  it('generates an RFC 7636 S256 PKCE verifier and matching SHA-256 challenge', async () => {
    const pair = await generatePassportPkcePair()
    expect(pair.codeChallengeMethod).toBe('S256')
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const expectedChallenge = createHash('sha256')
      .update(pair.codeVerifier, 'ascii')
      .digest('base64url')
    expect(pair.codeChallenge).toBe(expectedChallenge)
  })

  it('normalizes email addresses and rejects malformed inputs', () => {
    expect(normalizePassportEmailInput('  Camille.Laurent@ACME.FR ')).toBe(
      'camille.laurent@acme.fr'
    )
    expect(normalizePassportEmailInput('invalid-email')).toBeNull()
    expect(normalizePassportEmailInput('two@@acme.fr')).toBeNull()
    expect(normalizePassportEmailInput('user@localhost')).toBeNull()
  })

  it('lists eligible workspaces from GET /auth/passport/workspaces', async () => {
    const directory = await listPassportWorkspaces({ sessionToken: 'kp1.test.sig' })
    expect(directory.workspaces.length).toBeGreaterThanOrEqual(1)
    expect(directory.workspaces[0]?.organisation_slug).toBe('acme-org')
  })
})

describe('PassportMagicLinkForm', () => {
  it.each([
    ['fr', 'Recevoir le lien de connexion', 'vient d’être envoyé'],
    ['en', 'Send sign-in link', 'has been sent'],
  ] as const)(
    'submits normalized email + S256 PKCE challenge and renders constant confirmation (%s)',
    async (locale, buttonName, expectedSnippet) => {
      await i18n.changeLanguage(locale)
      let capturedBody: Record<string, unknown> | null = null
      server.use(
        http.post(`${coreApiUrl()}/auth/passport/magic-link/request`, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ status: 'accepted', expires_in_seconds: 600 }, { status: 202 })
        })
      )

      const onRequested = vi.fn()
      render(<PassportMagicLinkForm onRequested={onRequested} />)

      await userEvent.type(screen.getByRole('textbox'), '  Camille.Laurent@ACME.FR ')
      await userEvent.click(screen.getByRole('button', { name: buttonName }))

      await waitFor(() => expect(onRequested).toHaveBeenCalledTimes(1))
      expect(capturedBody?.['email']).toBe('camille.laurent@acme.fr')
      expect(capturedBody?.['code_challenge_method']).toBe('S256')
      expect(String(capturedBody?.['code_challenge'])).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(screen.getByRole('status')).toHaveTextContent(expectedSnippet)
    }
  )

  it('surfaces rate-limit refusal on 429', async () => {
    server.use(
      http.post(`${coreApiUrl()}/auth/passport/magic-link/request`, () =>
        HttpResponse.json(
          {
            type: 'https://kodera.io/problems/rate-limited',
            title: 'Too many requests',
            status: 429,
            request_id: '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
            retry_after_s: 30,
          },
          {
            status: 429,
            headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '30' },
          }
        )
      )
    )

    render(<PassportMagicLinkForm initialEmail="camille.laurent@acme.fr" />)
    await userEvent.click(screen.getByRole('button', { name: 'Recevoir le lien de connexion' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Trop de tentatives récentes')
    )
  })

  it('verifies a magic-link token and handles 401 replay refusal cleanly', async () => {
    const onVerified = vi.fn()
    const { rerender } = render(
      <PassportMagicLinkForm
        verification={{
          token: 'a'.repeat(43),
          codeVerifier: 'v'.repeat(43),
        }}
        onVerified={onVerified}
      />
    )

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1))

    server.use(
      http.post(`${coreApiUrl()}/auth/passport/magic-link/verify`, () =>
        HttpResponse.json(
          {
            type: 'https://kodera.io/problems/unauthenticated',
            title: 'Authentication required',
            status: 401,
            request_id: '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
          },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } }
        )
      )
    )

    rerender(
      <PassportMagicLinkForm
        verification={{
          token: 'b'.repeat(43),
          codeVerifier: 'v'.repeat(43),
        }}
        onVerified={onVerified}
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('expiré ou a déjà été utilisé')
    )
  })
})

describe('PassportWorkspaceSwitcher', () => {
  it('renders workspaces across realms and switches active workspace', async () => {
    await i18n.changeLanguage('en')
    server.use(
      http.post(`${coreApiUrl()}/auth/passport/switch-workspace`, async ({ request }) => {
        const body = (await request.json()) as { organisation_id: string }
        return HttpResponse.json({
          active_organisation_id: body.organisation_id,
          active_workspace_id: '019467a3-0f9d-7eb5-b9e4-3bc6a04ab797',
          workspace: { ...WORKSPACES_FIXTURE[1], active: true },
          session_token: 'kp1.switched.sig',
          expires_in_seconds: 3600,
        })
      })
    )

    const onSwitched = vi.fn()
    render(
      <PassportWorkspaceSwitcher
        workspaces={WORKSPACES_FIXTURE}
        activeOrganisationId={WORKSPACES_FIXTURE[0]!.organisation_id}
        sessionToken="kp1.initial.sig"
        onSwitched={onSwitched}
      />
    )

    expect(screen.getByText('Acme SAS')).toBeVisible()
    expect(screen.getByText('Bravo Studio')).toBeVisible()
    expect(screen.getByText('Active')).toBeVisible()
    expect(screen.getByText('Owner')).toBeVisible()
    expect(screen.getByText('Administrator')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Switch workspace' }))
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1))
    expect(onSwitched.mock.calls[0]?.[0]?.active_organisation_id).toBe(
      '019467a3-0f9d-7eb5-b9e4-3bc6a04ab799'
    )
  })

  it('displays non-member 403 refusal alert without crashing', async () => {
    server.use(
      http.post(`${coreApiUrl()}/auth/passport/switch-workspace`, () =>
        HttpResponse.json(
          {
            type: 'https://kodera.io/problems/forbidden',
            title: 'Access refused',
            status: 403,
            request_id: '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
          },
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } }
        )
      )
    )

    render(
      <PassportWorkspaceSwitcher
        workspaces={WORKSPACES_FIXTURE}
        activeOrganisationId={WORKSPACES_FIXTURE[0]!.organisation_id}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir cet espace' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Vous n’êtes plus membre actif de cet espace.'
      )
    )
  })
})
