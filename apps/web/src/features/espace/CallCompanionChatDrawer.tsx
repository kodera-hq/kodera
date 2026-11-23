import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthLifetime, type AuthLifetime } from '../../auth/AuthProvider'
import {
  getMatrixRegistrationStamp,
  getMatrixSession,
  subscribeMatrixSession,
  type MatrixSession,
} from '../../auth/matrix'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { cleanText } from '../../ui/safeText'
import { permitsPlaintext } from '../confidential/room-boundary'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import type { MemberProfile } from '../profile/UserProfilePopover'
import type { Workspace } from '../workspace/workspace'
import { confidentialMessages } from './confidentialMessages'
import type { DraftChannel, DraftPatch } from './draftChannel'
import {
  EMPTY_DRAFT,
  useEspaceDraftMemory,
  type ChannelDraft,
  type DraftMemory,
  type RoomTarget,
} from './EspaceDraftProvider'
import {
  composing,
  displayNameOf,
  isNamedProfile,
  NO_MESSAGES,
  profileRoleIn,
  safeDisplayName,
  type CallChannel,
  type EspaceStoreLike,
  type TimelineInsert,
} from './liveViewModel'
import type { MemberView } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import type { MentionCandidate } from './mentions'
import { historicalMentionCandidates, inRoom, MessageComposer } from './MessageComposer'
import type { MessageRowActions } from './MessageRow'
import { MessageTimeline } from './MessageTimeline'
import { useMarkRead } from './useMarkRead'
import { useStableHandler } from './useStoreSlice'
import { useTimelineScroll } from './useTimelineScroll'

const NO_DOCUMENTS: readonly ChannelDoc[] = []
const NO_INSERTS: readonly TimelineInsert[] = []
const NO_CANDIDATES: readonly MentionCandidate[] = []

interface FallbackDraftScope {
  readonly memory: DraftMemory | null
  readonly organisationId: string | null
  readonly store: EspaceStoreLike
  readonly viewerId: string
  readonly roomId: string
  readonly protectionUnavailable: boolean
}

interface FallbackDraftOwner {
  readonly memory: DraftMemory
  readonly lifetime: AuthLifetime
  readonly organisationId: string
  readonly store: EspaceStoreLike
  readonly viewerId: string
  readonly roomId: string
  readonly issuer: string
  readonly subject: string
  readonly session: MatrixSession
  readonly baseUrl: string
  readonly userId: string
  readonly deviceId: string
  readonly matrixStamp: object
  readonly coreStamp: object
  readonly generation: number
}

class StandaloneCompanionDraftController {
  private draft: ChannelDraft = EMPTY_DRAFT
  private generation = 0
  private scopeGeneration = 0
  private owner: FallbackDraftOwner | null = null
  private lifetime: AuthLifetime | null = null
  private scope: FallbackDraftScope | null
  private listeners = new Set<() => void>()

  constructor(initialScope: FallbackDraftScope | null = null) {
    this.scope = initialScope
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getGeneration = () => this.generation
  getScopeGeneration = () => this.scopeGeneration

  private publish() {
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener()
    }
  }

  private scrub(retireScope: boolean) {
    const changed = this.draft !== EMPTY_DRAFT || retireScope
    this.draft = EMPTY_DRAFT
    this.owner = null
    if (retireScope) {
      this.generation += 1
      this.scopeGeneration += 1
    }
    if (changed) this.publish()
  }

