// « Réglages audio »: the member's microphone and output, the meter, and « Tester le son »
// (spec 11, « Choosing the microphone and the output »), how the member speaks (open microphone or
// push-to-talk) and the browser's noise suppression (docs/specs/espace-video-and-screenshare.md).
// A popover from the call dock: the call goes on behind it.

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { EspaceGlyph } from '../../ui/icons/EspaceGlyph'
import { Popover } from '../../ui/Popover/Popover'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { Select } from '../../ui/Select/Select'
import { Switch } from '../../ui/Switch/Switch'
import { cx } from '../../ui/cx'
import { initialCssProperty } from '../../ui/cssom'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { SOUND_PACKS, SOUND_PACK_IDS, translateSoundCopy } from '../sounds/manifest'
import { soundEngine, type SoundEngine } from '../sounds/SoundEngine'
import type { MasterSoundMode, SoundPackId, SoundPreferences } from '../sounds/types'
import {
  canChooseOutput,
  listAudioDevices,
  NO_DEVICES,
  playTestTone,
  type AudioDevice,
  type AudioDeviceChoice,
  type AudioDevices,
} from './audio/devices'
import { callPreferences, type CallInputMode, type CallPreferences } from './audio/callPreferences'

/** A Select value cannot be empty: this one stands for the system's default. */
const DEFAULT = 'default'
const MASTER_MODES: readonly MasterSoundMode[] = ['on', 'essential', 'off'] as const

const PACK_CARD_BASE = 'flex items-center justify-between gap-2 rounded-md bg-c-surface px-2 py-1'
const PACK_CARD_IDLE = 'border border-c-border'
const PACK_CARD_CHOSEN = 'border-2 border-c-accent-ink'
const PACK_RADIO_TRIGGER =
  'flex flex-1 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring focus-offset focus-visible:ring-offset-2'

export interface AudioSettingsCall {
  getDeviceChoice: () => AudioDeviceChoice
  chooseInput: (input: string | null) => Promise<void>
  chooseOutput: (output: string | null) => Promise<void>
  /** Applies noise suppression to the live microphone too; without it, the next capture has it. */
  setNoiseSuppression?: (on: boolean) => Promise<void>
}

const INPUT_MODES: readonly CallInputMode[] = ['voice', 'push-to-talk']

export interface AudioSettingsProps {
  embedded?: boolean
  call: AudioSettingsCall
  /** The microphone chosen is not plugged in, and the call took the default. */
  inputMissing: boolean
  /** The panel's meter fill, drawn by the caller as the dock's is (`useMicActivity`). */
  meterRef: Ref<HTMLSpanElement>
  /** The browser's devices now; tests hand their own. */
  listDevices?: () => Promise<AudioDevices>
  /** Calls `listener` when a device is plugged in or out; returns how to stop. */
  watchDevices?: (listener: () => void) => () => void
  canChooseOutput?: boolean
  playTone?: (output: string | null) => Promise<void>
  /** The sound engine for pack selection, mode controls and previews; shared singleton by default. */
  engine?: SoundEngine
  /** How the member speaks, and noise suppression: this browser's preferences by default. */
  preferences?: CallPreferences
}

function watchMediaDevices(listener: () => void): () => void {
  const media = globalThis.navigator?.mediaDevices
  if (media?.addEventListener === undefined) return () => undefined
  media.addEventListener('devicechange', listener)
  return () => media.removeEventListener('devicechange', listener)
}

