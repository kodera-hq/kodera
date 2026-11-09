import { useId } from 'react'
import type { MouseEvent, ReactNode, ReactElement } from 'react'
import { Avatar } from '../Avatar/Avatar'
import { cx } from '../cx'
import { EspaceGlyph } from '../icons/EspaceGlyph'
import { LINK_TEXT } from '../linkText'
import { hasLabel } from '../stateLabel'
import { TOUCH_TARGET_HEIGHT } from '../touchTarget'

/**
 * One message in a channel's timeline (`design specification`
 * `design/reference/p02-messages.html`, `.msg`, `.react`, `.thread-link`).
 * An `article` named by its author and time, as the reference's feed draws
 * it; the caller wraps the articles in its `role="log"` feed.
 *
 * - a 32 px avatar, the author, and the time in tabular figures in a `<time>`;
 * - the body as children, an optional edited marker and reply quote;
 * - reactions as toggles (`aria-pressed`), each named by the caller in words
 *   (« 👍 3, vous avez réagi ») — the pressed one also draws the `c-accent-ink`
 *   edge, which the idle one's `c-border` is far from;
 * - `addReaction`: the caller's « add a reaction » button, after the reactions;
 * - a thread button (« 6 réponses ») in `c-accent-ink`, with the faces of who
 *   replied and when the last reply came;
 * - `focused`: the message whose thread is open — the `c-accent-soft` tint and
 *   a bar at the leading edge;
 * - `mention`: the message names the viewer — the bar, and the caller's words
 *   in the article's name; no tint, which stays the focused message's;
 * - `deleted`: the message was removed — the caller's words replace the body,
 *   and it has no reactions, no edited marker and no actions;
 * - `delivery`: the viewer's own message is still sending, or failed — said in
 *   words, read in the name, with a retry button when it failed;
 * - `compact`: a continuation of the same author's run, with no avatar and no
 *   header. The author stays in the name; the time shows in the gutter on
 *   hover and focus;
 * - `actions`: the caller's action disclosure beside the body, shown on hover, on
 *   focus within the message and while one of its menus is open, and always on a
 *   screen with no hover or in forced colours. It reserves its own space, so it
 *   never covers text.
 * A state named in words is on when its label is given and not empty
 * (`hasLabel`).
 */
export interface TimelineReaction {
  /** Stable key, such as the emoji's text. */
  key: string
  /** What the reaction shows: an emoji, or a glyph. */
  emoji: ReactNode
  count: number
  /** The viewer is among those who reacted. */
  mine: boolean
  /** The toggle's accessible name, e.g. « 👍 3, vous avez réagi ». */
  label: string
  onToggle: () => void
}

/** Someone who replied in the thread, drawn as a 20 px face on its link. */
export interface ThreadParticipant {
  id: string
  name: string
  src?: string
}

export interface TimelineThread {
  /** The button's words, e.g. « 6 réponses ». */
  label: string
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void
  /** Whether the thread panel is open, for `aria-expanded`. */
  expanded?: boolean
  /** Who replied; the first three faces are drawn, decorative. */
  participants?: readonly ThreadParticipant[]
  /** When the last reply came, e.g. « dernière il y a 4 min ». */
  lastReply?: string
}

/** The viewer's own message on its way: still sending, or failed with a retry. */
export type TimelineDelivery =
  | { state: 'sending'; label: string }
  | { state: 'failed'; label: string; retryLabel: string; onRetry: () => void }