  private isTerminal(owner: FallbackDraftOwner, scope: FallbackDraftScope): boolean {
    if (
      scope.memory === null ||
      scope.memory !== owner.memory ||
      this.lifetime === null ||
      this.lifetime !== owner.lifetime ||
      scope.organisationId === null ||
      scope.organisationId !== owner.organisationId ||
      scope.store !== owner.store ||
      scope.viewerId !== owner.viewerId ||
      scope.roomId !== owner.roomId
    ) {
      return true
    }
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const session = getMatrixSession()
    if (identity === undefined || session === undefined) return true
    return (
      live.status === 'unauthenticated' ||
      !this.lifetime.hasUsableCredential() ||
      live.generation !== owner.generation ||
      this.lifetime.getRetirementStamp() !== owner.coreStamp ||
      identity.issuer !== owner.issuer ||
      identity.subject !== owner.subject ||
      session !== owner.session ||
      getMatrixRegistrationStamp() !== owner.matrixStamp ||
      session.baseUrl !== owner.baseUrl ||
      session.userId !== owner.userId ||
      session.deviceId !== owner.deviceId
    )
  }

  private authorizedFor(expected: FallbackDraftScope): boolean {
    if (expected.protectionUnavailable) return false
    if (expected.memory === null) return true
    if (this.lifetime === null || expected.organisationId === null) return false
    const session = getMatrixSession()
    if (session === undefined || session.userId !== expected.viewerId) return false
    if (
      !expected.memory.canPresent(
        session,
        { organisation_id: expected.organisationId } as Workspace,
        expected.store
      )
    ) {
      return false
    }
    return !(this.owner !== null && this.isTerminal(this.owner, expected))
  }

  private isCurrentAuthorizedScope(expected: FallbackDraftScope): boolean {
    const current = this.scope
    if (
      current === null ||
      current.protectionUnavailable ||
      expected.protectionUnavailable ||
      current.store !== expected.store ||
      current.viewerId !== expected.viewerId ||
      current.roomId !== expected.roomId ||
      current.organisationId !== expected.organisationId ||
      current.memory !== expected.memory
    ) {
      return false
    }
    return this.authorizedFor(current)
  }

  private captureOwner(expected: FallbackDraftScope) {
    if (expected.memory === null || this.lifetime === null || expected.organisationId === null) {
      return
    }
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const session = getMatrixSession()
    if (identity === undefined || session === undefined) return
    this.owner = {
      memory: expected.memory,
      lifetime: this.lifetime,
      organisationId: expected.organisationId,
      store: expected.store,
      viewerId: expected.viewerId,
      roomId: expected.roomId,
      issuer: identity.issuer,
      subject: identity.subject,
      session,
      baseUrl: session.baseUrl,
      userId: session.userId,
      deviceId: session.deviceId,
      matrixStamp: getMatrixRegistrationStamp(),
      coreStamp: this.lifetime.getRetirementStamp(),
      generation: live.generation,
    }
  }

  sync(next: FallbackDraftScope) {
    const previous = this.scope
    this.scope = next
    if (previous === null) {
      if (next.protectionUnavailable) {
        this.draft = EMPTY_DRAFT
        this.owner = null
      }
      return
    }
    const scopeRetired =
      previous.roomId !== next.roomId ||
      previous.protectionUnavailable !== next.protectionUnavailable ||
      previous.store !== next.store ||
      previous.viewerId !== next.viewerId ||
      previous.organisationId !== next.organisationId ||
      previous.memory !== next.memory
    if (scopeRetired) {
      this.scrub(true)
      return
    }
    if (next.protectionUnavailable) {
      this.scrub(false)
      return
    }
    if (this.owner !== null && this.isTerminal(this.owner, next)) {
      this.scrub(true)
    }
  }

  connect(lifetime: AuthLifetime, memory: DraftMemory) {
    this.lifetime = lifetime
    const reconcile = () => {
      if (this.scope !== null && this.owner !== null && this.isTerminal(this.owner, this.scope)) {
        this.scrub(true)
        return
      }
      this.publish()
    }
    const offLifetime = lifetime.subscribe(reconcile)
    const offMatrix = subscribeMatrixSession(reconcile)
    const offMemory = memory.subscribe(reconcile)
    reconcile()
    return () => {
      offLifetime()
      offMatrix()
      offMemory()
      if (this.lifetime === lifetime) {
        this.lifetime = null
      }
    }
  }

