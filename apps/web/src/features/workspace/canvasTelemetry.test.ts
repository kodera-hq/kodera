import { expect, it } from 'vitest'
import { onTrack, type AnalyticsEvent } from '../../analytics/track'
import { CanvasNavigation } from './canvasNavigation'

it('reports applied chat/docs/files transitions with fixed surface names and elapsed time', () => {
  const events: AnalyticsEvent[] = []
  const unsubscribe = onTrack((event) => events.push(event))
  try {
    const navigation = new CanvasNavigation(() => {}, { reducedMotion: () => true })
    navigation.change('docs')
    navigation.change('files')
    navigation.change('chat')
    navigation.change('chat')
    expect(events.map((event) => event.properties.surface)).toEqual(['docs', 'files', 'chat'])
    expect(
      events.every(
        (event) =>
          event.name === 'workspace_surface_changed' &&
          typeof event.properties.duration_ms === 'number'
      )
    ).toBe(true)
    navigation.dispose()
  } finally {
    unsubscribe()
  }
})
