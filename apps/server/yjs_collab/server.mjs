/** Separately deployed native collaboration service with PostgreSQL recovery. */
import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { configuration } from './configuration.mjs'
import { createCollabServer } from './socket-server.mjs'
import { Store } from './store.mjs'
import { assertDatabaseBoundary } from './database-boundary.mjs'

export async function start(environment) {
  const config = configuration(environment)
  const pool = new pg.Pool({connectionString: config.connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000})
  pool.on('error', () => {})
  try {
    await assertDatabaseBoundary(pool)
  } catch (error) { await pool.end();throw error }
  const service = createCollabServer({key: config.key, store: new Store(pool), origins: config.origins})
  let stopping = false, listener = null, reconnect = null
  async function listen() {
    if (stopping) return
    const candidate = new pg.Client({connectionString: config.connectionString, connectionTimeoutMillis: 5000})
    let failed = false
    function retry() {
      if (failed) return
      failed = true
      if (listener === candidate) listener = null
      void candidate.end().catch(() => {})
      if (!stopping) { reconnect = setTimeout(() => void listen(), 1000);reconnect.unref() }
    }
    candidate.on('error', retry)
    candidate.on('end', retry)
    candidate.on('notification', message => {
      if (message.channel === 'kodera_docs' && /^[a-f0-9-]{36}$/.test(message.payload ?? '')) void service.notify(message.payload)
    })
    try { await candidate.connect();await candidate.query('LISTEN kodera_docs');listener = candidate }
    catch { retry() }
  }
  await listen()
  try {
    await new Promise((resolve, reject) => {
      service.server.once('error', reject)
      service.server.listen(config.port, '0.0.0.0', resolve)
    })
  } catch {
    stopping = true;clearTimeout(reconnect)
    if (listener) await listener.end().catch(() => {})
    await service.shutdown();await pool.end()
    throw new Error('collaboration startup refused')
  }
  return {
    ...service,
    async shutdown() {
      stopping = true;clearTimeout(reconnect)
      if (listener) await listener.end().catch(() => {})
      await service.shutdown()
      await pool.end()
    },
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let running
  start(process.env).then(value => { running = value;process.stdout.write('Document collaboration service started\n') }).catch(() => {
    process.stderr.write('Document collaboration startup refused\n');process.exitCode = 1
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    if (running) void running.shutdown().finally(() => process.exit(0))
    else process.exit(1)
  })
}
