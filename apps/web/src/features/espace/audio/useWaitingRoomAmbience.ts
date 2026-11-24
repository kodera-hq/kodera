// Waiting-room ambient audio hook wired to WaitingRoomAmbienceController (WAITING_AMBIENCE_DUCK_GAIN = 0.18).
// Auto-ducks on speech and deterministically calls stop() on peer join, deafen, call leave, or unmount.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AudioDockMediaToggle } from '../../../ui/AudioDock/AudioDock'
import { WaitingRoomAmbienceController } from '../../sounds/SoundboardPopover'
import { useExperiencePreferences } from '../experienceApi'
import { experienceCopy } from '../experienceMessages'

export interface UseWaitingRoomAmbienceInput {
  readonly organisationId: string | null
  readonly callLive: boolean
  readonly roomId: string | null
  readonly remotePeersCount: number
  readonly deafened: boolean
  readonly listenOnly: boolean
  readonly speaking: boolean
  readonly locale?: string | undefined
  readonly contextFactory?: (() => AudioContext | null) | undefined
}

export interface WaitingRoomAmbienceResult {
  readonly active: boolean
  readonly ducked: boolean
  readonly toggleControl: AudioDockMediaToggle | undefined
  readonly controller: WaitingRoomAmbienceController
}

export function useWaitingRoomAmbience({
  organisationId,
  callLive,
  roomId,
  remotePeersCount,
  deafened,
  listenOnly,
  speaking,
  locale,
  contextFactory,
}: UseWaitingRoomAmbienceInput): WaitingRoomAmbienceResult {
  const prefs = useExperiencePreferences(organisationId)
  const labsEnabled = prefs.labsFlags.waiting_room_ambience
  const copy = experienceCopy(locale).ambience

  const [controller] = useState(() => new WaitingRoomAmbienceController(contextFactory))

  const [sessionState, setSessionState] = useState<{
    roomId: string | null
    enabled: boolean
  }>({
    roomId,
    enabled: prefs.waitingRoomAmbience,
  })

  if (sessionState.roomId !== roomId) {
    setSessionState({
      roomId,
      enabled: prefs.waitingRoomAmbience,
    })
  }

  const inWaitingRoom = callLive && roomId !== null && remotePeersCount === 0
  const canPlay = inWaitingRoom && labsEnabled && !deafened && !listenOnly
  const shouldPlay = canPlay && sessionState.enabled

  useEffect(() => {
    if (!shouldPlay) {
      controller.stop()
      return
    }
    controller.start()
  }, [controller, shouldPlay])

  useEffect(() => {
    controller.duckForSpeech(speaking)
  }, [controller, speaking])

  useEffect(() => {
    return () => {
      controller.stop()
    }
  }, [controller])

  const onToggle = useCallback(() => {
    setSessionState((prev) => {
      const nextEnabled = !prev.enabled
      if (!nextEnabled) {
        controller.stop()
      }
      return { roomId, enabled: nextEnabled }
    })
  }, [controller, roomId])

  const active = shouldPlay
  const toggleControl = useMemo<AudioDockMediaToggle | undefined>(() => {
    if (!inWaitingRoom || !labsEnabled || listenOnly || deafened) return undefined
    const isOn = sessionState.enabled
    return {
      on: isOn,
      busy: false,
      label: isOn ? copy.disable : copy.enable,
      onToggle,
    }
  }, [
    inWaitingRoom,
    labsEnabled,
    listenOnly,
    deafened,
    sessionState.enabled,
    copy.disable,
    copy.enable,
    onToggle,
  ])

  return {
    active,
    ducked: speaking,
    toggleControl,
    controller,
  }
}
