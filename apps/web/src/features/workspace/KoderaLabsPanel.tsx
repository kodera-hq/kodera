// Personal Kodera Labs settings panel: per-member experimental flags persisted on Core API.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import {
  updateMyWorkspacePreferences,
  useExperiencePreferences,
  type LabsFlagKey,
} from '../espace/experienceApi'
import { experienceCopy } from '../espace/experienceMessages'

const FLAG_ORDER: readonly LabsFlagKey[] = [
  'send_later',
  'custom_emojis',
  'personal_reminders',
  'waiting_room_ambience',
] as const

export function KoderaLabsPanel({ organisationId }: { organisationId: string }) {
  const { i18n } = useTranslation()
  const copy = experienceCopy(i18n.resolvedLanguage).labs
  const prefs = useExperiencePreferences(organisationId, { autoFetch: true })
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  async function toggleFlag(flag: LabsFlagKey) {
    const nextValue = !prefs.labsFlags[flag]
    setStatus('saving')
    try {
      await updateMyWorkspacePreferences(organisationId, {
        labsFlags: { [flag]: nextValue },
      })
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  async function toggleDefaultAmbience() {
    const nextValue = !prefs.waitingRoomAmbience
    setStatus('saving')
    try {
      await updateMyWorkspacePreferences(organisationId, {
        waitingRoomAmbience: nextValue,
      })
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div data-testid="kodera-labs-panel" className="flex flex-col gap-5">
      <p className="text-sm text-c-ink-2">{copy.intro}</p>

      <div className="flex flex-col gap-3">
        {FLAG_ORDER.map((flag) => {
          const itemCopy = copy.flags[flag]
          const checked = prefs.labsFlags[flag]
          return (
            <div
              key={flag}
              className="flex items-start justify-between gap-4 rounded-lg border border-c-border bg-c-sunken p-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-c-ink">{itemCopy.title}</span>
                  <span className="rounded-full bg-c-accent-soft px-2 py-[2px] font-mono text-xs font-medium text-c-accent-ink">
                    {copy.betaBadge}
                  </span>
                </div>
                <p className="text-xs text-c-ink-2">{itemCopy.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={itemCopy.title}
                data-testid={`labs-toggle-${flag}`}
                disabled={status === 'saving'}
                onClick={() => void toggleFlag(flag)}
                className={cx(
                  'relative inline-flex h-6 w-[44px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
                  checked
                    ? 'border-transparent bg-c-action'
                    : 'border-c-border-input bg-c-muted'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'inline-block h-4 w-4 rounded-full transition-transform',
                    checked ? 'translate-x-5 bg-c-on-inverse' : 'translate-x-1 bg-c-ink-3'
                  )}
                />
              </button>
            </div>
          )
        })}
      </div>

      {prefs.labsFlags.waiting_room_ambience ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-c-border-soft p-4">
          <span className="text-sm text-c-ink">{copy.defaultAmbienceLabel}</span>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.waitingRoomAmbience}
            aria-label={copy.defaultAmbienceLabel}
            data-testid="labs-default-ambience-toggle"
            disabled={status === 'saving'}
            onClick={() => void toggleDefaultAmbience()}
            className={cx(
              'relative inline-flex h-6 w-[44px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
              prefs.waitingRoomAmbience
                ? 'border-transparent bg-c-action'
                : 'border-c-border-input bg-c-muted'
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                'inline-block h-4 w-4 rounded-full transition-transform',
                prefs.waitingRoomAmbience
                  ? 'translate-x-5 bg-c-on-inverse'
                  : 'translate-x-1 bg-c-ink-3'
              )}
            />
          </button>
        </div>
      ) : null}

      {status === 'saving' ? (
        <p role="status" className="text-xs text-c-ink-3">
          {copy.saving}
        </p>
      ) : status === 'saved' ? (
        <p role="status" className="text-xs text-c-ink-2">
          {copy.saved}
        </p>
      ) : status === 'error' ? (
        <p role="alert" className="text-xs text-c-bad-ink">
          {copy.errGeneric}
        </p>
      ) : null}
    </div>
  )
}