export interface TimelineMessageProps {
  author: string
  /** Optional accessible profile disclosure around the avatar and author name. */
  profileTrigger?: ((trigger: ReactElement) => ReactNode) | undefined
  avatarIdentity?: string
  avatarOnlineLabel?: string | undefined
  /** The author's photo; initials otherwise. */
  avatarSrc?: string
  /** Machine-readable time, for `<time dateTime>`. */
  dateTime: string
  /** The time as the reader sees it, already formatted, e.g. « 09:31 ». */
  timeLabel: string
  /** The message body. */
  children: ReactNode
  /** The message was edited: the marker's words, e.g. « (modifié) ». */
  edited?: string
  /** The message answers an earlier one. `label` is read before it, e.g. « En réponse à ». */
  reply?: { label: string; author: string; excerpt: string }
  reactions?: readonly TimelineReaction[]
  /** After the reactions: the caller's « add a reaction » button. */
  addReaction?: ReactNode
  /** The message has a thread: the button's words, its faces and what it opens. */
  thread?: TimelineThread
  /** The message whose thread is open beside the timeline. */
  focused?: boolean
  /** The message mentions the viewer: the words read with it, e.g. « vous mentionne ». */
  mention?: string
  /** The message was removed: the words that replace its body, e.g. « Message supprimé ». */
  deleted?: string
  /** The viewer's own message is still sending, or failed. */
  delivery?: TimelineDelivery
  /** A continuation of the same author's run: no avatar, no header. */
  compact?: boolean
  /** The message action disclosure, filled by the caller. */
  actions?: ReactNode
}

const ROOT =
  'group relative flex gap-3 rounded-md px-2 text-md leading-body wrap-anywhere text-c-ink'

