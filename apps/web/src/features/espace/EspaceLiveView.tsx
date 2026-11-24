import { SimpleMessagingSidebar } from './SimpleMessagingSidebar'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { uiModeCopy } from './uiModePreference'
import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { AnyRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { demoMessages } from '../../app/demoMessages'
import { keepFocusOnRouteTo, releaseRouteFocus } from '../../app/routeFocusHold'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { getMatrixRegistrationStamp, type MatrixSession } from '../../auth/matrix'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Drawer } from '../../ui/Drawer/Drawer'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { cleanText } from '../../ui/safeText'
import {
  WorkspacePaletteRegistration,
  useWorkspaceOmniboxDynamicEntries,
} from '../command-palette/WorkspacePaletteRegistration'
import type {
  ConfidentialChannelFlags,
  OmniboxCollectionDescriptor,
} from '../command-palette/omniboxIndex'
import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { MessagingOrganisation } from '../messaging/organisationContext'
import type { Notification } from '../notifications/notificationFeed'
import { isPlaceholderName } from '../profile/passport'
import { PassportContext } from '../profile/passportContext'
import type { MemberProfile } from '../profile/UserProfilePopover'

const LazyKoderaPassportModal = lazy(() =>
  import('../profile/KoderaPassportModal').then((module) => ({
    default: module.KoderaPassportModal,
  }))
)
import { soundEngine } from '../sounds/SoundEngine'
import { withdrawn, type ChannelSearchEntry } from '../workspace/ChannelSearch'
import { OrganisationHeader } from '../workspace/OrganisationHeader'
import { categoryLabel, channelLabel, currentChannel } from '../workspace/workspace'
import type { Workspace, WorkspaceCategory, WorkspaceChannel } from '../workspace/workspace'
import { WORKSPACE_COMMAND_EVENT } from '../workspace/WorkspaceMenu'
import { isArrivalsChannel } from './ArrivalCard'
import { arrivalInserts } from './ArrivalInsert'
import type { ChannelMenuTarget } from './ChannelContextMenu'
import { ChannelSidebar } from './ChannelSidebar'
import {
  favoriteChannelsStorageKey,
  setUiMode,
  useFavoriteChannels,
  useWorkspaceUiMode,
  type WorkspaceUiMode,
} from './uiModePreference'
import { createCommittedValue } from './committedValue'
import { confidentialMessages } from './confidentialMessages'
import { createLocalDrafts, useDraftChannel, useDraftSlice } from './draftChannel'
import { EspaceCanvasPanes } from './EspaceCanvasPanes'
import { EspaceChannelHeader } from './EspaceChannelHeader'
import {
  useEspaceDraftMemory,
  type ChannelDraft,
  type DraftLease,
  type RoomTarget,
} from './EspaceDraftProvider'
import { EspaceMembersPanel, EspaceSidebarResizer } from './EspaceMembersPanel'
import { EspaceThreadPane } from './EspaceThreadPane'
import { LeaveCallGuard } from './LeaveCallGuard'
import {
  composing,
  isProximityChannel,
  NO_MESSAGES,
  profileRoleIn,
  roomForChannel,
  roomResolved,
  roomRowId,
  type AudioCallLike,
  type CallChannel,
  type CanvasMode,
  type EspaceStoreLike,
  type TimelineInsert,
} from './liveViewModel'
import { isMatrixRoomId } from './matrix/directs'
import type { ArrivalView, RoomSummary } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { historicalMentionCandidates, inRoom, MessageComposer } from './MessageComposer'
import { MessageCueTracker } from './messageCues'
import type { MessageRowActions } from './MessageRow'
import { MessageTimeline, type MessageTimelineHandle } from './MessageTimeline'
import { mutedChannelsStorageKey, useMutedChannels } from './mutedChannels'
import { channelAfter, channelMove } from './shortcuts'
import { useEspaceJoinSync } from './useEspaceJoinSync'
import { useEspacePassportAndProfile } from './useEspacePassportAndProfile'
import { useEspaceRuntime } from './useEspaceRuntime'
import { useMarkRead } from './useMarkRead'
import { useStableHandler, useStoreSlice } from './useStoreSlice'
import { useTimelineScroll } from './useTimelineScroll'
import { VoiceCallDock, type CallPlacement } from './VoiceCallDock'

// The view's public names stay this module's, wherever their definitions live.
export { isProximityChannel, mergeTimelineInserts } from './liveViewModel'
export type { AudioCallLike, EspaceStoreLike, TimelineInsert } from './liveViewModel'
export { mutedChannelsStorageKey, favoriteChannelsStorageKey }

const NO_DOCUMENTS: readonly ChannelDoc[] = []
const NO_INSERTS: readonly TimelineInsert[] = []
const NO_ARRIVALS: readonly ArrivalView[] = []

function directChannelOf(roomId: string, name: string): WorkspaceChannel {
  return {
    id: `direct:${roomId}`,
    kind: 'text',
    name,
    template_key: null,
    topic: '',
    lifecycle: 'active',
    is_confidential: false,
    room_state: 'ready',
  } as WorkspaceChannel
}

const LazyMessagesPinnedBanner = lazy(() =>
  import('./MessagesPinnedBanner').then((module) => ({ default: module.MessagesPinnedBanner }))
)

export interface EspaceLiveViewProps {
  /** Optional presentation metadata; never an access grant. */
  categoryDescriptions?: Readonly<Record<string, string>> | undefined
  org: string
  organisationName: string
  workspace: Workspace
  channelId: string | undefined
  session?: MatrixSession
  store?: EspaceStoreLike
  /** The audio call; by default one made from `session` and the store's token. */
  call?: AudioCallLike
  /**
   * Makes a channel the address. Given, the view shows the channel the address names, and only
   * that one: a click asks for the channel, and the router's commit shows it.
   */
  onNavigateChannel?: (channelId: string) => void | boolean | Promise<void | boolean>
  /** Whether the router is between two addresses: nothing is sent until it has settled. */
  navigationPending?: boolean
  onReconnect?: () => void
  /**
   * The name the console's own account carries (`Me.display_name`, else the address's local part).
   * A homeserver names a new account by its id, so without this the settings panel would offer
   * « Ce239589 A4bd … » as the member's own name.
   */
  readonly accountName?: string | undefined
  readonly ownerId?: string | undefined
  readonly membershipId?: string | undefined
  readonly membershipActive?: boolean | undefined
  readonly defaultMembersOpen?: boolean | undefined
  readonly focusedDocs?: boolean | undefined
  readonly activeCanvasMode?: CanvasMode | undefined
  readonly onChangeCanvasMode?: ((mode: CanvasMode) => void) | undefined
  readonly documents?: readonly ChannelDoc[]
  readonly collections?: readonly OmniboxCollectionDescriptor[] | undefined
  readonly onOpenDocument?: ((doc: ChannelDoc) => void) | undefined
  readonly onOpenCollection?: ((id: string) => void) | undefined
  readonly docsCanvasSlot?: ReactNode | undefined
  readonly onActiveChannelBoundaryChange?:
    | ((context: {
        readonly channelId: string | undefined
        readonly roomBoundary: RoomBoundary | undefined
        readonly isConfidential: boolean
      }) => void)
    | undefined
  /** Channels the server flags as the proximity room; see `isProximityChannel`. */
  readonly proximityChannelIds?: ReadonlySet<string> | undefined
  /** Draws the proximity panel above a flagged channel's timeline. */
  readonly renderProximityPanel?: ((channel: WorkspaceChannel) => ReactNode) | undefined
  readonly onCreateInCategory?: ((category: WorkspaceCategory) => void) | undefined
  /** Items drawn in the channel's timeline at their own time, between the messages (polls). */
  readonly timelineInserts?: readonly TimelineInsert[] | undefined
  readonly organisationActionSlot?: ReactNode | undefined
  readonly sidebarActionSlot?: ReactNode | undefined
  readonly sidebarFooterSlot?: ReactNode | undefined
  readonly onChannelContextMenu?:
    | ((info: {
        readonly channelId: string
        readonly label: string
        readonly kind: 'text' | 'audio'
        readonly clientX: number
        readonly clientY: number
      }) => void)
    | undefined
}

/** A message the member acts on, in the room it was shown in: never another room's. */
interface ThreadOpener extends RoomTarget {
  store: EspaceStoreLike
  generation: number
  viewerId: string
  element: HTMLButtonElement
}

const subscribeToNoDraft = () => () => undefined
const noDraftSnapshot = () => 0

interface CommittedView {
  session: MatrixSession | undefined
  store: EspaceStoreLike | undefined
  organisationId: string
  stamp: object | null
}

