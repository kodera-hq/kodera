// Where the member writes: the channel's composer, with the line that says who else is writing,
// and a thread's reply field. Each reads its own text from the draft of the channel shown
// (`draftChannel.ts`), so a keystroke draws the field it was typed in and nothing else: not the
// message log, not the sidebar, not the view that holds them.

import { memo, useCallback, useRef } from 'react'
import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import { demoMessages } from '../../app/demoMessages'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { MentionIcon, SendIcon } from '../../ui/icons/Composer'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET, TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { transformOutsideCode } from '../messaging/formatting'
import { RichComposerInput } from '../messaging/RichComposerInput'
import { useDraftSlice, type DraftChannel } from './draftChannel'
import { replaceShortcodes } from './emoji'
import { EmojiPalette } from './EmojiPalette'
import type { ChannelDraft, RoomTarget } from './EspaceDraftProvider'
import { composing, displayNameOf, nameOf, sameItems, type EspaceStoreLike } from './liveViewModel'
import type { MemberView, SendOptions } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { MentionInput } from './MentionInput'
import { mentionedIn } from './mentions'
import type { MentionCandidate } from './mentions'
import { newestEditable } from './shortcuts'
import { useStoreSlice } from './useStoreSlice'

const NO_TYPING: readonly MemberView[] = []

/**
 * Who is typing, in words (gap report G9): one or two by name, as their messages are signed, and
 * any more as « Plusieurs personnes ». Empty when no one is.
 */
function typingLine(members: readonly MemberView[], t: TFunction): string {
  const names = members.map(({ userId, name }) => name ?? displayNameOf(userId))
  const [first, second] = names
  if (first === undefined) return ''
  if (second === undefined) return t('console.workspace.channel.typing-one', { name: first })
  if (names.length === 2) return t('console.workspace.channel.typing-two', { first, second })
  return t('console.workspace.channel.typing-many')
}

/** The target's message, while its room is the one shown; nothing for another room's. */
export function inRoom(target: RoomTarget | null, roomId: string | null): string | null {
  return target !== null && target.roomId === roomId ? target.eventId : null
}

/** The members the text names, as `m.mentions` carries them; nothing when it names none. */
function mentioning(text: string, members: readonly MentionCandidate[]): SendOptions {
  const userIds = mentionedIn(text, members)
  return userIds.length === 0 ? {} : { mentions: userIds }
}

const textOf = (draft: ChannelDraft) => draft.text
const replyOf = (draft: ChannelDraft) => draft.replyTo
const editOf = (draft: ChannelDraft) => draft.editing
const threadTextOf = (draft: ChannelDraft) => draft.threadText

/**
 * Where one can write, so where others may be writing. Its own polite region, apart from the
 * log's: a name typing is said once, and a message arriving is not held behind it.
 */
const TypingLine = memo(function TypingLine({
  store,
  roomId,
}: {
  store: EspaceStoreLike
  roomId: string
}) {
  const { t } = useTranslation()
  const typingIn = useCallback(() => store.getTyping?.(roomId) ?? NO_TYPING, [store, roomId])
  const typing = useStoreSlice(store.subscribe, store.getSnapshot, typingIn, sameItems)
  return (
    <p aria-live="polite" aria-atomic="true" className="min-h-5 text-xs text-c-ink-3">
      {typingLine(typing, t)}
    </p>
  )
})

export interface MessageComposerProps {
  store: EspaceStoreLike
  /** The room written to: the composer is drawn only where the member can write. */
  roomId: string
  viewerId: string
  draft: DraftChannel
  /** The channel as the sidebar labels it: the field's name and its placeholder. */
  channelName: string
  simulation: boolean
  narrow: boolean
  /** Between two addresses, the channel the member means is not known: nothing is sent. */
  navigationUnsettled: boolean
  inputId: string
  /** The demo's guidance paragraph, which the field is described by in a simulation. */
  guidanceId: string
  members: readonly MentionCandidate[]
  /** A file is staged for this room: sending waits for it. */
  attachmentStaged: boolean
  onStagingChange: (staged: boolean) => void
  onInvite: (() => void) | undefined
  onMentionStart: () => void
  /** Turns the field into an edit of one of the member's messages (`ArrowUp`). */
  onEdit: (message: MessageView) => void
  onAnnounce: (text: string) => void
  /** « Mentionner »: writes « @ » in the composer and opens its member list. */
  mentionRef: RefObject<(() => void) | null>
  insertRef: RefObject<((text: string) => void) | null>
}

