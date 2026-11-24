import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import {
  FakeVoiceAudioContext,
  installVoiceAudioContext,
} from '../../../../tests/fakeVoiceAudioContext'
import { MessagingOrganisation } from '../organisationContext'
import { AttachmentQueue } from './attachmentQueue'
import { MessageAttachments } from './MessageAttachments'
import { preflight } from './uploadPreflight'
import { MAX_VOICE_NOTE_DURATION_MS, VoiceNoteRecorder } from './VoiceNoteRecorder'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('../../../api/client', () => ({
  coreApi: () => ({
    GET: getMock,
    POST: postMock,
  }),
}))

const getFromStorageMock = vi.fn()
vi.mock('./storageTransport', () => ({
  getFromStorage: (...args: unknown[]) => getFromStorageMock(...args),
}))

const ORG_ID = '00000000-0000-7000-8000-000000000099'
const ATTACHMENT_ID = '00000000-0000-7000-8000-000000000077'
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00])
const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
])
const UPLOADED_ATTACHMENT = {
  id: ATTACHMENT_ID,
  filename: 'note.ogg',
  contentType: 'audio/ogg',
  sizeBytes: OGG_BYTES.length,
  sha256: 'a'.repeat(64),
  downloadUrl: 'https://storage.kodera.io/voice-note.ogg',
  expiresAt: '2026-12-01T00:00:00Z',
  disposition: 'inline' as const,
}

