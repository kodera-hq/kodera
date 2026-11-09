import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AuthSessionSnapshot } from '../auth/AuthAdapter'
import '../i18n'
import { AppProviders } from './providers'
import {
  clearWorkspaceSettingsRuntime,
  registerWorkspaceSettingsRuntime,
  useWorkspaceSettingsRuntime,
} from '../features/workspace/settingsRuntime'

const auth = vi.hoisted(() => {
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    user: { realm: 'community', identity: { issuer: 'https://id.example.test', subject: 'first' } },
    generation: 1,
    credentialGeneration: 1,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getAccessToken: () => (snapshot.user ? 'test-token' : undefined),
    getUser: () => snapshot.user,
    getExpiresAt: () => undefined,
    onExpiring: () => () => {},
    onRenewed: () => () => {},
    onRenewalFailed: () => () => {},
    restoreSession: async () => Boolean(snapshot.user),
    renew: async () => false,
    change: (subject: string | undefined) => {
      snapshot = {
        status: subject ? 'ready' : 'unauthenticated',
        user: subject
          ? { realm: 'community', identity: { issuer: 'https://id.example.test', subject } }
          : undefined,
        generation: snapshot.generation + 1,
        credentialGeneration: snapshot.credentialGeneration + 1,
      }
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('../auth/oidc', () => ({ authAdapter: auth }))
function Probe() {
  return <p data-testid="identity">{useWorkspaceSettingsRuntime()?.userId ?? 'empty'}</p>
}
afterEach(clearWorkspaceSettingsRuntime)
it.each(['second', undefined])(
  'clears profile identity when the authenticated identity changes to %s',
  (subject) => {
    auth.change('first')
    registerWorkspaceSettingsRuntime({
      org: 'community',
      userId: '@first:community.kodera.io',
      displayName: 'First',
      members: [],
      call: null,
      invite: undefined,
      memberRole: () => 'member',
    })
    render(
      <AppProviders>
        <Probe />
      </AppProviders>
    )
    expect(screen.getByTestId('identity')).toHaveTextContent('@first:community.kodera.io')
    act(() => auth.change(subject))
    expect(screen.getByTestId('identity')).toHaveTextContent('empty')
  }
)
