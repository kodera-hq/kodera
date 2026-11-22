import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { publishRailDirects } from '../../app/railDirectsStore'
import { cleanText } from '../../ui/safeText'
import type { PassportDraft } from '../profile/KoderaPassportModal'
import { squareAvatarPng } from '../profile/avatarImage'
import { useLocalProfile } from '../profile/localProfile'
import { EMPTY_PASSPORT, isPlaceholderName } from '../profile/passport'
import type { PassportServices } from '../profile/passportContext'
import { profileMessages } from '../profile/profileMessages'
import type { MemberProfile } from '../profile/UserProfilePopover'
import {
  registerWorkspaceSettingsRuntime,
  type WorkspaceSettingsProfile,
} from '../workspace/settingsRuntime'
import { channelLabel, type Workspace } from '../workspace/workspace'
import type { AudioSettingsCall } from './AudioSettings'
import {
  displayNameOf,
  isNamedProfile,
  profileRoleIn,
  safeDisplayName,
  type EspaceStoreLike,
} from './liveViewModel'
import type { DirectSummary } from './matrix/directs'
import type { EspaceSnapshot, MemberView } from './matrix/store'
import type { MentionCandidate } from './mentions'
import { useAvatarSrc } from './useAvatarSrc'
import { useStableHandler, useStoreSlice } from './useStoreSlice'

const NO_CANDIDATES: readonly MentionCandidate[] = []
const NO_DIRECTS: readonly DirectSummary[] = []

export interface UseEspacePassportAndProfileOptions {
  org: string
  workspace: Workspace
  activeStore: EspaceStoreLike
  snapshot: EspaceSnapshot
  simulation: boolean
  activeRoomId: string | null
  directRoomId: string | null
  selectDirect: (roomId: string) => void
  accountName: string | undefined
  deviceSettings: AudioSettingsCall | null
  settingsEpoch: number
  membersOpen: boolean
}