export function EspaceLiveView(props: EspaceLiveViewProps) {
  const memory = useEspaceDraftMemory()
  const { t } = useTranslation()
  useSyncExternalStore(
    memory?.subscribe ?? subscribeToNoDraft,
    memory?.getSnapshot ?? noDraftSnapshot
  )
  const stamp = memory === null ? null : getMatrixRegistrationStamp()
  const [registration, setRegistration] = useState({ stamp, generation: 0 })
  if (registration.stamp !== stamp)
    setRegistration({ stamp, generation: registration.generation + 1 })
  const [committedView] = useState(() => createCommittedValue<CommittedView | null>(null))
  const committed = useSyncExternalStore(committedView.subscribe, committedView.getSnapshot)
  const sameView =
    committed !== null &&
    committed.session === props.session &&
    committed.store === props.store &&
    committed.organisationId === props.workspace.organisation_id &&
    committed.stamp === stamp
  const allowed =
    memory === null ||
    (sameView && memory.canKeepView(props.session, props.workspace, props.store)) ||
    memory.canPresent(props.session, props.workspace, props.store)
  useLayoutEffect(() => {
    memory?.observeView(props.session, props.workspace, props.store)
    if (allowed && !sameView)
      committedView.commit({
        session: props.session,
        store: props.store,
        organisationId: props.workspace.organisation_id,
        stamp,
      })
  }, [memory, props.session, props.workspace, props.store, stamp, allowed, sameView, committedView])
  useLayoutEffect(() => () => committedView.commit(null), [committedView])
  if (!allowed)
    return <InlineAlert kind="error">{t('console.workspace.live.problem-unavailable')}</InlineAlert>
  return (
    <MessagingOrganisation
      value={props.store?.simulation === true ? null : props.workspace.organisation_id}
    >
      <MountedEspaceLiveView key={registration.generation} {...props} />
    </MessagingOrganisation>
  )
}

