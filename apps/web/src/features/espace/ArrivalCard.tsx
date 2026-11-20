// A newcomer's arrival in the welcome channel (`#arrivées`, `#arrivals`): a warm card in place of a
// grey membership line, with one button to wave at them. The wave is the 👋 reaction the view
// sends; once the member has waved, the button says so and is not pressed twice.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET } from '../../ui/touchTarget'

/** The emoji a wave sends, as a reaction on the arrival. */
export const WAVE = '👋'

/** The channel names a workspace greets its newcomers in, in either language. */
const ARRIVALS = new Set(['arrivees', 'arrivals', 'arrivee', 'arrival', 'bienvenue', 'welcome'])

/**
 * Whether a channel is where newcomers are greeted: its name without its `#`, accents, case or
 * surrounding emoji, as `arrivées`, `Arrivees`, `#arrivals` or `👋-welcome` are all written.
 */
export function isArrivalsChannel(name: string): boolean {
  const plain = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '')
    .replace(/^-+|-+$/gu, '')
  return ARRIVALS.has(plain)
}

export interface ArrivalCardProps {
  /** The newcomer's name as their messages are signed. */
  name: string
  userId: string
  /** Their avatar's `blob:` address, once the cache holds it; their initials stand in meanwhile. */
  avatarSrc?: string | undefined
  /** A face drawn by the caller instead (a profile trigger around it, for instance). */
  avatar?: ReactNode
  /** When they arrived, as the timeline's other times are written. */
  timeLabel?: string | undefined
  dateTime?: string | undefined
  /** The member has already waved at them. */
  waved: boolean
  /** Waving is not possible here (read-only channel, no reactions). */
  disabled?: boolean | undefined
  onWave: () => void
}

export function ArrivalCard({
  name,
  userId,
  avatarSrc,
  avatar,
  timeLabel,
  dateTime,
  waved,
  disabled = false,
  onWave,
}: ArrivalCardProps) {
  const { t } = useTranslation()
  return (
    <article
      aria-label={t('console.workspace.arrivals.label', { name })}
      className="flex items-center gap-3 rounded-lg border border-c-border-soft bg-c-accent-soft px-4 py-3"
    >
      {avatar ?? (
        <Avatar
          name={name}
          identity={userId}
          size="lg"
          aria-hidden="true"
          {...(avatarSrc === undefined ? {} : { src: avatarSrc })}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold break-words text-c-ink">
          {t('console.workspace.arrivals.title', { name })}
        </p>
        <p className="text-xs text-c-ink-2">
          {t('console.workspace.arrivals.body')}
          {timeLabel === undefined ? null : (
            <>
              {' · '}
              <time dateTime={dateTime}>{timeLabel}</time>
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        aria-label={t(
          waved
            ? 'console.workspace.arrivals.action-waved'
            : 'console.workspace.arrivals.action-wave',
          { name }
        )}
        title={t(
          waved
            ? 'console.workspace.arrivals.action-waved'
            : 'console.workspace.arrivals.action-wave',
          { name }
        )}
        aria-pressed={waved}
        disabled={disabled || waved}
        onClick={onWave}
        className={cx(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-lg',
          'border-c-border bg-c-surface hover:border-c-accent-ink hover:bg-c-elevated',
          'aria-pressed:border-c-accent-ink aria-pressed:bg-c-elevated',
          'motion-safe:transition-transform motion-safe:active:scale-90',
          'disabled:cursor-not-allowed disabled:hover:border-c-border',
          'focus-visible:ring focus-visible:outline-hidden',
          TOUCH_TARGET
        )}
      >
        <span aria-hidden="true">{WAVE}</span>
      </button>
    </article>
  )
}
