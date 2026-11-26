import { isDesktopBundledOrigin } from './desktopOidc'
import { authAdapter } from './oidc'

// Native authentication completes in place, so this intent needs no persistent storage.
// Keep the destination fixed and expire it after the native browser interaction window.
let intent: { expiresAt: number; generation: number } | undefined

export async function beginDesktopWorkspaceCreation(): Promise<void> {
  if (!isDesktopBundledOrigin()) throw new Error('Desktop registration unavailable.')
  const request = authAdapter.signIn('community', { registration: true })
  const current = {
    expiresAt: Date.now() + 10 * 60_000,
    generation: authAdapter.getSnapshot().generation,
  }
  intent = current
  try {
    await request
  } finally {
    // LoginRoute consumes a successful intent synchronously when the adapter publishes ready.
    // Failure, cancellation or an unmounted route must not leave an intent for another sign-in.
    if (intent === current) intent = undefined
  }
}

export function consumeDesktopWorkspaceCreation(realm: string): '/workspaces/new' | undefined {
  const current = intent
  intent = undefined
  return realm === 'community' &&
    current !== undefined &&
    current.generation === authAdapter.getSnapshot().generation &&
    Date.now() < current.expiresAt
    ? '/workspaces/new'
    : undefined
}