const MountedEspaceLiveView = memo(function MountedEspaceLiveView({
  categoryDescriptions,
  org,
  organisationName,
  workspace,
  channelId,
  session,
  store: injectedStore,
  call: injectedCall,
  onNavigateChannel,
  navigationPending = false,
  onReconnect,
  accountName,
  ownerId,
  membershipId,
  membershipActive,
  defaultMembersOpen = false,
  focusedDocs = false,
  activeCanvasMode = 'chat',
  onChangeCanvasMode,
  docsCanvasSlot,
  onActiveChannelBoundaryChange,
  documents = NO_DOCUMENTS,
  collections,
  onOpenDocument,
  onOpenCollection,
  proximityChannelIds,
  renderProximityPanel,
  onCreateInCategory,
  timelineInserts,
  organisationActionSlot,
  sidebarActionSlot,
  sidebarFooterSlot,
  onChannelContextMenu,
}: EspaceLiveViewProps) {
  const memory = useEspaceDraftMemory()
  const { t, i18n } = useTranslation()
  const demoCopy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const protectionCopy = confidentialMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const simulation = injectedStore?.simulation === true
  const demoGuidanceId = useId()
  const composerInputId = useId()
  const startMention = useRef<() => void>(null)
  const insertInComposer = useRef<(text: string) => void>(null)
  const threadInputId = useId()
  const sidebarHeadingId = useId()
  const narrow = useNarrowViewport()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [messagesDetailOpen, setMessagesDetailOpen] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(false)
  const channelChooserReturnFocus = useRef<HTMLElement | null>(null)
  function changeChannelChooser(open: boolean) {
    if (open) channelChooserReturnFocus.current = null
    setChannelsOpen(open)
  }
  const closeChannelChooser = useStableHandler(() => {
    if (!narrow || !channelsOpen) return
    channelChooserReturnFocus.current = headingRef.current
    setChannelsOpen(false)
  })
  const leaveChannelChooser = useStableHandler(() => {
    if (!narrow) return
    channelChooserReturnFocus.current = headingRef.current
    setChannelsOpen(false)
  })
  const inRouter = Boolean(useRouter({ warn: false }) as AnyRouter | null)

  const {
    activeStore,
    settingsEpoch,
    snapshot,
    activeCall,
    micActivity,
    inLiveCall,
    deviceSettings,
    signedOut,
  } = useEspaceRuntime({
    injectedStore,
    injectedCall,
    session,
    workspace,
    channelId,
    ownerId,
    membershipId,
    membershipActive,
  })

  const [viewingCallStage, setViewingCallStage] = useState(false)
  const [callDetached, setCallDetached] = useState(false)
  const [fullStage, setFullStage] = useState(false)
  const [localCallsOpen, setLocalCallsOpen] = useState(false)
  const [wasInLiveCall, setWasInLiveCall] = useState(inLiveCall)
  if (wasInLiveCall !== inLiveCall) {
    setWasInLiveCall(inLiveCall)
    if (!inLiveCall) {
      setViewingCallStage(false)
      setCallDetached(false)
      setFullStage(false)
    }
  }

  const initialChannel = currentChannel(workspace, channelId)
  const addressedChannel = channelId ?? initialChannel?.id
  const [clickedChannelId, setClickedChannelId] = useState<string | null>(null)
  const [requestedChannelId, setRequestedChannelId] = useState<string | null>(null)
  const [addressedChannelId, setAddressedChannelId] = useState(channelId)
  if (addressedChannelId !== channelId) {
    setAddressedChannelId(channelId)
    setClickedChannelId(null)
    setRequestedChannelId(null)
    setViewingCallStage(false)
    setFullStage(false)
    setLocalCallsOpen(false)
  }
  const [wasPending, setWasPending] = useState(navigationPending)
  if (wasPending !== navigationPending) {
    setWasPending(navigationPending)
    if (!navigationPending) setRequestedChannelId(null)
  }
  const selectedChannelId =
    (onNavigateChannel === undefined ? clickedChannelId : null) ?? addressedChannel
  const navigationUnsettled =
    navigationPending || (requestedChannelId !== null && requestedChannelId !== addressedChannel)

  const uiMode = useWorkspaceUiMode(workspace.default_ui_mode)
  const [direct, setDirect] = useState<{ roomId: string; over: string | null | undefined } | null>(
    null
  )
  const [observedCanvasMode, setObservedCanvasMode] = useState(activeCanvasMode)
  if (observedCanvasMode !== activeCanvasMode) {
    setObservedCanvasMode(activeCanvasMode)
    setLocalCallsOpen(false)
    if (activeCanvasMode !== 'chat') {
      setViewingCallStage(false)
      setFullStage(false)
      if (direct !== null) setDirect(null)
    }
  }
  const [observedUiMode, setObservedUiMode] = useState(uiMode)
  if (observedUiMode !== uiMode) {
    setObservedUiMode(uiMode)
    if (uiMode === 'messages' && localCallsOpen) setLocalCallsOpen(false)
  }
  const rawCanvasMode: CanvasMode =
    onChangeCanvasMode === undefined && localCallsOpen ? 'calls' : activeCanvasMode
  const effectiveCanvasMode: CanvasMode = uiMode === 'messages' ? 'chat' : rawCanvasMode
  useEffect(() => {
    if (uiMode !== 'messages' || activeCanvasMode === 'chat') return
    onChangeCanvasMode?.('chat')
  }, [uiMode, activeCanvasMode, onChangeCanvasMode])
  const directRoomId =
    direct !== null && direct.over === selectedChannelId && effectiveCanvasMode === 'chat'
      ? direct.roomId
      : null
  const directRoom =
    directRoomId === null ? undefined : snapshot.rooms.find((room) => room.roomId === directRoomId)
  const directName =
    directRoom === undefined
      ? undefined
      : (activeStore.getDirects?.().find((item) => item.roomId === directRoom.roomId)?.name ??
        directRoom.name)
  const activeChannel = useMemo(
    () =>
      directRoomId !== null
        ? directRoom !== undefined && directName !== undefined
          ? directChannelOf(directRoom.roomId, directName)
          : undefined
        : currentChannel(workspace, selectedChannelId),
    [workspace, selectedChannelId, directRoomId, directRoom, directName]
  )
  const activeRoom = useMemo(
    () =>
      directRoom ??
      (activeChannel !== null && activeChannel !== undefined
        ? roomForChannel(activeChannel, snapshot.channels, snapshot.rooms)
        : undefined),
    [directRoom, activeChannel, snapshot.channels, snapshot.rooms]
  )
  const pendingMessageJump = useRef<{
    readonly roomId: string
    readonly eventId: string
    readonly targetChannelId: string | null
    readonly token: symbol
  } | null>(null)
  const navigationStateRef = useRef({ addressedChannel, navigationPending })
  useLayoutEffect(() => {
    navigationStateRef.current = { addressedChannel, navigationPending }
  })
  const selectDirectWithJump = useStableHandler(
    (roomId: string, jumpTarget?: { readonly roomId: string; readonly eventId: string }) => {
      pendingMessageJump.current = jumpTarget
        ? {
            roomId: jumpTarget.roomId,
            eventId: jumpTarget.eventId,
            targetChannelId: null,
            token: Symbol(),
          }
        : null
      setMessagesDetailOpen(true)
      closeChannelChooser()
      setViewingCallStage(false)
      setFullStage(false)
      setLocalCallsOpen(false)
      onChangeCanvasMode?.('chat')
      setDirect({ roomId, over: selectedChannelId })
    }
  )
  const selectDirect = useStableHandler((roomId: string) => {
    selectDirectWithJump(roomId)
  })
  const activeRoomId = activeRoom?.roomId ?? null
  const roomBoundary =
    activeRoomId === null ? undefined : activeStore.getRoomBoundary?.(activeRoomId)
  const protectionUnavailable = roomBoundary !== undefined && !permitsPlaintext(roomBoundary)
  const activeDirect =
    directRoomId === null
      ? undefined
      : activeStore.getDirects?.().find((item) => item.roomId === directRoomId)

  const { joinRefused } = useEspaceJoinSync({
    activeStore,
    workspace,
    snapshot,
    activeChannel,
    activeRoomId,
  })

  const [membersOpen, setMembersOpen] = useState<boolean>(defaultMembersOpen)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(256)
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(280)
  const membersPanelId = useId()
  const membersTrigger = useRef<HTMLButtonElement>(null)
  const sidebarDrag = useRef<AbortController | null>(null)
  const routeFocusTimers = useRef<Map<ReturnType<typeof setTimeout>, string>>(new Map())
  const jumpCheckTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(
    () => () => {
      sidebarDrag.current?.abort()
      for (const [timer, path] of routeFocusTimers.current) {
        clearTimeout(timer)
        releaseRouteFocus(path)
      }
      routeFocusTimers.current.clear()
      for (const timer of jumpCheckTimers.current) clearTimeout(timer)
      jumpCheckTimers.current.clear()
    },
    []
  )
  function closeMembers() {
    setMembersOpen(false)
    membersTrigger.current?.focus()
  }
  function startSidebarResize(event: MouseEvent<HTMLDivElement>, resize: (delta: number) => void) {
    event.preventDefault()
    sidebarDrag.current?.abort()
    const drag = new AbortController()
    sidebarDrag.current = drag
    const startX = event.clientX
    window.addEventListener('mousemove', (moveEvent) => resize(moveEvent.clientX - startX), {
      signal: drag.signal,
    })
    const end = () => drag.abort()
    window.addEventListener('mouseup', end, { once: true, signal: drag.signal })
    window.addEventListener('blur', end, { once: true, signal: drag.signal })
  }
  function startLeftSidebarResize(event: MouseEvent<HTMLDivElement>) {
    startSidebarResize(event, (delta) =>
      setLeftSidebarWidth(Math.max(180, Math.min(420, leftSidebarWidth + delta)))
    )
  }
  function startRightSidebarResize(event: MouseEvent<HTMLDivElement>) {
    startSidebarResize(event, (delta) =>
      setRightSidebarWidth(Math.max(220, Math.min(560, rightSidebarWidth - delta)))
    )
  }

  const {
    viewerId,
    ownMatrixProfile,
    profileCopy,
    passportServices,
    ownAvatarSrc,
    ownPassport,
    passportOffered,
    savePassport,
    dismissPassport,
    unnamedMember,
    nameOfMember,
    roster,
    memberProfile,
    resolveMember,
    mentionMembers,
    mentionCandidates,
  } = useEspacePassportAndProfile({
    org,
    workspace,
    activeStore,
    snapshot,
    simulation,
    activeRoomId,
    directRoomId,
    selectDirect,
    accountName,
    deviceSettings,
    settingsEpoch,
    membersOpen,
  })

  const viewEpoch = useSyncExternalStore(
    memory?.subscribe ?? subscribeToNoDraft,
    memory?.getViewEpoch ?? noDraftSnapshot
  )
  const draftOrganisationId = workspace.organisation_id
  const [committedLease] = useState(() => createCommittedValue<DraftLease | null>(null))
  const lease = useSyncExternalStore(committedLease.subscribe, committedLease.getSnapshot)
  useLayoutEffect(() => {
    if (memory === null || activeRoomId === null) {
      committedLease.commit(null)
      return
    }
    const next = memory.attachView(
      activeStore,
      { organisation_id: draftOrganisationId },
      activeRoomId
    )
    committedLease.commit(next)
    return () => {
      next.release()
      if (committedLease.getSnapshot() === next) committedLease.commit(null)
    }
  }, [memory, activeStore, draftOrganisationId, activeRoomId, viewEpoch, committedLease])

  const [draftContext, setDraftContext] = useState(() => ({
    store: activeStore,
    generation: 0,
    drafts: createLocalDrafts(),
  }))
  if (draftContext.store !== activeStore) {
    setDraftContext({
      store: activeStore,
      generation: draftContext.generation + 1,
      drafts: createLocalDrafts(),
    })
  }
  const draftKey = activeRoomId === null ? null : `${viewerId}\n${activeRoomId}`
  const draft = useDraftChannel(memory, lease, draftContext.drafts, draftKey)
  const mentionMember = useStableHandler((member: MemberProfile) => {
    activeStore.loadMembers?.(activeRoomId!)
    const input = document.getElementById(composerInputId) as HTMLInputElement | null
    const needsSpace =
      input !== null &&
      (input.selectionStart ?? 0) > 0 &&
      !/\s$/.test(input.value.slice(0, input.selectionStart ?? 0))
    insertInComposer.current?.(`${needsSpace ? ' ' : ''}@${member.name} `)
  })
  function targetInShownRoom(eventId: string): RoomTarget | null {
    return activeRoomId === null ? null : { roomId: activeRoomId, eventId }
  }
  const openThreadIn = useCallback(
    (current: ChannelDraft) => inRoom(current.threadRoot, activeRoomId),
    [activeRoomId]
  )
  const openThreadRootId = useDraftSlice(draft, openThreadIn)
  const [callChannel, setCallChannel] = useState<CallChannel | null>(null)
  const threadOpener = useRef<ThreadOpener | null>(null)

  function ownsThreadOpener(opener: ThreadOpener) {
    return (
      opener.store === activeStore &&
      opener.generation === draftContext.generation &&
      opener.viewerId === viewerId &&
      opener.roomId === activeRoomId &&
      opener.eventId === openThreadRootId &&
      opener.element.isConnected
    )
  }

  const threadFocusTarget = {
    get current() {
      const opener = threadOpener.current
      return opener !== null && ownsThreadOpener(opener) ? opener.element : null
    },
  }

  useEffect(() => {
    const opener = threadOpener.current
    if (
      opener !== null &&
      (!ownsThreadOpener(opener) ||
        !activeStore
          .getTimeline(opener.roomId)
          .some((message) => message.eventId === opener.eventId))
    ) {
      threadOpener.current = null
    }
  })
  useEffect(
    () => () => {
      threadOpener.current = null
    },
    []
  )

  const openThread = useStableHandler((eventId: string, element: HTMLButtonElement) => {
    if (activeRoomId === null || draftKey === null) return
    setMembersOpen(false)
    draft.command(() => {
      threadOpener.current = {
        store: activeStore,
        generation: draftContext.generation,
        viewerId,
        roomId: activeRoomId,
        eventId,
        element,
      }
      draft.update((previous) => ({
        threadRoot: { roomId: activeRoomId, eventId },
        ...(previous.threadRoot?.roomId === activeRoomId && previous.threadRoot.eventId === eventId
          ? {}
          : { threadText: '' }),
      }))
    })
  })

  const timeline = activeRoomId !== null ? activeStore.getTimeline(activeRoomId) : NO_MESSAGES
  const history = activeRoomId !== null ? activeStore.getHistory?.(activeRoomId) : undefined
  const {
    ref: logRef,
    onScroll: onLogScroll,
    older: showOlder,
  } = useTimelineScroll({
    roomId: activeRoomId,
    timeline,
    history,
    loadOlder: activeStore.loadOlder,
  })
  const readMarkerOf = (room: RoomSummary | undefined) =>
    room === undefined || (room.unread === 0 && room.mentions === 0)
      ? null
      : (activeStore.getReadMarker?.(room.roomId) ?? null)
  const [readAtOpen, setReadAtOpen] = useState(() => ({
    store: activeStore,
    roomId: activeRoomId,
    eventId: readMarkerOf(activeRoom),
  }))
  if (readAtOpen.store !== activeStore || readAtOpen.roomId !== activeRoomId) {
    setReadAtOpen({ store: activeStore, roomId: activeRoomId, eventId: readMarkerOf(activeRoom) })
  }
  const unreadFrom =
    activeRoomId === null || readAtOpen.eventId === null
      ? null
      : (activeStore.firstShownAfter?.(activeRoomId, readAtOpen.eventId) ?? null)
  useMarkRead({ room: activeRoom, newestKey: timeline.at(-1)?.key, store: activeStore })

  const { mutedChannels, isChannelMuted, toggleChannelMute } = useMutedChannels(
    org,
    workspace.organisation_id,
    viewerId
  )
  const { favoriteChannels, isChannelFavorite, toggleChannelFavorite } = useFavoriteChannels(
    org,
    workspace.organisation_id,
    viewerId
  )

  const messageCues = useRef<{ store: EspaceStoreLike; tracker: MessageCueTracker } | null>(null)
  useEffect(() => {
    if (messageCues.current?.store !== activeStore) {
      messageCues.current = { store: activeStore, tracker: new MessageCueTracker() }
    }
    messageCues.current.tracker.update(
      activeStore,
      snapshot,
      (cue, context) => {
        if (
          cue === 'msg_channel_unread' &&
          context.channelId !== undefined &&
          mutedChannels.has(context.channelId)
        ) {
          return
        }
        soundEngine.play(cue, context)
      },
      effectiveCanvasMode === 'chat' ? activeRoomId : null
    )
  }, [activeStore, snapshot, timeline, activeRoomId, effectiveCanvasMode, mutedChannels])

  const selectTextChannel = useStableHandler(
    (
      nextChannelId: string,
      keepFocus = false,
      jumpTarget?: { readonly roomId: string; readonly eventId: string }
    ) => {
      const jumpToken = Symbol()
      pendingMessageJump.current = jumpTarget
        ? {
            roomId: jumpTarget.roomId,
            eventId: jumpTarget.eventId,
            targetChannelId: nextChannelId,
            token: jumpToken,
          }
        : null
      setMessagesDetailOpen(true)
      closeChannelChooser()
      setDirect(null)
      setViewingCallStage(false)
      setFullStage(false)
      setLocalCallsOpen(false)
      onChangeCanvasMode?.('chat')
      if (onNavigateChannel === undefined) {
        setClickedChannelId(nextChannelId)
        return
      }
      setRequestedChannelId(nextChannelId)
      const path = `/${encodeURIComponent(org)}/workspace/${encodeURIComponent(nextChannelId)}`
      if (keepFocus) keepFocusOnRouteTo(path)
      const settled = () => {
        setRequestedChannelId((current) => (current === nextChannelId ? null : current))
        if (keepFocus) {
          const timer = setTimeout(() => {
            routeFocusTimers.current.delete(timer)
            releaseRouteFocus(path)
          }, 0)
          routeFocusTimers.current.set(timer, path)
        }
      }
      const clearIfAborted = (outcome?: unknown) => {
        if (outcome === false) {
          if (pendingMessageJump.current?.token === jumpToken) pendingMessageJump.current = null
          return
        }
        if (!jumpTarget) return
        const checkTimer = setTimeout(() => {
          jumpCheckTimers.current.delete(checkTimer)
          if (pendingMessageJump.current?.token !== jumpToken) return
          if (
            !navigationStateRef.current.navigationPending &&
            navigationStateRef.current.addressedChannel !== nextChannelId
          ) {
            pendingMessageJump.current = null
          }
        }, 0)
        jumpCheckTimers.current.add(checkTimer)
      }
      void Promise.resolve(onNavigateChannel(nextChannelId)).then(
        (outcome) => {
          settled()
          clearIfAborted(outcome)
        },
        () => {
          settled()
          clearIfAborted(false)
        }
      )
    }
  )

  const [announcement, setAnnouncementState] = useState({ count: 0, text: '' })
  const setAnnouncement = useCallback(
    (text: string) => setAnnouncementState((current) => ({ count: current.count + 1, text })),
    []
  )
  const joinAudioRoom = useStableHandler(
    (
      channel: WorkspaceChannel,
      room: RoomSummary | undefined,
      categoryName: string | undefined
    ) => {
      setMessagesDetailOpen(true)
      closeChannelChooser()
      setLocalCallsOpen(false)
      onChangeCanvasMode?.('chat')
      if (activeCall === null || room === undefined) return
      const boundary = activeStore.getRoomBoundary?.(room.roomId)
      if (
        boundary !== undefined &&
        !permitsPlaintext(boundary) &&
        !activeCall.canJoinProtectedRoom?.(room.roomId)
      ) {
        setAnnouncement(protectionCopy.unavailable)
        return
      }
      setViewingCallStage(true)
      setCallDetached(false)
      setCallChannel({
        channelId: channel.id,
        roomId: room.roomId,
        roomName: channelLabel(channel, t),
        categoryName,
      })
      void activeCall.join(room.roomId)
    }
  )
  const openCallStage = useStableHandler(() => {
    closeChannelChooser()
    setCallDetached(false)
    setViewingCallStage(true)
    setLocalCallsOpen(false)
    onChangeCanvasMode?.('chat')
  })
  const detachCall = useStableHandler(() => {
    setCallDetached(true)
    setViewingCallStage(false)
    setFullStage(false)
  })
  const redockCall = useStableHandler(() => {
    setCallDetached(false)
    setViewingCallStage(false)
    setFullStage(false)
  })
  const openCallsSurface = useStableHandler(() => {
    setDirect(null)
    setViewingCallStage(false)
    setFullStage(false)
    if (onChangeCanvasMode !== undefined) onChangeCanvasMode('calls')
    else setLocalCallsOpen(true)
    leaveChannelChooser()
  })

  const loadMembers = useStableHandler(() => {
    if (activeRoomId !== null) activeStore.loadMembers?.(activeRoomId)
  })

  const [attachmentRoom, setAttachmentRoom] = useState<string | null>(null)
  const [composerRoom, setComposerRoom] = useState(activeRoomId)
  if (composerRoom !== activeRoomId) {
    setComposerRoom(activeRoomId)
    setAttachmentRoom(null)
  }
  const attachmentStaged = activeRoomId !== null && attachmentRoom === activeRoomId
  const changeStaging = useStableHandler((staged: boolean) =>
    setAttachmentRoom(staged ? activeRoomId : null)
  )
  const inviteTrigger = useRef<HTMLButtonElement>(null)
  const inviteReturnFocus = useRef<HTMLElement | null>(null)
  const canInviteChannel = useCallback(
    (id: string) => {
      if (workspace.allow_member_invites !== false) return true
      const resolved = snapshot.channels.get(id)
      if (resolved?.state !== 'resolved') return false
      const role = profileRoleIn(activeStore, resolved.roomId, viewerId)
      return role === 'admin' || role === 'maintainer'
    },
    [workspace.allow_member_invites, snapshot.channels, activeStore, viewerId]
  )
  const canInvite =
    (workspace.allow_member_invites !== false ||
      (activeRoomId !== null &&
        ['admin', 'maintainer'].includes(profileRoleIn(activeStore, activeRoomId, viewerId)))) &&
    directRoomId === null &&
    activeRoom !== undefined &&
    activeChannel != null &&
    !focusedDocs &&
    effectiveCanvasMode === 'chat' &&
    !navigationUnsettled
  const openInvitation = useCallback(() => inviteTrigger.current?.click(), [])
  const pendingInviteChannelId = useRef<string | null>(null)
  useEffect(() => {
    if (
      pendingInviteChannelId.current !== null &&
      activeChannel?.id === pendingInviteChannelId.current &&
      canInvite
    ) {
      pendingInviteChannelId.current = null
      setTimeout(() => inviteTrigger.current?.click(), 0)
    }
  }, [activeChannel?.id, canInvite])

  const searchEntries = useMemo<ChannelSearchEntry[]>(
    () => [
      ...workspace.categories.flatMap((category) =>
        category.channels.map((channel) => ({
          id: channel.id,
          label: channelLabel(channel, t),
          kind: channel.kind,
          category: categoryLabel(category, t),
        }))
      ),
      ...workspace.uncategorised_channels.map((channel) => ({
        id: channel.id,
        label: channelLabel(channel, t),
        kind: channel.kind,
      })),
    ],
    [workspace, t]
  )
  const audioRooms = useMemo(
    () => searchEntries.filter((entry) => entry.kind === 'audio'),
    [searchEntries]
  )
  const channelsById = useMemo<ReadonlyMap<string, ConfidentialChannelFlags>>(
    () =>
      new Map(
        [
          ...workspace.categories.flatMap((category) => category.channels),
          ...workspace.uncategorised_channels,
        ].map((channel) => [channel.id, channel as WorkspaceChannel & ConfidentialChannelFlags])
      ),
    [workspace]
  )

  const pendingModeFocus = useRef<{
    readonly mode: WorkspaceUiMode
    readonly force: boolean
  } | null>(null)
  useEffect(() => {
    const req = pendingModeFocus.current
    if (req === null || req.mode !== uiMode) return
    pendingModeFocus.current = null
    const focusToggle = () => {
      const candidates = document.querySelectorAll<HTMLButtonElement>(
        `[data-testid="workspace-ui-mode-${req.mode}"]`
      )
      const target = [...candidates].find((el) => !withdrawn(el)) ?? candidates[0]
      target?.focus()
    }
    if (req.force) {
      focusToggle()
      return
    }
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === null || document.activeElement === document.body) {
        focusToggle()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [uiMode])

  const handleSelectUiMode = useStableHandler(
    (next: WorkspaceUiMode, options?: { fromToggle?: boolean }) => {
      pendingModeFocus.current = { mode: next, force: options?.fromToggle === true }
      setUiMode(next)
      if (next === 'messages') {
        setLocalCallsOpen(false)
        onChangeCanvasMode?.('chat')
      }
    }
  )
  const handleToggleUiMode = useStableHandler(() => {
    const next = uiMode === 'messages' ? 'pro' : 'messages'
    setUiMode(next)
    pendingModeFocus.current = { mode: next, force: false }
    if (next === 'messages') {
      setLocalCallsOpen(false)
      onChangeCanvasMode?.('chat')
    }
  })

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'm' &&
        !event.isComposing
      ) {
        event.preventDefault()
        handleToggleUiMode()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [handleToggleUiMode])

  const openFromSearch = useStableHandler((entry: ChannelSearchEntry): HTMLElement | null => {
    if (entry.kind === 'text') {
      selectTextChannel(entry.id)
      return headingRef.current
    }
    const row = document.getElementById(roomRowId(sidebarHeadingId, entry.id))
    return row instanceof HTMLButtonElement && !row.disabled && row.closest('[hidden]') === null
      ? row
      : null
  })
  const changeCanvas = useStableHandler((mode: CanvasMode) => {
    pendingMessageJump.current = null
    if (mode !== 'chat' && uiMode === 'messages') setUiMode('pro')
    if (mode !== 'chat') {
      setDirect(null)
      setViewingCallStage(false)
      setFullStage(false)
    }
    setLocalCallsOpen(mode === 'calls')
    onChangeCanvasMode?.(mode)
  })
  const openDocument = useStableHandler((doc: ChannelDoc) => {
    pendingMessageJump.current = null
    if (uiMode === 'messages') setUiMode('pro')
    setDirect(null)
    setViewingCallStage(false)
    setFullStage(false)
    setLocalCallsOpen(false)
    onOpenDocument?.(doc)
    requestAnimationFrame(() => headingRef.current?.focus())
    leaveChannelChooser()
    return headingRef.current
  })
  const openStudioDocument = onOpenDocument ? openDocument : undefined
  const openCollectionFromOmnibox = useStableHandler((id: string): HTMLElement | null => {
    pendingMessageJump.current = null
    if (onOpenCollection !== undefined) {
      if (uiMode === 'messages') setUiMode('pro')
      setDirect(null)
      setViewingCallStage(false)
      setFullStage(false)
      setLocalCallsOpen(false)
      onOpenCollection(id)
      requestAnimationFrame(() => headingRef.current?.focus())
      leaveChannelChooser()
      return headingRef.current
    }
    const matched = documents.find((doc) => doc.id === id)
    if (matched !== undefined && openStudioDocument !== undefined) {
      return openStudioDocument(matched)
    }
    return null
  })
  const openStudioChannel = useStableHandler((entry: ChannelSearchEntry) => {
    setLocalCallsOpen(false)
    if (entry.kind === 'text') onChangeCanvasMode?.('chat')
    return openFromSearch(entry)
  })
  const [docsEverOpened, setDocsEverOpened] = useState(effectiveCanvasMode === 'docs')
  if (effectiveCanvasMode === 'docs' && !docsEverOpened) setDocsEverOpened(true)
  const switchCanvas = useStableHandler((mode: CanvasMode) => {
    pendingMessageJump.current = null
    if (mode !== 'chat') {
      setDirect(null)
      setViewingCallStage(false)
      setFullStage(false)
    }
    setLocalCallsOpen(mode === 'calls')
    onChangeCanvasMode?.(mode)
    leaveChannelChooser()
  })
  const createInCategory = useStableHandler((category: WorkspaceCategory) => {
    closeChannelChooser()
    onCreateInCategory?.(category)
  })

  const activeChannelFlags = activeChannel as
    (WorkspaceChannel & ConfidentialChannelFlags) | null | undefined
  const activeDocsIsConfidential =
    activeChannelFlags?.isConfidential === true ||
    activeChannelFlags?.is_confidential === true ||
    roomBoundary === 'confidential-unavailable' ||
    roomBoundary === 'invalid'
  const activeDocsBoundary: RoomBoundary | undefined = activeDocsIsConfidential
    ? roomBoundary !== undefined && !permitsPlaintext(roomBoundary)
      ? roomBoundary
      : 'confidential-unavailable'
    : roomBoundary !== undefined
      ? roomBoundary
      : activeStore.getRoomBoundary !== undefined
        ? 'unknown'
        : undefined
  const activeChannelIdForDocs = activeChannel?.id
  useLayoutEffect(() => {
    onActiveChannelBoundaryChange?.({
      channelId: activeChannelIdForDocs,
      roomBoundary: activeDocsBoundary,
      isConfidential: activeDocsIsConfidential,
    })
  }, [
    activeChannelIdForDocs,
    activeDocsBoundary,
    activeDocsIsConfidential,
    onActiveChannelBoundaryChange,
  ])

  const activeChannelName =
    activeChannel !== null && activeChannel !== undefined ? channelLabel(activeChannel, t) : ''
  const isArchivedChannel = activeChannel?.lifecycle === 'archived'
  const canSendInRoom =
    activeRoomId !== null && (activeStore.canSendMessage?.(activeRoomId) ?? true)
  const canWrite = !isArchivedChannel && !protectionUnavailable && canSendInRoom
  const canReact =
    !isArchivedChannel &&
    !protectionUnavailable &&
    activeRoomId !== null &&
    (activeStore.canReact?.(activeRoomId) ?? true)
  const welcomeRoomId =
    directRoomId === null && activeRoomId !== null && isArrivalsChannel(activeChannelName)
      ? activeRoomId
      : null
  const arrivalsOf = useCallback(
    () =>
      welcomeRoomId === null
        ? NO_ARRIVALS
        : (activeStore.getArrivals?.(welcomeRoomId) ?? NO_ARRIVALS),
    [activeStore, welcomeRoomId]
  )
  const arrivals = useStoreSlice(activeStore.subscribe, activeStore.getSnapshot, arrivalsOf)
  const shownInserts = useMemo(() => {
    const base = timelineInserts ?? NO_INSERTS
    if (welcomeRoomId === null || arrivals.length === 0) return base
    return [
      ...base,
      ...arrivalInserts(arrivals, nameOfMember, canReact, (eventId, emoji) =>
        activeStore.toggleReaction(welcomeRoomId, eventId, emoji)
      ),
    ].sort((a, b) => a.ts - b.ts)
  }, [timelineInserts, welcomeRoomId, arrivals, nameOfMember, canReact, activeStore])

  const paneNotice = protectionUnavailable
    ? roomBoundary === 'unknown'
      ? protectionCopy.checking
      : protectionCopy.unavailable
    : isArchivedChannel
      ? t('console.workspace.channel.label-archived')
      : canWrite || activeChannel === null || activeChannel === undefined
        ? undefined
        : activeRoomId !== null
          ? t('console.workspace.channel.label-read-only')
          : !roomResolved(activeChannel, snapshot.channels)
            ? t('console.workspace.channel.label-preparing')
            : joinRefused
              ? t('console.workspace.channel.label-join-refused')
              : snapshot.status === 'live'
                ? t('console.workspace.channel.label-arriving')
                : undefined

  const retryMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite || activeRoomId === null) return
    draft.command(() => {
      if (activeStore.resend !== undefined) void activeStore.resend(activeRoomId, msg.key)
      else void activeStore.send(activeRoomId, msg.body)
    })
  })

  const reactToMessage = useStableHandler((eventId: string, reaction: string) => {
    if (!canReact || activeRoomId === null) return
    draft.command(() => {
      void activeStore.toggleReaction(activeRoomId, eventId, reaction)
    })
  })

  const replyToMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite) return
    const replyTo = targetInShownRoom(msg.eventId)
    draft.update((previous) => ({
      editing: null,
      replyTo,
      ...(previous.editing === null ? {} : { text: '' }),
    }))
  })

  const editMessage = useStableHandler((msg: MessageView) => {
    if (!canWrite) return
    if (activeRoomId !== null) activeStore.setTyping?.(activeRoomId, false)
    const target = targetInShownRoom(msg.eventId)
    const retained = historicalMentionCandidates(msg, mentionCandidates)
    draft.update({
      replyTo: null,
      editing:
        target === null || retained.length === 0 ? target : { ...target, mentionTargets: retained },
      text: msg.body,
    })
  })

  const removeMessage = useStableHandler((eventId: string) => {
    if (activeRoomId !== null)
      draft.command(() => {
        void activeStore.remove(activeRoomId, eventId)
      })
  })

  const timelineHandle = useRef<MessageTimelineHandle>(null)
  const showMessage = useStableHandler(
    (eventId: string): boolean => timelineHandle.current?.showMessage(eventId) ?? false
  )
  useEffect(() => {
    const pending = pendingMessageJump.current
    if (pending === null || pending.targetChannelId === null) return
    if (
      !navigationPending &&
      requestedChannelId === null &&
      addressedChannel !== pending.targetChannelId
    ) {
      pendingMessageJump.current = null
    }
  }, [addressedChannel, navigationPending, requestedChannelId])

  useEffect(() => {
    const pending = pendingMessageJump.current
    if (pending === null || activeRoomId !== pending.roomId || effectiveCanvasMode !== 'chat')
      return
    pendingMessageJump.current = null
    showMessage(pending.eventId)
    const frame = requestAnimationFrame(() => {
      showMessage(pending.eventId)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeRoomId, effectiveCanvasMode, showMessage])

  const onJumpToMessage = useStableHandler(
    (
      roomId: string,
      targetId: string,
      isDirectTarget: boolean,
      eventId: string
    ): HTMLElement | null => {
      if (activeRoomId === roomId && effectiveCanvasMode === 'chat') {
        pendingMessageJump.current = null
        showMessage(eventId)
        requestAnimationFrame(() => {
          showMessage(eventId)
        })
        const shown = document.querySelector('[data-shown="true"]')
        return shown instanceof HTMLElement ? shown : headingRef.current
      }
      if (isDirectTarget) selectDirectWithJump(targetId, { roomId, eventId })
      else selectTextChannel(targetId, false, { roomId, eventId })
      return headingRef.current
    }
  )

  const dynamicEntries = useWorkspaceOmniboxDynamicEntries({
    store: activeStore,
    snapshot,
    entries: searchEntries,
    channelsById,
    documents,
    collections,
    openDocument: openStudioDocument,
    onOpenCollection:
      onOpenCollection !== undefined || openStudioDocument !== undefined
        ? openCollectionFromOmnibox
        : undefined,
    onJumpToMessage,
    simulation,
  })
  const rowActions = useMemo<MessageRowActions>(
    () => ({
      onRetry: retryMessage,
      onReaction: reactToMessage,
      onReply: replyToMessage,
      onEdit: editMessage,
      onRemove: removeMessage,
      onOpenThread: openThread,
    }),
    [retryMessage, reactToMessage, replyToMessage, editMessage, removeMessage, openThread]
  )

  const threadRootMessage =
    openThreadRootId !== null
      ? timeline.find((candidate) => candidate.eventId === openThreadRootId)
      : undefined
  const activeThreadReplies =
    openThreadRootId !== null && activeRoomId !== null
      ? activeStore.getThread(activeRoomId, openThreadRootId)
      : []
  const channelColumn = useRef<HTMLElement>(null)
  const movedByKey = useRef(false)
  const shownChannelId = activeChannel?.id
  useEffect(() => {
    if (!movedByKey.current) return
    movedByKey.current = false
    const focused = document.activeElement
    if (focused === null || focused === document.body) headingRef.current?.focus()
  }, [shownChannelId])
  const textChannelIds = useMemo(
    () =>
      [
        ...workspace.categories.flatMap((category) => category.channels),
        ...workspace.uncategorised_channels,
      ]
        .filter((channel) => channel.kind === 'text')
        .map((channel) => channel.id),
    [workspace]
  )
  const onChannelKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const move = channelMove(event)
    if (move === null || event.defaultPrevented || withdrawn(channelColumn.current)) return
    const from = event.target instanceof Element ? event.target : null
    if (from?.closest('aside, [data-popover]')) return
    event.preventDefault()
    const unread = (id: string) => {
      const channel = currentChannel(workspace, id)
      const room =
        channel === null || channel === undefined
          ? undefined
          : roomForChannel(channel, snapshot.channels, snapshot.rooms)
      return room !== undefined && (room.unread > 0 || room.mentions > 0)
    }
    const next = channelAfter(
      textChannelIds,
      requestedChannelId ?? activeChannel?.id,
      move.step,
      move.unread ? unread : undefined
    )
    if (next === null) {
      if (move.unread) setAnnouncement(t('console.workspace.shortcuts.announce-no-unread'))
      return
    }
    movedByKey.current = true
    selectTextChannel(next, true)
    const channel = currentChannel(workspace, next)
    if (channel !== null && channel !== undefined)
      setAnnouncement(
        t('console.workspace.shortcuts.announce-channel', { channel: channelLabel(channel, t) })
      )
  })
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => onChannelKey(event)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  function columnKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || composing(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const current = draft.read()
    if (current.editing !== null) {
      event.preventDefault()
      draft.update({ editing: null, text: '' })
      return
    }
    const replyToEventId = inRoom(current.replyTo, activeRoomId)
    if (
      replyToEventId !== null &&
      timeline.some((candidate) => candidate.eventId === replyToEventId)
    ) {
      event.preventDefault()
      draft.update({ replyTo: null })
      return
    }
    const unread = activeRoom !== undefined && (activeRoom.unread > 0 || activeRoom.mentions > 0)
    if (activeRoomId === null || (!unread && unreadFrom === null)) return
    event.preventDefault()
    setReadAtOpen({ store: activeStore, roomId: activeRoomId, eventId: null })
    if (unread) activeStore.markRead?.(activeRoomId).catch(() => undefined)
    setAnnouncement(
      t('console.workspace.shortcuts.announce-marked-read', { channel: activeChannelName })
    )
  }

  const copyChannelLink = useStableHandler((target: ChannelMenuTarget) => {
    const url = `${window.location.origin}/${encodeURIComponent(org)}/workspace/${encodeURIComponent(target.channelId)}`
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) {
      setAnnouncement(t('console.workspace.channel-menu.announce-copy-failed'))
      return
    }
    void clipboard.writeText(url).then(
      () =>
        setAnnouncement(
          t('console.workspace.channel-menu.announce-copied', { channel: target.label })
        ),
      () => setAnnouncement(t('console.workspace.channel-menu.announce-copy-failed'))
    )
  })
  const inviteFromChannelMenu = useStableHandler((target: ChannelMenuTarget) => {
    if (!canInviteChannel(target.channelId)) return
    inviteReturnFocus.current = target.trigger ?? null
    if (target.kind === 'audio') {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_COMMAND_EVENT, {
          detail: { command: 'settings', section: 'members' },
        })
      )
      return
    }
    if (target.channelId === activeChannel?.id && canInvite) {
      setTimeout(() => inviteTrigger.current?.click(), 0)
      return
    }
    pendingInviteChannelId.current = target.channelId
    selectTextChannel(target.channelId)
  })
  const openChannelSettings = useStableHandler((target: ChannelMenuTarget) => {
    if (target.kind === 'text' && target.channelId !== activeChannel?.id) {
      selectTextChannel(target.channelId)
    }
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_COMMAND_EVENT, {
        detail: { command: 'settings', section: target.kind === 'audio' ? 'audio' : 'members' },
      })
    )
  })
  const canManageChannel = useCallback(
    (id: string) => {
      const resolved = snapshot.channels.get(id)
      if (resolved?.state !== 'resolved') return false
      const role = profileRoleIn(activeStore, resolved.roomId, viewerId)
      return role === 'admin' || role === 'maintainer' || role === 'core'
    },
    [snapshot.channels, activeStore, viewerId]
  )
  const openChannelPermissions = useStableHandler((target: ChannelMenuTarget) => {
    if (target.kind === 'text' && target.channelId !== activeChannel?.id) {
      selectTextChannel(target.channelId)
    }
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_COMMAND_EVENT, {
        detail: { command: 'settings', section: 'moderation' },
      })
    )
  })
  const openNotification = useStableHandler((item: Notification) => {
    if (item.kind === 'moderation') {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_COMMAND_EVENT, {
          detail: { command: 'settings', section: 'moderation' },
        })
      )
      return
    }
    if (item.kind === 'document') {
      const matched = documents.find(
        (doc) => doc.id === item.resourceId || doc.id === `workspace-page:${item.resourceId}`
      )
      if (matched !== undefined && openStudioDocument !== undefined) {
        openStudioDocument(matched)
      } else {
        changeCanvas('docs')
      }
      return
    }
    if (item.kind === 'invitation') {
      if (isMatrixRoomId(item.resourceId)) {
        selectDirect(item.resourceId)
      } else {
        window.dispatchEvent(
          new CustomEvent(WORKSPACE_COMMAND_EVENT, {
            detail: { command: 'settings', section: 'members' },
          })
        )
      }
      return
    }
    if (textChannelIds.includes(item.resourceId)) {
      selectTextChannel(item.resourceId)
      return
    }
    for (const [chId, room] of snapshot.channels) {
      if (room.state === 'resolved' && room.roomId === item.resourceId) {
        selectTextChannel(chId)
        return
      }
    }
    if (isMatrixRoomId(item.resourceId)) {
      selectDirect(item.resourceId)
    }
  })

  const guardCall = inLiveCall && !signedOut
  const callPlacement: CallPlacement = !inLiveCall
    ? 'stage'
    : callDetached
      ? 'floating'
      : viewingCallStage && effectiveCanvasMode === 'chat'
        ? 'stage'
        : 'sidebar'

  const startQuickCall = useStableHandler(
    (target: {
      readonly kind: 'direct' | 'text' | 'audio'
      readonly channel?: WorkspaceChannel | undefined
      readonly direct?: { readonly roomId: string; readonly name: string } | undefined
      readonly room?: RoomSummary | undefined
      readonly categoryName?: string | undefined
    }) => {
      if (target.kind === 'direct' && target.direct !== undefined) {
        const dmChannel = directChannelOf(target.direct.roomId, target.direct.name)
        const dmRoom =
          target.room ?? snapshot.rooms.find((room) => room.roomId === target.direct!.roomId)
        joinAudioRoom(dmChannel, dmRoom, undefined)
        return
      }
      if (target.channel !== undefined) {
        const targetRoom =
          target.room ?? roomForChannel(target.channel, snapshot.channels, snapshot.rooms)
        joinAudioRoom(target.channel, targetRoom, target.categoryName)
      }
    }
  )

  const startHeaderQuickCall = useStableHandler(() => {
    if (directRoomId !== null && activeDirect !== undefined) {
      startQuickCall({ kind: 'direct', direct: activeDirect, room: activeRoom })
    } else if (activeChannel != null) {
      startQuickCall({ kind: activeChannel.kind, channel: activeChannel, room: activeRoom })
    }
  })

  const sidebarGridClass = narrow
    ? undefined
    : callPlacement === 'sidebar' && inLiveCall
      ? 'col-start-1 row-span-2 row-start-1'
      : 'col-start-1 row-span-3 row-start-1'

  const sidebar =
    uiMode === 'messages' ? (
      <SimpleMessagingSidebar
        store={activeStore}
        workspace={workspace}
        org={org}
        organisationName={organisationName}
        narrow={narrow}
        simulation={simulation}
        headingId={sidebarHeadingId}
        width={leftSidebarWidth}
        uiMode={uiMode}
        onChangeUiMode={handleSelectUiMode}
        activeChannelId={activeChannel?.id}
        activeDirectRoomId={directRoomId}
        favoriteChannels={favoriteChannels}
        proximityChannelIds={proximityChannelIds}
        documents={documents}
        searchEntries={searchEntries}
        dynamicEntries={dynamicEntries}
        mentionCandidates={mentionCandidates}
        insertRef={insertInComposer}
        organisationActionSlot={organisationActionSlot}
        sidebarActionSlot={sidebarActionSlot}
        sidebarFooterSlot={sidebarFooterSlot}
        className={sidebarGridClass}
        onChooseFromSearch={openFromSearch}
        onOpenDocument={openStudioDocument}
        onSelectTextChannel={selectTextChannel}
        onSelectDirect={selectDirect}
        onStartQuickCall={startQuickCall}
        onChannelContextMenu={onChannelContextMenu}
        onChannelSettings={openChannelSettings}
        onChannelToggleFavorite={toggleChannelFavorite}
        isChannelFavorite={isChannelFavorite}
        onChannelToggleMute={toggleChannelMute}
        isChannelMuted={isChannelMuted}
        onChannelInvite={inviteFromChannelMenu}
        canInviteChannel={canInviteChannel}
        onChannelCopyLink={copyChannelLink}
        onChannelPermissions={openChannelPermissions}
        canManageChannel={canManageChannel}
        onOpenNotification={simulation ? undefined : openNotification}
      />
    ) : (
      <ChannelSidebar
        store={activeStore}
        call={activeCall}
        workspace={workspace}
        org={org}
        organisationName={organisationName}
        narrow={narrow}
        simulation={simulation}
        headingId={sidebarHeadingId}
        width={leftSidebarWidth}
        activeChannelId={activeChannel?.id}
        canvasMode={effectiveCanvasMode}
        categoryDescriptions={categoryDescriptions}
        proximityChannelIds={proximityChannelIds}
        documents={documents}
        searchEntries={searchEntries}
        dynamicEntries={dynamicEntries}
        uiMode={uiMode}
        onChangeUiMode={handleSelectUiMode}
        mentionCandidates={mentionCandidates}
        canInvite={canInvite}
        speakingRef={micActivity.speakingRef}
        insertRef={insertInComposer}
        organisationActionSlot={organisationActionSlot}
        sidebarActionSlot={sidebarActionSlot}
        sidebarFooterSlot={sidebarFooterSlot}
        onInvite={openInvitation}
        onChooseFromSearch={openFromSearch}
        onOpenChannel={openStudioChannel}
        onOpenDocument={openStudioDocument}
        onChangeCanvasMode={onChangeCanvasMode ? changeCanvas : undefined}
        onSwitchCanvas={onChangeCanvasMode ? switchCanvas : undefined}
        onOpenCalls={openCallsSurface}
        className={sidebarGridClass}
        onSelectTextChannel={selectTextChannel}
        activeDirectRoomId={directRoomId}
        onSelectDirect={selectDirect}
        onJoinAudioRoom={joinAudioRoom}
        onCreateInCategory={onCreateInCategory === undefined ? undefined : createInCategory}
        onChannelContextMenu={onChannelContextMenu}
        onChannelSettings={openChannelSettings}
        onChannelToggleFavorite={toggleChannelFavorite}
        isChannelFavorite={isChannelFavorite}
        onChannelToggleMute={toggleChannelMute}
        isChannelMuted={isChannelMuted}
        onChannelInvite={inviteFromChannelMenu}
        canInviteChannel={canInviteChannel}
        onChannelCopyLink={copyChannelLink}
        onChannelPermissions={openChannelPermissions}
        canManageChannel={canManageChannel}
        onOpenNotification={simulation ? undefined : openNotification}
      />
    )

  return (
    <PassportContext.Provider value={passportServices}>
      {passportOffered ? (
        <Suspense fallback={null}>
          <LazyKoderaPassportModal
            open
            userId={viewerId}
            initialName={
              isPlaceholderName(ownMatrixProfile?.displayName, viewerId)
                ? ''
                : cleanText(ownMatrixProfile?.displayName, 80)
            }
            initialPassport={ownPassport}
            avatarSrc={ownAvatarSrc}
            roleLabel={profileCopy[profileRoleIn(activeStore, activeRoomId, viewerId)]}
            onSave={savePassport}
            onDismiss={dismissPassport}
          />
        </Suspense>
      ) : null}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="studio-workspace"
        data-ui-mode={uiMode}
        data-messages-detail={messagesDetailOpen}
      >
        <WorkspacePaletteRegistration
          store={activeStore}
          entries={searchEntries}
          channelsById={channelsById}
          documents={documents}
          collections={collections}
          openDocument={openStudioDocument}
          onOpenCollection={
            onOpenCollection !== undefined || openStudioDocument !== undefined
              ? openCollectionFromOmnibox
              : undefined
          }
          onJumpToMessage={onJumpToMessage}
          onChoose={openFromSearch}
          onSelectDirect={selectDirect}
          onChangeCanvasMode={onChangeCanvasMode ? changeCanvas : undefined}
          uiMode={uiMode}
          onToggleUiMode={handleToggleUiMode}
          dynamicEntries={dynamicEntries}
          simulation={simulation}
          snapshot={snapshot}
        />
        <div className="messages-layout grid min-h-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] grid-rows-[auto_minmax(0,1fr)_auto] narrow:flex narrow:flex-col">
          {narrow && uiMode !== 'messages' ? (
            <div className="order-first flex shrink-0 flex-col gap-2 border-b border-c-border-soft pb-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <OrganisationHeader
                    name={workspace.display_name || organisationName}
                    slug={org}
                    logoUrl={workspace.logo_url}
                  />
                </div>
                <Drawer
                  open={channelsOpen}
                  onOpenChange={changeChannelChooser}
                  side="bottom"
                  title={t('console.workspace.sidebar.title')}
                  closeLabel={t('console.common.action-close')}
                  returnFocusTo={channelChooserReturnFocus}
                  trigger={
                    <Button variant="secondary" size="sm" className="shrink-0">
                      {t('console.workspace.sidebar.title')}
                    </Button>
                  }
                >
                  {sidebar}
                </Drawer>
              </div>
            </div>
          ) : null}
          {inRouter ? <LeaveCallGuard live={guardCall} /> : null}
          {narrow || uiMode === 'messages' ? null : (
            <EspaceSidebarResizer
              testId="espace-sidebar-primary-resizer"
              ariaLabel={t('console.workspace.layout.resize-channels')}
              value={leftSidebarWidth}
              min={180}
              max={420}
              defaultWidth={256}
              direction="left"
              onMouseDown={startLeftSidebarResize}
              onChangeWidth={setLeftSidebarWidth}
              className="col-start-2 row-span-3 row-start-1 w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
            />
          )}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <section
            ref={channelColumn}
            onKeyDown={columnKeyDown}
            className={cx(
              'messages-detail workspace-canvas flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-c-surface px-6 py-5 narrow:gap-2 narrow:bg-transparent narrow:p-0',
              narrow
                ? ''
                : inLiveCall && callPlacement === 'stage' && fullStage
                  ? 'hidden'
                  : callPlacement === 'stage'
                    ? 'col-start-3 row-span-2 row-start-2'
                    : 'col-start-3 row-span-3 row-start-1'
            )}
          >
            <p aria-live="polite" aria-atomic="true" className="sr-only">
              {announcement.count === 0 ? null : (
                <span key={announcement.count}>{announcement.text}</span>
              )}
            </p>
            {uiMode === 'messages' ? (
              <button
                type="button"
                onClick={() => {
                  setMessagesDetailOpen(false)
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLElement>('[data-testid="simple-messaging-sidebar"] button')
                      ?.focus()
                  )
                }}
                className="messages-back min-h-[44px] items-center gap-2 rounded-md px-3 text-sm text-c-ink-2 focus-visible:ring"
              >
                <KoderaIcon name="left" />
                {uiModeCopy(i18n.resolvedLanguage).back}
              </button>
            ) : null}
            <EspaceChannelHeader
              org={org}
              activeStore={activeStore}
              activeChannel={activeChannel}
              activeChannelName={activeChannelName}
              activeRoom={activeRoom}
              activeRoomId={activeRoomId}
              directRoomId={directRoomId}
              activeDirect={activeDirect}
              proximityChannelIds={proximityChannelIds}
              roomBoundary={roomBoundary}
              effectiveCanvasMode={effectiveCanvasMode}
              focusedDocs={focusedDocs}
              navigationUnsettled={navigationUnsettled}
              signedOut={signedOut}
              simulation={simulation}
              demoPresenceLabel={demoCopy.presence}
              unnamedMember={unnamedMember}
              narrow={narrow}
              membersOpen={membersOpen}
              membersPanelId={membersPanelId}
              headingRef={headingRef}
              inviteTrigger={inviteTrigger}
              inviteReturnFocus={inviteReturnFocus}
              canInvite={canInvite}
              membersTrigger={membersTrigger}
              audioRooms={audioRooms}
              simpleMode={uiMode === 'messages'}
              onStartQuickCall={startHeaderQuickCall}
              onShowMessage={showMessage}
              onToggleMembers={() => setMembersOpen((open) => !open)}
              onOpenCalls={openCallsSurface}
              onChooseAudioRoom={(entry) => {
                if (narrow) {
                  setChannelsOpen(true)
                  return null
                }
                return openFromSearch(entry)
              }}
            />

            {uiMode === 'messages' ? (
              <Suspense fallback={null}>
                <LazyMessagesPinnedBanner
                  store={activeStore}
                  roomId={activeRoomId}
                  topic={activeChannel?.topic}
                  flags={activeChannel ?? undefined}
                  onShow={showMessage}
                />
              </Suspense>
            ) : null}
            <EspaceCanvasPanes
              signedOut={signedOut}
              onReconnect={onReconnect}
              docsEverOpened={docsEverOpened}
              activeChannel={activeChannel}
              directRoomId={directRoomId}
              docsCanvasSlot={docsCanvasSlot}
              effectiveCanvasMode={effectiveCanvasMode}
              searchEntries={searchEntries}
              activeStore={activeStore}
              snapshot={snapshot}
              documents={documents}
              openStudioDocument={openStudioDocument}
              onOpenDocument={onOpenDocument}
              onSelectTextChannel={(nextId) => selectTextChannel(nextId)}
              onSelectDirect={selectDirect}
              workspace={workspace}
              activeCall={activeCall}
              callChannel={callChannel}
              deviceSettings={deviceSettings}
              onJoinAudioRoom={joinAudioRoom}
              onOpenCallStage={openCallStage}
            />

            {activeChannel == null || effectiveCanvasMode !== 'chat' ? null : (
              <>
                {isProximityChannel(activeChannel, proximityChannelIds) &&
                renderProximityPanel !== undefined ? (
                  <div data-testid="espace-proximity-room-surface" className="flex flex-col gap-3">
                    <div data-testid="proximity-room-panel">
                      {renderProximityPanel(activeChannel)}
                    </div>
                  </div>
                ) : null}
                <MessageTimeline
                  store={activeStore}
                  roomId={activeRoomId}
                  channelId={activeChannel.id}
                  channelName={activeChannelName}
                  direct={
                    directRoomId === null
                      ? undefined
                      : {
                          userId: activeDirect?.userIds[0] ?? directRoomId,
                          avatarMxc: activeDirect?.avatarMxc,
                        }
                  }
                  resolveMember={resolveMember}
                  viewerId={viewerId}
                  archived={isArchivedChannel}
                  canWrite={canWrite}
                  canReact={canReact}
                  simulation={simulation}
                  expandedEventId={openThreadRootId}
                  unreadFrom={unreadFrom}
                  menuContext={`${draftContext.generation}:${viewerId}:${activeRoomId}`}
                  documents={documents}
                  onOpenDocument={openStudioDocument}
                  inserts={shownInserts}
                  onMention={!canWrite || navigationUnsettled ? undefined : mentionMember}
                  actions={rowActions}
                  handleRef={timelineHandle}
                  logRef={logRef}
                  onScroll={onLogScroll}
                  onLoadOlder={showOlder}
                />

                {!canWrite ? (
                  paneNotice === undefined ? null : (
                    <p className="border-t border-c-border-soft pt-3 text-sm text-c-ink-3">
                      {paneNotice}
                    </p>
                  )
                ) : (
                  <MessageComposer
                    store={activeStore}
                    roomId={activeRoomId}
                    viewerId={viewerId}
                    draft={draft}
                    channelName={activeChannelName}
                    direct={directRoomId !== null}
                    simulation={simulation}
                    narrow={narrow}
                    navigationUnsettled={navigationUnsettled}
                    inputId={composerInputId}
                    guidanceId={demoGuidanceId}
                    members={mentionCandidates}
                    attachmentStaged={attachmentStaged}
                    onStagingChange={changeStaging}
                    onInvite={canInvite ? openInvitation : undefined}
                    onMentionStart={loadMembers}
                    onEdit={editMessage}
                    onAnnounce={setAnnouncement}
                    mentionRef={startMention}
                    insertRef={insertInComposer}
                  />
                )}
              </>
            )}
          </section>

          {!narrow && !focusedDocs && membersOpen && activeRoomId !== null ? (
            <EspaceSidebarResizer
              testId="espace-sidebar-secondary-resizer"
              ariaLabel={t('console.workspace.layout.resize-side-panel')}
              value={rightSidebarWidth}
              min={220}
              max={560}
              defaultWidth={280}
              direction="right"
              onMouseDown={startRightSidebarResize}
              onChangeWidth={setRightSidebarWidth}
              className="row-span-3 row-start-1 w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
            />
          ) : null}

          {!focusedDocs && membersOpen && activeRoomId !== null ? (
            <EspaceMembersPanel
              id={membersPanelId}
              narrow={narrow}
              width={rightSidebarWidth}
              simulation={simulation}
              demoRosterLabel={demoCopy.roster}
              demoPresenceLabel={demoCopy.presence}
              profileCopy={profileCopy}
              roster={roster}
              memberProfile={memberProfile}
              viewerId={viewerId}
              canWrite={canWrite}
              navigationUnsettled={navigationUnsettled}
              onMention={mentionMember}
              onClose={closeMembers}
            />
          ) : null}
          {threadRootMessage !== undefined &&
          activeChannel !== null &&
          activeChannel !== undefined ? (
            <EspaceThreadPane
              activeStore={activeStore}
              activeRoomId={activeRoomId}
              directRoomId={directRoomId}
              activeChannelName={activeChannelName}
              threadRootMessage={threadRootMessage}
              activeThreadReplies={activeThreadReplies}
              openThreadRootId={openThreadRootId}
              draft={draft}
              draftGeneration={draftContext.generation}
              viewerId={viewerId}
              isArchivedChannel={isArchivedChannel}
              canWrite={canWrite}
              canReact={canReact}
              simulation={simulation}
              demoPresenceLabel={demoCopy.presence}
              navigationUnsettled={navigationUnsettled}
              threadInputId={threadInputId}
              demoGuidanceId={demoGuidanceId}
              mentionCandidates={mentionCandidates}
              mentionMembers={mentionMembers}
              resolveMember={resolveMember}
              onMention={!canWrite || navigationUnsettled ? undefined : mentionMember}
              onLoadMembers={loadMembers}
              onClose={() => draft.update({ threadRoot: null })}
              returnFocusTo={threadFocusTarget}
              rowActions={rowActions}
            />
          ) : null}

          {narrow && uiMode !== 'messages' ? null : sidebar}

          <VoiceCallDock
            call={activeCall}
            channel={callChannel}
            store={activeStore}
            viewerId={viewerId}
            deviceSettings={deviceSettings}
            meterRef={micActivity.meterRef}
            panelMeterRef={micActivity.panelMeterRef}
            placement={callPlacement}
            narrow={narrow}
            sidebarWidth={leftSidebarWidth}
            fullStage={fullStage}
            onToggleFullStage={() => setFullStage((value) => !value)}
            onOpenStage={openCallStage}
            onDetach={detachCall}
            onRedock={redockCall}
            className={
              narrow
                ? ''
                : callPlacement === 'sidebar'
                  ? 'col-start-1 row-start-3'
                  : callPlacement === 'stage'
                    ? fullStage && inLiveCall
                      ? 'col-start-3 row-span-3 row-start-1'
                      : 'col-start-3 row-start-1'
                    : ''
            }
          />
        </div>
      </div>
    </PassportContext.Provider>
  )
})
