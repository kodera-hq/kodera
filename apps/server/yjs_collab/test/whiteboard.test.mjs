import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { randomUUID } from 'node:crypto'
import {
  ALLOWED_WHITEBOARD_COLORS,
  ALLOWED_WHITEBOARD_KINDS,
  MAX_WHITEBOARD_ELEMENTS,
  MAX_WHITEBOARD_TEXT,
  WHITEBOARD_COORD_BOUND,
  Refused,
  apply,
  inspect,
  load,
  replace,
} from '../engine.mjs'
import { transform } from '../transform.mjs'

test('whiteboard_elements array supports all six element kinds, Y.Map entries, and concurrent CRDT merges', () => {
  const doc = load()
  try {
    const arr = doc.getArray('whiteboard_elements')
    const stickyMap = new Y.Map()
    stickyMap.set('id', 'sticky-1')
    stickyMap.set('kind', 'sticky')
    stickyMap.set('x', -240)
    stickyMap.set('y', 120)
    stickyMap.set('width', 200)
    stickyMap.set('height', 160)
    stickyMap.set('color', 'warning')
    stickyMap.set('fill', 'warning')
    stickyMap.set('text', 'Architecture review notes\nLine 2')

    arr.push([
      {
        id: 'pen-1',
        kind: 'pen',
        x: 10,
        y: 20,
        points: [[10, 20], [15.5, 25.25], [40, 60]],
        color: 'ink',
        strokeWidth: 2.5,
      },
      {
        id: 'rect-1',
        kind: 'rect',
        x: 100,
        y: 100,
        width: 320,
        height: 180,
        color: 'accent',
        fill: 'none',
        strokeWidth: 2,
      },
      {
        id: 'ellipse-1',
        kind: 'ellipse',
        x: -50,
        y: -50,
        width: 100,
        height: 80,
        color: 'success',
      },
      {
        id: 'arrow-1',
        kind: 'arrow',
        x: 0,
        y: 0,
        x2: 250,
        y2: -120,
        color: 'danger',
      },
      stickyMap,
      {
        id: 'text-1',
        kind: 'text',
        x: 400,
        y: 80,
        color: 'muted',
        text: 'Sprint H3.3 Milestone',
      },
    ])

    const meta = doc.getMap('whiteboard')
    meta.set('title', 'System Canvas')
    meta.set('grid', true)
    meta.set('version', 1)

    const inspected = inspect(doc)
    assert.equal(inspected.markdown, '')
    assert.deepEqual(inspected.links, [])
    assert.ok(inspected.state.byteLength > 0)

    // Concurrent merge with a second peer that also adds a ProseMirror doc body
    const peer = load(inspected.state)
    try {
      replace(peer, '# Meeting Notes\n\nSee [[Diagram Spec]]\n')
      peer.getArray('whiteboard_elements').push([
        {
          id: 'rect-peer',
          kind: 'rect',
          x: 500,
          y: 200,
          width: 140,
          height: 90,
          color: 'accent',
        },
      ])
      const peerUpdate = Y.encodeStateAsUpdate(peer)
      apply(doc, peerUpdate)
      const merged = inspect(doc)
      assert.match(merged.markdown, /^# Meeting Notes/)
      assert.deepEqual(merged.links, ['Diagram Spec'])
      assert.equal(doc.getArray('whiteboard_elements').length, 7)
    } finally {
      peer.destroy()
    }
  } finally {
    doc.destroy()
  }
})

test('whiteboard validation enforces <= 2000 elements, coordinate bounds [-100000, 100000], and text <= 512 chars', () => {
  assert.equal(MAX_WHITEBOARD_ELEMENTS, 2000)
  assert.equal(WHITEBOARD_COORD_BOUND, 100000)
  assert.equal(MAX_WHITEBOARD_TEXT, 512)
  assert.deepEqual([...ALLOWED_WHITEBOARD_KINDS].sort(), ['arrow', 'ellipse', 'pen', 'rect', 'sticky', 'text'])
  assert.deepEqual([...ALLOWED_WHITEBOARD_COLORS].sort(), ['accent', 'danger', 'ink', 'muted', 'success', 'warning'])

  // 2000 elements pass; 2001st is refused
  const maxDoc = load()
  try {
    const items = Array.from({ length: MAX_WHITEBOARD_ELEMENTS }, (_, idx) => ({
      id: `el-${idx}`,
      kind: 'rect',
      x: (idx % 100) * 10,
      y: Math.floor(idx / 100) * 10,
      width: 8,
      height: 8,
      color: 'ink',
    }))
    maxDoc.getArray('whiteboard_elements').push(items)
    assert.doesNotThrow(() => inspect(maxDoc))

    maxDoc.getArray('whiteboard_elements').push([
      { id: 'el-overflow', kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 'ink' },
    ])
    assert.throws(() => inspect(maxDoc), /whiteboard element limit exceeded/)
  } finally {
    maxDoc.destroy()
  }

  // Coordinate bounds & NaN/Infinity rejections
  for (const badCoord of [100_001, -100_001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10']) {
    const doc = load()
    try {
      doc.getArray('whiteboard_elements').push([
        { id: 'bad-coord', kind: 'rect', x: badCoord, y: 0, width: 10, height: 10, color: 'ink' },
      ])
      assert.throws(() => inspect(doc), Refused)
    } finally {
      doc.destroy()
    }
  }

  // Overflow via x + width > 100000
  const edgeDoc = load()
  try {
    edgeDoc.getArray('whiteboard_elements').push([
      { id: 'edge-overflow', kind: 'rect', x: 99_950, y: 0, width: 100, height: 10, color: 'ink' },
    ])
    assert.throws(() => inspect(edgeDoc), /whiteboard coordinate out of bounds/)
  } finally {
    edgeDoc.destroy()
  }

  // Text length > 512 or NUL/CR/control chars
  for (const badText of ['x'.repeat(513), 'hello\u0000world', 'bad\u0007bell', 'carriage\rreturn']) {
    const doc = load()
    try {
      doc.getArray('whiteboard_elements').push([
        { id: 'bad-text', kind: 'sticky', x: 0, y: 0, width: 100, height: 100, color: 'warning', text: badText },
      ])
      assert.throws(() => inspect(doc), /whiteboard text exceeds limit/)
    } finally {
      doc.destroy()
    }
  }
})

test('whiteboard rejects dual-channel Y.Array._map / Y.Map._start smuggling, > 50k total points, and > 1 MiB state', () => {
  // Smuggle map property onto whiteboard_elements Y.Array via cross-typed Y.Doc update
  const attackerArrayMap = new Y.Doc()
  const victimArrayMap = load()
  try {
    attackerArrayMap.getMap('whiteboard_elements').set('smuggled', 'payload')
    const poison = Y.encodeStateAsUpdate(attackerArrayMap)
    Y.applyUpdate(victimArrayMap, poison)
    assert.throws(() => inspect(victimArrayMap), /invalid whiteboard array map channel/)
  } finally {
    attackerArrayMap.destroy()
    victimArrayMap.destroy()
  }

  // Smuggle sequence item onto whiteboard Y.Map via cross-typed Y.Doc update
  const attackerMapSeq = new Y.Doc()
  const victimMapSeq = load()
  try {
    attackerMapSeq.getArray('whiteboard').push(['smuggled-seq-item'])
    const poison = Y.encodeStateAsUpdate(attackerMapSeq)
    Y.applyUpdate(victimMapSeq, poison)
    assert.throws(() => inspect(victimMapSeq), /invalid whiteboard map sequence channel/)
  } finally {
    attackerMapSeq.destroy()
    victimMapSeq.destroy()
  }

  // Total points across document > 50,000 (e.g. 50 strokes * 1001 points = 50,050)
  const pointsDoc = load()
  try {
    const strokePoints = Array.from({ length: 1001 }, (_, idx) => [idx % 500, idx % 300])
    const strokes = Array.from({ length: 50 }, (_, idx) => ({
      id: `stroke-${idx}`,
      kind: 'pen',
      x: 0,
      y: 0,
      color: 'ink',
      points: strokePoints,
    }))
    pointsDoc.getArray('whiteboard_elements').push(strokes)
    assert.throws(() => inspect(pointsDoc), /whiteboard total points limit exceeded/)
  } finally {
    pointsDoc.destroy()
  }

  // Binary state > 1 MiB for whiteboard document
  const oversizedDoc = new Y.Doc()
  try {
    const arr = oversizedDoc.getArray('whiteboard_elements')
    const pad = Array.from({ length: 2000 }, (_, i) => ({
      id: `pad-${i}`,
      kind: 'sticky',
      x: (i % 100) * 10,
      y: Math.floor(i / 100) * 10,
      width: 120,
      height: 80,
      color: 'accent',
      text: `${i}-` + 'A'.repeat(500),
      authorId: `member-${i}-` + 'B'.repeat(90),
    }))
    arr.push(pad)
    const bigUpdate = Y.encodeStateAsUpdate(oversizedDoc)
    assert.ok(bigUpdate.byteLength > 1024 * 1024)
    assert.throws(() => load(bigUpdate), /whiteboard binary state exceeds limit/)
  } finally {
    oversizedDoc.destroy()
  }
})

test('whiteboard rejects raw hex colors, CSS functions, HTML tags, URLs, unknown kinds, and duplicate IDs', () => {
  const rejectedColors = [
    '#2563eb',
    '#fff',
    'rgb(0, 0, 0)',
    'var(--custom)',
    '<svg onload=alert(1)>',
    'https://evil.example/track.png',
    'javascript:alert(1)',
    'primary',
  ]
  for (const badColor of rejectedColors) {
    const doc = load()
    try {
      doc.getArray('whiteboard_elements').push([
        { id: 'c1', kind: 'rect', x: 0, y: 0, width: 50, height: 50, color: badColor },
      ])
      assert.throws(() => inspect(doc), /invalid whiteboard color token/)
    } finally {
      doc.destroy()
    }
  }

  // Unknown kind or extra unapproved property
  const unknownKindDoc = load()
  try {
    unknownKindDoc.getArray('whiteboard_elements').push([
      { id: 'k1', kind: 'iframe', x: 0, y: 0, width: 50, height: 50, color: 'ink' },
    ])
    assert.throws(() => inspect(unknownKindDoc), /invalid whiteboard element kind/)
  } finally {
    unknownKindDoc.destroy()
  }

  const extraPropDoc = load()
  try {
    extraPropDoc.getArray('whiteboard_elements').push([
      { id: 'p1', kind: 'rect', x: 0, y: 0, width: 50, height: 50, color: 'ink', onclick: 'alert(1)' },
    ])
    assert.throws(() => inspect(extraPropDoc), /invalid whiteboard element/)
  } finally {
    extraPropDoc.destroy()
  }

  // Duplicate element ID across whiteboard map and whiteboard_elements array
  const dupDoc = load()
  try {
    dupDoc.getArray('whiteboard_elements').push([
      { id: 'same-id', kind: 'text', x: 0, y: 0, color: 'ink', text: 'First' },
    ])
    dupDoc.getMap('whiteboard').set('same-id', {
      id: 'same-id',
      kind: 'text',
      x: 10,
      y: 10,
      color: 'accent',
      text: 'Second',
    })
    assert.throws(() => inspect(dupDoc), /invalid whiteboard element id|duplicate whiteboard element id/)
  } finally {
    dupDoc.destroy()
  }
})

test('transform worker RPC accepts valid whiteboard updates and rejects invalid updates cleanly', () => {
  const base = load()
  let baseSnapshot
  try {
    replace(base, '# Whiteboard Host Doc\n')
    baseSnapshot = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  } finally {
    base.destroy()
  }

  const client = load(Buffer.from(baseSnapshot, 'base64'))
  try {
    const vector = Y.encodeStateVector(client)
    client.getArray('whiteboard_elements').push([
      {
        id: 'arrow-rpc',
        kind: 'arrow',
        x: 12,
        y: 24,
        x2: 180,
        y2: 96,
        color: 'accent',
        strokeWidth: 2,
      },
    ])
    const delta = Buffer.from(Y.encodeStateAsUpdate(client, vector)).toString('base64')
    const out = transform({
      operation: 'apply',
      snapshot: baseSnapshot,
      updates: [],
      update: delta,
      nonce: randomUUID(),
    })
    assert.match(out.markdown, /^# Whiteboard Host Doc/)

    // Attempt to apply a poisoned update with a hex color
    const badClient = load(Buffer.from(out.snapshot, 'base64'))
    try {
      const v2 = Y.encodeStateVector(badClient)
      badClient.getArray('whiteboard_elements').push([
        { id: 'bad-hex', kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: '#000000' },
      ])
      const badDelta = Buffer.from(Y.encodeStateAsUpdate(badClient, v2)).toString('base64')
      assert.throws(
        () =>
          transform({
            operation: 'apply',
            snapshot: out.snapshot,
            updates: [],
            update: badDelta,
            nonce: randomUUID(),
          }),
        /invalid whiteboard color token/
      )
    } finally {
      badClient.destroy()
    }
  } finally {
    client.destroy()
  }
})
