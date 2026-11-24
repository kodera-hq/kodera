import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { setTokenProvider } from '../../api/client'
import {
  clearLocalSessionStorage,
  notifyOrganisationCleanup,
  purgeEspaceVaultDatabases,
} from '../../auth/localSession'
import { server } from '../../mocks/server'
import { AudioDock } from '../../ui/AudioDock/AudioDock'
import { AttachmentQueue } from '../messaging/attachments/attachmentQueue'
import type { AttachmentRef } from '../messaging/attachments/attachmentRefs'
import {
  clearInlineAttachmentPreviews,
  MAX_INLINE_CACHE_ENTRIES,
  MessageAttachments,
} from '../messaging/attachments/MessageAttachments'
import * as imagePreviewMod from '../messaging/attachments/imagePreview'
import type { Attachment } from '../messaging/attachments/uploadAttachment'
import { MessagingOrganisation } from '../messaging/organisationContext'
import { RichComposerInput } from '../messaging/RichComposerInput'
import { WAITING_AMBIENCE_DUCK_GAIN } from '../sounds/SoundboardPopover'
import { CustomEmojiPanel } from '../workspace/admin/CustomEmojiPanel'
import { KoderaLabsPanel } from '../workspace/KoderaLabsPanel'
import { useWaitingRoomAmbience } from './audio/useWaitingRoomAmbience'
import {
  clearAllCustomEmojiBlobs,
  setWorkspaceCustomEmojisSnapshot,
} from './customEmojiStore'
import { EmojiPalette } from './EmojiPalette'
import {
  clearExperienceStores,
  DEFAULT_LABS_FLAGS,
  setCachedWorkspacePreferencesForTest,
} from './experienceApi'
import { GLYPHS } from './KoderaEmojiGlyphs'
import { KODERA_EMOJI, koderaSegments } from './koderaShortcodes'
import { MessageRow } from './MessageRow'
import { MessageText } from './MessageText'
import { ReactionPalette } from './ReactionPalette'
import { RemindersPanel } from './RemindersPanel'
import { ScheduledMessagesBanner, SendLaterPopover } from './SendLaterPopover'

const ORG_ID = '0192f3a4-5b6c-7d8e-9f01-23456789ab01'
const CHANNEL_ID = '0192f3a4-5b6c-7d8e-9f01-23456789ab02'
const ROOM_ID = '!general:acme.kodera.io'

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

