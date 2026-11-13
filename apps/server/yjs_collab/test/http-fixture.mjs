/** Test-owned transform server; its stdout contains only the ephemeral loopback port. */
import { createTransformServer } from '../transform-http.mjs'
const key = Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url')
const server = createTransformServer(key)
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({port: server.address().port})))
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
