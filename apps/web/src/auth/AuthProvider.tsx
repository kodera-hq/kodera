// The React binding over `AuthAdapter` (ADR-0007). Wraps the same
// `authAdapter` singleton `src/app/routeTree.ts` reads in its route guards
// (`oidc.ts`), which is the SAME class whether `VITE_AUTH_MODE` is `oidc` or
// `mock`: only what it talks to changes (ADR-0007). `adapter` exists as a
// prop so a test can swap in a fake without touching this file; the
// application itself never passes one.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'
import { setTokenProvider } from '../api/client'
import type { AuthAdapter, AuthCallbackResult, AuthSessionSnapshot, AuthUser } from './AuthAdapter'
import * as matrixAuth from './matrix'
import { authAdapter as defaultAdapter } from './oidc'
import {
  clearLocalSessionStorage,
  purgeDocsCollabDatabases,
  purgeEspaceVaultDatabases,
} from './localSession'
import {
  hasStoredPushDeviceKey,
  pushSupported,
  readStoredPushDeviceId,
} from '../features/notifications/pushState'

export interface AuthContextValue {
  readonly user: AuthUser | undefined
  readonly status: AuthSessionSnapshot['status']
  readonly generation: number
  readonly credentialGeneration: number
  readonly isAuthenticated: boolean
  signIn: (realm: string) => Promise<void>
  handleCallback: () => Promise<AuthCallbackResult>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const PUSH_MODULE_LOAD_TIMEOUT_MS = 1_500

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PushTeardownModule = Pick<typeof import('../features/notifications/push'), 'disablePush'>

const defaultLoadPushModule = (): Promise<PushTeardownModule> =>
  import('../features/notifications/push')

async function loadPushModuleBounded(
  load: () => Promise<PushTeardownModule>,
  timeoutMs = PUSH_MODULE_LOAD_TIMEOUT_MS
): Promise<PushTeardownModule | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = Promise.resolve(load())
    void pending.catch(() => undefined)
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface AuthProviderProps {
  children: ReactNode
  adapter?: AuthAdapter
  loadPushModule?: () => Promise<PushTeardownModule>
  onSessionEnded?: () => void
  onCredentialChanged?: () => void
}

import {
  AuthLifetimeContext,
  useAuthLifetime,
  useOptionalAuthLifetime,
  type AuthLifetime,
} from './authLifetimeContext'

export type { AuthLifetime }

function createAuthLifetime(
  adapter: AuthAdapter,
  initialCallbacks: {
    onSessionEnded?: (() => void) | undefined
    onCredentialChanged?: (() => void) | undefined
  }
) {
  let currentCallbacks = initialCallbacks
  type Record = { listener: () => void; active: boolean; added: number }
  const priority = new Set<Record>()
  const react = new Set<Record>()
  let previous = adapter.getSnapshot()
  let usable = Boolean(adapter.getAccessToken())
  let stamp: object = {}
  let revision = 0
  let queued = false
  let dispatching = false
  let upstream: (() => void) | undefined
  let pendingEnded = false
  let pendingCredential = false
  let endedCount = 0
  let failures = 0
  const contain = (callback: (() => void) | undefined) => {
    try {
      callback?.()
    } catch {
      failures = Math.min(failures + 1, 1000)
    }
  }
  const ended = () => {
    endedCount += 1
    contain(currentCallbacks.onSessionEnded)
  }
  const dispatch = () => {
    queued = true
    if (dispatching) return
    dispatching = true
    try {
      while (queued) {
        queued = false
        const currentRevision = revision
        const sessionEnded = pendingEnded
        const credentialChanged = pendingCredential
        pendingEnded = false
        pendingCredential = false
        for (const record of [...priority]) {
          if (currentRevision !== revision) break
          if (record.active && record.added < currentRevision) contain(record.listener)
        }
        if (currentRevision !== revision) {
          pendingEnded ||= sessionEnded
          pendingCredential ||= credentialChanged
          continue
        }
        if (sessionEnded) ended()
        else if (credentialChanged) contain(currentCallbacks.onCredentialChanged)
        for (const record of [...react]) {
          if (currentRevision !== revision) break
          if (record.active && record.added < currentRevision) contain(record.listener)
        }
      }
    } finally {
      dispatching = false
    }
  }
  const update = () => {
    const next = adapter.getSnapshot()
    const nextUsable = Boolean(adapter.getAccessToken())
    const hadAuthenticatedUser = previous.user !== undefined
    const identityChanged =
      previous.user?.realm !== next.user?.realm ||
      previous.user?.identity?.issuer !== next.user?.identity?.issuer ||
      previous.user?.identity?.subject !== next.user?.identity?.subject
    const principalSwitched = hadAuthenticatedUser && identityChanged
    const sessionEnded =
      next.generation !== previous.generation ||
      (next.status === 'unauthenticated' && previous.status !== 'unauthenticated') ||
      principalSwitched
    const credentialChanged = next.credentialGeneration !== previous.credentialGeneration
    const changed =
      previous !== next ||
      sessionEnded ||
      credentialChanged ||
      identityChanged ||
      previous.status !== next.status ||
      usable !== nextUsable
    if (!changed) return
    if (sessionEnded || identityChanged || (usable && !nextUsable)) stamp = {}
    if (
      principalSwitched ||
      (hadAuthenticatedUser && sessionEnded) ||
      (previous.status !== 'unauthenticated' && next.status === 'unauthenticated')
    ) {
      contain(() => purgeEspaceVaultDatabases())
      contain(() => purgeDocsCollabDatabases(true))
    }
    previous = next
    usable = nextUsable
    revision += 1
    pendingEnded ||= sessionEnded
    pendingCredential ||= !sessionEnded && credentialChanged
    dispatch()
  }
  const subscribeTo = (records: Set<Record>, listener: () => void) => {
    const record = { listener, active: true, added: revision }
    records.add(record)
    if (!upstream) {
      upstream = adapter.subscribe(update)
      update()
    }
    return () => {
      if (!record.active) return
      record.active = false
      records.delete(record)
      if (priority.size === 0 && react.size === 0) {
        stamp = {}
        revision += 1
        const detach = upstream
        upstream = undefined
        contain(detach)
      }
    }
  }
  const port: AuthLifetime = {
    getSnapshot: () => adapter.getSnapshot(),
    hasUsableCredential: () => Boolean(adapter.getAccessToken()),
    getRetirementStamp: () => stamp,
    subscribe: (listener) => subscribeTo(priority, listener),
  }
  return {
    port,
    subscribeReact: (listener: () => void) => subscribeTo(react, listener),
    setCallbacks(next: typeof initialCallbacks) {
      currentCallbacks = next
    },
    retire() {
      stamp = {}
      revision += 1
      dispatch()
    },
    getEndedCount: () => endedCount,
    notifyEnded: ended,
  }
}

export function AuthProvider({
  children,
  adapter: adapterProp,
  loadPushModule = defaultLoadPushModule,
  onSessionEnded,
  onCredentialChanged,
}: AuthProviderProps) {
  const [adapter] = useState<AuthAdapter>(() => adapterProp ?? defaultAdapter)
  const [lifetime] = useState(() =>
    createAuthLifetime(adapter, { onSessionEnded, onCredentialChanged })
  )
  useLayoutEffect(() => {
    lifetime.setCallbacks({ onSessionEnded, onCredentialChanged })
  }, [lifetime, onSessionEnded, onCredentialChanged])
  const session = useSyncExternalStore(lifetime.subscribeReact, lifetime.port.getSnapshot)
  const user = session.user

  // The one place the client's bearer token comes from (docs/dev/API_CLIENT.md):
  // nothing else calls `setTokenProvider`, and the token itself never leaves
  // the adapter's own in-memory storage — this closure only asks for it.
  useEffect(() => {
    setTokenProvider(() => adapter.getAccessToken())
  }, [adapter])

  const signIn = useCallback((realm: string) => adapter.signIn(realm), [adapter])

  const handleCallback = useCallback(async () => {
    return adapter.handleCallback()
  }, [adapter])

  const signOut = useCallback(async () => {
    const take = matrixAuth.prepareMatrixSessionForSignOut()
    const before = lifetime.getEndedCount()
    let outgoingAccessToken: string | undefined
    let hadPushDeviceKey = false
    let pushDeviceId: string | null = null
    try {
      outgoingAccessToken = adapter.getAccessToken()
      hadPushDeviceKey = hasStoredPushDeviceKey()
      pushDeviceId = readStoredPushDeviceId()
    } catch {
      /* Local cleanup still follows. */
    }
    lifetime.retire()
    let didPushTeardown = false
    try {
      if (hadPushDeviceKey || pushSupported()) {
        const pushModule = await loadPushModuleBounded(loadPushModule)
        if (pushModule !== undefined) {
          didPushTeardown = await pushModule.disablePush({
            deviceId: pushDeviceId,
            accessToken: outgoingAccessToken,
            bestEffort: true,
          })
        }
      }
    } catch {
      didPushTeardown = false
    }
    // Observe rejection immediately, including a synchronous SDK throw, then do all local work.
    let ended: Promise<void>
    try {
      ended = Promise.resolve(adapter.signOut())
    } catch (error) {
      ended = Promise.reject(error)
    }
    const outcome = ended.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )
    if (lifetime.getEndedCount() === before) lifetime.notifyEnded()
    try {
      const target = take()
      if (target !== undefined) {
        try {
          void matrixAuth.signOutOfMatrix(target.baseUrl, target.accessToken).catch(() => undefined)
        } catch {
          /* Local cleanup still follows. */
        }
      }
    } finally {
      try {
        clearLocalSessionStorage(didPushTeardown ? { skipBrowserPushCleanup: true } : undefined)
      } catch {
        /* SDK outcome remains truthful. */
      }
    }
    const settled = await outcome
    if (!settled.ok) throw settled.error
  }, [adapter, lifetime, loadPushModule])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status: session.status,
      generation: session.generation,
      credentialGeneration: session.credentialGeneration,
      isAuthenticated: user !== undefined,
      signIn,
      handleCallback,
      signOut,
    }),
    [
      user,
      session.status,
      session.generation,
      session.credentialGeneration,
      signIn,
      handleCallback,
      signOut,
    ]
  )

  return (
    <AuthLifetimeContext.Provider value={lifetime.port}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </AuthLifetimeContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return value
}

export { useAuthLifetime, useOptionalAuthLifetime }
