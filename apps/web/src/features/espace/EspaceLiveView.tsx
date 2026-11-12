// Espace's live view: one organisation's channels, the channel shown with its messages, its
// composer and its members, an open thread, and the audio room the member is in. This module is
// the view's owner: it decides which channel and which room are shown, holds the lease on the
// member's drafts, and hands each part what it needs. The parts draw themselves, each from its
// own slice of the store, of the call or of the draft, so each is drawn again only for what it
// reads: `ChannelSidebar`, `MessageTimeline` and its `MessageRow`s, `MessageComposer`,
// `VoiceCallDock`. What they share lives in `liveViewModel.ts`.

import { demoMessages } from '../../app/demoMessages'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { StudioNavigation } from '../workspace/StudioNavigation'
import {
  Fragment,
  memo,
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
import { getMatrixRegistrationStamp, type MatrixSession } from '../../auth/matrix'
import {
  useEspaceDraftMemory,
  type ChannelDraft,
  type DraftLease,
  type RoomTarget,
} from './EspaceDraftProvider'
import { Button } from '../../ui/Button/Button'
import { Drawer } from '../../ui/Drawer/Drawer'
import { Avatar } from '../../ui/Avatar/Avatar'
import { ChannelInviteDialog } from './ChannelInviteDialog'
import { useLocalProfile } from '../profile/localProfile'
import { UserProfilePopover, type MemberProfile } from '../profile/UserProfilePopover'
import { profileMessages } from '../profile/profileMessages'
import {
  getWorkspaceSettingsEpoch,
  registerWorkspaceSettingsRuntime,
} from '../workspace/settingsRuntime'
import { PersonIcon } from '../../ui/icons/Person'
import { CloseIcon } from '../../ui/icons/Close'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { ThreadPanel } from '../../ui/ThreadPanel/ThreadPanel'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { withdrawn } from '../workspace/ChannelSearch'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { OrganisationHeader } from '../workspace/OrganisationHeader'
import { categoryLabel, channelLabel, currentChannel } from '../workspace/workspace'
import type { Workspace, WorkspaceCategory, WorkspaceChannel } from '../workspace/workspace'
import { createCallController, type CallSnapshot } from './audio/call'
import { createEspaceStore, HEADER_FACES, type MemberView, type RoomSummary } from './matrix/store'
import { serverNameOf } from './homeserver'
import { LeaveCallGuard } from './LeaveCallGuard'
import { useTimelineScroll } from './useTimelineScroll'
import type { MentionCandidate } from './mentions'
import { useMarkRead } from './useMarkRead'
import { useTabTitle } from './useTabTitle'
import { useMicActivity } from './useMicActivity'
import type { AudioSettingsCall } from './AudioSettings'
import { channelAfter, channelMove } from './shortcuts'
import { keepFocusOnRouteTo, releaseRouteFocus } from '../../app/routeFocusHold'
import { soundEngine } from '../sounds/SoundEngine'
import type { MessageView } from './matrix/timeline'
import { AntennaIcon } from './AntennaIcon'
import { ChannelSidebar } from './ChannelSidebar'
import { createLocalDrafts, useDraftChannel, useDraftSlice } from './draftChannel'
import {
  composing,
  displayNameOf,
  isProximityChannel,
  LIVE_CALL,
  NO_MESSAGES,
  noCallSnapshot,
  profileRoleIn,
  readyChannelIds,
  roomForChannel,
  roomResolved,
  roomRowId,
  subscribeToNoCall,
  type AudioCallLike,
  type CallChannel,
  type EspaceStoreLike,
  type TimelineInsert,
} from './liveViewModel'
import { inRoom, MessageComposer, ThreadComposer } from './MessageComposer'
import { MessageRow, type MessageRowActions } from './MessageRow'
import { MessageSearch } from './MessageSearch'
import { MessageTimeline, type MessageTimelineHandle } from './MessageTimeline'
import { PinnedMessages } from './PinnedMessages'
import { useStableHandler, useStoreSlice } from './useStoreSlice'
import { VoiceCallDock } from './VoiceCallDock'
import { cssProperty } from '../../ui/cssom'

// The view's public names stay this module's, wherever their definitions live.
export { isProximityChannel, mergeTimelineInserts } from './liveViewModel'
export type { AudioCallLike, EspaceStoreLike, TimelineInsert } from './liveViewModel'

const NO_CANDIDATES: readonly MentionCandidate[] = []
const NO_DOCUMENTS: readonly ChannelDoc[] = []
const NO_INSERTS: readonly TimelineInsert[] = []

/** The member's own microphone is on, in a call that is through. */
const microphoneOn = (call: CallSnapshot) =>
  call.status === 'connected' && !call.muted && call.muting !== true && !call.listenOnly
const callIsLive = (call: CallSnapshot) => LIVE_CALL.has(call.status)

/** The call, when it can choose the member's devices: what « Réglages audio » drives. */
function deviceSettingsOf(call: AudioCallLike): AudioSettingsCall | null {
  const { getDeviceChoice, chooseInput, chooseOutput } = call
  if (getDeviceChoice === undefined || chooseInput === undefined || chooseOutput === undefined)
    return null
  return {
    getDeviceChoice,
    chooseInput: (input) => chooseInput.call(call, input),
    chooseOutput: (output) => chooseOutput.call(call, output),
  }
}

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
  onNavigateChannel?: (channelId: string) => void | Promise<void>
  /** Whether the router is between two addresses: nothing is sent until it has settled. */
  navigationPending?: boolean
  onReconnect?: () => void
  readonly defaultMembersOpen?: boolean | undefined
  readonly focusedDocs?: boolean | undefined
  readonly activeCanvasMode?: 'chat' | 'docs' | undefined
  readonly onChangeCanvasMode?: ((mode: 'chat' | 'docs') => void) | undefined
  readonly documents?: readonly ChannelDoc[]
  readonly onOpenDocument?: ((doc: ChannelDoc) => void) | undefined
  readonly docsCanvasSlot?: ReactNode | undefined
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

/**
 * The view's own store, for one session. A stopped store never syncs again, and in development
 * React mounts, unmounts and remounts the view's effects: the unmount stops the store, so the
 * remount asks for `live()` and gets a new one, which the view then reads. A store syncs only once
 * started, so one built and never started is inert.
 */
class OwnedStoreSlot {
  #store: EspaceStoreLike
  readonly #make: () => EspaceStoreLike
  readonly #listeners = new Set<() => void>()

  constructor(make: () => EspaceStoreLike) {
    this.#make = make
    this.#store = make()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): EspaceStoreLike => this.#store

  /** The store to start: the current one, or a new one in place of a stopped one. */
  live(): EspaceStoreLike {
    if (this.#store.getSnapshot().status === 'stopped') {
      this.#store = this.#make()
      for (const listener of this.#listeners) listener()
    }
    return this.#store
  }
}
const subscribeToNoSlot = () => () => undefined
const noSlotStore = () => null

/** A message the member acts on, in the room it was shown in: never another room's. */
interface ThreadOpener extends RoomTarget {
  store: EspaceStoreLike
  generation: number
  viewerId: string
  element: HTMLButtonElement
}

const subscribeToNoDraft = () => () => undefined
const noDraftSnapshot = () => 0

/** A view-local external store: only committed lifecycle work publishes values. */
function createCommittedValue<T>(initial: T) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit(next: T) {
      if (Object.is(current, next)) return
      current = next
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try {
          listener()
        } catch {
          /* A removed/throwing observer cannot skip another. */
        }
      }
    },
  }
}

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
  return <MountedEspaceLiveView key={registration.generation} {...props} />
}

