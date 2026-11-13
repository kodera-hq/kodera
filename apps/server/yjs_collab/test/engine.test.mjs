import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { schema } from 'prosemirror-markdown'
import { prosemirrorToYXmlFragment } from 'y-prosemirror'
import * as encoding from 'lib0/encoding'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { apply, inspect, load, replace, Refused } from '../engine.mjs'
import { bind, verify, TicketRefused } from '../tickets.mjs'
import { frame, stateFrame, updateFrame, vectorFrame, ViewerWrite } from '../protocol.mjs'

function native() {
  const doc = load()
  replace(doc, '# Example\n\nInitial text\n\n[[Related]]\n\n`[[Not a link]]`\n')
  return doc
}
function ticket(claims, key) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}
function claims(now) {
  return {v: 1, organisation: randomUUID(), document: randomUUID(), membership: randomUUID(), identity: randomUUID(), issuer: 'https://identity.example.org/realms/community', subject: randomUUID(), role: 'viewer', issued: now, expires: now + 300, nonce: randomUUID()}
}

test('native blocks export sanitized canonical markdown and live wiki references', () => {
  const doc = native()
  try {
    const result = inspect(doc)
    assert.deepEqual(result.links, ['Related'])
    assert.match(result.markdown, /^# Example/)
    const restored = load(result.state)
    assert.equal(inspect(restored).markdown, result.markdown)
    restored.destroy()
  } finally { doc.destroy() }
})
test('markdown replacement preserves tombstones when stale clients replay old state', () => {
  const doc = native()
  try {
    const obsolete = Y.encodeStateAsUpdate(doc)
    const changed = replace(doc, '# Replacement\n\nCurrent state\n')
    apply(doc, obsolete)
    assert.equal(inspect(doc).markdown, changed.markdown)
    assert.doesNotMatch(inspect(doc).markdown, /Initial text|Related/)
    const reconnect = load(changed.state)
    apply(reconnect, obsolete)
    assert.equal(inspect(reconnect).markdown, changed.markdown)
    reconnect.destroy()
  } finally { doc.destroy() }
})
test('concurrent editors converge and snapshot reload retains binary identity', () => {
  const base = native()
  const left = load(Y.encodeStateAsUpdate(base))
  const right = load(Y.encodeStateAsUpdate(base))
  try {
    const textLeft = left.getXmlFragment('content').get(1).get(0)
    const textRight = right.getXmlFragment('content').get(1).get(0)
    textLeft.insert(0, 'Left ')
    textRight.insert(textRight.length, ' Right')
    const first = Y.encodeStateAsUpdate(left), second = Y.encodeStateAsUpdate(right)
    apply(left, second);apply(right, first)
    assert.equal(inspect(left).markdown, inspect(right).markdown)
    const restored = load(inspect(left).state)
    assert.equal(inspect(restored).markdown, inspect(left).markdown)
    assert.deepEqual(Y.encodeStateVector(restored), Y.encodeStateVector(left))
    restored.destroy()
  } finally { base.destroy();left.destroy();right.destroy() }
})
test('viewer state-update and sync-step-2 frames are refused before application', () => {
  const doc = native()
  try {
    const before = inspect(doc).state
    for (const message of [updateFrame(before), stateFrame(doc)]) assert.throws(() => frame(message, 'viewer'), ViewerWrite)
    assert.equal(frame(vectorFrame(doc), 'viewer').kind, 'vector')
    assert.deepEqual(inspect(doc).state, before)
    assert.equal(frame(updateFrame(before), 'editor').kind, 'update')
  } finally { doc.destroy() }
})
test('protocol rejects trailing bytes, oversized awareness and unknown message kinds', () => {
  const doc = native()
  try {
    const vector = vectorFrame(doc)
    assert.throws(() => frame(Uint8Array.from([...vector, 0]), 'viewer'), Refused)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1);encoding.writeVarUint8Array(encoder, new Uint8Array(8193))
    assert.throws(() => frame(encoding.toUint8Array(encoder), 'editor'), /awareness frame exceeds limit/)
    assert.throws(() => frame(new Uint8Array([100]), 'editor'), /unknown protocol message/)
  } finally { doc.destroy() }
})
test('unrecognized shared maps and unsupported native block types are refused', () => {
  const doc = native()
  try {
    doc.getMap('unreviewed').set('example', 'value')
    assert.throws(() => inspect(doc), /unknown shared document type/)
  } finally { doc.destroy() }
  const invalid = load()
  try {
    invalid.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('unsupported')])
    assert.throws(() => inspect(invalid), Refused)
  } finally { invalid.destroy() }
})
test('tickets bind a short lifetime to one persisted identity and exact room', () => {
  const now = Math.floor(Date.now() / 1000), key = randomBytes(32), value = claims(now)
  const decoded = verify(ticket(value, key), key, now)
  assert.equal(decoded.role, 'viewer')
  bind(decoded, {organisation: value.organisation, document: value.document, role: 'viewer'})
  assert.throws(() => bind(decoded, {organisation: randomUUID(), document: value.document, role: 'viewer'}), error => error instanceof TicketRefused && error.code === 4403)
  assert.throws(() => verify(ticket(value, key), key, now + 300), TicketRefused)
  assert.throws(() => verify(ticket(value, key), randomBytes(32), now), TicketRefused)
  for (const patch of [{expires: now + 301}, {issued: now + 10}, {role: 'owner'}, {identity: randomUUID().replaceAll('-', '')}, {extra: 'unsupported'}]) {
    assert.throws(() => verify(ticket({...value, ...patch}, key), key, now), TicketRefused)
  }
})


