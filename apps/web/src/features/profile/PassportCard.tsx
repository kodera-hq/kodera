// The Kodera Passport card: how a member is drawn when someone opens their profile, and the live
// preview the first-run passport and the profile settings show while it is being written. Pure
// presentation: the banner accent, the avatar with its presence ring, the name, the role and tag
// pills and the bio. What the card lets one do (copy the id, mention, write) is the caller's.

import type { ReactNode } from 'react'
import { Avatar } from '../../ui/Avatar/Avatar'
import { cx } from '../../ui/cx'
import type { PassportAccent } from './passport'

/** Each accent as a banner: a design-token role, written whole so the stylesheet carries it. */
export const ACCENT_BANNER: Record<PassportAccent, string> = {
  cobalt: 'bg-c-accent-ink',
  t1: 'bg-c-t1-fg',
  t2: 'bg-c-t2-fg',
  t3: 'bg-c-t3-fg',
  t4: 'bg-c-t4-fg',
  t5: 'bg-c-t5-fg',
  t6: 'bg-c-t6-fg',
}

export interface PassportCardProps {
  name: string
  userId: string
  avatarSrc?: string | undefined
  /** The portrait has no name to take initials from: a person glyph stands in. */
  anonymous?: boolean
  /** Said after the name, and drawn as a ring around the portrait; absent when offline. */
  presenceLabel?: string | undefined
  accent: PassportAccent
  /** The role pill first (« Admin », « Membre »), then the member's own tags. */
  role?: string | undefined
  tags: readonly string[]
  bio?: string | undefined
  headingId?: string
  /** The close control, drawn over the banner's corner. */
  corner?: ReactNode
  /** The card's actions, under its text. */
  children?: ReactNode
}

export function PassportCard({
  name,
  userId,
  avatarSrc,
  anonymous = false,
  presenceLabel,
  accent,
  role,
  tags,
  bio,
  headingId,
  corner,
  children,
}: PassportCardProps) {
  return (
    <div className="flex flex-col" data-passport-accent={accent}>
      <div className={cx('relative h-[64px] shrink-0', ACCENT_BANNER[accent])}>
        {corner === undefined ? null : <div className="absolute top-2 right-2">{corner}</div>}
      </div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <span
          className={cx(
            '-mt-8 inline-flex w-fit rounded-full bg-c-elevated p-1',
            presenceLabel === undefined ? '' : 'ring-2 ring-c-ok'
          )}
          data-presence={presenceLabel === undefined ? 'offline' : 'online'}
        >
          <Avatar
            name={name}
            identity={userId}
            size="xl"
            anonymous={anonymous}
            onlineLabel={presenceLabel}
            {...(avatarSrc === undefined ? {} : { src: avatarSrc })}
          />
        </span>
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-lg font-bold break-words text-c-ink">
            {name}
          </h2>
          <p className="font-mono text-xs break-all text-c-ink-3 select-text">{userId}</p>
        </div>
        {role === undefined && tags.length === 0 ? null : (
          <ul className="flex flex-wrap items-center gap-1 text-xs">
            {role === undefined ? null : (
              <li className="rounded-full bg-c-accent-soft px-2 py-[2px] font-semibold text-c-accent-ink">
                {role}
              </li>
            )}
            {tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full border border-c-border px-2 py-[2px] font-semibold text-c-ink-2"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        {bio === undefined || bio === '' ? null : (
          <p className="text-sm break-words whitespace-pre-line text-c-ink-2">{bio}</p>
        )}
        {children}
      </div>
    </div>
  )
}
