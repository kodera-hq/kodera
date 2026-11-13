/** First-frame admission, current-policy emission fences and ephemeral room presence. */
import * as Y from 'yjs'
import { WebSocket, WebSocketServer } from 'ws'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { createTransformServer } from './transform-http.mjs'
import { verify, bind, TicketRefused } from './tickets.mjs'
import { frame, snapshotFrame, storedVectorFrame, storedDiff, updateFrame, ViewerWrite } from './protocol.mjs'
import { Refused } from './engine.mjs'
import { receive, awarenessFrame } from './presence.mjs'
const MAX_BUFFER = 2 * 1024 * 1024 + 32

export function createCollabServer({key, store, origins, pollMilliseconds = 1000}) {
  const server = createTransformServer(key)
  const wss = new WebSocketServer({noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false})
  const rooms = new Map(), connections = new Set()
  let unauthenticated = 0, pendingBytes = 0, polling = false
  function close(socket, code = 4403) {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, code === 4401 ? 'ticket refused' : code === 1013 ? 'retry later' : 'operation refused')
    if (!socket.forcedClose) {
      socket.forcedClose = setTimeout(() => socket.terminate(), 1000)
      socket.forcedClose.unref()
    }
  }
  function send(socket, bytes) {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount + bytes.byteLength > MAX_BUFFER) { close(socket, 1013);return }
    socket.send(bytes, {binary: true}, error => { if (error) close(socket, 1013) })
  }
  function failure(socket, error) {
    close(socket, error instanceof TicketRefused ? error.code : error instanceof Refused ? 1008 : 1013)
  }
  function roomFor(document) {
    let room = rooms.get(document)
    if (room) return room
    if (rooms.size >= 32) throw new Error('room capacity reached')
    const doc = new Y.Doc(), awareness = new Awareness(doc)
    awareness.setLocalState(null)
    room = {doc, awareness, connections: new Set(), owners: new Map(), refreshing: false}
    rooms.set(document, room)
    awareness.on('update', ({added, updated, removed}) => {
      const changed = [...added, ...updated, ...removed]
      const packet = awarenessFrame(encodeAwarenessUpdate(awareness, changed))
      void (async () => {
        for (const target of [...room.connections]) {
          if (target.readyState !== WebSocket.OPEN) continue
          try { await store.emit(target.claims, () => send(target, packet)) } catch (error) { failure(target, error) }
        }
      })()
    })
    return room
  }
  async function refresh(socket) {
    if (!socket.claims || socket.readyState !== WebSocket.OPEN) return
    try {
      await store.deliver(socket.claims, ({state, revision}) => {
        send(socket, updateFrame(state));socket.revision = revision
      }, socket.revision)
    } catch (error) { failure(socket, error) }
  }
  async function refreshRoom(document) {
    const room = rooms.get(document)
    if (!room || room.refreshing) return
    room.refreshing = true
    try { for (const socket of [...room.connections]) await refresh(socket) }
    finally { room.refreshing = false }
  }
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/documents/collab' || typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin) || connections.size >= 64 || unauthenticated >= 8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    try { wss.handleUpgrade(request, socket, head, webSocket => wss.emit('connection', webSocket)) }
    catch { socket.destroy() }
  })
  wss.on('connection', socket => {
    connections.add(socket);unauthenticated += 1
    socket.claims = null;socket.presenceId = null;socket.revision = null;socket.anonymous = true
    let chain = Promise.resolve(), queued = 0, window = performance.now(), frames = 0, bytes = 0
    const firstFrame = setTimeout(() => close(socket, 4401), 5000)
    socket.on('error', () => close(socket, 1013))
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return
      const now = performance.now()
      if (now - window >= 1000) { window = now;frames = 0;bytes = 0 }
      frames += 1;bytes += data.byteLength
      if (frames > 60 || bytes > 4 * 1024 * 1024 || queued >= 8 || pendingBytes + data.byteLength > 16 * 1024 * 1024) { close(socket, 1008);return }
      queued += 1;pendingBytes += data.byteLength
      chain = chain.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return
        if (!socket.claims) {
          if (binary || data.byteLength > 6144) throw new TicketRefused()
          let first
          try { first = JSON.parse(data.toString('utf8')) } catch { throw new TicketRefused() }
          if (!first || typeof first !== 'object' || Array.isArray(first)) throw new TicketRefused()
          const firstKeys = Object.getOwnPropertyNames(first).sort().join()
          let claims
          if (firstKeys === 'token,type' && first.type === 'auth') {
            claims = verify(first.token, key)
          } else if (firstKeys === 'document,organisation,token') {
            claims = verify(first.token, key)
            bind(claims, {organisation: first.organisation, document: first.document, role: claims.role})
          } else {
            throw new TicketRefused()
          }
          await store.admit(claims, ({state, revision}) => {
            if (socket.readyState !== WebSocket.OPEN) return
            const room = roomFor(claims.document)
            if (room.connections.size >= 32 || [...connections].filter(peer => peer.claims?.identity === claims.identity).length >= 4) throw new Error('connection capacity reached')
            socket.claims = claims;socket.revision = revision
            socket.anonymous = false;unauthenticated -= 1;clearTimeout(firstFrame)
            room.connections.add(socket)
            socket.expiry = setTimeout(() => close(socket, 4401), Math.max(1, claims.expires * 1000 - Date.now()))
            send(socket, snapshotFrame(state))
            if (claims.role === 'editor') send(socket, storedVectorFrame(state))
            if (room.awareness.getStates().size) send(socket, awarenessFrame(encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()])))
          })
          return
        }
        if (!binary) throw new Refused('binary protocol frame required')
        let message
        try { message = frame(new Uint8Array(data), socket.claims.role) }
        catch (error) {
          if (error instanceof ViewerWrite) { await store.viewerRefusal(socket.claims);close(socket, 4403);return }
          throw error
        }
        const room = rooms.get(socket.claims.document)
        if (!room) throw new TicketRefused(4403)
        if (message.kind === 'vector') {
          await store.deliver(socket.claims, ({state, revision}) => {
            send(socket, snapshotFrame(storedDiff(state, message.body)));socket.revision = revision
          })
        } else if (message.kind === 'update') {
          const result = await store.update(socket.claims, message.body)
          const packet = updateFrame(result.update)
          for (const target of [...room.connections]) {
            if (target.readyState !== WebSocket.OPEN) continue
            try { await store.emit(target.claims, () => { send(target, packet);target.revision = result.revision }) }
            catch (error) { failure(target, error) }
          }
        } else if (message.kind === 'awareness') {
          await store.emit(socket.claims, () => applyAwarenessUpdate(room.awareness, receive(message.body, socket, room), socket))
        } else {
          await store.emit(socket.claims, () => send(socket, awarenessFrame(encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]))))
        }
      }).catch(error => failure(socket, error)).finally(() => { queued -= 1;pendingBytes -= data.byteLength })
    })
    socket.on('close', () => {
      clearTimeout(firstFrame);clearTimeout(socket.expiry);clearTimeout(socket.forcedClose)
      connections.delete(socket)
      if (socket.anonymous) { unauthenticated -= 1;socket.anonymous = false }
      if (!socket.claims) return
      const room = rooms.get(socket.claims.document)
      if (!room) return
      room.connections.delete(socket)
      if (socket.presenceId !== null) { room.owners.delete(socket.presenceId);removeAwarenessStates(room.awareness, [socket.presenceId], socket) }
      if (!room.connections.size) { rooms.delete(socket.claims.document);room.doc.destroy() }
    })
  })
  const poll = setInterval(() => {
    if (polling) return
    polling = true
    void (async () => { try { for (const socket of [...connections]) await refresh(socket) } finally { polling = false } })()
  }, pollMilliseconds)
  poll.unref()
  return {
    server, wss, rooms,
    notify: document => refreshRoom(document),
    async shutdown() {
      clearInterval(poll)
      for (const socket of connections) socket.terminate()
      await new Promise(resolve => wss.close(resolve))
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