  channelFor(expected: FallbackDraftScope): DraftChannel {
    const boundGeneration = this.scopeGeneration
    const isLive = () =>
      boundGeneration === this.scopeGeneration && this.isCurrentAuthorizedScope(expected)
    return {
      subscribe: this.subscribe,
      read: () => (isLive() ? this.draft : EMPTY_DRAFT),
      update: (patch: DraftPatch) => {
        if (!isLive()) {
          if (
            boundGeneration === this.scopeGeneration &&
            this.owner !== null &&
            this.scope !== null &&
            this.isTerminal(this.owner, this.scope)
          ) {
            this.scrub(true)
          }
          return
        }
        if (this.owner === null) this.captureOwner(expected)
        const change = typeof patch === 'function' ? patch(this.draft) : patch
        this.draft = { ...this.draft, ...change }
        this.publish()
      },
      command: (effect, patch) => {
        if (!isLive()) {
          if (
            boundGeneration === this.scopeGeneration &&
            this.owner !== null &&
            this.scope !== null &&
            this.isTerminal(this.owner, this.scope)
          ) {
            this.scrub(true)
          }
          return false
        }
        if (this.owner === null) this.captureOwner(expected)
        if (patch !== undefined) {
          this.draft = { ...this.draft, ...patch }
        }
        try {
          effect()
        } finally {
          if (patch !== undefined) this.publish()
        }
        return true
      },
    }
  }
}

function StandaloneAuthLifetimeSync({
  controller,
  memory,
}: {
  readonly controller: StandaloneCompanionDraftController
  readonly memory: DraftMemory
}) {
  const lifetime = useAuthLifetime()
  useLayoutEffect(() => controller.connect(lifetime, memory), [controller, lifetime, memory])
  return null
}

export interface CallCompanionChatDrawerProps {
  readonly store: EspaceStoreLike
  readonly channel: CallChannel
  readonly viewerId: string
  readonly open: boolean
  readonly narrow?: boolean | undefined
  readonly draft?: DraftChannel | undefined
  readonly draftGeneration?: number | undefined
}

