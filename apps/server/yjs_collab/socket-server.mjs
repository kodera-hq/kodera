/** First-frame admission, current-policy emission fences and ephemeral room presence. */
import * as Y from 'yjs'
import { WebSocket, WebSocketServer } from 'ws'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { createTransformServer } from './transform-http.mjs'
import { verify, bind, TicketRefused } from './tickets.mjs'
import {
  confidentialFrame,
  ConfidentialRefused,
  frame,
  snapshotFrame,
  storedVectorFrame,
  storedDiff,
  updateFrame,
  ViewerWrite,
} from './protocol.mjs'
import { Refused } from './engine.mjs'
import { LockBusy } from './store.mjs'
import { receive, awarenessFrame } from './presence.mjs'
const MAX_BUFFER = 2 * 1024 * 1024 + 32

export function createCollabServer({key, store, origins, pollMilliseconds = 1000}) {
  const server = createTransformServer(key)
  const wss = new WebSocketServer({noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false})
  const rooms = new Map(), connections = new Set()
  let unauthenticated = 0, pendingBytes = 0, polling = false
  function close(socket, code = 4403, reason) {
    const label = reason ?? (code === 4401 ? 'ticket refused' : code === 1013 ? 'retry later' : 'operation refused')
    if (socket.readyState === WebSocket.OPEN) socket.close(code, label)
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
    if (error instanceof TicketRefused) close(socket, error.code)
    else if (error instanceof ConfidentialRefused) close(socket, 4403)
    else if (error instanceof Refused) close(socket, 1008)
    else if (error instanceof LockBusy) close(socket, 1013, 'lock-busy')
    else close(socket, 1013)
  }
  function roomFor(document, confidential = false) {
    let room = rooms.get(document)
    if (room) {
      if (room.confidential !== Boolean(confidential)) throw new TicketRefused(4403)
      return room
    }
    if (rooms.size >= 32) throw new Error('room capacity reached')
    if (confidential) {
      room = {
        confidential: true,
        doc: null,
        awareness: null,
        connections: new Set(),
        owners: new Map(),
        senders: new Map(),
        refreshing: false,
      }
      rooms.set(document, room)
      return room
    }
    const doc = new Y.Doc(), awareness = new Awareness(doc)
    awareness._checkInterval?.unref?.()
    awareness.setLocalState(null)
    room = {
      confidential: false,
      doc,
      awareness,
      connections: new Set(),
      owners: new Map(),
      senders: new Map(),
      refreshing: false,
    }
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
  function enqueueDelivery(socket, task) {
    const run = socket.deliveryChain.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return
      await task()
    })
    socket.deliveryChain = run.then(() => undefined, () => undefined)
    return run
  }
  async function refresh(socket) {
    if (!socket.claims || socket.readyState !== WebSocket.OPEN) return
    try {
      if (socket.claims.confidential) {
        await enqueueDelivery(socket, async () => {
          if (!socket.claims || socket.deliveredHead === null) return
          await store.deliver(socket.claims, ({envelopes = [], journalSeqs, head = 0, revision}) => {
            for (const envelope of envelopes) send(socket, envelope)
            if (Array.isArray(journalSeqs)) socket.journalSeqs.push(...journalSeqs)
            else for (let s = socket.deliveredHead + 1; s <= head; s += 1) socket.journalSeqs.push(s)
            socket.deliveredHead = head
            socket.revision = revision
          }, socket.deliveredHead)
        })
        return
      }
      await store.deliver(socket.claims, ({state, revision}) => {
        send(socket, updateFrame(state));socket.revision = revision
      }, socket.revision)
    } catch (error) {
      failure(socket, error)
    }
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
    socket.claims = null;socket.presenceId = null;socket.revision = null;socket.deliveredHead = null
    socket.admittedHead = 0;socket.journalSeqs = [];socket.deliveryChain = Promise.resolve()
    socket.confidentialSender = null;socket.confidentialSequence = 0;socket.anonymous = true
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
          await enqueueDelivery(socket, () => store.admit(claims, payload => {
            if (socket.readyState !== WebSocket.OPEN) return
            const room = roomFor(claims.document, claims.confidential)
            if (room.connections.size >= 32 || [...connections].filter(peer => peer.claims?.identity === claims.identity).length >= 4) throw new Error('connection capacity reached')
            socket.claims = claims;socket.revision = payload.revision
            socket.anonymous = false;unauthenticated -= 1;clearTimeout(firstFrame)
            room.connections.add(socket)
            socket.expiry = setTimeout(() => close(socket, 4401), Math.max(1, claims.expires * 1000 - Date.now()))
            if (claims.confidential) {
              const head = payload.head ?? 0
              socket.admittedHead = head
              socket.deliveredHead = head
              if (Array.isArray(payload.journalSeqs)) socket.journalSeqs.push(...payload.journalSeqs)
              else for (let s = 1; s <= (payload.envelopes?.length ?? 0); s += 1) socket.journalSeqs.push(s)
              for (const envelope of payload.envelopes ?? []) {
                send(socket, envelope)
              }
              return
            }
            send(socket, snapshotFrame(payload.state))
            if (claims.role === 'editor') send(socket, storedVectorFrame(payload.state))
            if (room.awareness.getStates().size) send(socket, awarenessFrame(encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()])))
          }))
          return
        }
        if (socket.claims.confidential) {
          if (!binary) {
            try {
              if (data.byteLength > 2 * 1024 * 1024 + 4096) throw new ConfidentialRefused('compact control frame too large')
              let cmd
              try { cmd = JSON.parse(data.toString('utf8')) } catch { throw new ConfidentialRefused('malformed confidential control frame') }
              if (
                !cmd ||
                typeof cmd !== 'object' ||
                Array.isArray(cmd) ||
                Object.getOwnPropertyNames(cmd).sort().join() !== 'snapshot,type,upToHead' ||
                cmd.type !== 'compact' ||
                typeof cmd.upToHead !== 'number' ||
                !Number.isSafeInteger(cmd.upToHead) ||
                cmd.upToHead < 0 ||
                typeof cmd.snapshot !== 'string' ||
                cmd.snapshot.length === 0
              ) {
                throw new ConfidentialRefused('invalid confidential control frame')
              }
              if (socket.claims.role !== 'editor') throw new ViewerWrite()
              if (socket.deliveredHead === null || cmd.upToHead > socket.deliveredHead) {
                throw new ConfidentialRefused('compaction cursor ahead of socket delivered head')
              }
              const snapshotBytes = new Uint8Array(Buffer.from(cmd.snapshot, 'base64'))
              const parsed = confidentialFrame(snapshotBytes, socket.claims.role, socket.claims.epoch)
              if (parsed.kind !== 3) throw new ConfidentialRefused('compact control requires kind=3 snapshot')
              await store.compact(socket.claims, cmd.upToHead, parsed.envelope)
              return
            } catch (error) {
              if (error instanceof ViewerWrite || error instanceof ConfidentialRefused) {
                await store.viewerRefusal(socket.claims)
                close(socket, 4403)
                return
              }
              throw error
            }
          }
          let message
          try {
            message = confidentialFrame(new Uint8Array(data), socket.claims.role, socket.claims.epoch)
            const room = rooms.get(socket.claims.document)
            if (!room || !room.confidential) throw new TicketRefused(4403)
            if (message.kind !== 3) {
              if (socket.confidentialSender === null) {
                const existingOwner = room.senders.get(message.sender)
                if (existingOwner && existingOwner !== socket) {
                  throw new ConfidentialRefused('duplicate confidential sender on active room')
                }
                socket.confidentialSender = message.sender
                room.senders.set(message.sender, socket)
              } else if (message.sender !== socket.confidentialSender) {
                throw new ConfidentialRefused('confidential sender mismatch on socket')
              }
              if (message.sequence <= socket.confidentialSequence) {
                throw new ConfidentialRefused('confidential sequence must strictly increase')
              }
              socket.confidentialSequence = message.sequence
            }
          } catch (error) {
            if (error instanceof ViewerWrite || error instanceof ConfidentialRefused) {
              await store.viewerRefusal(socket.claims)
              close(socket, 4403)
              return
            }
            throw error
          }
          const room = rooms.get(socket.claims.document)
          if (!room) throw new TicketRefused(4403)
          if (message.kind === 3) {
            let upToHead
            if (socket.journalSeqs.length === 0 && message.sequence === 1) {
              upToHead = socket.admittedHead ?? 0
            } else if (message.sequence >= 1 && message.sequence <= socket.journalSeqs.length) {
              upToHead = socket.journalSeqs[message.sequence - 1]
            } else {
              await store.viewerRefusal(socket.claims)
              close(socket, 4403)
              return
            }
            try {
              await store.compact(socket.claims, upToHead, message.envelope)
            } catch (error) {
              if (error instanceof ViewerWrite || error instanceof ConfidentialRefused) {
                await store.viewerRefusal(socket.claims)
                close(socket, 4403)
                return
              }
              throw error
            }
            return
          }
          if (message.kind === 0) {
            const result = await store.update(socket.claims, message.envelope)
            await enqueueDelivery(socket, async () => {
              if (socket.deliveredHead !== null && socket.deliveredHead < result.head - 1) {
                await store.deliver(socket.claims, ({envelopes = [], journalSeqs}) => {
                  for (let i = 0; i < envelopes.length; i += 1) {
                    const seq = Array.isArray(journalSeqs) ? journalSeqs[i] : undefined
                    if (seq !== result.head) {
                      send(socket, envelopes[i])
                      if (seq !== undefined) socket.journalSeqs.push(seq)
                    }
                  }
                }, socket.deliveredHead)
              }
              socket.deliveredHead = Math.max(socket.deliveredHead ?? 0, result.head)
              socket.revision = result.revision
              if (socket.journalSeqs[socket.journalSeqs.length - 1] !== result.head) {
                socket.journalSeqs.push(result.head)
              }
            })
            for (const target of [...room.connections]) {
              if (target === socket || target.readyState !== WebSocket.OPEN) continue
              await enqueueDelivery(target, async () => {
                if (!target.claims || target.deliveredHead === null || target.deliveredHead >= result.head) return
                if (target.deliveredHead === result.head - 1) {
                  await store.emit(target.claims, () => {
                    send(target, result.envelope)
                    target.deliveredHead = result.head
                    target.revision = result.revision
                    target.journalSeqs.push(result.head)
                  })
                  return
                }
                await store.deliver(target.claims, ({envelopes = [], journalSeqs, head = 0, revision}) => {
                  for (const envelope of envelopes) send(target, envelope)
                  if (Array.isArray(journalSeqs)) target.journalSeqs.push(...journalSeqs)
                  else for (let s = target.deliveredHead + 1; s <= head; s += 1) target.journalSeqs.push(s)
                  target.deliveredHead = head
                  target.revision = revision
                }, target.deliveredHead)
              }).catch(error => failure(target, error))
            }
          } else {
            await store.emit(socket.claims, () => true)
            for (const target of [...room.connections]) {
              if (target === socket || target.readyState !== WebSocket.OPEN) continue
              try {
                await store.emit(target.claims, () => send(target, message.envelope))
              } catch (error) {
                failure(target, error)
              }
            }
          }
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
      if (socket.confidentialSender !== null && room.senders.get(socket.confidentialSender) === socket) {
        room.senders.delete(socket.confidentialSender)
      }
      if (!room.confidential && socket.presenceId !== null) {
        room.owners.delete(socket.presenceId)
        removeAwarenessStates(room.awareness, [socket.presenceId], socket)
      }
      if (!room.connections.size) {
        rooms.delete(socket.claims.document)
        room.awareness?.destroy?.()
        room.doc?.destroy?.()
      }
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
      for (const room of rooms.values()) { room.awareness?.destroy?.();room.doc?.destroy?.() }
      rooms.clear()
      await new Promise(resolve => wss.close(resolve))
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