export function useEspacePassportAndProfile({
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
}: UseEspacePassportAndProfileOptions) {
  const { t, i18n } = useTranslation()
  const viewerId = activeStore.getUserId()
  const { profile: localProfile, hasProfile } = useLocalProfile(viewerId)

  // The profile the homeserver holds for the member, re-read whenever the sync moves: a name or a
  // picture set on another device arrives here without a request of its own.
  void snapshot
  const ownProfileRead = activeStore.getOwnProfile?.()
  const ownDisplayName = ownProfileRead?.displayName
  const ownAvatarUrl = ownProfileRead?.avatarUrl
  const ownMatrixProfile = useMemo(
    () =>
      ownDisplayName === undefined && ownAvatarUrl === undefined
        ? undefined
        : { displayName: ownDisplayName, avatarUrl: ownAvatarUrl },
    [ownDisplayName, ownAvatarUrl]
  )
  const settingsProfile = useMemo((): WorkspaceSettingsProfile | undefined => {
    const { setProfileDisplayName, setProfileAvatar, clearProfileAvatar, fetchOwnAvatar } =
      activeStore
    if (!setProfileDisplayName || !setProfileAvatar || !clearProfileAvatar || !fetchOwnAvatar) {
      return undefined
    }
    return {
      matrixDisplayName: isNamedProfile(cleanText(ownMatrixProfile?.displayName, 80), viewerId)
        ? cleanText(ownMatrixProfile?.displayName, 80)
        : undefined,
      avatarKey: ownMatrixProfile?.avatarUrl,
      fetchAvatar: (size) => fetchOwnAvatar.call(activeStore, size),
      setDisplayName: (displayName) => setProfileDisplayName.call(activeStore, displayName),
      setAvatar: async (file, filename) => {
        await setProfileAvatar.call(activeStore, file, filename)
      },
      clearAvatar: () => clearProfileAvatar.call(activeStore),
    }
  }, [activeStore, ownMatrixProfile, viewerId])

  const profileCopy = profileMessages(i18n.resolvedLanguage)
  const passportServices = useMemo((): PassportServices | null => {
    if (simulation) return null
    const { openDirect } = activeStore
    return {
      avatars: activeStore.getAvatarCache?.(),
      subscribe: activeStore.subscribe,
      getSnapshot: activeStore.getSnapshot,
      getPassport: activeStore.getPassport?.bind(activeStore),
      sendDirect:
        openDirect === undefined
          ? undefined
          : async (userId: string, text: string) => {
              const roomId = await openDirect.call(activeStore, [userId])
              await activeStore.send(roomId, text)
            },
    }
  }, [activeStore, simulation])

  const railDirectsOf = useCallback(() => activeStore.getDirects?.() ?? NO_DIRECTS, [activeStore])
  const railDirectList = useStoreSlice(
    activeStore.subscribe,
    activeStore.getSnapshot,
    railDirectsOf
  )
  const railAvatars = passportServices?.avatars
  useEffect(() => {
    if (simulation || activeStore.getDirects === undefined) {
      publishRailDirects(null)
      return
    }
    publishRailDirects({
      items: railDirectList.map((item) => ({
        roomId: item.roomId,
        name: item.name,
        userId: item.userIds.length === 1 ? item.userIds[0] : undefined,
        avatarMxc: item.avatarMxc,
        unread: item.unread,
        active: item.roomId === directRoomId,
      })),
      avatars: railAvatars,
      onOpen: selectDirect,
      onOpenAll: () => {
        const heading = document.querySelector<HTMLElement>('[data-directs-section] h3')
        heading?.scrollIntoView({ block: 'nearest' })
        heading?.focus()
      },
    })
  }, [activeStore, simulation, railDirectList, railAvatars, directRoomId, selectDirect])
  useEffect(() => () => publishRailDirects(null), [])

  const ownAvatarSrc = useAvatarSrc(passportServices?.avatars, ownMatrixProfile?.avatarUrl)
  const ownPassport = useStoreSlice(
    activeStore.subscribe,
    activeStore.getSnapshot,
    useCallback(
      () => activeStore.getPassport?.(viewerId) ?? EMPTY_PASSPORT,
      [activeStore, viewerId]
    )
  )
  const [closedPassport, setClosedPassport] = useState<{
    store: EspaceStoreLike
    viewerId: string
  } | null>(null)
  const passportClosed =
    closedPassport?.store === activeStore && closedPassport.viewerId === viewerId
  const passportOffered =
    !simulation &&
    !passportClosed &&
    snapshot.status === 'live' &&
    settingsProfile !== undefined &&
    activeStore.setPassport !== undefined &&
    !ownPassport.onboarded &&
    isPlaceholderName(ownMatrixProfile?.displayName, viewerId)
  const savePassport = useStableHandler(async (draft: PassportDraft) => {
    if (settingsProfile === undefined || activeStore.setPassport === undefined) return
    if (draft.avatar !== null) {
      await settingsProfile.setAvatar(await squareAvatarPng(draft.avatar), 'avatar.png')
    }
    await settingsProfile.setDisplayName(draft.displayName)
    await activeStore.setPassport(draft.passport)
    setClosedPassport({ store: activeStore, viewerId })
  })
  const dismissPassport = useStableHandler(() => {
    setClosedPassport({ store: activeStore, viewerId })
    void activeStore.setPassport?.({ ...ownPassport, onboarded: true }).catch(() => undefined)
  })

  const roomMembers = useMemo(() => {
    void snapshot
    return activeRoomId === null ? undefined : activeStore.getMembers?.(activeRoomId)
  }, [activeRoomId, activeStore, snapshot])
  const rawRoster = useMemo(() => {
    void snapshot
    return activeRoomId === null ? [] : (activeStore.getRoster?.(activeRoomId) ?? roomMembers ?? [])
  }, [activeRoomId, activeStore, roomMembers, snapshot])
  const unnamedMember = t('console.workspace.members.unnamed')
  const nameOfMember = useCallback(
    (member: MemberView) => safeDisplayName(member.name, member.userId, unnamedMember),
    [unnamedMember]
  )

  const viewerName =
    localProfile.displayName ||
    [
      ownMatrixProfile?.displayName,
      roomMembers?.find((member) => member.userId === viewerId)?.name,
      rawRoster.find((member) => member.userId === viewerId)?.name,
    ]
      .map((name) => cleanText(name, 80))
      .filter((name) => isNamedProfile(name, viewerId))[0] ||
    accountName ||
    displayNameOf(viewerId, unnamedMember)
  const roster =
    rawRoster.some((member) => member.userId === viewerId) || !hasProfile
      ? rawRoster
      : [...rawRoster, { userId: viewerId, name: viewerName }]

  function memberProfile(member: MemberView): MemberProfile {
    return {
      userId: member.userId,
      name: member.userId === viewerId ? viewerName : nameOfMember(member),
      presence:
        member.userId === viewerId && hasProfile
          ? localProfile.presence
          : activeStore.isOnline?.(member.userId)
            ? 'online'
            : 'offline',
      role: profileRoleIn(activeStore, activeRoomId, member.userId),
      ...(member.userId === viewerId ? { status: localProfile.status } : {}),
      ...(member.avatarMxc === undefined ? {} : { avatarMxc: member.avatarMxc }),
    }
  }

  const resolveMember = useStableHandler((userId: string): MemberProfile => {
    if (userId === viewerId) {
      return memberProfile({
        userId: viewerId,
        name: viewerName,
        ...(ownMatrixProfile?.avatarUrl === undefined
          ? {}
          : { avatarMxc: ownMatrixProfile.avatarUrl }),
      })
    }
    const found =
      rawRoster.find((member) => member.userId === userId) ??
      roomMembers?.find((member) => member.userId === userId)
    if (found !== undefined) return memberProfile(found)
    return {
      userId,
      name: userId,
      presence: activeStore.isOnline?.(userId) ? 'online' : 'offline',
      role: profileRoleIn(activeStore, activeRoomId, userId),
    }
  })

  const mentionMembers = useMemo(() => {
    const source = rawRoster.length > 0 ? rawRoster : roomMembers
    if (source === undefined) return undefined
    const unnamed = t('console.workspace.members.unnamed')
    return source.map(({ userId, name }) => ({
      userId,
      name: safeDisplayName(name, userId, unnamed),
    }))
  }, [rawRoster, roomMembers, t])

  const connectorChannels = useMemo(
    () =>
      [
        ...workspace.categories.flatMap((category) => category.channels),
        ...workspace.uncategorised_channels,
      ]
        .filter((channel) => {
          const room = snapshot.channels.get(channel.id)
          return (
            channel.kind === 'text' &&
            room?.state === 'resolved' &&
            snapshot.rooms.some((joined) => joined.roomId === room.roomId) &&
            activeStore.canSendMessage?.(room.roomId) !== false
          )
        })
        .map((channel) => ({ id: channel.id, label: channelLabel(channel, t) })),
    [workspace, snapshot, activeStore, t]
  )

  useEffect(
    () =>
      registerWorkspaceSettingsRuntime(
        {
          org,
          userId: viewerId,
          displayName: viewerName,
          ...(accountName === undefined ? {} : { accountName }),
          channels: connectorChannels,
          members: [
            ...rawRoster.filter((member) => member.userId !== viewerId),
            { userId: viewerId, name: viewerName },
          ],
          call: deviceSettings,
          ...(settingsProfile === undefined ? {} : { profile: settingsProfile }),
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
      viewerName,
      accountName,
      rawRoster,
      settingsEpoch,
      deviceSettings,
      settingsProfile,
      connectorChannels,
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

  const mentionCandidates = useMemo(() => {
    const unnamed = t('console.workspace.members.unnamed')
    return (
      roomMembers?.map(({ userId, name }) => ({
        userId,
        label: safeDisplayName(name, userId, unnamed),
      })) ?? NO_CANDIDATES
    )
  }, [roomMembers, t])

  return {
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
  }
}
