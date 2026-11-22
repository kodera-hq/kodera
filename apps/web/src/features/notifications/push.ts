// Web Push for this browser (docs/specs/messaging-media-and-notifications.md). Core's pushes carry
// no payload: Core keeps the member's notifications, and the push only wakes `push-sw.js`, which
// shows a fixed line in the member's language and opens the console. The subscription is filed
// under a random id for this device, kept under the console's `kodera.web.` prefix, which the
// console's sign-out clears; signing out of this device also forgets the subscription here.

import { coreApi } from '../../api/client'
import { PUSH_COPY_CACHE } from '../../auth/localSession'
import {
  PUSH_DEVICE_KEY,
  hasStoredPushDeviceKey,
  pushSupported,
  readStoredPushDeviceId,
} from './pushState'

export {
  PUSH_COPY_CACHE,
  PUSH_DEVICE_KEY,
  hasStoredPushDeviceKey,
  pushSupported,
  readStoredPushDeviceId,
}
const WORKER = 'push-sw.js'
const SIGN_OUT_PUSH_WAIT_MS = 3_000

export class PushRefused extends Error {
  constructor(readonly reason: 'unsupported' | 'denied' | 'payload' | 'subscription' | 'core') {
    super(`push refused: ${reason}`)
    this.name = 'PushRefused'
  }
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
  const stored = readStoredPushDeviceId()
  if (stored !== null) return stored
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

async function forgetPushCopy(): Promise<boolean> {
  let deleted = true
  try {
    if (globalThis.caches !== undefined) {
      await globalThis.caches.delete(PUSH_COPY_CACHE)
    }
  } catch {
    deleted = false
  }
  if (!pushSupported()) return deleted
  try {
    const ready = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
    ready?.active?.postMessage({ type: 'kodera-push-forget' })
  } catch {
    // Best-effort worker notification.
  }
  return deleted
}

export interface DisablePushOptions {
  readonly deviceId?: string | null | undefined
  readonly accessToken?: string | undefined
  readonly bestEffort?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

async function withBoundedTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function disablePush(options?: DisablePushOptions): Promise<boolean> {
  const hadDeviceKey =
    hasStoredPushDeviceKey() || (options?.deviceId !== undefined && options.deviceId !== null)
  const id =
    options?.deviceId !== undefined
      ? options.deviceId !== null && /^[0-9a-f-]{36}$/iu.test(options.deviceId)
        ? options.deviceId
        : null
      : readStoredPushDeviceId()
  const timeoutMs = options?.timeoutMs ?? SIGN_OUT_PUSH_WAIT_MS

  if (options?.bestEffort === true) {
    try {
      if (id !== null) {
        const abort = new AbortController()
        const deleteTimer = setTimeout(() => abort.abort(), timeoutMs)
        try {
          await withBoundedTimeout(
            coreApi()
              .DELETE('/push/subscriptions/{device_id}', {
                params: { path: { device_id: id } },
                ...(options.accessToken !== undefined
                  ? {
                      middleware: [
                        {
                          onRequest({ request }) {
                            request.headers.set('Authorization', `Bearer ${options.accessToken}`)
                            return request
                          },
                        },
                      ],
                    }
                  : {}),
                signal: abort.signal,
              })
              .catch(() => undefined),
            timeoutMs
          )
        } finally {
          clearTimeout(deleteTimer)
        }
      }
      const unsubscribed = await withBoundedTimeout(
        currentSubscription()
          .then(async (subscription) => {
            if (subscription !== null) await subscription.unsubscribe()
            return true
          })
          .catch(() => false),
        timeoutMs
      )
      const cacheDeleted = await withBoundedTimeout(forgetPushCopy(), timeoutMs)
      return unsubscribed === true && cacheDeleted === true
    } finally {
      if (hadDeviceKey) {
        try {
          localStorage.removeItem(PUSH_DEVICE_KEY)
        } catch {
          // Storage blocked.
        }
      }
    }
  }

  if (id !== null) {
    await coreApi().DELETE('/push/subscriptions/{device_id}', {
      params: { path: { device_id: id } },
      ...(options?.accessToken !== undefined
        ? {
            middleware: [
              {
                onRequest({ request }) {
                  request.headers.set('Authorization', `Bearer ${options.accessToken}`)
                  return request
                },
              },
            ],
          }
        : {}),
    })
  }
  const subscription = await currentSubscription()
  await subscription?.unsubscribe()
  const cacheDeleted = await forgetPushCopy()
  if (hadDeviceKey) {
    localStorage.removeItem(PUSH_DEVICE_KEY)
  }
  return cacheDeleted
}