test('stored block links cannot execute script or inline SVG payloads', () => {
  const unsafe = [
    schema.node('paragraph', null, [schema.text('Example', [schema.marks.link.create({href: 'javascript:alert(1)'})])]),
    schema.node('paragraph', null, [schema.node('image', {src: 'data:image/svg+xml,example'})]),
  ]
  for (const block of unsafe) {
    const doc = load()
    try {
      prosemirrorToYXmlFragment(schema.node('doc', null, [block]), doc.getXmlFragment('prosemirror'))
      assert.throws(() => inspect(doc), /unsafe document link/)
    } finally { doc.destroy() }
  }
})


test('unresolved causal updates and NUL text cannot poison the durable document', () => {
  const original = native(), peer = load(Y.encodeStateAsUpdate(original))
  try {
    const text = peer.getXmlFragment('content').get(1).get(0)
    text.insert(0, 'Earlier ')
    const vector = Y.encodeStateVector(peer)
    text.insert(0, 'Later ')
    apply(original, Y.encodeStateAsUpdate(peer, vector))
    assert.throws(() => inspect(original), /incomplete causal state/)
  } finally { original.destroy();peer.destroy() }
  const doc = load()
  try { assert.throws(() => replace(doc, 'invalid\0text'), /markdown exceeds limit/) } finally { doc.destroy() }
})

test('content XML fragment with TipTap blocks validates, exports markdown/wikilinks, survives replace, and persists', () => {
  const doc = load()
  try {
    const content = doc.getXmlFragment('content')
    const heading = new Y.XmlElement('heading')
    heading.setAttribute('level', 2)
    const headingText = new Y.XmlText()
    headingText.insert(0, 'Architecture')
    heading.insert(0, [headingText])

    const para = new Y.XmlElement('paragraph')
    const paraText = new Y.XmlText()
    paraText.insert(0, 'See ', { bold: {} })
    para.insert(0, [paraText])
    const wikilink = new Y.XmlElement('wikilink')
    wikilink.setAttribute('title', 'Runbook')
    wikilink.setAttribute('label', 'Runbook')
    const tailText = new Y.XmlText()
    tailText.insert(0, ' and [[Spec Page|Spec]]')
    para.insert(1, [wikilink, tailText])

    const tasks = new Y.XmlElement('taskList')
    const task = new Y.XmlElement('taskItem')
    task.setAttribute('checked', true)
    const taskPara = new Y.XmlElement('paragraph')
    const taskText = new Y.XmlText()
    taskText.insert(0, 'Shipped')
    taskPara.insert(0, [taskText])
    task.insert(0, [taskPara])
    tasks.insert(0, [task])

    const callout = new Y.XmlElement('calloutBlock')
    callout.setAttribute('tone', 'warning')
    const calloutPara = new Y.XmlElement('paragraph')
    const calloutText = new Y.XmlText()
    calloutText.insert(0, 'Check permissions')
    calloutPara.insert(0, [calloutText])
    callout.insert(0, [calloutPara])

    content.insert(0, [heading, para, tasks, callout])

    const initial = inspect(doc)
    assert.deepEqual(initial.links, ['Runbook', 'Spec Page'])
    assert.match(initial.markdown, /^## Architecture/)
    assert.match(initial.markdown, /\[\[Runbook\]\]/)
    assert.match(initial.markdown, /- \[x\] Shipped/)
    assert.match(initial.markdown, /> \[!WARNING\]/)

    const persisted = load(initial.state)
    try {
      assert.equal(persisted.share.has('prosemirror'), false)
      assert.equal(inspect(persisted).markdown, initial.markdown)
      const stale = Y.encodeStateAsUpdate(persisted)
      const replaced = replace(persisted, '# Replaced\n\n- Updated item\n\n[[Target Doc]]\n')
      assert.equal(persisted.share.has('prosemirror'), false)
      assert.ok(persisted.getXmlFragment('content').length > 0)
      assert.deepEqual(replaced.links, ['Target Doc'])
      apply(persisted, stale)
      assert.equal(inspect(persisted).markdown, replaced.markdown)
    } finally {
      persisted.destroy()
    }
  } finally {
    doc.destroy()
  }
})

test('simultaneously non-empty prosemirror and content fragments are refused', () => {
  const doc = native()
  try {
    const extraPara = new Y.XmlElement('paragraph')
    const extraText = new Y.XmlText()
    extraText.insert(0, 'Conflicting fragment')
    extraPara.insert(0, [extraText])
    doc.getXmlFragment('prosemirror').insert(0, [extraPara])
    assert.throws(() => inspect(doc), /ambiguous shared document fragments/)
    assert.throws(() => replace(doc, '# Clean\n'), /ambiguous shared document fragments/)
  } finally {
    doc.destroy()
  }
})

test('replacement writes the block editor content fragment and migrates a legacy prosemirror document', () => {
  // Django creates every document through `replace` on an empty snapshot; the browser binds `content`.
  const created = load()
  try {
    replace(created, '# Created\n\nFirst line\n')
    assert.equal(created.share.has('prosemirror'), false)
    assert.ok(created.getXmlFragment('content').length > 0)
    assert.match(inspect(created).markdown, /First line/)
  } finally { created.destroy() }
  const legacy = load()
  try {
    prosemirrorToYXmlFragment(schema.node('doc', null, [schema.node('paragraph', null, [schema.text('Legacy text')])]), legacy.getXmlFragment('prosemirror'))
    assert.match(inspect(legacy).markdown, /Legacy text/)
    const replaced = replace(legacy, '# Moved\n\nNew text\n')
    assert.equal(legacy.getXmlFragment('prosemirror').length, 0)
    assert.ok(legacy.getXmlFragment('content').length > 0)
    assert.match(replaced.markdown, /New text/)
    assert.doesNotMatch(replaced.markdown, /Legacy text/)
  } finally { legacy.destroy() }
})
