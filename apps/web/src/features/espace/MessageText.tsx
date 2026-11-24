import { InlineMarkdown, MarkdownText } from '../messaging/MarkdownText'
// A message's text with its web addresses as links (V1 bar M10): http and https only, each
// opening a new tab with no handle back on this page and no referrer. No preview is fetched.
// Everything else stays text, which React escapes.

import { Fragment, useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { useCustomEmojis } from './customEmojiStore'
import { withGlyphs } from './KoderaEmoji'
import { LINK_TEXT } from '../../ui/linkText'
import { hasMentionBoundaryAfter } from './mentions'
import { isMatrixUserId } from './roomInvitations'

export type TextSegment = { text: string } | { text: string; href: string }

const ADDRESS = /\bhttps?:\/\/[^\s<>"]+/giu
/** Punctuation that ends a sentence more often than an address. */
const TRAILING = /[.,;:!?'»…]/u

/**
 * Drops what reads as the sentence's, not the address's: trailing punctuation, an unopened `)`.
 * The brackets are counted once and the count kept as `)` is dropped: a message is up to
 * 64 KiB, so counting again on each pass would let one message stall every reader's tab.
 */
function trim(candidate: string): string {
  let end = candidate.length
  const open = count(candidate, '(')
  let close = count(candidate, ')')
  for (;;) {
    const last = candidate[end - 1]
    if (last !== undefined && TRAILING.test(last)) {
      end--
      continue
    }
    if (last === ')' && open < close) {
      end--
      close--
      continue
    }
    return candidate.slice(0, end)
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

/** The text cut into plain runs and web addresses, in order; nothing is lost or added. */
export function linkSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let from = 0
  for (const match of text.matchAll(ADDRESS)) {
    const address = trim(match[0])
    // The pattern admits http and https only; an address the URL parser refuses stays text.
    let href: string
    try {
      href = new URL(address).href
    } catch {
      continue
    }
    if (match.index > from) segments.push({ text: text.slice(from, match.index) })
    segments.push({ text: address, href })
    from = match.index + address.length
  }
  if (from < text.length) segments.push({ text: text.slice(from) })
  return segments
}

/** A member a message may name: the id a pill opens, the name the text writes after « @ ». */
export interface MentionMember {
  userId: string
  name?: string | undefined
}

/** What a mention pill does when pressed: the member's passport opens beside it. */
export type MentionClick = (userId: string, anchor: HTMLElement) => void

export type MentionSegment =
  { text: string } | { text: string; userId: string } | { text: string; room: true }

/** A full Matrix user id, `@localpart:server`, as other clients' plain bodies write a mention. */
const USER_ID = /^@[a-z0-9._=\-/+]+:[a-z0-9.-]+(?::\d{1,5})?/iu
/** The words that name the whole room. */
const ROOM_WORD = /^@(salon|room)/iu

/** The member a `matrix.to` permalink points at, when it is a user's; nothing for anything else. */
export function permalinkUser(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.hostname !== 'matrix.to' || !url.hash.startsWith('#/')) return null
  let id: string
  try {
    id = decodeURIComponent(url.hash.slice(2).split('?')[0]!)
  } catch {
    return null
  }
  const match = USER_ID.exec(id)
  return match !== null && match[0] === id && isMatrixUserId(id) ? id : null
}

/**
 * The text cut into plain runs and mentions, in order, nothing lost or added: « @Name » of a
 * known member (the longest name at each « @ »), a full user id, and « @salon » / « @room ».
 * An « @ » counts at the start of the text or after a space or an opening bracket.
 */
export function mentionSegments(
  text: string,
  members: readonly MentionMember[] = []
): MentionSegment[] {
  if (!text.includes('@')) return [{ text }]
  const named = members
    .filter((member): member is { userId: string; name: string } => Boolean(member.name?.trim()))
    .sort((a, b) => b.name.length - a.name.length)
  const segments: MentionSegment[] = []
  let from = 0
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at < from) continue
    if (at > 0 && !/[\s([{«]/u.test(text[at - 1]!)) continue
    const rest = text.slice(at)
    const afterAt = rest.slice(1)
    let found: MentionSegment | null = null
    const room = ROOM_WORD.exec(rest)
    if (room !== null && hasMentionBoundaryAfter(afterAt, room[1]!)) {
      found = { text: room[0], room: true }
    }
    if (found === null) {
      const id = USER_ID.exec(rest)
      // A trailing full stop ends the sentence, not the server name.
      const raw = id?.[0].replace(/\.+$/u, '')
      if (
        raw !== undefined &&
        raw.includes(':') &&
        hasMentionBoundaryAfter(afterAt, raw.slice(1))
      ) {
        const exactMember = named.find(({ name }) => name === raw.slice(1))
        found = { text: raw, userId: exactMember ? exactMember.userId : raw }
      }
    }
    if (found === null) {
      const member = named.find(
        ({ name }) => afterAt.startsWith(name) && hasMentionBoundaryAfter(afterAt, name)
      )
      if (member !== undefined) found = { text: `@${member.name}`, userId: member.userId }
    }
    if (found === null) continue
    if (at > from) segments.push({ text: text.slice(from, at) })
    segments.push(found)
    from = at + found.text.length
  }
  if (from < text.length) segments.push({ text: text.slice(from) })
  return segments
}

const PILL = 'rounded-sm bg-c-accent-soft px-1 font-semibold text-c-accent-ink'

function MentionPill({
  text,
  userId,
  onMentionClick,
}: {
  text: string
  userId: string | null
  onMentionClick: MentionClick | undefined
}) {
  if (userId === null || onMentionClick === undefined)
    return (
      <span className={PILL} data-mention={userId ?? 'room'}>
        {text}
      </span>
    )
  return (
    <button
      type="button"
      data-mention={userId}
      onClick={(event) => onMentionClick(userId, event.currentTarget)}
      className={cx(
        PILL,
        'cursor-pointer hover:underline focus-visible:ring focus-visible:outline-hidden'
      )}
    >
      {text}
    </button>
  )
}

function MentionedRun({
  text,
  members,
  onMentionClick,
  organisationId,
  customShortcodes,
}: {
  text: string
  members: readonly MentionMember[] | undefined
  onMentionClick: MentionClick | undefined
  organisationId: string | null
  customShortcodes: ReadonlySet<string>
}) {
  const segments = mentionSegments(text, members)
  if (segments.length === 1 && !('userId' in segments[0]!) && !('room' in segments[0]!))
    return <>{withGlyphs(text, organisationId, customShortcodes)}</>
  return (
    <>
      {segments.map((segment, index) =>
        'room' in segment ? (
          <MentionPill key={index} text={segment.text} userId={null} onMentionClick={undefined} />
        ) : 'userId' in segment ? (
          <MentionPill
            key={index}
            text={segment.text}
            userId={segment.userId}
            onMentionClick={onMentionClick}
          />
        ) : (
          <Fragment key={index}>
            {withGlyphs(segment.text, organisationId, customShortcodes)}
          </Fragment>
        )
      )}
    </>
  )
}

const HAS_NON_KODERA_SHORTCODE = /:(?!kodera_)[a-z0-9_]{2,32}:/u

export function MessageText({
  body,
  members,
  onMentionClick,
}: {
  body: string
  /** The room's members, so « @Name » in the text is drawn as their pill. */
  members?: readonly MentionMember[] | undefined
  /** Makes a member's pill a button; without it the pill is only highlighted text. */
  onMentionClick?: MentionClick | undefined
}) {
  const { t } = useTranslation()
  const organisationId = useMessagingOrganisation()
  const { shortcodeSet } = useCustomEmojis(organisationId, {
    autoFetch: HAS_NON_KODERA_SHORTCODE.test(body),
  })
  const newTabId = useId()
  const hasExternalUrl = /https?:\/\/(?!matrix\.to\/#\/(?:@|%40))/iu.test(body)
  const nameOf = (userId: string) => members?.find((member) => member.userId === userId)?.name
  const renderLink = (href: string, label: ReactNode) => {
    const user = permalinkUser(href)
    if (user !== null) {
      return (
        <MentionPill
          text={`@${nameOf(user)?.trim() || user}`}
          userId={user}
          onMentionClick={onMentionClick}
        />
      )
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={newTabId}
        className={cx(
          LINK_TEXT.inline,
          'rounded-sm focus-visible:ring focus-visible:outline-hidden'
        )}
      >
        {label}
      </a>
    )
  }
  const renderPlainRun = (run: string) => {
    const segments = linkSegments(run)
    if (!segments.some((segment) => 'href' in segment))
      return (
        <MentionedRun
          text={run}
          members={members}
          onMentionClick={onMentionClick}
          organisationId={organisationId}
          customShortcodes={shortcodeSet}
        />
      )
    return (
      <>
        {segments.map((segment, index) =>
          'href' in segment ? (
            <Fragment key={index}>{renderLink(segment.href, segment.text)}</Fragment>
          ) : (
            <MentionedRun
              key={index}
              text={segment.text}
              members={members}
              onMentionClick={onMentionClick}
              organisationId={organisationId}
              customShortcodes={shortcodeSet}
            />
          )
        )}
      </>
    )
  }
  return (
    <>
      <MarkdownText
        body={body}
        renderText={(blockText) => (
          <InlineMarkdown text={blockText} renderLink={renderLink} renderText={renderPlainRun} />
        )}
      />
      {hasExternalUrl ? (
        <span id={newTabId} className="sr-only">
          {t('console.common.a11y-opens-new-tab')}
        </span>
      ) : null}
    </>
  )
}
