/** Reuse bounded, environment-free workers without blocking the WebSocket event loop. */
import { Worker } from 'node:worker_threads'
import { Refused } from './engine.mjs'
const slots = new Set()
let next = 0
export class Busy extends Error { constructor() { super('document worker unavailable') } }
function spawn() {
  const worker = new Worker(new URL('./transform-worker.mjs', import.meta.url), {env: {}, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 128, stackSizeMb: 4}})
  const slot = {worker, current: null, retiring: false, jobs: 0, bytes: 0}
  slots.add(slot)
  worker.unref()
  async function finish(error, value) {
    const job = slot.current
    if (!job) return
    slot.current = null
    clearTimeout(job.timer)
    if (slot.retiring) {
      try { await worker.terminate() } catch { /* No input or application key is logged. */ }
      slots.delete(slot)
    } else worker.unref()
    if (error) job.reject(error)
    else job.resolve(value)
  }
  worker.on('message', result => {
    if (!slot.current || result.id !== slot.current.id) return
    if (slot.jobs >= 128 || slot.bytes >= 32 * 1024 * 1024) slot.retiring = true
    void finish(result.ok === true ? null : new Refused(), result.value)
  })
  worker.on('error', () => { slot.retiring = true; void finish(new Busy()) })
  worker.on('exit', () => {
    slots.delete(slot)
    if (slot.current) { slot.retiring = true; void finish(new Busy()) }
  })
  return slot
}
export async function work(request) {
  let slot = [...slots].find(value => !value.current && !value.retiring)
  if (!slot) {
    if (slots.size >= 4) throw new Busy()
    slot = spawn()
  }
  const id = ++next
  slot.worker.ref()
  slot.jobs += 1
  slot.bytes += JSON.stringify(request).length
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { slot.retiring = true; void slot.worker.terminate() }, 3000)
    slot.current = {id, resolve, reject, timer}
    slot.worker.postMessage({id, request})
  })
}
