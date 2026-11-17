import { afterEach, expect, it, vi } from 'vitest'
import * as apiClient from '../../api/client'
import { onTrack, type AnalyticsEvent } from '../../analytics/track'
import { setTelemetryConsent, setTelemetryScope } from '../../analytics/telemetry/consent'
import { getWorkspaceDocument, updateWorkspaceDocument } from './workspaceDocumentsApi'

afterEach(() => {
  setTelemetryScope(undefined)
  localStorage.clear()
  vi.restoreAllMocks()
})
it('measures real document reads and writes without retaining their inputs', async () => {
  setTelemetryScope({ person: 'person', workspace: 'workspace', slug: 'sample' })
  setTelemetryConsent(true)
  const document = { id: 'private-id', title: 'private document', markdown: 'private content' }
  const result = {
    data: document,
    response: new Response(null, { status: 200, headers: { ETag: '"revision"' } }),
  }
  const get = vi.fn().mockResolvedValue(result)
  const patch = vi.fn().mockResolvedValue(result)
  vi.spyOn(apiClient, 'coreApi').mockReturnValue({
    GET: get,
    PATCH: patch,
  } as unknown as ReturnType<typeof apiClient.coreApi>)
  const events: AnalyticsEvent[] = []
  const unsubscribe = onTrack((event) => events.push(event))
  try {
    expect((await getWorkspaceDocument('private-workspace', 'private-id')).document).toBe(document)
    await updateWorkspaceDocument('private-workspace', 'private-id', '"revision"', {
      title: 'private document',
    })
    expect(events.map((event) => event.properties.operation)).toEqual(['docs_load', 'docs_save'])
    expect(
      events.every(
        (event) =>
          event.properties.success === true && typeof event.properties.duration_ms === 'number'
      )
    ).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private')
  } finally {
    unsubscribe()
  }
})
