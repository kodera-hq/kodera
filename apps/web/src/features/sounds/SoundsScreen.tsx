import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { useEffect, useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatPercent } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { PAGE_TITLE } from '../../ui/pageTitle'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { Switch } from '../../ui/Switch/Switch'
import {
  MENTION_VARIANT_IDS,
  SOUND_PACKS,
  SOUND_PACK_IDS,
  translateSoundCopy,
} from './manifest'
import { soundEngine } from './SoundEngine'
import type { SoundEngine } from './SoundEngine'
import type {
  MasterSoundMode,
  SoundCategory,
  SoundPackId,
  SoundPreferences,
} from './types'

export interface SoundsScreenProps {
  engine?: SoundEngine
}

const MASTER_MODES: readonly MasterSoundMode[] = ['on', 'essential', 'off'] as const
const SOUND_CATEGORIES: readonly SoundCategory[] = [
  'voice',
  'calls',
  'messages',
  'workspace',
] as const

const CARD_BASE = 'flex items-start justify-between gap-3 rounded-lg bg-c-surface p-4'
const CARD_IDLE = 'border border-c-border'
const CARD_CHOSEN = 'border-2 border-c-accent-ink'

const RADIO_TRIGGER =
  'flex flex-1 cursor-pointer flex-col gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring focus-offset focus-visible:ring-offset-2'

