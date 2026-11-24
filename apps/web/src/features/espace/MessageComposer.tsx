// Where the member writes: the channel's composer, with the line that says who else is writing,
// and a thread's reply field. Each reads its own text from the draft of the channel shown
// (`draftChannel.ts`), so a keystroke draws the field it was typed in and nothing else: not the
// message log, not the sidebar, not the view that holds them.

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import { demoMessages } from '../../app/demoMessages'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { MentionIcon, SendIcon } from '../../ui/icons/Composer'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET, TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { permitsPlaintext } from '../confidential/room-boundary'
import { AttachmentQueue, type QueuedFile } from '../messaging/attachments/attachmentQueue'
import { resolveAttachmentScope } from '../messaging/attachments/attachmentRefs'
import { VoiceNoteRecorder } from '../messaging/attachments/VoiceNoteRecorder'
import { transformOutsideCode } from '../messaging/formatting'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { RichComposerInput } from '../messaging/RichComposerInput'
import { pollMessages } from '../polls/pollMessages'
import { parsePollCommand, pollFallbackBody, type PollWirePayload } from '../polls/pollState'
import { pollStore } from '../polls/pollStore'
import { useDraftSlice, type DraftChannel } from './draftChannel'
import { replaceShortcodes } from './emoji'
import { EmojiPalette } from './EmojiPalette'
import type { ChannelDraft, RoomTarget } from './EspaceDraftProvider'
import { ScheduledMessagesBanner, SendLaterPopover } from './SendLaterPopover'
import {
  composing,
  nameOf,
  safeDisplayName,
  sameItems,
  type EspaceStoreLike,
} from './liveViewModel'
import type { MemberView, SendOptions } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { MentionInput } from './MentionInput'
import { hasMentionBoundaryAfter, mentionedIn, mentionsRoom, mentionTargetsIn } from './mentions'
import type { MentionCandidate } from './mentions'
import { newestEditable } from './shortcuts'
import { useStoreSlice } from './useStoreSlice'

const NO_TYPING: readonly MemberView[] = []
const NO_FILES: readonly QueuedFile[] = []
const noSubscription = () => () => {}

/**
 * The composer's uploads, for as long as it is mounted in a live workspace: none in the demo, where
 * there is no organisation to store a file in, and the files are only shown on the device.
 */
function useAttachmentQueue(store: EspaceStoreLike): AttachmentQueue | null {
  const permitted = (room: string) => {
    const boundary = store.getRoomBoundary?.(room)
    return (
      (boundary === undefined || permitsPlaintext(boundary)) &&
      store.canSendMessage?.(room) !== false
    )
  }
  const scopeOf = (room: string) => resolveAttachmentScope(room, store.getSnapshot().channels)
  const organisationId = useMessagingOrganisation()
  const [queue, setQueue] = useState<{
    organisationId: string | null
    store: EspaceStoreLike
    queue: AttachmentQueue | null
  }>(() => ({
    organisationId,
    store,
    queue:
      organisationId === null
        ? null
        : new AttachmentQueue(organisationId, undefined, permitted, scopeOf),
  }))
  if (queue.organisationId !== organisationId || queue.store !== store) {
    setQueue({
      organisationId,
      store,
      queue:
        organisationId === null
          ? null
          : new AttachmentQueue(organisationId, undefined, permitted, scopeOf),
    })
  }
  const current = queue.queue
  useEffect(() => () => current?.close(), [current])
  return current
}

/**
 * Who is typing, in words (gap report G9): one or two by name, as their messages are signed, and
 * any more as « Plusieurs personnes ». Empty when no one is.
 */
