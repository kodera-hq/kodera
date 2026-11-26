import { onTrack } from '../../../src/analytics/track'
import { expect, it, vi } from 'vitest'
import { CanvasNavigation } from '../../../src/features/workspace/canvasNavigation'

it('keeps Chat when it supersedes an uncommitted Docs transition', () => {
  const updates: (() => void)[] = []
  const apply = vi.fn()
  const skip = vi.fn()
  const navigation = new CanvasNavigation(apply, {
    reducedMotion: () => false,
    start: (update) => {
      updates.push(update)
      return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: skip }
    },
  })
  navigation.change('docs')
  navigation.change('chat')
  updates[1]!()
  updates[0]!()
  expect(apply.mock.calls).toEqual([['chat']])
  expect(skip).toHaveBeenCalledOnce()
})
it('applies reduced motion immediately and retires pending work when the owner leaves', () => {
  const apply = vi.fn()
  const start = vi.fn()
  const navigation = new CanvasNavigation(apply, { start, reducedMotion: () => true })
  navigation.change('files')
  expect(apply).toHaveBeenCalledWith('files')
  expect(start).not.toHaveBeenCalled()
  let update!: () => void
  const pending = new CanvasNavigation(apply, {
    reducedMotion: () => false,
    start: (callback) => {
      update = callback
      return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() }
    },
  })
  pending.change('docs')
  pending.dispose()
  update()
  expect(apply).toHaveBeenCalledTimes(1)
})

it('suppresses a transition into a confidential target even before its render acquires a hold', () => {
  const capture = vi.fn()
  const stop = onTrack(capture)
  try {
    const navigation = new CanvasNavigation(() => {}, { reducedMotion: () => true })
    navigation.change('docs', false)
    expect(capture).not.toHaveBeenCalled()
    navigation.change('chat')
    expect(capture).toHaveBeenCalledOnce()
  } finally {
    stop()
  }
})