/**
 * The view itself. Memoised: the outer view follows every change of the draft memory, a keystroke
 * included, to decide whether it may still be shown; this one is drawn again only for what it
 * reads.
 */
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
  defaultMembersOpen = false,
  focusedDocs = false,
  activeCanvasMode = 'chat',
  onChangeCanvasMode,
  docsCanvasSlot,
  documents = NO_DOCUMENTS,
  onOpenDocument,
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
  const simulation = injectedStore?.simulation === true
  const demoGuidanceId = useId()
  const composerInputId = useId()
  /** « Mentionner »: writes « @ » in the channel's composer and opens its member list. */
  const startMention = useRef<() => void>(null)
  const insertInComposer = useRef<(text: string) => void>(null)
  const threadInputId = useId()
  const sidebarHeadingId = useId()
  const narrow = useNarrowViewport()
  const headingRef = useRef<HTMLHeadingElement>(null)
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
  /** On a phone, the chooser gives way to what was chosen, and the heading takes the focus. */
  const leaveChannelChooser = useStableHandler(() => {
    if (!narrow) return
    channelChooserReturnFocus.current = headingRef.current
    setChannelsOpen(false)
  })
  // The Console always mounts the view under its router; a view rendered on its own has no
  // navigation to guard. Outside one, the hook gives `null`, whatever its type says.
  const inRouter = Boolean(useRouter({ warn: false }) as AnyRouter | null)

  const ownedSlot = useMemo<OwnedStoreSlot | null>(() => {
    if (injectedStore !== undefined) return null
    if (session === undefined) return null
    return new OwnedStoreSlot(() =>
      createEspaceStore({
        baseUrl: session.baseUrl,
        userId: session.userId,
        deviceId: session.deviceId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        refresh: session.refresh,
      })
    )
  }, [injectedStore, session])
  const ownedStore = useSyncExternalStore(
    ownedSlot?.subscribe ?? subscribeToNoSlot,
    ownedSlot?.getSnapshot ?? noSlotStore
  )

  useEffect(() => {
    if (ownedSlot === null) return
    const store = ownedSlot.live()
    void store.start?.()?.catch(() => undefined)
    return () => {
      store.stop?.()
    }
  }, [ownedSlot])

  const resolvedStore = injectedStore ?? ownedStore
  if (resolvedStore === null) {
    throw new Error('EspaceLiveView requires either a store or a MatrixSession')
  }
  const activeStore: EspaceStoreLike = resolvedStore
  const settingsEpoch = useMemo(() => {
    void activeStore
    return getWorkspaceSettingsEpoch()
  }, [activeStore])

  const snapshot = useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot)
  useTabTitle(snapshot.rooms)

  // The store asks the directory; the view only says which channels it shows.
  const readyChannels = readyChannelIds(workspace).join(' ')
  useEffect(() => {
    void activeStore.resolveChannels?.(readyChannels === '' ? [] : readyChannels.split(' '))
  }, [activeStore, readyChannels])

  // One call per view, on the homeserver the session names, with the store's own token.
  const ownedCall = useMemo<AudioCallLike | null>(() => {
    if (injectedCall !== undefined || activeStore.audioCall !== undefined || session === undefined)
      return null
    const { accessToken, renewAccessToken } = activeStore
    if (accessToken === undefined || renewAccessToken === undefined) return null
    return createCallController({
      homeserver: session.baseUrl,
      // Signed in as `@{sub}:{server name}` (`src/auth/matrix.ts`); an ID without one fails closed.
      serverName: serverNameOf(session.userId) ?? '',
      tokens: { current: accessToken, renew: renewAccessToken },
    })
  }, [injectedCall, session, activeStore])

  useEffect(() => {
    if (ownedCall === null) return
    // Leaving, not disposing: React mounts, unmounts and remounts an effect in development.
    return () => {
      void ownedCall.leave()
    }
  }, [ownedCall])

  const activeCall = injectedCall ?? activeStore.audioCall ?? ownedCall
  useEffect(() => {
    if (!activeStore.audioCall) return
    const call = activeStore.audioCall
    return () => {
      void call.leave()
    }
  }, [activeStore])
  // The view reads two facts of the call, and is drawn again only when one of them changes: the
  // dock and the room the member is in read the rest themselves (who is speaking, most of all).
  const subscribeToCall = activeCall?.subscribe ?? subscribeToNoCall
  const getCallSnapshot = activeCall?.getSnapshot ?? noCallSnapshot
  // The member's own microphone, read only while it is on in a call that is through.
  const micActivity = useMicActivity(
    activeCall?.micLevel,
    useStoreSlice(subscribeToCall, getCallSnapshot, microphoneOn)
  )
  const inLiveCall = useStoreSlice(subscribeToCall, getCallSnapshot, callIsLive)
  const deviceSettings = useMemo(
    () => (activeCall === null ? null : deviceSettingsOf(activeCall)),
    [activeCall]
  )

  // A member signed out of the workspace's homeserver is no longer in its calls either.
  const signedOut = snapshot.status === 'signed-out'
  useEffect(() => {
    if (signedOut && activeCall !== null) void activeCall.leave()
  }, [signedOut, activeCall])

  const initialChannel = currentChannel(workspace, channelId)
  const addressedChannel = channelId ?? initialChannel?.id
  // With a router, the channel shown is the one the committed address names, never the one a
  // click asked for: a navigation given up on the way (Back before it commits) shows nothing else.
  // Without one, a click chooses in place, until the address changes.
  const [clickedChannelId, setClickedChannelId] = useState<string | null>(null)
  // The channel a click asked the router for, until its navigation settles.
  const [requestedChannelId, setRequestedChannelId] = useState<string | null>(null)
  const [addressedChannelId, setAddressedChannelId] = useState(channelId)
  if (addressedChannelId !== channelId) {
    setAddressedChannelId(channelId)
    setClickedChannelId(null)
    setRequestedChannelId(null)
  }
  const [wasPending, setWasPending] = useState(navigationPending)
  if (wasPending !== navigationPending) {
    setWasPending(navigationPending)
    if (!navigationPending) setRequestedChannelId(null)
  }
  const selectedChannelId =
    (onNavigateChannel === undefined ? clickedChannelId : null) ?? addressedChannel
  // Between two addresses, the channel the member means is not known: nothing is sent.
  const navigationUnsettled =
    navigationPending || (requestedChannelId !== null && requestedChannelId !== addressedChannel)

  const activeChannel = useMemo(
    () => currentChannel(workspace, selectedChannelId),
    [workspace, selectedChannelId]
  )
  const activeRoom = useMemo(
    () =>
      activeChannel !== null && activeChannel !== undefined
        ? roomForChannel(activeChannel, snapshot.channels, snapshot.rooms)
        : undefined,
    [activeChannel, snapshot.channels, snapshot.rooms]
  )
  // No room, no messages and nowhere to send them: never a channel id taken for a room id.
  const activeRoomId = activeRoom?.roomId ?? null
  /** « 18 membres »: a text channel's people (`RoomSummary.joined`). */
  const memberCount =
    activeRoom?.joined === undefined
      ? null
      : t('console.workspace.channel.members-count', { count: activeRoom.joined })
  /** Under the channel's name: its topic, then its member count (p02 « topic · 18 membres »). */
  const headerLine = [
    ...(activeChannel !== null && activeChannel !== undefined && activeChannel.topic !== ''
      ? [{ key: 'topic', text: activeChannel.topic }]
      : []),
    ...(memberCount === null ? [] : [{ key: 'members', text: memberCount }]),
  ]
  /** Beside it, a few of those members' faces, drawn only with the count they illustrate. */
  const faces = activeRoom?.faces ?? []
  // The first sync lazy-loads only the people who wrote lately: when the header shows fewer faces
  // than the people it counts, the room's member list is asked for, once, to fill them in.
  const facesMissing =
    activeRoom?.joined !== undefined && faces.length < Math.min(HEADER_FACES, activeRoom.joined - 1)
  useEffect(() => {
    if (activeRoomId !== null && facesMissing) activeStore.loadMembers?.(activeRoomId)
  }, [activeStore, activeRoomId, facesMissing])
  const [membersOpen, setMembersOpen] = useState<boolean>(defaultMembersOpen)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(256)
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(280)
  const membersPanelId = useId()
  const membersTrigger = useRef<HTMLButtonElement>(null)
  function closeMembers() {
    setMembersOpen(false)
    membersTrigger.current?.focus()
  }
  function startLeftSidebarResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = leftSidebarWidth
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const delta = moveEvent.clientX - startX
      setLeftSidebarWidth(Math.max(180, Math.min(420, startWidth + delta)))
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }
  function startRightSidebarResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = rightSidebarWidth
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const delta = startX - moveEvent.clientX
      setRightSidebarWidth(Math.max(220, Math.min(560, startWidth + delta)))
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }
  const viewerId = activeStore.getUserId()
  const { profile: localProfile, hasProfile } = useLocalProfile(viewerId)
  const profileCopy = profileMessages(i18n.resolvedLanguage)
  const roomMembers = useMemo(() => {
    void snapshot
    return activeRoomId === null ? undefined : activeStore.getMembers?.(activeRoomId)
  }, [activeRoomId, activeStore, snapshot])
  const rawRoster = useMemo(() => {
    void snapshot
    return activeRoomId === null ? [] : (activeStore.getRoster?.(activeRoomId) ?? roomMembers ?? [])
  }, [activeRoomId, activeStore, roomMembers, snapshot])
  const roster =
    rawRoster.some((member) => member.userId === viewerId) || !hasProfile
      ? rawRoster
      : [
          ...rawRoster,
          { userId: viewerId, name: localProfile.displayName || displayNameOf(viewerId) },
        ]
  function memberProfile(member: MemberView): MemberProfile {
    return {
      userId: member.userId,
      name:
        member.userId === viewerId && localProfile.displayName
          ? localProfile.displayName
          : (member.name ?? displayNameOf(member.userId)),
      presence:
        member.userId === viewerId && hasProfile
          ? localProfile.presence
          : activeStore.isOnline?.(member.userId)
            ? 'online'
            : 'offline',
      role: profileRoleIn(activeStore, activeRoomId, member.userId),
      ...(member.userId === viewerId ? { status: localProfile.status } : {}),
    }
  }
  useEffect(
    () =>
      registerWorkspaceSettingsRuntime(
        {
          org,
          userId: viewerId,
          displayName:
            localProfile.displayName ||
            roomMembers?.find((member) => member.userId === viewerId)?.name ||
            displayNameOf(viewerId),
          members: [
            ...rawRoster.filter((member) => member.userId !== viewerId),
            {
              userId: viewerId,
              name:
                localProfile.displayName ||
                rawRoster.find((member) => member.userId === viewerId)?.name ||
                displayNameOf(viewerId),
            },
          ],
          call: deviceSettings,
          invite:
            activeRoomId !== null && activeStore.inviteToRoom
              ? (userId) => activeStore.inviteToRoom!(activeRoomId, userId)
              : undefined,
          memberRole: (userId) =>
            activeRoomId === null
              ? 'member'
              : (activeStore.getMemberRole?.(activeRoomId, userId) ?? 'member'),
        },
        settingsEpoch
      ),
    [
      org,
      viewerId,
      localProfile.displayName,
      roomMembers,
      rawRoster,
      settingsEpoch,
      deviceSettings,
      activeRoomId,
      activeStore,
    ]
  )
  useEffect(() => {
    if (membersOpen && activeRoomId !== null) activeStore.loadMembers?.(activeRoomId)
  }, [membersOpen, activeRoomId, activeStore])
  // Leaving the room, or the view, says the member no longer types there.
  useEffect(() => {
    if (activeRoomId === null) return
    return () => activeStore.setTyping?.(activeRoomId, false)
  }, [activeStore, activeRoomId])
  const mentionCandidates = useMemo(
    () =>
      roomMembers?.map(({ userId, name }) => ({ userId, label: name ?? displayNameOf(userId) })) ??
      NO_CANDIDATES,
    [roomMembers]
  )

  // The memory's epoch: a new one is a new lease to ask for. Read here, since the outer view's
  // own reading of the memory no longer draws this one.
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
  // Another store is another session, perhaps another member's: it starts with no draft.
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
  // A draft belongs to the room it was typed for and to the member who typed it.
  const draftKey = activeRoomId === null ? null : `${viewerId}\n${activeRoomId}`
  // What the member has started in the channel shown. The view reads one slice of it, the open
  // thread; the composer and the thread's field read their own text (`MessageComposer`), so a
  // keystroke draws neither this view nor the message log.
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

  // Read only at explicit close. ThreadPanel calls onClose before reading this
  // target; the following commit retires the record after that focus handoff.
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

  /** Opens a message's thread; a reply typed under another thread is not carried to it. */
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
  // Where the member had read up to when this room opened. Noted before `useMarkRead` moves the
  // marker (it runs after this draw), and kept for the visit: « Nouveaux messages » stays where it
  // was while the member reads, instead of vanishing as soon as the room is marked read. Noted
  // only for a room that counted something unread: in a room already read, a message that
  // arrives while the member is on it is not one they missed.
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
  // Resolved on every draw, so a marker older than the loaded messages is found once older
  // messages bring it in. A walk over the loaded events: about a millisecond for 500 messages.
  const unreadFrom =
    activeRoomId === null || readAtOpen.eventId === null
      ? null
      : (activeStore.firstShownAfter?.(activeRoomId, readAtOpen.eventId) ?? null)
  useMarkRead({ room: activeRoom, newestKey: timeline.at(-1)?.key, store: activeStore })

  const liveMentionTracker = useRef<{
    store: EspaceStoreLike
    roomId: string | null
    primed: boolean
    seenKeys: Set<string>
    lastTailKey: string | null
  } | null>(null)
  const activeChannelId = activeChannel?.id
  useEffect(() => {
    if (activeRoomId === null || activeChannelId === undefined) {
      liveMentionTracker.current = {
        store: activeStore,
        roomId: null,
        primed: false,
        seenKeys: new Set(),
        lastTailKey: null,
      }
      return
    }
    const current = liveMentionTracker.current
    if (current === null || current.store !== activeStore || current.roomId !== activeRoomId) {
      liveMentionTracker.current = {
        store: activeStore,
        roomId: activeRoomId,
        primed: snapshot.status === 'live',
        seenKeys: new Set(timeline.map((msg) => msg.key)),
        lastTailKey: timeline.at(-1)?.key ?? null,
      }
      return
    }
    if (!current.primed) {
      for (const msg of timeline) current.seenKeys.add(msg.key)
      current.lastTailKey = timeline.at(-1)?.key ?? null
      if (snapshot.status === 'live') current.primed = true
      return
    }
    if (snapshot.status !== 'live') return

    const prevTailIndex =
      current.lastTailKey === null
        ? -1
        : timeline.findIndex((msg) => msg.key === current.lastTailKey)
    const candidates =
      prevTailIndex >= 0
        ? timeline.slice(prevTailIndex + 1)
        : history === 'loading'
          ? NO_MESSAGES
          : timeline

    for (const msg of candidates) {
      if (current.seenKeys.has(msg.key)) continue
      if (!msg.redacted && msg.mentionsMe === true && msg.sender !== viewerId) {
        void soundEngine.play('msg_mention', {
          channelId: activeChannelId,
          senderId: msg.sender,
          currentUserId: viewerId,
        })
      }
    }
    for (const msg of timeline) current.seenKeys.add(msg.key)
    current.lastTailKey = timeline.at(-1)?.key ?? null
  }, [activeStore, activeRoomId, activeChannelId, snapshot.status, timeline, history, viewerId])

  /** `keepFocus`: the new address leaves the focus where it is (`RouteFocus`), as a click does not. */
  const selectTextChannel = useStableHandler((nextChannelId: string, keepFocus = false) => {
    closeChannelChooser()
    if (onNavigateChannel === undefined) {
      setClickedChannelId(nextChannelId)
      return
    }
    setRequestedChannelId(nextChannelId)
    const path = `/${encodeURIComponent(org)}/workspace/${encodeURIComponent(nextChannelId)}`
    if (keepFocus) keepFocusOnRouteTo(path)
    const settled = () => {
      setRequestedChannelId((current) => (current === nextChannelId ? null : current))
      // Once the navigation is over, the address it reached has been drawn, and one it never
      // reached (superseded, refused) holds nothing. A task later, after that draw.
      if (keepFocus) setTimeout(() => releaseRouteFocus(path), 0)
    }
    void Promise.resolve(onNavigateChannel(nextChannelId)).then(settled, settled)
  })

  const joinAudioRoom = useStableHandler(
    (
      channel: WorkspaceChannel,
      room: RoomSummary | undefined,
      categoryName: string | undefined
    ) => {
      if (activeCall === null || room === undefined) return
      closeChannelChooser()
      setCallChannel({
        channelId: channel.id,
        roomId: room.roomId,
        roomName: channelLabel(channel, t),
        categoryName,
      })
      // Called from the click: the call unlocks audio playback while the gesture still counts.
      void activeCall.join(room.roomId)
    }
  )

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
  const canInvite =
    activeRoom !== undefined && activeChannel != null && !focusedDocs && !navigationUnsettled
  const openInvitation = useCallback(() => inviteTrigger.current?.click(), [])

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

  // A text channel opens, and focus goes to its heading. An audio room is not joined: focus goes
  // to its row, whose own action joins it — unless its category is folded away or the room cannot
  // be joined yet, when the search keeps focus.
  const openFromSearch = useStableHandler((entry: ChannelSearchEntry): HTMLElement | null => {
    if (entry.kind === 'text') {
      selectTextChannel(entry.id)
      return headingRef.current
    }
    // A room that cannot be joined yet draws a disabled row, which cannot take focus either.
    const row = document.getElementById(roomRowId(sidebarHeadingId, entry.id))
    return row instanceof HTMLButtonElement && !row.disabled && row.closest('[hidden]') === null
      ? row
      : null
  })
  const openDocument = useStableHandler((doc: ChannelDoc) => {
    onOpenDocument?.(doc)
    requestAnimationFrame(() => headingRef.current?.focus())
    leaveChannelChooser()
    return headingRef.current
  })
  const openStudioDocument = onOpenDocument ? openDocument : undefined
  const openStudioChannel = useStableHandler((entry: ChannelSearchEntry) => {
    if (entry.kind === 'text') onChangeCanvasMode?.('chat')
    return openFromSearch(entry)
  })
  const switchCanvas = useStableHandler((mode: 'chat' | 'docs') => {
    onChangeCanvasMode?.(mode)
    leaveChannelChooser()
  })
  const createInCategory = useStableHandler((category: WorkspaceCategory) => {
    closeChannelChooser()
    onCreateInCategory?.(category)
  })

  // What a message's controls do. Each keeps its identity, and acts on the room shown when it is
  // used: a message is not drawn again because the view was.
  const retryMessage = useStableHandler((msg: MessageView) => {
    if (activeRoomId === null) return
    draft.command(() => {
      if (activeStore.resend !== undefined) void activeStore.resend(activeRoomId, msg.key)
      else void activeStore.send(activeRoomId, msg.body)
    })
  })

  const reactToMessage = useStableHandler((eventId: string, reaction: string) => {
    if (activeRoomId !== null)
      draft.command(() => {
        void activeStore.toggleReaction(activeRoomId, eventId, reaction)
      })
  })

  const replyToMessage = useStableHandler((msg: MessageView) => {
    const replyTo = targetInShownRoom(msg.eventId)
    draft.update((previous) => ({
      editing: null,
      replyTo,
      ...(previous.editing === null ? {} : { text: '' }),
    }))
  })

  const editMessage = useStableHandler((msg: MessageView) => {
    // The new message being written gives way to the edit, which the room is not told about.
    if (activeRoomId !== null) activeStore.setTyping?.(activeRoomId, false)
    draft.update({ replyTo: null, editing: targetInShownRoom(msg.eventId), text: msg.body })
  })

  const removeMessage = useStableHandler((eventId: string) => {
    if (activeRoomId !== null)
      draft.command(() => {
        void activeStore.remove(activeRoomId, eventId)
      })
  })

  // The log's handle: pinned messages and search results bring a message into sight through it.
  const timelineHandle = useRef<MessageTimelineHandle>(null)
  const showMessage = useStableHandler(
    (eventId: string): boolean => timelineHandle.current?.showMessage(eventId) ?? false
  )
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

  const activeChannelName =
    activeChannel !== null && activeChannel !== undefined ? channelLabel(activeChannel, t) : ''
  const isArchivedChannel = activeChannel?.lifecycle === 'archived'
  const canWrite = !isArchivedChannel && activeRoomId !== null
  // In place of the composer, why the member cannot write here; nothing while the sync starts.
  const paneNotice = isArchivedChannel
    ? t('console.workspace.channel.label-archived')
    : canWrite || activeChannel === null || activeChannel === undefined
      ? undefined
      : !roomResolved(activeChannel, snapshot.channels)
        ? t('console.workspace.channel.label-preparing')
        : snapshot.status === 'live'
          ? t('console.workspace.channel.label-arriving')
          : undefined
  // Keyboard shortcuts (spec « Keyboard shortcuts »). What a shortcut did is said here, politely:
  // the focus stays where the member had it. Counted, so the same words twice are said twice.
  const [announcement, setAnnouncementState] = useState({ count: 0, text: '' })
  const setAnnouncement = useCallback(
    (text: string) => setAnnouncementState((current) => ({ count: current.count + 1, text })),
    []
  )
  const channelColumn = useRef<HTMLElement>(null)
  // A key moved the channel. The focus stays where it was, but a channel with no composer (archived,
  // still being prepared) takes the composer away: the focus would fall to the page, with
  // `RouteFocus` held from rescuing it, so the channel's heading takes it instead.
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
  // Read at the key press, so the listener is not added again on every render.
  const onChannelKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const move = channelMove(event)
    if (move === null || event.defaultPrevented || withdrawn(channelColumn.current)) return
    // From the thread panel or a popover (the reaction or emoji palette), the channel's change
    // would take away the very thing the focus is in: the key is theirs.
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
    // From the channel already asked for, while the address has not caught up: two quick presses
    // go two channels on.
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

  /** `Escape` in the channel's column: the edit, else the reply, else the unread, given up. */
  function columnKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || composing(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    // Read at the key press: what the member types does not draw this view again.
    const current = draft.read()
    if (current.editing !== null) {
      event.preventDefault()
      draft.update({ editing: null, text: '' })
      return
    }
    // A reply is under way only while its banner shows: to a loaded message of this room.
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

  // Leaving the view ends the call, so leaving it asks first. Not while signed out: the call is
  // already left then, and « Se reconnecter » leaves the page on purpose.
  const guardCall = inLiveCall && !signedOut

  const sidebar = (
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
      canvasMode={activeCanvasMode ?? 'chat'}
      categoryDescriptions={categoryDescriptions}
      proximityChannelIds={proximityChannelIds}
      documents={documents}
      searchEntries={searchEntries}
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
      onChangeCanvasMode={onChangeCanvasMode}
      onSwitchCanvas={onChangeCanvasMode ? switchCanvas : undefined}
      onSelectTextChannel={selectTextChannel}
      onJoinAudioRoom={joinAudioRoom}
      onCreateInCategory={onCreateInCategory === undefined ? undefined : createInCategory}
      onChannelContextMenu={onChannelContextMenu}
    />
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="studio-workspace">
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        {narrow ? (
          <div className="order-first flex shrink-0 flex-col gap-3 border-b border-c-border-soft pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <OrganisationHeader name={organisationName} slug={org} />
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
        {narrow ? null : (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            data-testid="espace-sidebar-primary-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('console.workspace.layout.resize-channels')}
            aria-valuenow={leftSidebarWidth}
            aria-valuemin={180}
            aria-valuemax={420}
            // A focusable splitter (role="separator" with a value) is interactive in WAI-ARIA.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onMouseDown={startLeftSidebarResize}
            onDoubleClick={() => setLeftSidebarWidth(256)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                setLeftSidebarWidth((w) => Math.max(180, w - 16))
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                setLeftSidebarWidth((w) => Math.min(420, w + 16))
              }
            }}
            className="w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
          />
        )}
        {/* `Escape` from anything in the column that did not use it (spec « Keyboard shortcuts »). */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <section
          ref={channelColumn}
          onKeyDown={columnKeyDown}
          className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-c-surface px-6 py-5 narrow:overflow-visible narrow:bg-transparent narrow:p-0"
        >
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement.count === 0 ? null : (
              <span key={announcement.count}>{announcement.text}</span>
            )}
          </p>
          <header className="flex items-center gap-3 border-b border-c-border-soft pb-4 narrow:flex-wrap">
            <div className="flex min-w-0 flex-1 flex-col gap-1 narrow:basis-full">
              {activeChannel === null || activeChannel === undefined ? (
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  data-route-heading=""
                  className="text-lg font-semibold text-c-ink"
                >
                  {t(
                    activeChannel === null
                      ? 'console.workspace.channel.title-not-found'
                      : 'console.workspace._.title'
                  )}
                </h1>
              ) : (
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  data-route-heading=""
                  className="flex min-w-0 items-center gap-2 text-lg font-semibold text-c-ink"
                >
                  <span aria-hidden="true" className="text-c-ink-3">
                    {isProximityChannel(activeChannel, proximityChannelIds) ? <AntennaIcon /> : '#'}
                  </span>
                  <span className="min-w-0 truncate">{activeChannelName}</span>
                </h1>
              )}
              {headerLine.length > 0 ? (
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 text-sm text-c-ink-3">
                    {headerLine.map((part, index) => (
                      <Fragment key={part.key}>
                        {index > 0 ? (
                          <>
                            {' '}
                            <span aria-hidden="true">·</span>{' '}
                          </>
                        ) : null}
                        <span>{part.text}</span>
                      </Fragment>
                    ))}
                  </p>
                  {/* Reference screen p02: who is here, at a glance, beside the count that says it
                    in words, so the faces are not read. Someone with no name gets a person
                    glyph, never a character of their id. */}
                  {memberCount !== null && faces.length > 0 ? (
                    <span className="flex shrink-0 gap-1 narrow:hidden">
                      {faces.map((face) => (
                        <Avatar
                          key={face.userId}
                          name={face.name ?? displayNameOf(face.userId)}
                          identity={face.userId}
                          onlineLabel={
                            activeStore.isOnline?.(face.userId)
                              ? simulation
                                ? demoCopy.presence
                                : t('console.workspace.presence.online')
                              : undefined
                          }
                          anonymous={face.name === undefined}
                          size="xs"
                          className="ring-2 ring-c-surface"
                        />
                      ))}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {activeRoom !== undefined && activeChannel != null && !focusedDocs ? (
              <ChannelInviteDialog
                key={`${org}:${activeRoom.roomId}`}
                triggerRef={inviteTrigger}
                org={org}
                channel={activeChannel}
                room={activeRoom}
                store={activeStore}
                unavailable={navigationUnsettled || signedOut}
              />
            ) : null}
            {activeRoomId === null || focusedDocs || activeCanvasMode === 'docs' ? null : (
              <>
                <MessageSearch store={activeStore} roomId={activeRoomId} onShow={showMessage} />
                <PinnedMessages store={activeStore} roomId={activeRoomId} onShow={showMessage} />
              </>
            )}
            {activeRoomId === null || focusedDocs ? null : (
              <Button
                variant="tertiary"
                size="sm"
                icon={<PersonIcon />}
                iconOnly
                aria-label={t('console.workspace.members.title')}
                ref={membersTrigger}
                aria-controls={membersPanelId}
                aria-expanded={membersOpen}
                onClick={() => setMembersOpen((open) => !open)}
              />
            )}
            <StudioNavigation
              compact={narrow}
              section="call-entry"
              mode={activeCanvasMode ?? 'chat'}
              rooms={audioRooms}
              onChoose={(entry) => {
                if (narrow) {
                  setChannelsOpen(true)
                  return null
                }
                return openFromSearch(entry)
              }}
            />
            {activeCanvasMode === 'docs' ? (
              <span className="text-sm font-bold text-c-ink">
                {t('console.workspace.canvas.mode-docs')}
              </span>
            ) : null}
          </header>

          {snapshot.status === 'signed-out' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <InlineAlert kind="warning">
                {t('console.workspace.message.session-expired')}
              </InlineAlert>
              {onReconnect === undefined ? null : (
                <Button variant="secondary" size="sm" onClick={onReconnect}>
                  {t('console.workspace.message.action-reconnect')}
                </Button>
              )}
            </div>
          ) : null}

          {activeChannel != null && docsCanvasSlot !== undefined ? (
            <div
              hidden={activeCanvasMode !== 'docs'}
              data-testid="espace-inline-docs-canvas"
              className={activeCanvasMode === 'docs' ? 'flex min-h-0 flex-1 flex-col' : ''}
            >
              {docsCanvasSlot}
            </div>
          ) : null}
          {activeChannel == null || activeCanvasMode === 'docs' ? null : (
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
                viewerId={viewerId}
                archived={isArchivedChannel}
                simulation={simulation}
                expandedEventId={openThreadRootId}
                unreadFrom={unreadFrom}
                menuContext={`${draftContext.generation}:${viewerId}:${activeRoomId}`}
                documents={documents}
                onOpenDocument={openStudioDocument}
                inserts={timelineInserts ?? NO_INSERTS}
                onMention={isArchivedChannel || navigationUnsettled ? undefined : mentionMember}
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
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            data-testid="espace-sidebar-secondary-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('console.workspace.layout.resize-side-panel')}
            aria-valuenow={rightSidebarWidth}
            aria-valuemin={220}
            aria-valuemax={560}
            // A focusable splitter (role="separator" with a value) is interactive in WAI-ARIA.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onMouseDown={startRightSidebarResize}
            onDoubleClick={() => setRightSidebarWidth(280)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                setRightSidebarWidth((w) => Math.min(560, w + 16))
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                setRightSidebarWidth((w) => Math.max(220, w - 16))
              }
            }}
            className="w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
          />
        ) : null}

        {!focusedDocs && membersOpen && activeRoomId !== null ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <aside
            id={membersPanelId}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                closeMembers()
              }
            }}
            aria-label={t('console.workspace.members.title')}
            ref={cssProperty('width', narrow ? undefined : `${rightSidebarWidth}px`)}
            className="flex w-shell-sidebar-width shrink-0 flex-col gap-3 overflow-y-auto border-l border-c-border-soft bg-c-sunken p-4 narrow:w-full"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-c-ink">
                {t('console.workspace.members.title')}
              </h2>
              <Button
                variant="tertiary"
                size="sm"
                icon={<CloseIcon />}
                iconOnly
                aria-label={t('console.common.action-close')}
                onClick={closeMembers}
              />
            </div>
            <div
              data-testid="espace-members-presence-summary"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs font-medium text-c-ink-2"
            >
              <span className="text-c-ok-ink">
                {simulation
                  ? demoCopy.roster
                  : t('console.workspace.members.online-count', {
                      count: roster.filter((member) => memberProfile(member).presence !== 'offline')
                        .length,
                    })}
              </span>
              <span className="text-c-ink-3">
                {simulation ? demoCopy.presence : profileCopy.offline} (
                {roster.filter((member) => memberProfile(member).presence === 'offline').length})
              </span>
            </div>
            {(['maintainer', 'core', 'admin', 'partner', 'member', 'offline'] as const).map(
              (group) => {
                const members = roster
                  .map(memberProfile)
                  .filter((member) =>
                    group === 'offline'
                      ? member.presence === 'offline'
                      : member.presence !== 'offline' && member.role === group
                  )
                if (members.length === 0) return null
                const label =
                  group === 'offline'
                    ? profileCopy.offlineGroup
                    : group === 'admin'
                      ? t('console.workspace.members.admins')
                      : profileCopy[group]
                return (
                  <section key={group} aria-label={label} className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold text-c-ink-3">
                      {label} · {members.length}
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {members.map((member) => (
                        <li key={member.userId}>
                          <UserProfilePopover
                            member={member}
                            onMention={
                              isArchivedChannel || navigationUnsettled || member.userId === viewerId
                                ? undefined
                                : mentionMember
                            }
                            trigger={
                              <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
                              >
                                <Avatar
                                  name={member.name}
                                  identity={member.userId}
                                  size="lg"
                                  presenceGround="sunken"
                                  onlineLabel={
                                    member.presence === 'offline'
                                      ? undefined
                                      : member.presence === 'online'
                                        ? simulation
                                          ? demoCopy.presence
                                          : t('console.workspace.presence.online')
                                        : profileCopy[member.presence]
                                  }
                                />
                                <span className="flex min-w-0 flex-1 flex-col gap-1">
                                  <span className="truncate text-sm font-medium text-c-ink-2">
                                    {member.name}
                                  </span>
                                  <span className="truncate text-xs text-c-ink-3">
                                    {member.status || profileCopy[member.presence]}
                                  </span>
                                </span>
                              </button>
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              }
            )}
          </aside>
        ) : null}
        {threadRootMessage !== undefined &&
        activeChannel !== null &&
        activeChannel !== undefined ? (
          <>
            <p className="text-xs text-c-ink-2">{t('console.onboarding.studio.thread-poll')}</p>
            <ThreadPanel
              label={t('console.workspace.thread.title')}
              title={t('console.workspace.thread.title')}
              channel={`# ${activeChannelName}`}
              closeLabel={t('console.common.action-close')}
              onClose={() => draft.update({ threadRoot: null })}
              returnFocusTo={threadFocusTarget}
              parent={
                <MessageRow
                  profileRole={profileRoleIn(activeStore, activeRoomId, threadRootMessage.sender)}
                  onMention={isArchivedChannel || navigationUnsettled ? undefined : mentionMember}
                  key={threadRootMessage.key}
                  onlineLabel={
                    activeStore.isOnline?.(threadRootMessage.sender)
                      ? simulation
                        ? demoCopy.presence
                        : t('console.workspace.presence.online')
                      : undefined
                  }
                  message={threadRootMessage}
                  placement="thread"
                  viewerId={viewerId}
                  archived={isArchivedChannel}
                  expanded={false}
                  repliedMessage={undefined}
                  threadReplies={NO_MESSAGES}
                  menuContextKey={`${draftContext.generation}:${viewerId}:${activeRoomId}:${threadRootMessage.key}`}
                  {...rowActions}
                />
              }
              repliesLabel={t('console.workspace.thread.label-replies')}
              composer={
                isArchivedChannel ||
                activeRoomId === null ||
                openThreadRootId === null ? undefined : (
                  <ThreadComposer
                    store={activeStore}
                    roomId={activeRoomId}
                    rootEventId={openThreadRootId}
                    draft={draft}
                    simulation={simulation}
                    navigationUnsettled={navigationUnsettled}
                    inputId={threadInputId}
                    guidanceId={demoGuidanceId}
                    members={mentionCandidates}
                    onMentionStart={loadMembers}
                  />
                )
              }
            >
              {activeThreadReplies.map((reply) => (
                <MessageRow
                  profileRole={profileRoleIn(activeStore, activeRoomId, reply.sender)}
                  onMention={isArchivedChannel || navigationUnsettled ? undefined : mentionMember}
                  key={reply.key}
                  onlineLabel={
                    activeStore.isOnline?.(reply.sender)
                      ? simulation
                        ? demoCopy.presence
                        : t('console.workspace.presence.online')
                      : undefined
                  }
                  message={reply}
                  placement="thread"
                  viewerId={viewerId}
                  archived={isArchivedChannel}
                  expanded={false}
                  repliedMessage={undefined}
                  threadReplies={NO_MESSAGES}
                  menuContextKey={`${draftContext.generation}:${viewerId}:${activeRoomId}:${reply.key}`}
                  {...rowActions}
                />
              ))}
            </ThreadPanel>
          </>
        ) : null}

        {narrow ? null : sidebar}
      </div>
      <div className="shrink-0">
        <VoiceCallDock
          call={activeCall}
          channel={callChannel}
          store={activeStore}
          viewerId={viewerId}
          deviceSettings={deviceSettings}
          meterRef={micActivity.meterRef}
          panelMeterRef={micActivity.panelMeterRef}
        />
      </div>
    </div>
  )
})