function MessageComposerView({
  store,
  roomId,
  viewerId,
  draft,
  channelName,
  simulation,
  narrow,
  navigationUnsettled,
  inputId,
  guidanceId,
  members,
  attachmentStaged,
  onStagingChange,
  onInvite,
  onMentionStart,
  onEdit,
  onAnnounce,
  mentionRef,
  insertRef,
}: MessageComposerProps) {
  const { t, i18n } = useTranslation()
  const demoCopy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const composerBox = useRef<HTMLDivElement>(null)
  const text = useDraftSlice(draft, textOf)
  const replyTo = useDraftSlice(draft, replyOf)
  const editing = useDraftSlice(draft, editOf)
  const replyToEventId = inRoom(replyTo, roomId)
  const editingEventId = inRoom(editing, roomId)
  // The text of an edit whose room is no longer the channel's is not shown, so never sent.
  const staleEdit = editing !== null && editingEventId === null
  const composerText = staleEdit ? '' : text
  // A reply goes as one only while its banner shows: to a message of this room, still in the
  // loaded timeline.
  const replyTargetIn = useCallback(
    () =>
      replyToEventId === null
        ? undefined
        : store.getTimeline(roomId).find((candidate) => candidate.eventId === replyToEventId),
    [store, roomId, replyToEventId]
  )
  const replyBannerTarget = useStoreSlice(store.subscribe, store.getSnapshot, replyTargetIn)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // A « :nom: » still in the text, pasted for instance, goes as its emoji. The mentions are read
    // from the text as typed, so a member whose name holds a code is still named.
    const typed = composerText.trim()
    const trimmed = transformOutsideCode(typed, replaceShortcodes)
    if (trimmed === '' || navigationUnsettled || attachmentStaged) return
    store.setTyping?.(roomId, false)
    if (editing !== null) {
      // An edit started in another room is dropped, never sent here, as an edit or as a message.
      draft.command(
        () => {
          if (editingEventId !== null) void store.edit(roomId, editingEventId, trimmed)
        },
        { editing: null, text: '' }
      )
      return
    }
    const options: SendOptions = mentioning(typed, members)
    // Otherwise the text goes to this room on its own.
    if (replyBannerTarget !== undefined) {
      options.replyTo = replyBannerTarget.eventId
    }
    draft.command(
      () => {
        void store.send(roomId, trimmed, options)
      },
      { replyTo: null, text: '' }
    )
  }

  /** `ArrowUp` in the empty channel composer: the newest own message, edited. */
  function keyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.shiftKey || composerText !== '' || editing !== null) return
    if (composing(event) || navigationUnsettled) return
    const newest = newestEditable(store.getTimeline(roomId), viewerId)
    if (newest === undefined) return
    event.preventDefault()
    onEdit(newest)
    // A screen reader passes `ArrowUp` through to re-read the line: the field turning into an
    // edit is said, or the next `Enter` would save over the message unawares.
    onAnnounce(t('console.workspace.shortcuts.announce-editing'))
  }

  return (
    <>
      <TypingLine store={store} roomId={roomId} />
      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
        {replyBannerTarget !== undefined ? (
          <div className="flex items-center justify-between gap-2 rounded-md bg-c-sunken px-3 py-2 text-xs text-c-ink-2">
            <span>
              <Trans
                i18nKey="console.workspace.message.reply-banner"
                components={{
                  author: <strong>{nameOf(replyBannerTarget)}</strong>,
                }}
              />
            </span>
            <Button variant="secondary" size="sm" onClick={() => draft.update({ replyTo: null })}>
              {t('console.workspace.composer.reply-cancel')}
            </Button>
          </div>
        ) : null}
        {editingEventId !== null ? (
          <div className="flex items-center justify-between gap-2 rounded-md bg-c-sunken px-3 py-2 text-xs text-c-ink-2">
            <span>{t('console.workspace.composer.edit-label')}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => draft.update({ editing: null, text: '' })}
            >
              {t('console.workspace.composer.edit-cancel')}
            </Button>
          </div>
        ) : null}
        {/* Reference screen p02: the field above its tools, one bordered box, which greys
        and rings as a whole, as TextField does. The dark workspace reference sets it
        in a muted well (docs/specs/workspace-dark-roles.md); its input edge stays, at
        3.21 / 3.71 / 3.26 : 1 on that well, since a text field needs a boundary
        (WCAG 1.4.11). */}
        {simulation ? (
          <p id={guidanceId} className="mb-2 text-xs text-c-ink-2">
            {demoCopy.composer}
          </p>
        ) : null}
        <div
          ref={composerBox}
          className={cx(
            'composer-frame-focus flex items-center gap-1 rounded-lg border px-2 focus-within:ring',
            navigationUnsettled
              ? 'border-c-border bg-c-disabled'
              : 'border-c-border-input bg-c-muted focus-within:border-c-accent-ink'
          )}
        >
          <label htmlFor={inputId} className="sr-only">
            {t('console.workspace.composer.label-message', {
              channel: channelName,
            })}
          </label>
          <RichComposerInput
            scope={roomId}
            onInvite={onInvite}
            onStagingChange={onStagingChange}
            id={inputId}
            aria-describedby={simulation ? guidanceId : undefined}
            value={composerText}
            onValueChange={(next) => {
              draft.update({
                text: next,
                ...(staleEdit ? { editing: null } : {}),
              })
              // A new message being written, not an edit of a sent one.
              store.setTyping?.(roomId, next.trim() !== '' && editingEventId === null)
            }}
            members={members}
            listLabel={t('console.workspace.composer.label-mention-list')}
            emojiListLabel={t('console.workspace.composer.label-emoji-list')}
            onMentionStart={onMentionStart}
            mentionRef={mentionRef}
            insertRef={insertRef}
            onKeyDown={keyDown}
            {...(narrow
              ? {}
              : {
                  'aria-keyshortcuts':
                    'Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown',
                })}
            placeholder={
              simulation
                ? demoCopy.placeholder
                : t('console.workspace.composer.placeholder-message', {
                    channel: channelName,
                  })
            }
            // Read-only, not `disabled`, while the address is undecided: a disabled
            // field drops the focus to the page, and a channel shortcut pressed while
            // writing must leave it in the field. Sending is refused at submit.
            readOnly={navigationUnsettled}
            aria-disabled={navigationUnsettled || undefined}
            className={cx(
              'min-w-0 flex-1 bg-transparent px-1 py-2 text-md outline-hidden',
              navigationUnsettled
                ? 'text-c-on-disabled placeholder:text-c-on-disabled'
                : 'text-c-ink placeholder:text-c-placeholder',
              'aria-disabled:cursor-not-allowed',
              TOUCH_TARGET_HEIGHT
            )}
          />
          <div className="flex shrink-0 items-center gap-1">
            {/* p02's `.icon-btn`, drawn as the thread panel's close button is. */}
            <Tooltip content={t('console.workspace.composer.action-mention')} names>
              <button
                type="button"
                aria-label={t('console.workspace.composer.action-mention')}
                disabled={navigationUnsettled}
                onClick={() => mentionRef.current?.()}
                className={cx(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
                  'hover:bg-c-sunken hover:text-c-ink',
                  'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
                  TOUCH_TARGET,
                  'focus-visible:ring focus-visible:outline-hidden'
                )}
              >
                <MentionIcon />
              </button>
            </Tooltip>
            <EmojiPalette
              disabled={navigationUnsettled}
              anchorRef={composerBox}
              onPick={(emoji) => insertRef.current?.(emoji)}
            />
            {/* Icons only (owner decision): the name, « Envoyer » or « Enregistrer »
              while editing, is the accessible name and the tooltip. Enter still sends. */}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<SendIcon />}
              iconOnly
              aria-label={t(
                editingEventId !== null
                  ? 'console.workspace.composer.action-save'
                  : 'console.workspace.composer.action-send'
              )}
              disabled={navigationUnsettled || attachmentStaged}
              className="ml-auto"
            />
          </div>
        </div>
      </form>
    </>
  )
}