describe('Async Voice Notes preflight, recording guardrail, playback, and AI transcription', () => {
  beforeEach(() => {
    getMock.mockReset()
    postMock.mockReset()
    getFromStorageMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('validates OggS, WebM EBML, and MP4 ftyp magic signatures and rejects mismatched headers', () => {
    expect(
      preflight({ name: 'note.ogg', type: 'audio/ogg;codecs=opus', size: OGG_BYTES.length }, OGG_BYTES)
    ).toEqual({
      ok: true,
      filename: 'note.ogg',
      contentType: 'audio/ogg',
      sizeBytes: OGG_BYTES.length,
    })

    expect(
      preflight({ name: 'note.webm', type: 'audio/webm', size: WEBM_BYTES.length }, WEBM_BYTES)
    ).toEqual({
      ok: true,
      filename: 'note.webm',
      contentType: 'audio/webm',
      sizeBytes: WEBM_BYTES.length,
    })

    expect(
      preflight({ name: 'note.m4a', type: 'audio/mp4', size: MP4_BYTES.length }, MP4_BYTES)
    ).toEqual({
      ok: true,
      filename: 'note.m4a',
      contentType: 'audio/mp4',
      sizeBytes: MP4_BYTES.length,
    })

    const fakeHtmlBytes = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    expect(
      preflight({ name: 'spoof.ogg', type: 'audio/ogg', size: fakeHtmlBytes.length }, fakeHtmlBytes)
    ).toEqual({
      ok: false,
      reason: 'type-mismatch',
    })
  })

  it('disables VoiceNoteRecorder when !plaintextPermitted so confidential rooms never capture plaintext audio', () => {
    const queue = new AttachmentQueue(ORG_ID, async () => UPLOADED_ATTACHMENT)
    render(
      <VoiceNoteRecorder
        roomId="!conf:acme.kodera.io"
        uploads={queue}
        plaintextPermitted={false}
      />
    )
    const btn = screen.getByTestId('voice-note-record')
    expect(btn).toBeDisabled()
    expect(btn.textContent?.trim()).toBe('')
  })

  it('records Ogg voice note, releases mic tracks on stop, and queues waveform + duration metadata', async () => {
    const user = userEvent.setup()
    const stopTrack = vi.fn()
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
      getAudioTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream

    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
      })
    )

    class FakeMediaRecorder {
      static isTypeSupported(mime: string) {
        return mime.startsWith('audio/ogg')
      }
      state: 'inactive' | 'recording' = 'inactive'
      ondataavailable: ((ev: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob([OGG_BYTES], { type: 'audio/ogg' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    const queue = new AttachmentQueue(
      ORG_ID,
      async () => UPLOADED_ATTACHMENT,
      () => true,
      () => ({ channelId: '00000000-0000-7000-8000-000000000011' })
    )

    render(
      <VoiceNoteRecorder
        roomId="00000000-0000-7000-8000-000000000011"
        uploads={queue}
        plaintextPermitted
      />
    )

    await user.click(screen.getByTestId('voice-note-record'))
    await user.click(screen.getByTestId('voice-note-stop'))

    expect(stopTrack).toHaveBeenCalled()
    await waitFor(() => {
      const ready = queue.readyRefs('00000000-0000-7000-8000-000000000011')
      expect(ready).not.toBeNull()
      expect(ready).toHaveLength(1)
      expect(ready![0]!.contentType).toBe('audio/ogg')
      expect(ready![0]!.durationMs).toBeGreaterThan(0)
      expect(ready![0]!.waveform).toHaveLength(24)
    })
  })

  it('decodes presigned voice notes, closes the context on cleanup, and handles 403/200 transcription', async () => {
    const user = userEvent.setup()
    installVoiceAudioContext()
    const createUrl = vi.spyOn(URL, 'createObjectURL')

    getMock.mockResolvedValue({
      data: {
        id: ATTACHMENT_ID,
        downloadUrl: 'https://storage.kodera.io/voice-note.ogg',
      },
    })
    getFromStorageMock.mockResolvedValue(
      new Response(OGG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'audio/ogg' },
      })
    )

    postMock
      .mockResolvedValueOnce({
        data: undefined,
        response: new Response(null, { status: 403 }),
      })
      .mockResolvedValueOnce({
        data: {
          attachmentId: ATTACHMENT_ID,
          channelId: '00000000-0000-7000-8000-000000000011',
          text: 'Point produit confirmé à 14h.',
          language: 'fr',
          provider: 'mistral',
          model: 'voxtral-mini-latest',
        },
        response: new Response(null, { status: 200 }),
      })

    const view = render(
      <MessagingOrganisation.Provider value={ORG_ID}>
        <MessageAttachments
          refs={[
            {
              id: ATTACHMENT_ID,
              filename: 'note.ogg',
              contentType: 'audio/ogg',
              sizeBytes: OGG_BYTES.length,
              durationMs: 4200,
              waveform: [25, 60, 80, 45],
            },
          ]}
        />
      </MessagingOrganisation.Provider>
    )

    expect(await screen.findByTestId('voice-note-player')).toBeInTheDocument()
    await user.click(screen.getByTestId('voice-note-play-toggle'))
    await waitFor(() =>
      expect(FakeVoiceAudioContext.instances[0]?.sources[0]?.start).toHaveBeenCalled()
    )
    expect(getFromStorageMock).toHaveBeenCalledWith(
      'https://storage.kodera.io/voice-note.ogg',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    )

    // First transcription attempt when AI policy is OFF -> 403 refusal notice
    await user.click(screen.getByTestId('voice-note-transcribe'))
    await waitFor(() =>
      expect(screen.getByTestId('voice-note-transcribe-refusal')).toBeInTheDocument()
    )

    // Second transcription attempt when 3-tier AI policy is ON -> renders collapsible transcript
    await user.click(screen.getByTestId('voice-note-transcribe'))
    await waitFor(() =>
      expect(screen.getByTestId('voice-note-transcript')).toHaveTextContent(
        'Point produit confirmé à 14h.'
      )
    )

    // Collapsible transcript disclosure toggle hides and re-shows the transcript cleanly
    await user.click(screen.getByTestId('voice-note-transcript-toggle'))
    expect(screen.queryByTestId('voice-note-transcript')).toBeNull()
    await user.click(screen.getByTestId('voice-note-transcript-toggle'))
    expect(screen.getByTestId('voice-note-transcript')).toHaveTextContent(
      'Point produit confirmé à 14h.'
    )

    // Playback speed toggle cycles 1x -> 1.5x -> 2x -> 1x
    const speedBtn = screen.getByTestId('voice-note-speed-toggle')
    expect(speedBtn).toHaveTextContent('1×')
    await user.click(speedBtn)
    expect(speedBtn).toHaveTextContent('1.5×')
    await user.click(speedBtn)
    expect(speedBtn).toHaveTextContent('2×')
    await user.click(speedBtn)
    expect(speedBtn).toHaveTextContent('1×')

    // Changing attachment.id resets transcript and playback rate cleanly
    view.rerender(
      <MessagingOrganisation.Provider value={ORG_ID}>
        <MessageAttachments
          refs={[
            {
              id: '00000000-0000-7000-8000-000000000088',
              filename: 'second.ogg',
              contentType: 'audio/ogg',
              sizeBytes: OGG_BYTES.length,
              durationMs: 2000,
              waveform: [30, 50, 70, 40],
            },
          ]}
        />
      </MessagingOrganisation.Provider>
    )
    expect(screen.queryByTestId('voice-note-transcript')).toBeNull()
    expect(FakeVoiceAudioContext.instances[0]?.close).toHaveBeenCalledOnce()
    expect(createUrl).not.toHaveBeenCalled()

    view.unmount()
  })

  it('auto-stops VoiceNoteRecorder at the 90s (90_000 ms) ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const stopTrack = vi.fn()
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
      getAudioTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream

    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
      })
    )

    let stopCalled = false
    class FakeMediaRecorder {
      static isTypeSupported(mime: string) {
        return mime.startsWith('audio/ogg')
      }
      state: 'inactive' | 'recording' = 'inactive'
      ondataavailable: ((ev: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        stopCalled = true
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob([OGG_BYTES], { type: 'audio/ogg' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    const queue = new AttachmentQueue(
      ORG_ID,
      async () => UPLOADED_ATTACHMENT,
      () => true,
      () => ({ channelId: '00000000-0000-7000-8000-000000000011' })
    )

    render(
      <VoiceNoteRecorder
        roomId="00000000-0000-7000-8000-000000000011"
        uploads={queue}
        plaintextPermitted
      />
    )

    await act(async () => {
      screen.getByTestId('voice-note-record').click()
      await Promise.resolve()
    })
    expect(screen.getByTestId('voice-note-stop')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(MAX_VOICE_NOTE_DURATION_MS)
      await Promise.resolve()
    })
    expect(stopCalled).toBe(true)
    expect(stopTrack).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
