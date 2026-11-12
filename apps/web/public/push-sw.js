// Kodera's Web Push worker (docs/specs/messaging-media-and-notifications.md). Core sends every
// push without a payload (`payloadMode: "empty"`): the push service carries no message, no name and
// no room, only the fact that something arrived. This worker never reads what a push carries. It shows
// the words the console last gave it, in the member's language, and opens the console on a click.
// It holds no copy of its own beyond the product name, and fetches nothing.

const COPY_CACHE = 'kodera-push-copy-v1'
const COPY_KEY = 'push-copy'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function plain(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max)
    : ''
}

self.addEventListener('message', (message) => {
  // Only a page of this origin can post here; its copy is still checked before it is kept.
  const data = message.data
  if (data === null || typeof data !== 'object' || data.type !== 'kodera-push-copy') return
  const copy = { title: plain(data.title, 80), body: plain(data.body, 160) }
  message.waitUntil(
    caches
      .open(COPY_CACHE)
      .then((cache) =>
        cache.put(
          COPY_KEY,
          new Response(JSON.stringify(copy), { headers: { 'Content-Type': 'application/json' } })
        )
      )
  )
})

async function copy() {
  try {
    const cache = await caches.open(COPY_CACHE)
    const stored = await cache.match(COPY_KEY)
    const parsed = stored === undefined ? null : await stored.json()
    if (parsed !== null && typeof parsed === 'object') {
      return { title: plain(parsed.title, 80) || 'Kodera', body: plain(parsed.body, 160) }
    }
  } catch {
    // The defaults below.
  }
  return { title: 'Kodera', body: '' }
}

self.addEventListener('push', (push) => {
  push.waitUntil(
    copy().then(({ title, body }) =>
      self.registration.showNotification(title, {
        body,
        tag: 'kodera-activity',
        renotify: true,
        icon: new URL('icon-192.png', self.registration.scope).href,
      })
    )
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const scope = self.registration.scope
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(scope))
      return open !== undefined ? open.focus() : self.clients.openWindow(scope)
    })
  )
})
