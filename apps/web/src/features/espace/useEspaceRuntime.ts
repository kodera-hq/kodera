import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MatrixSession } from '../../auth/matrix'
import { getWorkspaceSettingsEpoch } from '../workspace/settingsRuntime'
import type { Workspace } from '../workspace/workspace'
import type { AudioSettingsCall } from './AudioSettings'
import { createCallController, type CallSnapshot } from './audio/call'
import { serverNameOf } from './homeserver'
import {
  LIVE_CALL,
  noCallSnapshot,
  readyChannelIds,
  subscribeToNoCall,
  type AudioCallLike,
  type EspaceStoreLike,
} from './liveViewModel'
import { createEspaceStore } from './matrix/store'
import { useMicActivity } from './useMicActivity'
import { useStoreSlice } from './useStoreSlice'
import { useTabTitle } from './useTabTitle'

/** The member's own microphone is on, in a call that is through. */
const microphoneOn = (call: CallSnapshot) =>
  call.status === 'connected' && !call.muted && call.muting !== true && !call.listenOnly
const callIsLive = (call: CallSnapshot) => LIVE_CALL.has(call.status)

const subscribeToNoSlot = () => () => undefined
const noSlotStore = () => null

/** The call, when it can choose the member's devices: what « Réglages audio » drives. */
function deviceSettingsOf(call: AudioCallLike): AudioSettingsCall | null {
  const { getDeviceChoice, chooseInput, chooseOutput } = call
  if (getDeviceChoice === undefined || chooseInput === undefined || chooseOutput === undefined)
    return null
  const { setNoiseSuppression } = call
  return {
    getDeviceChoice,
    chooseInput: (input) => chooseInput.call(call, input),
    chooseOutput: (output) => chooseOutput.call(call, output),
    ...(setNoiseSuppression === undefined
      ? {}
      : { setNoiseSuppression: (on: boolean) => setNoiseSuppression.call(call, on) }),
  }
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

export interface UseEspaceRuntimeOptions {
  injectedStore: EspaceStoreLike | undefined
  injectedCall: AudioCallLike | undefined
  session: MatrixSession | undefined
  workspace: Workspace
}

export function useEspaceRuntime({
  injectedStore,
  injectedCall,
  session,
  workspace,
}: UseEspaceRuntimeOptions) {
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
      ...(activeStore.getRoomBoundary
        ? {
            roomBoundary: (roomId: string) => activeStore.getRoomBoundary?.(roomId) ?? 'unknown',
            subscribeRoomBoundary: activeStore.subscribe,
          }
        : {}),
      mediaEncryption: (roomId: string) =>
        activeStore.getConfidentialMediaSession?.(roomId) ?? null,
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

  const subscribeToCall = activeCall?.subscribe ?? subscribeToNoCall
  const getCallSnapshot = activeCall?.getSnapshot ?? noCallSnapshot
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

  return {
    activeStore,
    settingsEpoch,
    snapshot,
    activeCall,
    micActivity,
    inLiveCall,
    deviceSettings,
    signedOut,
  }
}
