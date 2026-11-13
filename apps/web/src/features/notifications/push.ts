// Web Push for this browser (docs/specs/messaging-media-and-notifications.md). Core's pushes carry
// no payload: Core keeps the member's notifications, and the push only wakes `push-sw.js`, which
// shows a fixed line in the member's language and opens the console. The subscription is filed
// under a random id for this device, kept under the console's `kodera.web.` prefix, which the
// console's sign-out clears; signing out of this device also forgets the subscription here.

import { coreApi } from '../../api/client'

export const PUSH_DEVICE_KEY = 'kodera.web.push-device'
const WORKER = 'push-sw.js'

export class PushRefused extends Error {
  constructor(readonly reason: 'unsupported' | 'denied' | 'payload' | 'subscription' | 'core') {
    super(`push refused: ${reason}`)
    this.name = 'PushRefused'
  }
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** The VAPID key Core signs with, as the bytes `PushManager.subscribe` wants. */
export function applicationServerKey(publicKey: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{80,100}$/u.test(publicKey)) throw new PushRefused('core')
  const base64 = publicKey.replace(/-/gu, '+').replace(/_/gu, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
  // An uncompressed P-256 point: 65 bytes, starting with 4.
  if (bytes.length !== 65 || bytes[0] !== 4) throw new PushRefused('core')
  return bytes
}

export interface PushKeys {
  endpoint: string
  p256dh: string
  auth: string
}

/** The subscription as the contract takes it, or a refusal: https, and keys of the right size. */
export function subscriptionKeys(json: PushSubscriptionJSON): PushKeys {
  const endpoint = json.endpoint ?? ''
  const p256dh = json.keys?.['p256dh'] ?? ''
  const auth = json.keys?.['auth'] ?? ''
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new PushRefused('subscription')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new PushRefused('subscription')
  }
  if (!/^[A-Za-z0-9_-]{87}$/u.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/u.test(auth)) {
    throw new PushRefused('subscription')
  }
  return { endpoint: url.href, p256dh, auth }
}

function deviceId(): string {
  const stored = localStorage.getItem(PUSH_DEVICE_KEY)
  if (stored !== null && /^[0-9a-f-]{36}$/u.test(stored)) return stored
  const fresh = crypto.randomUUID()
  localStorage.setItem(PUSH_DEVICE_KEY, fresh)
  return fresh
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const base = import.meta.env.BASE_URL
  return navigator.serviceWorker.register(`${base}${WORKER}`, { scope: base })
}

/** Gives the worker the words it shows, in the member's language. */
export async function teachWorker(copy: { title: string; body: string }): Promise<void> {
  if (!pushSupported()) return
  const ready = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  ready?.active?.postMessage({ type: 'kodera-push-copy', ...copy })
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const existing = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  return (await existing?.pushManager.getSubscription()) ?? null
}

export async function enablePush(copy: { title: string; body: string }): Promise<void> {
  if (!pushSupported()) throw new PushRefused('unsupported')
  if ((await Notification.requestPermission()) !== 'granted') throw new PushRefused('denied')
  const { data } = await coreApi().GET('/push/public-key')
  // A key that would let Core send words through the push service is refused: this console only
  // takes empty pushes.
  if (data === undefined || data.payloadMode !== 'empty') throw new PushRefused('payload')
  const worker = await registration()
  await navigator.serviceWorker.ready
  const subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(data.publicKey) as BufferSource,
  })
  let keys: PushKeys
  try {
    keys = subscriptionKeys(subscription.toJSON())
  } catch (error) {
    await subscription.unsubscribe()
    throw error
  }
  const { response } = await coreApi().PUT('/push/subscriptions/{device_id}', {
    params: { path: { device_id: deviceId() } },
    body: keys,
  })
  if (!response.ok) {
    await subscription.unsubscribe()
    throw new PushRefused('core')
  }
  await teachWorker(copy)
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription()
  await subscription?.unsubscribe()
  const id = localStorage.getItem(PUSH_DEVICE_KEY)
  if (id === null) return
  await coreApi().DELETE('/push/subscriptions/{device_id}', { params: { path: { device_id: id } } })
  localStorage.removeItem(PUSH_DEVICE_KEY)
}
