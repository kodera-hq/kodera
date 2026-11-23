import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../../../i18n'
import {
  FakeVoiceAudioContext,
  installVoiceAudioContext,
} from '../../../../tests/fakeVoiceAudioContext'
import { VoiceNotePlayer } from './VoiceNotePlayer'

const { get, load } = vi.hoisted(() => ({ get: vi.fn(), load: vi.fn() }))
vi.mock('../../../api/client', () => ({ coreApi: () => ({ GET: get }) }))
vi.mock('./audioPreview', () => ({ loadVoiceNoteBlob: load }))

afterEach(() => vi.unstubAllGlobals())

const attachment = {
  id: 'voice-1',
  filename: 'note.ogg',
  contentType: 'audio/ogg' as const,
  sizeBytes: 8,
}

it('plays, pauses, seeks and changes rate using decoded buffers without media URLs', async () => {
  installVoiceAudioContext()
  const createUrl = vi.spyOn(URL, 'createObjectURL')
  get.mockResolvedValue({ data: { downloadUrl: 'https://storage.example.test/note.ogg' } })
  load.mockResolvedValue(new Blob([new Uint8Array([79, 103, 103, 83])]))
  const view = render(<VoiceNotePlayer organisationId="org" attachment={attachment} />)
  const toggle = screen.getByTestId('voice-note-play-toggle')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAccessibleName(/pause/i))
  const context = FakeVoiceAudioContext.instances[0]!
  expect(context.resume).toHaveBeenCalledOnce()
  expect(context.decodeAudioData).toHaveBeenCalledWith(expect.any(ArrayBuffer))
  expect(context.sources[0]!.start).toHaveBeenCalledWith(0, 0)

  context.currentTime = 2
  fireEvent.click(screen.getByTestId('voice-note-speed-toggle'))
  expect(context.sources[0]!.playbackRate.value).toBe(1.5)
  context.currentTime = 4
  fireEvent.click(toggle)
  expect(context.sources[0]!.stop).toHaveBeenCalledOnce()
  expect(context.sources[0]!.disconnect).toHaveBeenCalledOnce()
  fireEvent.click(toggle)
  await waitFor(() => expect(context.sources).toHaveLength(2))
  expect(context.sources[1]!.start).toHaveBeenCalledWith(0, 5)
  expect(context.sources[1]!.playbackRate.value).toBe(1.5)

  fireEvent.change(screen.getByTestId('voice-note-seek'), { target: { value: '0.7' } })
  expect(context.sources[1]!.stop).toHaveBeenCalledOnce()
  expect(context.sources[2]!.start).toHaveBeenCalledWith(0, 7)
  act(() => context.sources[2]!.onended?.())
  expect(toggle).toHaveAccessibleName(/Lire|Play/)
  expect(screen.getByTestId('voice-note-seek')).toHaveValue('0')
  fireEvent.click(toggle)
  await waitFor(() => expect(context.sources).toHaveLength(4))
  expect(context.sources[3]!.start).toHaveBeenCalledWith(0, 0)
  fireEvent.change(screen.getByTestId('voice-note-seek'), { target: { value: '1' } })
  expect(toggle).toHaveAccessibleName(/Lire|Play/)
  expect(screen.getByTestId('voice-note-seek')).toHaveValue('0')
  expect(context.sources[3]!.stop).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
  expect(createUrl).not.toHaveBeenCalled()
  expect(view.container.querySelector('audio')).toBeNull()

  view.rerender(<VoiceNotePlayer organisationId="other-org" attachment={attachment} />)
  expect(context.close).toHaveBeenCalledOnce()
  expect(context.sources[3]!.stop).toHaveBeenCalledOnce()
  view.unmount()
})

it('closes an in-flight decoder on unmount and never starts its completed buffer', async () => {
  installVoiceAudioContext()
  let finish!: (value: { duration: number }) => void
  const decode = vi.spyOn(FakeVoiceAudioContext.prototype, 'createBufferSource')
  get.mockResolvedValue({ data: { downloadUrl: 'https://storage.example.test/note.ogg' } })
  load.mockResolvedValue(new Blob(['bytes']))
  const view = render(<VoiceNotePlayer organisationId="org" attachment={attachment} />)
  // Pause before the decoder resolves, after the context was created during the click.
  fireEvent.click(screen.getByTestId('voice-note-play-toggle'))
  const context = FakeVoiceAudioContext.instances[0]!
  context.decodeAudioData.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () => finish({ duration: 10 }))
  expect(context.close).toHaveBeenCalledOnce()
  expect(decode).not.toHaveBeenCalled()
})