export function SoundsScreen({ engine = soundEngine }: SoundsScreenProps) {
  const { i18n } = useTranslation()
  const id = useId()
  const locale: 'fr' | 'en' = i18n.language.startsWith('en') ? 'en' : 'fr'

  function tr(key: string, vars?: Record<string, string>): string {
    return translateSoundCopy(i18n, key, vars)
  }

  const [preferences, setPreferences] = useState<SoundPreferences>(() => engine.getPreferences())
  const [notKept, setNotKept] = useState<boolean>(() => !engine.isPreferenceKept())
  const [statusMessage, setStatusMessage] = useState<string>('')

  useEffect(() => {
    return engine.subscribe((next) => {
      setPreferences(next)
      setNotKept(!engine.isPreferenceKept())
    })
  }, [engine])

  function handlePackChange(value: string): void {
    const nextPack = SOUND_PACK_IDS.find((candidate) => candidate === value)
    if (!nextPack) return
    const kept = engine.setPack(nextPack)
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handlePreviewPack(packId: SoundPackId, packLabel: string): void {
    engine.previewPack(packId)
    setStatusMessage(tr('console.shell.sounds.status-preview-playing', { pack: packLabel }))
  }

  function handleMasterModeChange(value: string): void {
    const nextMode = MASTER_MODES.find((candidate) => candidate === value)
    if (!nextMode) return
    const kept = engine.setMasterMode(nextMode)
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handleVolumeChange(event: ChangeEvent<HTMLInputElement>): void {
    const rawPercent = Number(event.target.value)
    const normalized = Math.max(0, Math.min(100, rawPercent)) / 100
    const kept = engine.setMasterVolume(normalized)
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handleCategoryToggle(category: SoundCategory, enabled: boolean): void {
    const kept = engine.setCategoryEnabled(category, enabled)
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handleMentionVariantChange(value: string): void {
    const nextVariant = MENTION_VARIANT_IDS.find((candidate) => candidate === value)
    if (!nextVariant) return
    const kept = engine.setMentionVariant(nextVariant)
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handleBooleanOption(
    field: 'vipEnriched' | 'selfActionsOnly' | 'softenedHighs',
    checked: boolean
  ): void {
    const kept = engine.updatePreferences({ [field]: checked })
    setPreferences(engine.getPreferences())
    setNotKept(!kept)
  }

  function handleSpeakerTest(): void {
    engine.playSpeakerTest()
    setStatusMessage(tr('console.shell.sounds.status-speaker-test'))
  }

  const volumePercent = Math.round(preferences.masterVolume * 100)
  const volumeInputId = `${id}-master-volume`

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className={PAGE_TITLE}>{tr('console.shell.sounds.title')}</h1>
        <p className="text-sm text-c-ink-2">{tr('console.shell.sounds.subtitle')}</p>
      </div>

      {/* Pack selector radio cards with sibling Apercu button (never nested button inside button) */}
      <section className="flex flex-col gap-3" aria-labelledby={`${id}-packs-heading`}>
        <h2 id={`${id}-packs-heading`} className="text-sm font-semibold text-c-ink">
          {tr('console.shell.sounds.label-pack-group')}
        </h2>

        <RadioGroupPrimitive.Root
          value={preferences.pack}
          onValueChange={handlePackChange}
          aria-label={tr('console.shell.sounds.label-pack-group')}
          className="grid grid-cols-2 gap-3 narrow:grid-cols-1"
        >
          {SOUND_PACKS.map((pack) => {
            const chosen = pack.id === preferences.pack
            const packLabel = tr(pack.labelKey)
            const labelId = `${id}-pack-${pack.id}-label`
            const hintId = `${id}-pack-${pack.id}-hint`

            return (
              <div
                key={pack.id}
                className={cx(CARD_BASE, chosen ? CARD_CHOSEN : CARD_IDLE)}
              >
                <RadioGroupPrimitive.Item
                  value={pack.id}
                  aria-labelledby={labelId}
                  aria-describedby={hintId}
                  className={RADIO_TRIGGER}
                >
                  <span className="flex items-center gap-2">
                    <span
                      id={labelId}
                      className={cx(
                        'text-sm font-semibold',
                        chosen ? 'text-c-accent-ink' : 'text-c-ink'
                      )}
                    >
                      {packLabel}
                    </span>
                    {pack.badgeKey ? (
                      <span className="rounded-full bg-c-muted px-2 py-1 text-xs font-medium text-c-ink-2">
                        {tr(pack.badgeKey)}
                      </span>
                    ) : null}
                  </span>
                  <span id={hintId} className="text-xs text-c-ink-3">
                    {tr(pack.hintKey)}
                  </span>
                </RadioGroupPrimitive.Item>

                <Button
                  variant="secondary"
                  size="lg"
                  type="button"
                  aria-label={tr('console.shell.sounds.action-preview-pack', {
                    pack: packLabel,
                  })}
                  onClick={() => handlePreviewPack(pack.id, packLabel)}
                  className="min-h-12 min-w-12 shrink-0"
                >
                  {tr('console.shell.sounds.action-preview')}
                </Button>
              </div>
            )
          })}
        </RadioGroupPrimitive.Root>
      </section>

      {/* Master mode and volume controls */}
      <section className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-surface p-4">
        <RadioGroup
          label={tr('console.shell.sounds.label-master-mode')}
          orientation="horizontal"
          value={preferences.masterMode}
          onValueChange={handleMasterModeChange}
          options={MASTER_MODES.map((mode) => ({
            value: mode,
            label: tr(`console.shell.sounds.mode-${mode}`),
          }))}
        />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={volumeInputId} className="text-sm font-medium text-c-ink">
              {tr('console.shell.sounds.label-master-volume')}
            </label>
            <span className="font-mono text-xs font-medium text-c-ink-2">
              {formatPercent(volumePercent, locale)}
            </span>
          </div>
          <input
            id={volumeInputId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={volumePercent}
            onChange={handleVolumeChange}
            className="h-2 w-full cursor-pointer rounded-full bg-c-muted focus-visible:outline-hidden focus-visible:ring focus-offset focus-visible:ring-offset-2"
          />
        </div>
      </section>

      {/* Four category toggles */}
      <section
        className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-4"
        aria-labelledby={`${id}-categories-heading`}
      >
        <h2 id={`${id}-categories-heading`} className="text-sm font-semibold text-c-ink">
          {tr('console.shell.sounds.label-categories')}
        </h2>
        <div className="flex flex-col gap-3">
          {SOUND_CATEGORIES.map((category) => (
            <Switch
              key={category}
              label={tr(`console.shell.sounds.category-${category}`)}
              checked={preferences.categories[category]}
              onCheckedChange={(checked) => handleCategoryToggle(category, checked)}
            />
          ))}
        </div>
      </section>

      {/* Mention variant, personalization toggles, and stereo speaker diagnostic */}
      <section className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-surface p-4">
        <RadioGroup
          label={tr('console.shell.sounds.label-mention-variant')}
          value={preferences.mentionVariant}
          onValueChange={handleMentionVariantChange}
          options={MENTION_VARIANT_IDS.map((variant) => ({
            value: variant,
            label: tr(`console.shell.sounds.option-mention-${variant}`),
          }))}
        />

        <div className="flex flex-col gap-3">
          <Switch
            label={tr('console.shell.sounds.label-vip')}
            checked={preferences.vipEnriched}
            onCheckedChange={(checked) => handleBooleanOption('vipEnriched', checked)}
          />
          <Switch
            label={tr('console.shell.sounds.label-self-only')}
            checked={preferences.selfActionsOnly}
            onCheckedChange={(checked) => handleBooleanOption('selfActionsOnly', checked)}
          />
          <Switch
            label={tr('console.shell.sounds.label-softened')}
            checked={preferences.softenedHighs}
            onCheckedChange={(checked) => handleBooleanOption('softenedHighs', checked)}
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 narrow:flex-col narrow:items-stretch">
          <p className="text-xs text-c-ink-3">{tr('console.shell.sounds.note-compliance')}</p>
          <Button
            variant="secondary"
            size="lg"
            type="button"
            onClick={handleSpeakerTest}
            className="min-h-12 min-w-12 shrink-0"
          >
            {tr('console.shell.sounds.action-speaker-test')}
          </Button>
        </div>
      </section>

      {/* Pre-mounted polite live region for preview status and storage refusal warning */}
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {statusMessage ? (
          <span className="text-xs text-c-ink-2">{statusMessage}</span>
        ) : null}
        {notKept ? (
          <InlineAlert kind="warning" inLiveRegion>
            {tr('console.shell.sounds.warning-not-kept')}
          </InlineAlert>
        ) : null}
      </div>
    </div>
  )
}
