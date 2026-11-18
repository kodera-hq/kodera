import { finishCleanup } from './cleanup'
import { expect, test } from '@playwright/test'
import type { Response } from '@playwright/test'
import { guard, object } from './oracles/shared'
import { readWave2Input, targets, withActors } from './world'
import type { Actor } from './world'

/** Retain event IDs only; never retain or report Matrix conversation bodies. */
function syncWitness(actor: Actor, homeserver: string) {
  const eventIds = new Set<string>()
  const failures: string[] = []
  const pending = new Set<Promise<void>>()
  const listener = (response: Response) => {
    const url = new URL(response.url())
    if (url.origin !== homeserver || url.pathname !== '/_matrix/client/v3/sync') return
    const task = (async () => {
      guard(response.status() === 200, 'WAVE2_SYNC_STATUS')
      const body: unknown = await response.json()
      guard(object(body), 'WAVE2_SYNC_SHAPE')
      if (body.rooms === undefined) return
      guard(object(body.rooms), 'WAVE2_SYNC_SHAPE')
      const joined = body.rooms.join
      if (!object(joined)) return
      for (const room of Object.values(joined)) {
        if (!object(room) || !object(room.timeline) || !Array.isArray(room.timeline.events))
          continue
        for (const event of room.timeline.events)
          if (object(event) && typeof event.event_id === 'string') eventIds.add(event.event_id)
      }
    })().catch(() => {
      failures.push('WAVE2_SYNC_WITNESS')
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  actor.page.on('response', listener)
  return {
    eventIds,
    failures,
    async dispose() {
      actor.page.off('response', listener)
      await Promise.all([...pending])
      guard(!failures.length, 'WAVE2_SYNC_WITNESS')
    },
  }
}

test('Persona 2: peer Matrix delivery, concurrent documents, exact preconditions and outsider refusal', async ({
  browser,
}) => {
  const input = readWave2Input('PERSONA2')
  await withActors(browser, input, ['A', 'B', 'C'], async (actors, budget) => {
    const a = actors.A!,
      b = actors.B!,
      c = actors.C!
    for (const actor of [a, b, c]) {
      await actor.signIn()
      await actor.workspace(input.workspaceReady, actor === c ? undefined : input.channelPath)
    }
    const witnesses = new Map(
      [a, b, c].map((actor) => [actor, syncWitness(actor, input.homeserverOrigin)])
    )
    let succeeded = false
    try {
      let roomId: string | undefined
      for (const [sender, receiver] of [
        [a, b],
        [b, a],
      ] as const) {
        const text = `wave2-${sender.alias}-${crypto.randomUUID()}`
        const sent = sender.page.waitForResponse((response) => {
          const url = new URL(response.url())
          return (
            url.origin === input.homeserverOrigin &&
            response.request().method() === 'PUT' &&
            /^\/_matrix\/client\/v3\/rooms\/[^/]+\/send\/m\.room\.message\/[^/]+$/.test(
              url.pathname
            )
          )
        })
        await sender.page.locator(input.composer).fill(text)
        await sender.page.locator(input.composer).press('Enter')
        const response = await sent
        guard(response.status() === 200, 'WAVE2_MATRIX_SEND_STATUS')
        const body: unknown = await response.json()
        guard(object(body) && typeof body.event_id === 'string', 'WAVE2_MATRIX_EVENT_ID')
        roomId = decodeURIComponent(new URL(response.url()).pathname.split('/')[5]!)
        await expect
          .poll(() => witnesses.get(receiver)!.eventIds.has(body.event_id as string))
          .toBe(true)
        await expect(receiver.page.getByText(text, { exact: true })).toBeVisible()
        guard(!witnesses.get(c)!.eventIds.has(body.event_id), 'WAVE2_OUTSIDER_EVENT')
      }
      guard(roomId, 'WAVE2_ROOM_BINDING')
      await c.denyForeignJoin(input.homeserverOrigin, roomId)

      const values = { organisation_id: a.input.organisationId, document_id: input.documentId }
      const documentPath =
        '/api/v1/organisations/{organisation_id}/workspace/documents/{document_id}'
      for (const actor of [a, b]) {
        const session = actor.page.waitForResponse(
          (response) =>
            response.url() ===
              `${targets().api}/api/v1/organisations/${encodeURIComponent(a.input.organisationId)}/workspace/documents/${encodeURIComponent(input.documentId)}/collab-session` &&
            response.request().method() === 'POST'
        )
        await actor.page.locator(input.docsButton).click()
        await actor.page.getByTestId(`docs-tree-item-${input.documentId}`).click()
        guard((await session).status() === 201, 'WAVE2_COLLAB_SESSION_STATUS')
        await expect(actor.page.locator(input.editor)).toBeEditable()
      }
      const markers = [`wave2-A-${crypto.randomUUID()}`, `wave2-B-${crypto.randomUUID()}`]
      // Both editors are ready before either edit is released; no timer establishes causality.
      await Promise.all(
        [a, b].map(async (actor, index) => {
          await actor.page.locator(input.editor).press('ControlOrMeta+End')
          await actor.page.locator(input.editor).pressSequentially(markers[index]!)
        })
      )
      for (const actor of [a, b])
        for (const marker of markers)
          await expect(actor.page.locator(input.editor)).toContainText(marker)
      await expect
        .poll(async () => {
          const response = await a.core(documentPath, values)
          const body: unknown = await response.json()
          return (
            object(body) &&
            typeof body.markdown === 'string' &&
            markers.every((marker) => (body.markdown as string).includes(marker))
          )
        })
        .toBe(true)
      // Close editors through actual canvas navigation before the isolated HTTP metadata race.
      for (const actor of [a, b]) await actor.page.locator(input.docsButton).click()
      const reads = await Promise.all([a.core(documentPath, values), b.core(documentPath, values)])
      const e0 = reads[0]!.headers().etag
      guard(e0 && reads[1]!.headers().etag === e0, 'WAVE2_RACE_SAME_ETAG')
      const first = await a.core(
        documentPath,
        values,
        'PATCH',
        { title: 'Wave 2 first revision' },
        { 'If-Match': e0 }
      )
      const e1 = first.headers().etag
      guard(e1 && e1 !== e0, 'WAVE2_RACE_NEW_ETAG')
      const stale = await b.core(
        documentPath,
        values,
        'PATCH',
        { title: 'Wave 2 stale revision' },
        { 'If-Match': e0 },
        412
      )
      const problem: unknown = await stale.json()
      guard(
        object(problem) &&
          typeof problem.type === 'string' &&
          /(?:^|\/)precondition-failed$/.test(problem.type),
        'WAVE2_PRECONDITION_PROBLEM'
      )
      const reviewed = await b.core(documentPath, values)
      const reviewBody: unknown = await reviewed.json()
      guard(
        object(reviewBody) &&
          reviewBody.title === 'Wave 2 first revision' &&
          reviewed.headers().etag === e1,
        'WAVE2_NO_STALE_OVERWRITE'
      )
      await b.core(
        documentPath,
        values,
        'PATCH',
        { title: 'Wave 2 reviewed revision' },
        { 'If-Match': e1 }
      )
      await b.core(documentPath, values, 'PATCH', { title: 'Wave 2 missing precondition' }, {}, 428)
      await c.core(documentPath, values, 'GET', undefined, {}, 404)
      await c.core(`${documentPath}/collab-session`, values, 'POST', {}, {}, 404)
      budget.assertExact('A', { 'matrix-login': 1, 'core-token': 2, 'local-join': 3 })
      budget.assertExact('B', { 'matrix-login': 1, 'core-token': 2, 'local-join': 3 })
      budget.assertExact('C', { 'matrix-login': 1, 'core-token': 2, 'local-join': 2 })
      succeeded = true
    } finally {
      await finishCleanup(
        succeeded,
        [...witnesses.values()].map((witness) => () => witness.dispose()),
        'WAVE2_WITNESS_CLEANUP'
      )
    }
  })
})
