import { forwardRef } from 'react'
import type { HTMLAttributes, Ref } from 'react'
import { cx } from '../cx'
import { PersonIcon } from '../icons/Person'

export type AvatarVariant = 'admin' | 'member' | 'pending'

/** `md` is the 32 px circle every table, list and message draws. `xs` is the
 * 20 px one Espace's sidebar draws beside a person's name: an occupant under
 * an audio room (`RoomRow`), the person a direct message's row leads with
 * (`ChannelRow`'s `leading`), the faces on a thread link
 * (`TimelineMessage`), and the faces beside a channel's member count in its
 * header, which sit on that line of text. It is not a size to pick for
 * anything else. */
export type AvatarSize = 'md' | 'xs' | 'lg'

const SIZE: Record<AvatarSize, string> = {
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
  xs: 'h-5 w-5',
}

/**
 * COMPONENTS.md: "Avatar 32 circle: slate.900/white for admins, cobalt.100/
 * cobalt.500 members, dashed slate.300 for pending."
 */
const VARIANT: Record<AvatarVariant, string> = {
  admin: 'bg-c-inverse text-c-on-inverse',
  member: 'bg-c-accent-soft text-c-accent-ink',
  pending: 'border border-dashed border-c-border-strong bg-c-surface text-c-ink-3',
}

/** Stable member tones use the design system's paired foreground/background roles. */
const MEMBER_TONES = [
  'bg-c-t1-bg text-c-t1-fg',
  'bg-c-t2-bg text-c-t2-fg',
  'bg-c-t3-bg text-c-t3-fg',
  'bg-c-t4-bg text-c-t4-fg',
  'bg-c-t5-bg text-c-t5-fg',
  'bg-c-t6-bg text-c-t6-fg',
]
export function memberTone(identity: string): string {
  let hash = 0
  for (const char of identity) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return MEMBER_TONES[hash % MEMBER_TONES.length]!
}

export interface AvatarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** The person's full name — source of the initials fallback and, when
   * there is no image, of the accessible name too. */
  name: string
  identity?: string | undefined
  /** Localised online suffix; absent means no presence indicator. */
  onlineLabel?: string | undefined
  presenceGround?: 'surface' | 'sunken'
  variant?: AvatarVariant
  /** 32 px unless a room's occupant list asks for the 20 px circle. */
  size?: AvatarSize
  /** Optional photo. When present the initials are not rendered; the `alt`
   * text is still the name, never left empty. */
  src?: string
  /** The person has no name to take initials from (only an id): a neutral person glyph is drawn
   * instead of a character of that id. `name` still names the element. */
  anonymous?: boolean
}

/** The initials an avatar without a photo shows: also what a button holding one must name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ''
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + second).toUpperCase()
}

/**
 * A 32 px circle — COMPONENTS.md gives no other size for this primitive. The
 * one exception is `size="xs"`, the 20 px face beside a name in Espace's
 * sidebar and thread links; the default stays 32 px, so a table row cannot get
 * it wrong.
 *
 * The rendered element is an `<img>` with a photo or a `<span>` without one,
 * so the ref this forwards is typed over their union — either branch below
 * narrows it back to the element it actually renders.
 */
export const Avatar = forwardRef<HTMLImageElement | HTMLSpanElement, AvatarProps>(function Avatar(
  {
    name,
    identity,
    onlineLabel,
    presenceGround = 'surface',
    variant = 'member',
    size = 'md',
    src,
    anonymous = false,
    className,
    ...rest
  },
  ref
) {
  const accessibleName = onlineLabel === undefined ? name : `${name}, ${onlineLabel}`
  const dot =
    onlineLabel === undefined ? null : (
      <span
        aria-hidden="true"
        data-online=""
        className={cx(
          'absolute right-0 bottom-0 h-2 w-2 rounded-full bg-c-ok ring-2',
          presenceGround === 'sunken' ? 'ring-c-sunken' : 'ring-c-surface'
        )}
      />
    )
  if (src !== undefined) {
    return (
      <span className={cx('relative inline-flex shrink-0', SIZE[size])}>
        <img
          // The caller's remaining props go first, so nothing they pass can
          // silently take the accessible name back off the element — the
          // same ordering `Button` uses for its state-critical attributes.
          {...rest}
          ref={ref as Ref<HTMLImageElement>}
          src={src}
          alt={accessibleName}
          className={cx(SIZE[size], 'shrink-0 rounded-full object-cover', className)}
        />
        {dot}
      </span>
    )
  }

  return (
    <span
      // Same ordering as the `img` branch above: `rest` first, the
      // guarantees last.
      {...rest}
      ref={ref as Ref<HTMLSpanElement>}
      role="img"
      aria-label={accessibleName}
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        SIZE[size],
        variant === 'member' && identity !== undefined ? memberTone(identity) : VARIANT[variant],
        className
      )}
    >
      {anonymous ? <PersonIcon /> : initialsOf(name)}
      {dot}
    </span>
  )
})