export function TimelineMessage({
  author,
  profileTrigger,
  avatarIdentity,
  avatarOnlineLabel,
  avatarSrc,
  dateTime,
  timeLabel,
  children,
  edited,
  reply,
  reactions = [],
  addReaction,
  thread,
  focused = false,
  mention,
  deleted,
  delivery,
  compact = false,
  actions,
}: TimelineMessageProps) {
  const id = useId()
  const authorId = `${id}-author`
  const timeId = `${id}-time`
  const mentionId = `${id}-mention`
  const deliveryId = `${id}-delivery`
  const isMention = hasLabel(mention)
  const isDeleted = hasLabel(deleted)
  const isEdited = hasLabel(edited)
  const hasDelivery = delivery !== undefined && hasLabel(delivery.label)
  const labelledBy = [
    authorId,
    timeId,
    isMention ? mentionId : undefined,
    hasDelivery ? deliveryId : undefined,
  ]
    .filter(hasLabel)
    .join(' ')
  const shownReactions = isDeleted ? [] : reactions
  const showAddReaction = !isDeleted && addReaction !== undefined
  const faces = thread?.participants?.slice(0, 3) ?? []

  const avatar = (
    <Avatar
      name={author}
      identity={avatarIdentity}
      onlineLabel={avatarOnlineLabel}
      size="lg"
      aria-hidden="true"
      {...(avatarSrc === undefined ? {} : { src: avatarSrc })}
    />
  )
  return (
    <article
      aria-labelledby={labelledBy}
      data-mention={isMention ? '' : undefined}
      data-focused={focused ? '' : undefined}
      className={cx(
        ROOT,
        compact ? 'py-1' : 'pt-2 pb-1',
        focused ? 'bg-c-accent-soft' : 'focus-within:bg-c-muted hover:bg-c-muted'
      )}
    >
      {focused || isMention ? (
        <span
          aria-hidden="true"
          data-bar=""
          className="absolute top-0 bottom-0 left-0 w-1 rounded-sm bg-c-accent-ink"
        />
      ) : null}
      <div className="w-10 shrink-0">
        {compact ? (
          <time
            id={timeId}
            dateTime={dateTime}
            className="block pt-1 text-xs text-c-ink-3 tabular-nums opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          >
            {timeLabel}
          </time>
        ) : profileTrigger ? (
          profileTrigger(
            <button
              type="button"
              aria-label={author}
              className="rounded-full focus-visible:ring focus-visible:outline-hidden"
            >
              {avatar}
            </button>
          )
        ) : (
          avatar
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {reply === undefined ? null : (
          <p className="flex min-w-0 items-center gap-1 text-xs text-c-ink-3">
            <EspaceGlyph name="reply" className="h-3 w-3 shrink-0" />
            <span className="sr-only">{reply.label}</span>
            <span className="shrink-0 font-semibold text-c-ink-2">{reply.author}</span>
            <span className="min-w-0 truncate">{reply.excerpt}</span>
          </p>
        )}
        {compact ? (
          <span id={authorId} className="sr-only">
            {author}
          </span>
        ) : (
          <div className="flex flex-wrap items-baseline gap-2">
            <span id={authorId} className="font-semibold">
              {profileTrigger
                ? profileTrigger(
                    <button
                      type="button"
                      className="rounded-sm text-left hover:underline focus-visible:ring focus-visible:outline-hidden"
                    >
                      {author}
                    </button>
                  )
                : author}
              {avatarOnlineLabel === undefined ? null : (
                <span className="sr-only">{`, ${avatarOnlineLabel}`}</span>
              )}
            </span>
            <time id={timeId} dateTime={dateTime} className="text-xs text-c-ink-3 tabular-nums">
              {timeLabel}
            </time>
          </div>
        )}
        {isMention ? (
          <span id={mentionId} className="sr-only">
            {mention}
          </span>
        ) : null}
        {isDeleted ? (
          <p data-deleted="" className="text-c-ink-3 italic">
            {deleted}
          </p>
        ) : (
          <div className="min-w-0">
            {children}
            {isEdited ? <span className="ml-1 text-xs text-c-ink-3">{edited}</span> : null}
          </div>
        )}
        {hasDelivery ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span
              id={deliveryId}
              data-delivery={delivery.state}
              className={delivery.state === 'failed' ? 'text-c-bad-ink' : 'text-c-ink-3'}
            >
              {delivery.label}
            </span>
            {delivery.state === 'failed' ? (
              <button
                type="button"
                onClick={delivery.onRetry}
                className={cx(
                  'rounded-sm font-semibold focus-visible:ring focus-visible:outline-hidden',
                  LINK_TEXT.standalone,
                  TOUCH_TARGET_HEIGHT
                )}
              >
                {delivery.retryLabel}
              </button>
            ) : null}
          </p>
        ) : null}
        {shownReactions.length === 0 && !showAddReaction ? null : (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            {shownReactions.map((reaction) => (
              <button
                key={reaction.key}
                type="button"
                aria-pressed={reaction.mine}
                aria-label={reaction.label}
                onClick={reaction.onToggle}
                className={cx(
                  'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold tabular-nums focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET_HEIGHT,
                  reaction.mine
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border bg-c-surface text-c-ink-2 hover:border-c-border-strong'
                )}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span aria-hidden="true">{reaction.count}</span>
              </button>
            ))}
            {showAddReaction ? <span data-add-reaction="">{addReaction}</span> : null}
          </div>
        )}
        {thread === undefined ? null : (
          <div>
            <button
              type="button"
              onClick={thread.onOpen}
              {...(thread.expanded === undefined ? {} : { 'aria-expanded': thread.expanded })}
              className={cx(
                'inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold hover:bg-c-accent-soft',
                LINK_TEXT.standalone,
                TOUCH_TARGET_HEIGHT
              )}
            >
              {faces.length === 0 ? null : (
                <span aria-hidden="true" data-thread-faces="" className="flex gap-px">
                  {faces.map((face) => (
                    <Avatar
                      key={face.id}
                      identity={face.id}
                      name={face.name}
                      size="xs"
                      aria-hidden="true"
                      {...(face.src === undefined ? {} : { src: face.src })}
                    />
                  ))}
                </span>
              )}
              <span>{thread.label}</span>
              {/* A space the name reads between the count and the time; the gap draws it. */}
              {hasLabel(thread.lastReply) ? ' ' : null}
              {hasLabel(thread.lastReply) ? (
                <span className="font-regular text-c-ink-3">{thread.lastReply}</span>
              ) : null}
            </button>
          </div>
        )}
      </div>
      {actions === undefined || isDeleted ? null : (
        // Shown while the pointer is on the message, while focus is in it, and while one of its
        // menus is open (focus is then in the menu's portal, outside the article). Hidden, it
        // keeps its space, so the text never moves or slides under it. A screen with no hover
        // (a phone) always shows it, and so do forced colours, where a faded control would be
        // the only one hidden; screen readers always reach it.
        <div
          data-message-actions=""
          className="shrink-0 self-start opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 forced-colors:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {actions}
        </div>
      )}
    </article>
  )
}