describe('H4.2 Experience & S6 Attachment Previews', () => {
  const createdUrls: string[] = []
  const revokedUrls: string[] = []
  let origCreateObjectURL: typeof URL.createObjectURL | undefined
  let origRevokeObjectURL: typeof URL.revokeObjectURL | undefined

  beforeAll(() => {
    server.listen()
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    createdUrls.length = 0
    revokedUrls.length = 0
    vi.stubEnv('VITE_CORE_API_URL', 'https://core.test/api/v1')
    setTokenProvider(() => 'synthetic-access-token')
    origCreateObjectURL = URL.createObjectURL
    origRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => {
      const next = `blob:https://console.kodera.test/obj-${createdUrls.length + 1}`
      createdUrls.push(next)
      return next
    })
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url)
    })
    clearExperienceStores()
    clearAllCustomEmojiBlobs()
    clearInlineAttachmentPreviews()
  })

  afterEach(() => {
    server.resetHandlers()
    clearExperienceStores()
    clearAllCustomEmojiBlobs()
    clearInlineAttachmentPreviews()
    if (origCreateObjectURL !== undefined) URL.createObjectURL = origCreateObjectURL
    if (origRevokeObjectURL !== undefined) URL.revokeObjectURL = origRevokeObjectURL
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // ---------------- 1. Original + Sanitized WebP Custom Emojis ----------------

  it('registers all 14 original Kodera SVG glyphs and segments custom shortcodes cleanly', () => {
    expect(KODERA_EMOJI).toContain('kodera_rocket')
    expect(KODERA_EMOJI).toContain('kodera_fire')
    expect(KODERA_EMOJI).toContain('kodera_shield')
    expect(KODERA_EMOJI).toContain('kodera_party')
    expect(KODERA_EMOJI).toContain('kodera_eyes')
    expect(KODERA_EMOJI).toContain('kodera_bolt')
    expect(Object.keys(GLYPHS).sort()).toEqual([...KODERA_EMOJI].sort())

    const customSet = new Set(['ship_it'])
    expect(koderaSegments('Go :kodera_rocket: and :ship_it: now!', customSet)).toEqual([
      { text: 'Go ' },
      { emoji: 'kodera_rocket' },
      { text: ' and ' },
      { customEmoji: 'ship_it' },
      { text: ' now!' },
    ])
  })

  it('resolves custom WebP emojis to CSP-safe blob: URLs across MessageText, EmojiPalette & ReactionPalette and revokes on cleanup', async () => {
    const user = userEvent.setup()
    const emojiId = '0192f3a4-5b6c-7d8e-9f01-23456789ab99'
    const emojiItem = {
      id: emojiId,
      shortcode: 'ship_it',
      sha256: 'a'.repeat(64),
      width: 64,
      height: 64,
      animated: false,
      creatorMembershipId: '0192f3a4-5b6c-7d8e-9f01-23456789ab10',
      createdAt: '2026-01-01T00:00:00Z',
      blobPath: `/api/v1/organisations/${ORG_ID}/workspace/emojis/${emojiId}/blob`,
    }

    server.use(
      http.get('*/organisations/:organisation_id/workspace/emojis', () =>
        HttpResponse.json({ items: [emojiItem] })
      ),
      http.get('*/organisations/:organisation_id/workspace/emojis/:emoji_id/blob', () =>
        new HttpResponse(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        })
      )
    )

    setWorkspaceCustomEmojisSnapshot(ORG_ID, [emojiItem])
    const onPick = vi.fn()
    const onReact = vi.fn()

    render(
      <MessagingOrganisation value={ORG_ID}>
        <div>
          <MessageText body="Bravo :ship_it: !" />
          <EmojiPalette onPick={onPick} />
          <ReactionPalette mine={new Set()} onReact={onReact} />
        </div>
      </MessagingOrganisation>
    )

    const inlineImg = await screen.findByAltText(':ship_it:')
    expect(inlineImg).toHaveAttribute('src', expect.stringMatching(/^blob:/))

    // Pick custom emoji from EmojiPalette
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    const paletteBtn = await screen.findByRole('button', { name: /ship_it/i })
    await user.click(paletteBtn)
    expect(onPick).toHaveBeenCalledWith(':ship_it:')

    // React with custom emoji from ReactionPalette
    await user.click(screen.getByRole('button', { name: 'Ajouter une réaction' }))
    const reactBtn = await screen.findByRole('button', { name: /:ship_it:/i })
    await user.click(reactBtn)
    expect(onReact).toHaveBeenCalledWith(':ship_it:')

    // Cleanup revokes blob: URLs deterministically
    act(() => {
      clearAllCustomEmojiBlobs()
    })
    expect(revokedUrls.length).toBeGreaterThanOrEqual(1)
  })

  it('resizes uploaded images via canvas to <= 128x128 WebP in CustomEmojiPanel and refuses kodera_* shortcodes', async () => {
    const user = userEvent.setup()
    const drawImage = vi.fn()
    const bitmapClose = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 512, height: 256, close: bitmapClose })
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' }))
    })

    let postedBody: Record<string, unknown> | null = null
    const createdId = '0192f3a4-5b6c-7d8e-9f01-23456789ab77'
    server.use(
      http.get('*/organisations/:organisation_id/workspace/emojis', () =>
        HttpResponse.json({ items: [] })
      ),
      http.post('*/organisations/:organisation_id/workspace/emojis', async ({ request }) => {
        postedBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(
          {
            id: createdId,
            shortcode: postedBody['shortcode'],
            sha256: 'b'.repeat(64),
            width: 128,
            height: 64,
            animated: false,
            creatorMembershipId: 'mem-1',
            createdAt: '2026-01-01T00:00:00Z',
            blobPath: `/api/v1/organisations/${ORG_ID}/workspace/emojis/${createdId}/blob`,
          },
          { status: 201 }
        )
      }),
      http.get('*/organisations/:organisation_id/workspace/emojis/:emoji_id/blob', () =>
        new HttpResponse(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        })
      )
    )

    const view = render(<CustomEmojiPanel organisationId={ORG_ID} canEdit />)
    const input = screen.getByRole('textbox', { name: /Nom court/i })
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement
    const pngFile = new File([PNG_HEADER], 'mascot.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [pngFile] } })

    // Reserved `kodera_*` refused client-side
    await user.type(input, 'kodera_bad')
    await user.click(screen.getByRole('button', { name: 'Ajouter l’émoji' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/kodera_/i)

    // Valid shortcode resizes to 128x64 and uploads WebP base64
    await user.clear(input)
    await user.type(input, 'mascot_wave')
    await user.click(screen.getByRole('button', { name: 'Ajouter l’émoji' }))

    await waitFor(() => expect(postedBody).not.toBeNull())
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 128, 64)
    expect(bitmapClose).toHaveBeenCalledOnce()
    expect(postedBody).toMatchObject({ shortcode: 'mascot_wave' })
  })

  // ---------------- 2. Send Later, Personal Reminders & Kodera Labs ----------------

  it('hides SendLaterPopover on confidential rooms and schedules + lists messages on plaintext rooms', async () => {
    const user = userEvent.setup()
    const scheduledId = '0192f3a4-5b6c-7d8e-9f01-23456789ab55'
    let currentScheduled = [
      {
        id: scheduledId,
        channelId: CHANNEL_ID,
        roomId: ROOM_ID,
        body: 'Message différé',
        mentions: [],
        threadRootEventId: null,
        deliverAt: new Date(Date.now() + 3_600_000).toISOString(),
        matrixTxnId: `kodera-sched-${'c'.repeat(32)}`,
        matrixEventId: null,
        state: 'pending',
        failureReason: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    server.use(
      http.post('*/organisations/:organisation_id/workspace/scheduled-messages', () =>
        HttpResponse.json(currentScheduled[0], { status: 201 })
      ),
      http.get('*/organisations/:organisation_id/workspace/scheduled-messages', () =>
        HttpResponse.json({ items: currentScheduled })
      ),
      http.delete(
        '*/organisations/:organisation_id/workspace/scheduled-messages/:scheduled_message_id',
        () => {
          currentScheduled = []
          return new HttpResponse(null, { status: 204 })
        }
      )
    )

    const onScheduled = vi.fn()
    const { rerender } = render(
      <div>
        <SendLaterPopover
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          roomId={ROOM_ID}
          plaintextPermitted={false}
          draftText="Secret"
          onScheduled={onScheduled}
        />
      </div>
    )
    expect(screen.queryByTestId('send-later-trigger')).toBeNull()

    rerender(
      <div>
        <ScheduledMessagesBanner
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          roomId={ROOM_ID}
          plaintextPermitted
        />
        <SendLaterPopover
          organisationId={ORG_ID}
          channelId={CHANNEL_ID}
          roomId={ROOM_ID}
          plaintextPermitted
          draftText="Message différé"
          onScheduled={onScheduled}
        />
      </div>
    )

    await user.click(screen.getByTestId('send-later-trigger'))
    await user.click(screen.getByRole('button', { name: 'Dans 30 minutes' }))
    await waitFor(() => expect(onScheduled).toHaveBeenCalledOnce())

    const banner = await screen.findByTestId('scheduled-messages-banner')
    expect(banner).toHaveTextContent('1 message programmé')
    await user.click(within(banner).getByRole('button', { name: 'Voir' }))
    expect(within(banner).getByText('Message différé')).toBeVisible()
    await user.click(within(banner).getByRole('button', { name: 'Annuler l’envoi' }))
    await waitFor(() => expect(screen.queryByTestId('scheduled-messages-banner')).toBeNull())
  })

  it('offers Remind me in MessageRow only on plaintext rooms and manages reminders in RemindersPanel + KoderaLabsPanel', async () => {
    const user = userEvent.setup()
    const reminderId = '0192f3a4-5b6c-7d8e-9f01-23456789ab66'
    let remindersList = [
      {
        id: reminderId,
        channelId: CHANNEL_ID,
        roomId: ROOM_ID,
        targetEventId: '$evt-42',
        note: 'Relancer jeudi',
        remindAt: new Date(Date.now() + 3_600_000).toISOString(),
        state: 'pending',
        notificationId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    server.use(
      http.post('*/organisations/:organisation_id/workspace/reminders', () =>
        HttpResponse.json(remindersList[0], { status: 201 })
      ),
      http.get('*/organisations/:organisation_id/workspace/reminders', () =>
        HttpResponse.json({ items: remindersList })
      ),
      http.patch('*/organisations/:organisation_id/workspace/reminders/:reminder_id', () => {
        remindersList = []
        return HttpResponse.json(
          {
            id: reminderId,
            channelId: CHANNEL_ID,
            roomId: ROOM_ID,
            targetEventId: '$evt-42',
            note: 'Relancer jeudi',
            remindAt: new Date(Date.now() + 3_600_000).toISOString(),
            state: 'completed',
            notificationId: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          { status: 200 }
        )
      }),
      http.get('*/organisations/:organisation_id/workspace/preferences/me', () =>
        HttpResponse.json({
          labsFlags: DEFAULT_LABS_FLAGS,
          waitingRoomAmbience: false,
          updatedAt: null,
        })
      ),
      http.patch('*/organisations/:organisation_id/workspace/preferences/me', async ({ request }) => {
        const body = (await request.json()) as { labsFlags?: Record<string, boolean> }
        return HttpResponse.json({
          labsFlags: { ...DEFAULT_LABS_FLAGS, ...(body.labsFlags ?? {}) },
          waitingRoomAmbience: false,
          updatedAt: '2026-01-01T00:00:00Z',
        })
      })
    )

    const sampleMsg = {
      key: 'k-42',
      eventId: '$evt-42',
      sender: '@alice:acme.kodera.io',
      senderName: 'Alice',
      body: 'Point important à suivre.',
      ts: 1_700_000_000_000,
      delivery: 'sent' as const,
      edited: false,
      redacted: false,
      replyTo: null,
      reactions: [],
    }

    const baseRowProps = {
      profileRole: 'member' as const,
      onMention: vi.fn(),
      message: sampleMsg,
      placement: 'timeline' as const,
      viewerId: '@viewer:acme.kodera.io',
      archived: false,
      expanded: false,
      repliedMessage: undefined,
      threadReplies: [],
      menuContextKey: 'ctx-1',
      roomId: ROOM_ID,
      channelId: CHANNEL_ID,
      onRetry: vi.fn(),
      onReaction: vi.fn(),
      onReply: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onOpenThread: vi.fn(),
    }

    // Confidential room hides "Me le rappeler"
    const { rerender } = render(
      <MessagingOrganisation value={ORG_ID}>
        <MessageRow {...baseRowProps} plaintextPermitted={false} />
      </MessagingOrganisation>
    )
    await user.click(screen.getByRole('button', { name: /Actions du message/i }))
    expect(screen.queryByRole('menuitem', { name: 'Me le rappeler' })).toBeNull()
    await user.keyboard('{Escape}')

    // Plaintext room shows "Me le rappeler" + RemindersPanel + KoderaLabsPanel
    rerender(
      <MessagingOrganisation value={ORG_ID}>
        <div>
          <RemindersPanel organisationId={ORG_ID} plaintextPermitted />
          <MessageRow {...baseRowProps} plaintextPermitted menuContextKey="ctx-2" />
          <KoderaLabsPanel organisationId={ORG_ID} />
        </div>
      </MessagingOrganisation>
    )

    await user.click(screen.getByRole('button', { name: /Actions du message/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Me le rappeler' }))
    const dialog = await screen.findByTestId('reminder-create-dialog')
    await user.type(within(dialog).getByLabelText(/Note personnelle/i), 'Relancer jeudi')
    await user.click(within(dialog).getByRole('button', { name: 'Dans 1 heure' }))
    await waitFor(() => expect(screen.queryByTestId('reminder-create-dialog')).toBeNull())

    // Open RemindersPanel and complete reminder
    await user.click(screen.getByTestId('reminders-panel-trigger'))
    const panel = await screen.findByTestId('reminders-panel')
    expect(within(panel).getByText('Relancer jeudi')).toBeVisible()
    await user.click(within(panel).getByRole('button', { name: 'Terminé' }))
    await waitFor(() => expect(within(panel).getByText(/Aucun rappel actif/i)).toBeVisible())

    // Toggle personal_reminders off in KoderaLabsPanel -> hides RemindersPanel trigger
    await user.click(screen.getByTestId('labs-toggle-personal_reminders'))
    await waitFor(() => expect(screen.queryByTestId('reminders-panel-trigger')).toBeNull())
  })

  // ---------------- 3. Waiting-Room Ambience Ducking ----------------

  it('starts waiting-room ambience, auto-ducks on speech (0.18), and stops deterministically on peer join/deafen/unmount', async () => {
    const user = userEvent.setup()
    const oscStart = vi.fn()
    const oscStop = vi.fn()
    const ctxClose = vi.fn().mockResolvedValue(undefined)
    const gainParam = { value: 1, setTargetAtTime: vi.fn() }
    const fakeContext = () =>
      ({
        currentTime: 0,
        destination: {},
        createGain: () => ({ gain: gainParam, connect: vi.fn(), disconnect: vi.fn() }),
        createOscillator: () => ({
          type: 'sine',
          frequency: { value: 220 },
          connect: vi.fn(),
          start: oscStart,
          stop: oscStop,
          disconnect: vi.fn(),
        }),
        close: ctxClose,
      }) as unknown as AudioContext

    setCachedWorkspacePreferencesForTest(ORG_ID, {
      labsFlags: DEFAULT_LABS_FLAGS,
      waitingRoomAmbience: true,
      updatedAt: null,
    })

    function Harness({
      peers,
      deafened,
      speaking,
    }: {
      peers: number
      deafened: boolean
      speaking: boolean
    }) {
      const { active, toggleControl } = useWaitingRoomAmbience({
        organisationId: ORG_ID,
        callLive: true,
        roomId: '!voice:acme.kodera.io',
        remotePeersCount: peers,
        deafened,
        listenOnly: false,
        speaking,
        locale: 'fr',
        contextFactory: fakeContext,
      })
      return (
        <div>
          <span data-testid="ambience-active">{String(active)}</span>
          <AudioDock
            label="Appel en cours"
            room="Lobby"
            status="connected"
            statusLabel="Connecté"
            muted={false}
            deafened={deafened}
            onToggleMute={vi.fn()}
            onToggleDeafen={vi.fn()}
            onLeave={vi.fn()}
            ambience={toggleControl}
            labels={{ mute: 'Couper le micro', deafen: 'Couper le son', leave: 'Quitter' }}
          />
        </div>
      )
    }

    const { rerender, unmount } = render(
      <Harness peers={0} deafened={false} speaking={false} />
    )
    await waitFor(() => expect(screen.getByTestId('ambience-active')).toHaveTextContent('true'))
    expect(oscStart).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Couper l’ambiance de salle d’attente' })
    ).toHaveAttribute('aria-pressed', 'true')

    // Speech auto-ducks to WAITING_AMBIENCE_DUCK_GAIN (0.18)
    rerender(<Harness peers={0} deafened={false} speaking />)
    expect(gainParam.value).toBeCloseTo(WAITING_AMBIENCE_DUCK_GAIN)

    // Peer joins -> stops deterministically and hides waiting-room toggle
    rerender(<Harness peers={1} deafened={false} speaking={false} />)
    await waitFor(() => expect(screen.getByTestId('ambience-active')).toHaveTextContent('false'))
    expect(oscStop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /ambiance de salle d’attente/i })).toBeNull()

    // Return to empty waiting room, then toggle off via AudioDock button
    rerender(<Harness peers={0} deafened={false} speaking={false} />)
    await waitFor(() => expect(screen.getByTestId('ambience-active')).toHaveTextContent('true'))
    await user.click(screen.getByRole('button', { name: 'Couper l’ambiance de salle d’attente' }))
    expect(screen.getByTestId('ambience-active')).toHaveTextContent('false')
    expect(oscStop).toHaveBeenCalledTimes(2)

    unmount()
  })

  // ---------------- 4. Founder S6 Attachment Previews ----------------

  it('renders 40x40 blob: image thumbnails + file size instead of Prêt in composer UploadTray and revokes on remove/clear', async () => {
    const user = userEvent.setup()
    let resolveUpload!: (res: Attachment) => void
    const queue = new AttachmentQueue(
      ORG_ID,
      () =>
        new Promise<Attachment>((resolve) => {
          resolveUpload = resolve
        }),
      () => true,
      () => ({ channelId: CHANNEL_ID })
    )

    const longFilename =
      'capture-ecran-architecture-tres-longue-avec-details-supplementaires-2026.png'
    const pngBytes = new Uint8Array(4096)
    pngBytes.set(PNG_HEADER, 0)
    const file = new File([pngBytes], longFilename, { type: 'image/png' })

    render(
      <RichComposerInput
        id="s6-composer"
        aria-label="Message"
        value=""
        onValueChange={vi.fn()}
        members={[]}
        listLabel="Members"
        emojiListLabel="Emoji"
        onStagingChange={vi.fn()}
        scope={ROOM_ID}
        uploads={queue}
      />
    )

    let adding!: Promise<void>
    act(() => {
      adding = queue.add(ROOM_ID, [file])
    })
    const thumb = await screen.findByTestId('composer-staged-image-preview')
    expect(thumb).toHaveAttribute('src', expect.stringMatching(/^blob:/))
    expect(thumb.className).toContain('h-10')
    expect(thumb.className).toContain('w-10')

    await act(async () => {
      resolveUpload({
        id: '0192f3a4-5b6c-7d8e-9f01-23456789ab88',
        filename: longFilename,
        contentType: 'image/png',
        sizeBytes: 4096,
        sha256: 'a'.repeat(64),
        downloadUrl: 'https://s3.fr-par.scw.cloud/kodera-media/presigned-object',
        expiresAt: '2099-01-01T00:00:00Z',
        disposition: 'inline',
      })
      await adding
    })

    // Shows human-readable size (4 Ko / 4 KB), NEVER vague "Prêt"
    await waitFor(() => expect(screen.getByText(/4\s*Ko|4\s*KB/i)).toBeVisible())
    expect(screen.queryByText('Prêt')).toBeNull()

    // Removing revokes the blob: URL
    await user.click(screen.getByRole('button', { name: `Retirer ${longFilename}` }))
    expect(revokedUrls.length).toBeGreaterThanOrEqual(1)
    queue.close()
  })

  it('renders CSP-safe inline blob: image previews in MessageAttachments, opens Lightbox on click, and falls back on confidential or >10MB', async () => {
    const user = userEvent.setup()
    const attId = '0192f3a4-5b6c-7d8e-9f01-23456789ab44'
    const bigAttId = '0192f3a4-5b6c-7d8e-9f01-23456789ab45'

    server.use(
      http.get('*/organisations/:organisation_id/workspace/attachments/:attachment_id', () =>
        HttpResponse.json({
          downloadUrl: 'https://s3.fr-par.scw.cloud/kodera-media/presigned-object',
        })
      )
    )
    vi.spyOn(imagePreviewMod, 'loadImagePreview').mockResolvedValue(
      new Blob([PNG_HEADER], { type: 'image/png' })
    )

    const refs: readonly AttachmentRef[] = [
      {
        id: attId,
        filename: 'roadmap-diagram.png',
        contentType: 'image/png',
        sizeBytes: 184_320,
      },
      {
        id: bigAttId,
        filename: 'huge-photo.png',
        contentType: 'image/png',
        sizeBytes: 12 * 1024 * 1024, // > 10 MiB -> stays chip!
      },
    ]

    // Confidential room -> no inline fetch, stays chip
    const { rerender } = render(
      <MessagingOrganisation value={ORG_ID}>
        <MessageAttachments refs={refs} plaintextPermitted={false} />
      </MessagingOrganisation>
    )
    expect(screen.queryByTestId('timeline-inline-image-preview')).toBeNull()

    // Plaintext room -> <= 10 MiB image renders inline blob: preview while > 10 MiB stays chip
    rerender(
      <MessagingOrganisation value={ORG_ID}>
        <MessageAttachments refs={refs} plaintextPermitted />
      </MessagingOrganisation>
    )

    const inlineImg = await screen.findByTestId('timeline-inline-image-preview')
    expect(inlineImg).toHaveAttribute('src', expect.stringMatching(/^blob:/))
    expect(inlineImg.getAttribute('src')).not.toContain('https://s3.')
    expect(screen.getByText('huge-photo.png')).toBeVisible()

    // Clicking the inline preview opens the Lightbox Dialog
    await user.click(screen.getByRole('button', { name: /roadmap-diagram\.png/i }))
    const dialog = await screen.findByRole('dialog', { name: 'roadmap-diagram.png' })
    expect(within(dialog).getByAltText('roadmap-diagram.png')).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/)
    )
  })

  it('protects mounted <img> blob: URLs from LRU eviction until unmount and purges on logout / vault wipe', async () => {
    const emojiId = '0192f3a4-5b6c-7d8e-9f01-23456789ab91'
    const emojiItem = {
      id: emojiId,
      shortcode: 'safe_blob',
      sha256: 'e'.repeat(64),
      width: 64,
      height: 64,
      animated: false,
      creatorMembershipId: '0192f3a4-5b6c-7d8e-9f01-23456789ab10',
      createdAt: '2026-01-01T00:00:00Z',
      blobPath: `/api/v1/organisations/${ORG_ID}/workspace/emojis/${emojiId}/blob`,
    }

    server.use(
      http.get('*/organisations/:organisation_id/workspace/attachments/:attachment_id', () =>
        HttpResponse.json({
          downloadUrl: 'https://s3.fr-par.scw.cloud/kodera-media/presigned-object',
        })
      ),
      http.get('*/organisations/:organisation_id/workspace/emojis/:emoji_id/blob', () =>
        new HttpResponse(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        })
      )
    )
    vi.spyOn(imagePreviewMod, 'loadImagePreview').mockResolvedValue(
      new Blob([PNG_HEADER], { type: 'image/png' })
    )

    setWorkspaceCustomEmojisSnapshot(ORG_ID, [emojiItem])
    const pinnedRef: AttachmentRef = {
      id: '0192f3a4-5b6c-7d8e-9f01-000000000000',
      filename: 'pinned-on-screen.png',
      contentType: 'image/png',
      sizeBytes: 2048,
    }

    // Mount pinned attachment `<img>` and keep it mounted while churning > MAX_INLINE_CACHE_ENTRIES items
    const pinnedView = render(
      <MessagingOrganisation value={ORG_ID}>
        <div>
          <MessageAttachments refs={[pinnedRef]} plaintextPermitted />
          <MessageText body="Hello :safe_blob: !" />
        </div>
      </MessagingOrganisation>
    )
    const pinnedImg = await screen.findByAltText('pinned-on-screen.png')
    const pinnedUrl = pinnedImg.getAttribute('src') ?? ''
    expect(pinnedUrl).toMatch(/^blob:/)

    const emojiImg = await screen.findByAltText(':safe_blob:')
    const emojiUrl = emojiImg.getAttribute('src') ?? ''
    expect(emojiUrl).toMatch(/^blob:/)

    // Churn MAX_INLINE_CACHE_ENTRIES + 2 transient unmounted previews -> pinnedUrl MUST NOT be revoked while mounted!
    for (let i = 1; i <= MAX_INLINE_CACHE_ENTRIES + 2; i += 1) {
      const transientRef: AttachmentRef = {
        id: `0192f3a4-5b6c-7d8e-9f01-${String(i).padStart(12, '0')}`,
        filename: `transient-${i}.png`,
        contentType: 'image/png',
        sizeBytes: 1024,
      }
      const sub = render(
        <MessagingOrganisation value={ORG_ID}>
          <MessageAttachments refs={[transientRef]} plaintextPermitted />
        </MessagingOrganisation>
      )
      await screen.findByAltText(`transient-${i}.png`)
      sub.unmount()
    }
    expect(revokedUrls).not.toContain(pinnedUrl)
    expect(revokedUrls.length).toBeGreaterThanOrEqual(2)

    // Explicit vault wipe / logout revokes BOTH custom emoji and inline attachment blob: URLs!
    act(() => {
      purgeEspaceVaultDatabases()
    })
    expect(revokedUrls).toContain(pinnedUrl)
    expect(revokedUrls).toContain(emojiUrl)

    // Re-populate and verify clearLocalSessionStorage() and notifyOrganisationCleanup() also revoke cleanly
    pinnedView.unmount()
    setWorkspaceCustomEmojisSnapshot(ORG_ID, [emojiItem])
    const secondView = render(
      <MessagingOrganisation value={ORG_ID}>
        <MessageText body="Again :safe_blob: !" />
      </MessagingOrganisation>
    )
    const secondEmojiImg = await screen.findByAltText(':safe_blob:')
    const secondEmojiUrl = secondEmojiImg.getAttribute('src') ?? ''
    act(() => {
      clearLocalSessionStorage({ skipBrowserPushCleanup: true })
    })
    expect(revokedUrls).toContain(secondEmojiUrl)
    secondView.unmount()

    setWorkspaceCustomEmojisSnapshot(ORG_ID, [emojiItem])
    const thirdView = render(
      <MessagingOrganisation value={ORG_ID}>
        <MessageText body="Org switch :safe_blob: !" />
      </MessagingOrganisation>
    )
    const thirdEmojiImg = await screen.findByAltText(':safe_blob:')
    const thirdEmojiUrl = thirdEmojiImg.getAttribute('src') ?? ''
    act(() => {
      notifyOrganisationCleanup(ORG_ID)
    })
    expect(revokedUrls).toContain(thirdEmojiUrl)
    thirdView.unmount()
  })
})