function typingLine(members: readonly MemberView[], t: TFunction): string {
  const unnamed = t('console.workspace.members.unnamed')
  const names = members.map(({ userId, name }) => safeDisplayName(name, userId, unnamed))
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

/**
 * Historical `{ userId, label }` candidates carried by an existing message (`mentionPills` and
 * `mentionedUsers`), so editing punctuation around an unchanged `@OldName` after a member renamed
 * themselves preserves their `m.mentions` identity and pill instead of dropping it.
 */
export function historicalMentionCandidates(
  message: Pick<MessageView, 'body' | 'mentionPills' | 'mentionedUsers'> | undefined,
  members: readonly MentionCandidate[]
): MentionCandidate[] {
  if (message === undefined) return []
  const candidates: MentionCandidate[] = []
  const seen = new Set<string>()
  const add = (userId: string, rawLabel: string) => {
    const label = rawLabel.trim()
    const key = `${userId}\n${label}`
    if (userId === '' || label === '' || seen.has(key)) return
    seen.add(key)
    candidates.push({ userId, label })
  }
  for (const pill of message.mentionPills ?? []) add(pill.userId, pill.label)
  for (const target of mentionTargetsIn(message.body, members)) add(target.userId, target.label)
  const mentionedUsers = message.mentionedUsers ?? []
  const localpartOwners = new Map<string, Set<string>>()
  const recordLocalpart = (userId: string) => {
    if (!userId.startsWith('@')) return
    const colon = userId.indexOf(':')
    const localpart = (colon > 1 ? userId.slice(1, colon) : userId.slice(1)).toLowerCase()
    if (localpart === '' || localpart === 'salon' || localpart === 'room') return
    let owners = localpartOwners.get(localpart)
    if (owners === undefined) {
      owners = new Set<string>()
      localpartOwners.set(localpart, owners)
    }
    owners.add(userId)
  }
  for (const member of members) recordLocalpart(member.userId)
  for (const userId of mentionedUsers) recordLocalpart(userId)

  for (const userId of mentionedUsers) {
    if (!userId.startsWith('@')) continue
    const mxidLabel = userId.slice(1)
    if (mentionTargetsIn(message.body, [{ userId, label: mxidLabel }]).length > 0) {
      add(userId, mxidLabel)
    }
    const colon = userId.indexOf(':')
    const rawLocalpart = colon > 1 ? userId.slice(1, colon) : userId.slice(1)
    const owners = localpartOwners.get(rawLocalpart.toLowerCase())
    if (owners !== undefined && owners.size === 1) {
      for (let at = message.body.indexOf('@'); at !== -1; at = message.body.indexOf('@', at + 1)) {
        if (at > 0 && !/\s/u.test(message.body[at - 1]!)) continue
        const rest = message.body.slice(at + 1)
        const slice = rest.slice(0, rawLocalpart.length)
        if (
          slice.toLowerCase() === rawLocalpart.toLowerCase() &&
          hasMentionBoundaryAfter(rest, slice)
        ) {
          add(userId, slice)
        }
      }
    }
  }
  return candidates
}

export function editMentionCandidates(
  members: readonly MentionCandidate[],
  retained: readonly MentionCandidate[] | undefined,
  original: Pick<MessageView, 'body' | 'mentionPills' | 'mentionedUsers'> | undefined
): MentionCandidate[] {
  const combined: MentionCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: MentionCandidate) => {
    const label = candidate.label.trim()
    const key = `${candidate.userId}\n${label}`
    if (candidate.userId === '' || label === '' || seen.has(key)) return
    seen.add(key)
    combined.push({ userId: candidate.userId, label })
  }
  for (const candidate of retained ?? []) push(candidate)
  for (const candidate of historicalMentionCandidates(original, members)) push(candidate)
  for (const candidate of members) push(candidate)
  return combined
}

/**
 * The members the text names, as `m.mentions` carries them, with the names the text writes them
 * by so the message's HTML links each as a pill; « @salon » sets `m.mentions.room`. Nothing when
 * it names no one.
 */
