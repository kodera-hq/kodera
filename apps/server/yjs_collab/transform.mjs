/** Pure-state request schema, used in a bounded worker thread. */
import * as Y from 'yjs'
import { apply, inspect, load, readBytes, replace, Refused } from './engine.mjs'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export function transform(request) {
  if (!request || Array.isArray(request) || !['replace', 'apply', 'inspect'].includes(request.operation) ||
      typeof request.nonce !== 'string' || !uuid.test(request.nonce) || !Array.isArray(request.updates)) throw new Refused()
  const extra = request.operation === 'replace' ? ['markdown'] : request.operation === 'apply' ? ['update'] : []
  const allowed = ['operation', 'snapshot', 'updates', 'nonce', ...extra].sort()
  if (Object.keys(request).sort().join() !== allowed.join()) throw new Refused()
  const snapshot = readBytes(request.snapshot)
  if (request.updates.length > 256) throw new Refused('journal window exceeds limit')
  const updates = request.updates.map(value => readBytes(value))
  let bytes = snapshot.byteLength + updates.reduce((sum, part) => sum + part.byteLength, 0)
  const incoming = request.operation === 'apply' ? readBytes(request.update) : undefined
  bytes += incoming?.byteLength ?? 0
  if (bytes > 5 * 1024 * 1024) throw new Refused('combined state exceeds limit')
  const doc = load(snapshot, updates)
  try {
    let result
    if (request.operation === 'replace') result = replace(doc, request.markdown)
    else {
      const vector = Y.encodeStateVector(doc)
      if (incoming) apply(doc, incoming)
      result = {...inspect(doc), update: Y.encodeStateAsUpdate(doc, vector)}
    }
    return {snapshot: Buffer.from(result.state).toString('base64'), update: Buffer.from(result.update).toString('base64'), markdown: result.markdown, links: result.links}
  } finally { doc.destroy() }
}
