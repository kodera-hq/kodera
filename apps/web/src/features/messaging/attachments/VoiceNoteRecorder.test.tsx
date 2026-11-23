import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AttachmentQueue } from './attachmentQueue'
import '../../../i18n'
import { VoiceNoteRecorder } from './VoiceNoteRecorder'

afterEach(() => vi.unstubAllGlobals())
it.each([false, true])(
  'stops pending capture on confidential switch (concurrent start: %s)',
  async (concurrentStart) => {
    let resolve!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((done) => {
          resolve = done
        })
    )
    const stop = vi.fn()
    const start = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported() {
          return true
        }
        start = start
      }
    )
    const uploads = { add: vi.fn() } as unknown as AttachmentQueue
    const { rerender } = render(
      <VoiceNoteRecorder roomId="ordinary" uploads={uploads} plaintextPermitted />
    )
    fireEvent.click(screen.getByTestId('voice-note-record'))
    if (concurrentStart) fireEvent.click(screen.getByTestId('voice-note-record'))
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    rerender(
      <VoiceNoteRecorder roomId="confidential" uploads={uploads} plaintextPermitted={false} />
    )
    await act(async () => {
      resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(screen.queryByTestId('voice-note-stop')).not.toBeInTheDocument()
  }
)