export function mentioning(text: string, members: readonly MentionCandidate[]): SendOptions {
  const userIds = mentionedIn(text, members)
  const room = mentionsRoom(text)
  if (userIds.length === 0 && !room) return {}
  const targets = mentionTargetsIn(text, members)
  return {
    mentions: userIds,
    ...(room ? { mentionsRoom: true } : {}),
    ...(targets.length === 0 ? {} : { mentionTargets: targets }),
  }
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
  /** A direct conversation: the field says the person written to, never « #channel ». */
  direct?: boolean | undefined
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
  direct = false,
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
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const demoCopy = demoMessages[locale]
  const organisationId = useMessagingOrganisation()
  const [pollError, setPollError] = useState<string | null>(null)
  const roomBoundary = store.getRoomBoundary?.(roomId)
  const plaintextPermitted = roomBoundary === undefined || permitsPlaintext(roomBoundary)
  const resolvedScope = resolveAttachmentScope(roomId, store.getSnapshot().channels)
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
  const uploads = useAttachmentQueue(store)
  const queued = useSyncExternalStore(
    uploads?.subscribe ?? noSubscription,
    () => uploads?.files(roomId) ?? NO_FILES
  )
  // Files still sending, or refused and not yet removed, hold the message back.
  const filesReady = uploads === null ? [] : uploads.readyRefs(roomId)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (store.canSendMessage?.(roomId) === false) return
    // A « :nom: » still in the text, pasted for instance, goes as its emoji. The mentions are read
    // from the text as typed, so a member whose name holds a code is still named.
    const typed = composerText.trim()
    const trimmed = transformOutsideCode(typed, replaceShortcodes)
    if (navigationUnsettled || attachmentStaged) return
    if (editing !== null) {
      if (trimmed === '') return
      store.setTyping?.(roomId, false)
      // An edit started in another room is dropped, never sent here, as an edit or as a message.
      const original =
        editingEventId === null
          ? undefined
          : store.getTimeline(roomId).find((candidate) => candidate.eventId === editingEventId)
      const editOptions = mentioning(
        typed,
        editMentionCandidates(members, editing.mentionTargets, original)
      )
      draft.command(
        () => {
          if (editingEventId === null) return
          if (Object.keys(editOptions).length === 0)
            void store.edit(roomId, editingEventId, trimmed)
          else void store.edit(roomId, editingEventId, trimmed, editOptions)
        },
        { editing: null, text: '' }
      )
      return
    }
    if (filesReady === null) return
    if (trimmed === '' && filesReady.length === 0) return
    if (
      filesReady.length === 0 &&
      (typed === '/poll' || typed.startsWith('/poll ') || typed.startsWith('/poll\n'))
    ) {
      if (!plaintextPermitted) {
        const forbiddenMsg = pollMessages[locale].errConfidentialForbidden
        setPollError(forbiddenMsg)
        onAnnounce(forbiddenMsg)
        return
      }
      const parsed = parsePollCommand(typed, locale)
      if (!parsed.ok) {
        setPollError(parsed.error)
        onAnnounce(parsed.error)
        return
      }
      setPollError(null)
      store.setTyping?.(roomId, false)
      const payload: PollWirePayload = {
        question: parsed.question,
        options: parsed.options,
        allowMultiple: parsed.allowMultiple,
        anonymous: false,
      }
      const authorName =
        store.getOwnProfile?.()?.displayName ??
        members.find((m) => m.userId === viewerId)?.label ??
        viewerId
      draft.command(
        () => {
          const optimistic = pollStore.recordLocalPoll({
            roomId,
            payload,
            createdBy: viewerId,
            createdByName: authorName,
            requireClientPollId: true,
          })
          const wirePayload: PollWirePayload = { ...payload, clientPollId: optimistic.id }
          Promise.resolve(store.send(roomId, pollFallbackBody(payload), { poll: wirePayload })).catch(
            () => {
              pollStore.removeLocalPoll(roomId, optimistic.id)
              const sendErr = pollMessages[locale].errSendFailed
              setPollError(sendErr)
              onAnnounce(sendErr)
            }
          )
        },
        { replyTo: null, text: '' }
      )
      return
    }
    setPollError(null)
    store.setTyping?.(roomId, false)
    const options: SendOptions = mentioning(typed, members)
    if (filesReady.length > 0) {
      options.attachments = filesReady
      uploads?.clear(roomId)
    }
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
        {pollError !== null ? (
          <p
            role="alert"
            data-testid="composer-poll-error"
            className="rounded-md bg-c-sunken px-3 py-2 text-xs text-c-bad-ink"
          >
            {pollError}
          </p>
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
        {editingEventId === null ? (
          <ScheduledMessagesBanner
            organisationId={organisationId}
            channelId={resolvedScope.channelId}
            roomId={roomId}
            plaintextPermitted={plaintextPermitted}
          />
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
            {direct
              ? t('console.workspace.composer.label-direct', { name: channelName })
              : t('console.workspace.composer.label-message', { channel: channelName })}
          </label>
          <RichComposerInput
            scope={roomId}
            onInvite={onInvite}
            onStagingChange={onStagingChange}
            uploads={editingEventId === null ? uploads : null}
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
            leadingTools={
              editingEventId === null && uploads !== null && composerText.trim() === '' ? (
                <VoiceNoteRecorder
                  roomId={roomId}
                  uploads={uploads}
                  plaintextPermitted={plaintextPermitted}
                  disabled={navigationUnsettled}
                />
              ) : null
            }
            trailing={
              <>
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
                  disabled={
                    navigationUnsettled ||
                    attachmentStaged ||
                    (editingEventId === null && queued.length > 0 && filesReady === null)
                  }
                  className="ml-auto"
                />
              </>
            }
            afterTrailing={
              editingEventId === null ? (
                <SendLaterPopover
                  organisationId={organisationId}
                  channelId={resolvedScope.channelId}
                  roomId={roomId}
                  plaintextPermitted={plaintextPermitted}
                  disabled={navigationUnsettled || attachmentStaged}
                  draftText={transformOutsideCode(composerText.trim(), replaceShortcodes)}
                  anchorRef={composerBox}
                  onScheduled={() => {
                    store.setTyping?.(roomId, false)
                    draft.update({ replyTo: null, text: '' })
                  }}
                />
              ) : null
            }
            {...(narrow
              ? {}
              : {
                  'aria-keyshortcuts':
                    'Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown',
                })}
            placeholder={
              simulation
                ? demoCopy.placeholder
                : direct
                  ? t('console.workspace.composer.placeholder-direct', { name: channelName })
                  : t('console.workspace.composer.placeholder-message', { channel: channelName })
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
    if (store.canSendMessage?.(roomId) === false) return
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
