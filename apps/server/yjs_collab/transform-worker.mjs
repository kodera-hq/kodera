/** No I/O and no inherited application data in the CPU-bound document worker. */
import { parentPort } from 'node:worker_threads'
import { transform } from './transform.mjs'
parentPort.on('message', ({id, request}) => {
  try { parentPort.postMessage({id, ok: true, value: transform(request)}) }
  catch { parentPort.postMessage({id, ok: false}) }
})