function CallCompanionChatDrawerView({
  store,
  channel,
  viewerId,
  open,
  narrow = false,
  draft: externalDraft,
  draftGeneration: externalDraftGeneration,
}: CallCompanionChatDrawerProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const protectionCopy = confidentialMessages[locale]
  const inputId = useId()
  const guidanceId = useId()
  const mentionRef = useRef<(() => void) | null>(null)
  const insertRef = useRef<((text: string) => void) | null>(null)

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const simulation = store.simulation === true

  // Fail-closed room boundary check: undefined or non-plaintext boundaries block reading,
  // writing, and reacting so quarantined content is never rendered or transmitted in plaintext.
  const boundary =
    store.getRoomBoundary !== undefined
      ? store.getRoomBoundary(channel.roomId)
      : simulation
        ? 'ordinary'
        : undefined
  const protectionUnavailable = boundary === undefined || !permitsPlaintext(boundary)

  const memory = useEspaceDraftMemory()
  const organisationId = useMessagingOrganisation()

  const fallbackScope = useMemo<FallbackDraftScope>(
    () => ({
      memory,
      organisationId,
      store,
      viewerId,
      roomId: channel.roomId,
      protectionUnavailable,
    }),
    [memory, organisationId, store, viewerId, channel.roomId, protectionUnavailable]
  )

  const [fallbackController] = useState(() => new StandaloneCompanionDraftController(fallbackScope))

  useLayoutEffect(() => {
    if (externalDraft !== undefined) return
    fallbackController.sync(fallbackScope)
  }, [externalDraft, fallbackController, fallbackScope])

  const fallbackScopeGeneration = useSyncExternalStore(
    fallbackController.subscribe,
    fallbackController.getScopeGeneration
  )
  const fallbackDraft = useMemo(() => {
    void fallbackScopeGeneration
    return fallbackController.channelFor(fallbackScope)
  }, [fallbackController, fallbackScope, fallbackScopeGeneration])
  const fallbackGeneration = useSyncExternalStore(
    fallbackController.subscribe,
    fallbackController.getGeneration
  )

  const draft = externalDraft ?? fallbackDraft
  const draftGeneration = externalDraftGeneration ?? fallbackGeneration

  const [attachmentState, setAttachmentState] = useState<{
    roomId: string
    staged: boolean
  }>({ roomId: channel.roomId, staged: false })
  if (attachmentState.roomId !== channel.roomId) {
    setAttachmentState({ roomId: channel.roomId, staged: false })
  }
  const handleStagingChange = useStableHandler((staged: boolean) => {
    setAttachmentState({ roomId: channel.roomId, staged })
  })

  const [announcement, setAnnouncementState] = useState({ count: 0, text: '' })
  const announce = useCallback(
    (text: string) => setAnnouncementState((current) => ({ count: current.count + 1, text })),
    []
  )

  const companionRoom = useMemo(
    () => snapshot.rooms.find((room) => room.roomId === channel.roomId),
    [snapshot.rooms, channel.roomId]
  )
  const timeline = protectionUnavailable ? NO_MESSAGES : store.getTimeline(channel.roomId)
  const history = protectionUnavailable ? undefined : store.getHistory?.(channel.roomId)

  const {
    ref: logRef,
    onScroll: onLogScroll,
    older: loadOlderMessages,
  } = useTimelineScroll({
    roomId: protectionUnavailable ? null : channel.roomId,
    timeline,
    history,
    loadOlder: store.loadOlder,
  })

  const readMarkerOf = () =>
    companionRoom === undefined || (companionRoom.unread === 0 && companionRoom.mentions === 0)
      ? null
      : (store.getReadMarker?.(channel.roomId) ?? null)

  const [readAtOpen, setReadAtOpen] = useState(() => ({
    store,
    roomId: channel.roomId,
    open,
    eventId: open && !protectionUnavailable ? readMarkerOf() : null,
  }))
  if (
    readAtOpen.store !== store ||
    readAtOpen.roomId !== channel.roomId ||
    readAtOpen.open !== open
  ) {
    setReadAtOpen({
      store,
      roomId: channel.roomId,
      open,
      eventId: open && !protectionUnavailable ? readMarkerOf() : null,
    })
  }
  const unreadFrom =
    protectionUnavailable || readAtOpen.eventId === null
      ? null
      : (store.firstShownAfter?.(channel.roomId, readAtOpen.eventId) ?? null)

  // Mark messages read strictly while the companion chat pane/drawer is open.
  useMarkRead({
    room: open && !protectionUnavailable ? companionRoom : undefined,
    newestKey: timeline.at(-1)?.key,
    store,
  })

  useEffect(
    () => () => {
      store.setTyping?.(channel.roomId, false)
    },
    [store, channel.roomId]
  )

  const unnamed = t('console.workspace.members.unnamed')
  const roomMembers = useMemo(() => {
    void snapshot
    return protectionUnavailable ? undefined : store.getMembers?.(channel.roomId)
  }, [protectionUnavailable, store, channel.roomId, snapshot])

  const rawRoster = useMemo(() => {
    void snapshot
    if (protectionUnavailable) return [] as readonly MemberView[]
    return store.getRoster?.(channel.roomId) ?? roomMembers ?? []
  }, [protectionUnavailable, store, channel.roomId, roomMembers, snapshot])

  const ownProfile = store.getOwnProfile?.()
  const viewerName =
    [
      ownProfile?.displayName,
      roomMembers?.find((member) => member.userId === viewerId)?.name,
      rawRoster.find((member) => member.userId === viewerId)?.name,
      companionRoom?.names?.[viewerId],
    ]
      .map((item) => cleanText(item, 80))
      .filter((item) => isNamedProfile(item, viewerId))[0] || displayNameOf(viewerId, unnamed)

  const mentionCandidates = useMemo<readonly MentionCandidate[]>(() => {
    const source = roomMembers ?? rawRoster
    if (source.length === 0) return NO_CANDIDATES
    return source
      .filter((member) => member.userId !== viewerId)
      .map(({ userId, name }) => ({
        userId,
        label: safeDisplayName(name, userId, unnamed),
      }))
  }, [roomMembers, rawRoster, viewerId, unnamed])

  const resolveMember = useStableHandler((userId: string): MemberProfile => {
    if (userId === viewerId) {
      return {
        userId: viewerId,
        name: viewerName,
        presence: store.isOnline?.(viewerId) ? 'online' : 'offline',
        role: profileRoleIn(store, channel.roomId, viewerId),
        ...(ownProfile?.avatarUrl === undefined ? {} : { avatarMxc: ownProfile.avatarUrl }),
      }
    }
    const found =
      rawRoster.find((member) => member.userId === userId) ??
      roomMembers?.find((member) => member.userId === userId)
    if (found !== undefined) {
      return {
        userId: found.userId,
        name: safeDisplayName(found.name, found.userId, unnamed),
        presence: store.isOnline?.(found.userId) ? 'online' : 'offline',
        role: profileRoleIn(store, channel.roomId, found.userId),
        ...(found.avatarMxc === undefined ? {} : { avatarMxc: found.avatarMxc }),
      }
    }
    return {
      userId,
      name: safeDisplayName(companionRoom?.names?.[userId], userId, unnamed),
      presence: store.isOnline?.(userId) ? 'online' : 'offline',
      role: profileRoleIn(store, channel.roomId, userId),
    }
  })

  const canWrite = !protectionUnavailable && (store.canSendMessage?.(channel.roomId) ?? true)
  const canReact = !protectionUnavailable && (store.canReact?.(channel.roomId) ?? true)

  const loadMembers = useStableHandler(() => {
    if (!protectionUnavailable) store.loadMembers?.(channel.roomId)
  })

  const mentionMember = useStableHandler((member: MemberProfile) => {
    if (!canWrite) return
    store.loadMembers?.(channel.roomId)
    const input = document.getElementById(inputId) as HTMLInputElement | null
    const needsSpace =
      input !== null &&
      (input.selectionStart ?? 0) > 0 &&
      !/\s$/.test(input.value.slice(0, input.selectionStart ?? 0))
    insertRef.current?.(`${needsSpace ? ' ' : ''}@${member.name} `)
  })

  const targetInRoom = (eventId: string): RoomTarget => ({
    roomId: channel.roomId,
    eventId,
  })

  const retryMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite) return
    draft.command(() => {
      if (store.resend !== undefined) void store.resend(channel.roomId, msg.key)
      else void store.send(channel.roomId, msg.body)
    })
  })

  const reactToMessage = useStableHandler((eventId: string, reaction: string) => {
    if (!canReact) return
    draft.command(() => {
      void store.toggleReaction(channel.roomId, eventId, reaction)
    })
  })

  const replyToMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite) return
    const replyTo = targetInRoom(msg.eventId)
    draft.update((previous) => ({
      editing: null,
      replyTo,
      ...(previous.editing === null ? {} : { text: '' }),
    }))
    requestAnimationFrame(() => document.getElementById(inputId)?.focus())
  })

  const editMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite) return
    store.setTyping?.(channel.roomId, false)
    const target = targetInRoom(msg.eventId)
    const retained = historicalMentionCandidates(msg, mentionCandidates)
    draft.update({
      replyTo: null,
      editing: retained.length === 0 ? target : { ...target, mentionTargets: retained },
      text: msg.body,
    })
    requestAnimationFrame(() => document.getElementById(inputId)?.focus())
  })

  const removeMessage = useStableHandler((eventId: string) => {
    if (protectionUnavailable) return
    draft.command(() => {
      void store.remove(channel.roomId, eventId)
    })
  })

  const openThreadAsReply = useStableHandler((eventId: string) => {
    if (!canWrite) return
    const target = timeline.find((msg) => msg.eventId === eventId)
    if (target !== undefined) replyToMessage(target)
  })

  const rowActions = useMemo<MessageRowActions>(
    () => ({
      onRetry: retryMessage,
      onReaction: reactToMessage,
      onReply: replyToMessage,
      onEdit: editMessage,
      onRemove: removeMessage,
      onOpenThread: openThreadAsReply,
    }),
    [retryMessage, reactToMessage, replyToMessage, editMessage, removeMessage, openThreadAsReply]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || composing(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const current = draft.read()
    if (current.editing !== null) {
      event.preventDefault()
      event.stopPropagation()
      draft.update({ editing: null, text: '' })
      return
    }
    const replyToEventId = inRoom(current.replyTo, channel.roomId)
    if (
      replyToEventId !== null &&
      timeline.some((candidate) => candidate.eventId === replyToEventId)
    ) {
      event.preventDefault()
      event.stopPropagation()
      draft.update({ replyTo: null })
    }
  }

  const standaloneSync =
    externalDraft === undefined && memory !== null ? (
      <StandaloneAuthLifetimeSync controller={fallbackController} memory={memory} />
    ) : null

  if (protectionUnavailable) {
    const statusLabel = boundary === undefined ? protectionCopy.unknown : protectionCopy[boundary]
    const noticeBody =
      boundary === undefined || boundary === 'unknown'
        ? protectionCopy.checking
        : protectionCopy.unavailable
    return (
      <div
        data-testid="call-companion-protection-quarantine"
        className="flex min-h-0 flex-1 flex-col gap-3 p-3 text-c-ink"
      >
        {standaloneSync}
        <p className="text-xs font-semibold text-c-ink-2">{statusLabel}</p>
        <InlineAlert kind="warning">{noticeBody}</InlineAlert>
      </div>
    )
  }

  return (
    // Captures Escape to dismiss active inline reply/edit banners before closing an enclosing Drawer.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-testid="call-companion-chat"
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-1 flex-col gap-2 text-c-ink motion-reduce:transition-none"
    >
      {standaloneSync}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement.text}
      </p>
      <MessageTimeline
        store={store}
        roomId={channel.roomId}
        channelId={channel.channelId}
        channelName={channel.roomName}
        resolveMember={resolveMember}
        viewerId={viewerId}
        archived={false}
        canWrite={canWrite}
        canReact={canReact}
        simulation={simulation}
        expandedEventId={null}
        unreadFrom={unreadFrom}
        menuContext={`companion:${draftGeneration}:${viewerId}:${channel.roomId}`}
        documents={NO_DOCUMENTS}
        onOpenDocument={undefined}
        inserts={NO_INSERTS}
        onMention={canWrite ? mentionMember : undefined}
        actions={rowActions}
        logRef={logRef}
        onScroll={onLogScroll}
        onLoadOlder={loadOlderMessages}
      />
      {canWrite ? (
        <MessageComposer
          store={store}
          roomId={channel.roomId}
          viewerId={viewerId}
          draft={draft}
          channelName={channel.roomName}
          simulation={simulation}
          narrow={narrow}
          navigationUnsettled={false}
          inputId={inputId}
          guidanceId={guidanceId}
          members={mentionCandidates}
          attachmentStaged={attachmentState.staged}
          onStagingChange={handleStagingChange}
          onInvite={undefined}
          onMentionStart={loadMembers}
          onEdit={editMessage}
          onAnnounce={announce}
          mentionRef={mentionRef}
          insertRef={insertRef}
        />
      ) : (
        <p className="border-t border-c-border-soft pt-2 text-xs text-c-ink-3">
          {t('console.workspace.channel.label-read-only')}
        </p>
      )}
    </div>
  )
}

export const CallCompanionChatDrawer = memo(CallCompanionChatDrawerView)
export default CallCompanionChatDrawer