export function AudioSettings({
  embedded = false,
  call,
  inputMissing,
  meterRef,
  listDevices = listAudioDevices,
  watchDevices = watchMediaDevices,
  canChooseOutput: outputChoosable = canChooseOutput(),
  playTone = playTestTone,
  engine = soundEngine,
  preferences = callPreferences,
}: AudioSettingsProps) {
  const speaking = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot)
  // Starts empty, then the meter scales it; never a `style` attribute (src/ui/cssom.ts).
  const meterFillRef = useMemo(
    () => initialCssProperty<HTMLSpanElement>('transform', 'scaleX(0)', meterRef),
    [meterRef]
  )
  const { t, i18n } = useTranslation()
  const id = useId()
  const [open, setOpen] = useState(embedded)
  const [devices, setDevices] = useState<AudioDevices>(NO_DEVICES)
  const [choice, setChoice] = useState<AudioDeviceChoice>(call.getDeviceChoice)
  const [tone, setTone] = useState<'idle' | 'playing' | 'failed'>('idle')
  const [deviceError, setDeviceError] = useState(false)
  const [soundPrefs, setSoundPrefs] = useState<SoundPreferences>(() => engine.getPreferences())

  function tr(key: string, vars?: Record<string, string>): string {
    return translateSoundCopy(i18n, key, vars)
  }

  useEffect(() => {
    return engine.subscribe((next) => {
      setSoundPrefs(next)
    })
  }, [engine])

  // The lists follow the browser while the panel is open: a device plugged in or out shows.
  useEffect(() => {
    if (!open) return
    let current = true
    const refresh = () => {
      void listDevices().then((listed) => {
        if (current) setDevices(listed)
      })
    }
    refresh()
    const stop = watchDevices(refresh)
    return () => {
      current = false
      stop()
    }
  }, [open, listDevices, watchDevices])

  const onOpenChange = (next: boolean) => {
    if (next) {
      // What the call holds now, which another tab or a fallback may have changed.
      setChoice(call.getDeviceChoice())
      setSoundPrefs(engine.getPreferences())
      setTone('idle')
    }
    setOpen(next)
  }

  // A browser not yet granted the microphone names no device: « Micro 1 », « Sortie 2 »…
  const unnamed = {
    input: (index: number) => t('console.workspace.audio.option-input-unnamed', { index }),
    output: (index: number) => t('console.workspace.audio.option-output-unnamed', { index }),
  }
  const options = (listed: readonly AudioDevice[], kind: keyof typeof unnamed) => [
    { value: DEFAULT, label: t('console.workspace.audio.option-default') },
    ...listed.map((device, index) => ({
      value: device.id,
      label: device.label !== '' ? device.label : unnamed[kind](index + 1),
    })),
  ]
  // A device chosen and not listed (unplugged) shows the default, which is what plays; so does a
  // microphone the call stands in for, even once it is back, until the member picks it again.
  const shown = (id: string | null, listed: readonly AudioDevice[]) =>
    id !== null && listed.some((device) => device.id === id) ? id : DEFAULT
  const input = shown(inputMissing ? null : choice.input, devices.inputs)
  const output = shown(choice.output, devices.outputs)

  const chooseInput = (value: string) => {
    const picked = value === DEFAULT ? null : value
    setChoice((previous) => ({ ...previous, input: picked }))
    // The call's word once it settles: a microphone that would not start leaves the one it had.
    setDeviceError(false)
    void call.chooseInput(picked).then(
      () => setChoice(call.getDeviceChoice()),
      () => {
        setChoice(call.getDeviceChoice())
        setDeviceError(true)
      }
    )
  }
  const chooseOutput = (value: string) => {
    const picked = value === DEFAULT ? null : value
    setChoice((previous) => ({ ...previous, output: picked }))
    setTone('idle')
    setDeviceError(false)
    void call
      .chooseOutput(picked)
      .then(async () => {
        setChoice(call.getDeviceChoice())
        await engine.setOutputDevice(picked)
      })
      .catch(() => {
        setChoice(call.getDeviceChoice())
        setDeviceError(true)
      })
  }
  const chooseInputMode = (value: string) => {
    const mode = INPUT_MODES.find((candidate) => candidate === value)
    if (mode !== undefined) preferences.update({ inputMode: mode })
  }
  const chooseNoiseSuppression = (on: boolean) => {
    if (call.setNoiseSuppression === undefined) preferences.update({ noiseSuppression: on })
    else void call.setNoiseSuppression(on).catch(() => setDeviceError(true))
  }
  const handlePackChange = (value: string) => {
    const nextPack = SOUND_PACK_IDS.find((candidate) => candidate === value)
    if (!nextPack) return
    engine.setPack(nextPack)
    setSoundPrefs(engine.getPreferences())
  }
  const handlePreviewPack = (packId: SoundPackId) => {
    engine.previewPack(packId)
  }
  const handleMasterModeChange = (value: string) => {
    const nextMode = MASTER_MODES.find((candidate) => candidate === value)
    if (!nextMode) return
    engine.setMasterMode(nextMode)
    setSoundPrefs(engine.getPreferences())
  }
  // The output shown, which is the one the call plays on. `Button` takes no click while loading.
  const testSound = () => {
    setTone('playing')
    playTone(output === DEFAULT ? null : output).then(
      () => setTone('idle'),
      () => setTone('failed')
    )
  }

  const label = t('console.workspace.audio.action-settings')
  const content = (
    <div className={embedded ? 'flex flex-col gap-6' : 'flex w-[264px] flex-col gap-4'}>
      {deviceError ? (
        <p role="alert" className="text-sm text-c-bad-ink">
          {t('console.common.error-unavailable')}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Select
          label={t('console.workspace.audio.label-input')}
          options={options(devices.inputs, 'input')}
          value={input}
          onValueChange={chooseInput}
          {...(inputMissing ? { help: t('console.workspace.audio.label-input-missing') } : {})}
        />
        {embedded ? null : (
          <>
            <span className="text-sm text-c-ink-2">
              {t('console.workspace.audio.label-input-level')}
            </span>
            <span
              aria-hidden="true"
              data-panel-meter=""
              className="block h-1 w-full overflow-hidden rounded-full bg-c-muted"
            >
              <span ref={meterFillRef} className="block h-full w-full origin-left bg-c-ok" />
            </span>
          </>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <RadioGroup
          label={t('console.workspace.audio.label-input-mode')}
          value={speaking.inputMode}
          onValueChange={chooseInputMode}
          options={[
            { value: 'voice', label: t('console.workspace.audio.option-voice') },
            { value: 'push-to-talk', label: t('console.workspace.audio.option-push-to-talk') },
          ]}
          {...(speaking.inputMode === 'push-to-talk'
            ? { help: t('console.workspace.audio.hint-push-to-talk') }
            : {})}
        />
        <Switch
          label={t('console.workspace.audio.label-noise-suppression')}
          checked={speaking.noiseSuppression}
          onCheckedChange={chooseNoiseSuppression}
        />
      </div>
      <div className="flex flex-col gap-2">
        {outputChoosable ? (
          <Select
            label={t('console.workspace.audio.label-output')}
            options={options(devices.outputs, 'output')}
            value={output}
            onValueChange={chooseOutput}
          />
        ) : (
          <p className="text-sm text-c-ink-2">
            {t('console.workspace.audio.label-output-unsupported')}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={tone === 'playing'}
          onClick={testSound}
          icon={<EspaceGlyph name="speaker" />}
        >
          {t('console.workspace.audio.action-test-sound')}
        </Button>
        <p role="status" className="text-sm text-c-ink-3">
          {tone === 'failed' ? t('console.workspace.audio.problem-test-sound') : null}
        </p>
      </div>
      <div className="flex flex-col gap-3 border-t border-c-border-soft pt-3">
        <div className="flex flex-col gap-2">
          <span id={`${id}-packs-label`} className="text-sm font-medium text-c-ink">
            {tr('console.shell.sounds.label-pack-group')}
          </span>
          <RadioGroupPrimitive.Root
            value={soundPrefs.pack}
            onValueChange={handlePackChange}
            aria-labelledby={`${id}-packs-label`}
            className="flex flex-col gap-1"
          >
            {SOUND_PACKS.map((pack) => {
              const chosen = pack.id === soundPrefs.pack
              const packLabel = tr(pack.labelKey)
              const packLabelId = `${id}-pack-${pack.id}-label`
              return (
                <div
                  key={pack.id}
                  className={cx(PACK_CARD_BASE, chosen ? PACK_CARD_CHOSEN : PACK_CARD_IDLE)}
                >
                  <RadioGroupPrimitive.Item
                    value={pack.id}
                    aria-labelledby={packLabelId}
                    className={PACK_RADIO_TRIGGER}
                  >
                    <span
                      id={packLabelId}
                      className={cx(
                        'text-xs font-semibold',
                        chosen ? 'text-c-accent-ink' : 'text-c-ink'
                      )}
                    >
                      {packLabel}
                    </span>
                  </RadioGroupPrimitive.Item>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    aria-label={tr('console.shell.sounds.action-preview-pack', {
                      pack: packLabel,
                    })}
                    onClick={() => handlePreviewPack(pack.id)}
                    className="shrink-0"
                  >
                    {tr('console.shell.sounds.action-preview')}
                  </Button>
                </div>
              )
            })}
          </RadioGroupPrimitive.Root>
        </div>
        <RadioGroup
          label={tr('console.shell.sounds.label-master-mode')}
          value={soundPrefs.masterMode}
          onValueChange={handleMasterModeChange}
          options={MASTER_MODES.map((mode) => ({
            value: mode,
            label: tr(`console.shell.sounds.mode-${mode}`),
          }))}
        />
      </div>
    </div>
  )
  if (embedded) return content
  return (
    <Popover
      label={label}
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="end"
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cx(
            'focus-offset flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-c-inverse-2 text-c-on-inverse-dim hover:text-c-on-inverse focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
            TOUCH_TARGET
          )}
        >
          <EspaceGlyph name="settings" />
        </button>
      }
    >
      {content}
    </Popover>
  )
}