export const MessageComposer = memo(MessageComposerView)

export interface ThreadComposerProps {
  store: EspaceStoreLike
  roomId: string
  /** The message the thread hangs from: where a reply goes. */
  rootEventId: string
  draft: DraftChannel
  simulation: boolean
  navigationUnsettled: boolean
  inputId: string
  guidanceId: string
  members: readonly MentionCandidate[]
  onMentionStart: () => void
}

/** The open thread's reply field: its text is the draft's, kept apart from the channel's own. */
export const ThreadComposer = memo(function ThreadComposer({
  store,
  roomId,
  rootEventId,
  draft,
  simulation,
  navigationUnsettled,
  inputId,
  guidanceId,
  members,
  onMentionStart,
}: ThreadComposerProps) {
  const { t, i18n } = useTranslation()
  const demoCopy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const threadText = useDraftSlice(draft, threadTextOf)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const typed = threadText.trim()
    const trimmed = transformOutsideCode(typed, replaceShortcodes)
    if (trimmed === '') return
    if (navigationUnsettled) return
    draft.command(
      () => {
        void store.send(roomId, trimmed, {
          ...mentioning(typed, members),
          threadRootId: rootEventId,
        })
      },
      { threadText: '' }
    )
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 pt-2">
      <label htmlFor={inputId} className="sr-only">
        {t('console.workspace.thread.composer-label')}
      </label>
      <MentionInput
        id={inputId}
        value={threadText}
        onValueChange={(next) => draft.update({ threadText: next })}
        members={members}
        listLabel={t('console.workspace.composer.label-mention-list')}
        emojiListLabel={t('console.workspace.composer.label-emoji-list')}
        onMentionStart={onMentionStart}
        placeholder={
          simulation ? demoCopy.placeholder : t('console.workspace.thread.composer-placeholder')
        }
        aria-describedby={simulation ? guidanceId : undefined}
        disabled={navigationUnsettled}
        className={cx(
          'min-w-0 flex-1 rounded-lg border border-c-border-input bg-c-muted px-3 py-2 text-md text-c-ink',
          'focus-visible:ring focus-visible:outline-hidden',
          'disabled:cursor-not-allowed disabled:bg-c-disabled disabled:text-c-on-disabled'
        )}
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        icon={<SendIcon />}
        iconOnly
        aria-label={t('console.workspace.thread.action-reply')}
        disabled={navigationUnsettled}
      />
    </form>
  )
})
