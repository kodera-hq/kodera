/** Local consent contains no event data and is never sent to the collection service. */
export interface TelemetryScope {
  readonly person: string
  readonly workspace: string
  readonly slug: string
}
const PREFIX = 'kodera.telemetry.consent.v1:'
let scope: Readonly<TelemetryScope> | undefined
let accepted = false
let version = 0
const denied = new Set<string>()
const listeners = new Set<() => void>()
const key = (value: TelemetryScope) => PREFIX + JSON.stringify([value.person, value.workspace])
const notify = () => {
  version += 1
  for (const listener of listeners) listener()
}
function readConsent(): boolean {
  if (!scope || denied.has(key(scope))) return false
  try {
    return localStorage.getItem(key(scope)) === 'yes'
  } catch {
    return false
  }
}
export function getTelemetryConsentVersion() {
  return version
}
export function getTelemetryScope() {
  return scope
}
export function hasTelemetryConsent(): boolean {
  return accepted && scope !== undefined
}
export function setTelemetryScope(value: TelemetryScope | undefined): () => void {
  const owner = value ? Object.freeze({ ...value }) : undefined
  scope = owner
  accepted = readConsent()
  notify()
  return () => {
    if (scope === owner) {
      scope = undefined
      accepted = false
      notify()
    }
  }
}
export function setTelemetryConsent(enabled: boolean): void {
  if (!scope) return
  // Revoke first: blocked storage cannot leave the running transport enabled.
  accepted = false
  if (!enabled) denied.add(key(scope))
  notify()
  try {
    if (enabled) {
      localStorage.setItem(key(scope), 'yes')
      denied.delete(key(scope))
      accepted = readConsent()
    } else localStorage.removeItem(key(scope))
  } catch {
    /* Unavailable storage fails closed. */
  }
  notify()
}
export function subscribeTelemetryConsent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function refreshTelemetryConsent(event: StorageEvent): void {
  if (!scope || (event.key !== null && event.key !== key(scope))) return
  accepted = event.key !== null && event.newValue === 'yes' && readConsent()
  notify()
}

/** Priority subscription retires the sink before a protected React render can remain stale. */
export function bindTelemetryScope(
  value: TelemetryScope,
  lifetime: {
    hasUsableCredential(): boolean
    getRetirementStamp(): object
    subscribe(listener: () => void): () => void
  }
): () => void {
  if (!lifetime.hasUsableCredential()) return setTelemetryScope(undefined)
  const stamp = lifetime.getRetirementStamp()
  const clear = setTelemetryScope(value)
  const retire = () => {
    if (!lifetime.hasUsableCredential() || lifetime.getRetirementStamp() !== stamp) clear()
  }
  const unsubscribe = lifetime.subscribe(retire)
  retire()
  return () => {
    unsubscribe()
    clear()
  }
}
