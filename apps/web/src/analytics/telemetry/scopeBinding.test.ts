import { afterEach, expect, it, vi } from 'vitest'
import type { AuthLifetime } from '../../auth/AuthProvider'
import {
  bindTelemetryScope,
  getTelemetryScope,
  hasTelemetryConsent,
  setTelemetryConsent,
  setTelemetryScope,
} from './consent'
import { deferTelemetryScopeBinding } from './scopeBinding'

const scope = { person: 'person-a', workspace: 'workspace-a', slug: 'sample' }
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
afterEach(() => {
  setTelemetryScope(undefined)
  localStorage.clear()
})
function authority() {
  let stamp = {}
  let usable = true
  let listener = () => {}
  const lifetime = {
    getSnapshot: vi.fn(),
    getRetirementStamp: () => stamp,
    hasUsableCredential: () => usable,
    subscribe: (callback: () => void) => {
      listener = callback
      return () => {}
    },
  } satisfies AuthLifetime
  return {
    lifetime,
    retire: () => {
      stamp = {}
      listener()
    },
    expire: () => {
      usable = false
      listener()
    },
  }
}
it('binds only after the original owner survives import, then retires synchronously with authentication', async () => {
  const { lifetime, retire } = authority()
  const cancel = deferTelemetryScopeBinding(scope, lifetime, async () => ({ bindTelemetryScope }))
  expect(getTelemetryScope()).toBeUndefined()
  await settle()
  expect(getTelemetryScope()).toEqual(scope)
  setTelemetryConsent(true)
  expect(hasTelemetryConsent()).toBe(true)
  retire()
  expect(getTelemetryScope()).toBeUndefined()
  expect(hasTelemetryConsent()).toBe(false)
  cancel()
})
it.each(['cancel', 'retire', 'expire'] as const)(
  'does not revive an owner after %s while import is pending',
  async (reason) => {
    const auth = authority()
    const bind = vi.fn(bindTelemetryScope)
    let complete: ((module: { bindTelemetryScope: typeof bindTelemetryScope }) => void) | undefined
    const cancel = deferTelemetryScopeBinding(
      scope,
      auth.lifetime,
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    if (reason === 'cancel') cancel()
    else auth[reason]()
    complete!({ bindTelemetryScope: bind })
    await settle()
    expect(bind).not.toHaveBeenCalled()
    expect(getTelemetryScope()).toBeUndefined()
    cancel()
  }
)
it('an old import and cleanup cannot overwrite a newer workspace binding', async () => {
  const { lifetime } = authority()
  let complete: ((module: { bindTelemetryScope: typeof bindTelemetryScope }) => void) | undefined
  const old = deferTelemetryScopeBinding(
    scope,
    lifetime,
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  old()
  const nextScope = { ...scope, workspace: 'workspace-b' }
  const next = deferTelemetryScopeBinding(nextScope, lifetime, async () => ({ bindTelemetryScope }))
  await settle()
  complete!({ bindTelemetryScope })
  await settle()
  old()
  expect(getTelemetryScope()).toEqual(nextScope)
  next()
  expect(getTelemetryScope()).toBeUndefined()
})
it('contains an optional module load failure', async () => {
  const { lifetime } = authority()
  const cancel = deferTelemetryScopeBinding(scope, lifetime, () =>
    Promise.reject(new Error('unavailable'))
  )
  await settle()
  expect(getTelemetryScope()).toBeUndefined()
  cancel()
})
