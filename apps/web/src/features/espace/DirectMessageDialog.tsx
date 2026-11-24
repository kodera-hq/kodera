import { directoryMessages } from './directoryMessages'
// The picker combines known channel rosters with authoritative IDs the homeserver directory
// makes discoverable. A directory result does not assert workspace membership. Manual federated
// IDs remain available for a person the server does not expose in search.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import { TextField } from '../../ui/TextField/TextField'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { defaultE2eeForConversationSurface } from './encryptionTiers'
import { safeDisplayName, type EspaceStoreLike } from './liveViewModel'
import { isMatrixUserId } from './roomInvitations'
import { useStoreSlice } from './useStoreSlice'
import {
  filterWorkspaceRoster,
  loadWorkspaceRoster,
  workspaceRosterOf,
  type WorkspaceMember,
} from './workspaceRoster'

/** A direct conversation holds one to eight people besides the member (`matrix/directs.ts`). */
const MAX_PEOPLE = 8

export interface DirectMessageDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly store: EspaceStoreLike
  /** Every channel of the workspace: where the roster is gathered from. */
  readonly searchEntries: readonly ChannelSearchEntry[]
  /** Called with the room the conversation lives in, once it is open. */
  readonly onOpened: (roomId: string) => void
}

// Mounted only while it is open (`DirectMessages.tsx`), so closing it unmounts it and every
// choice made in it goes with it: there is nothing to reset.
export function DirectMessageDialog({
  open,
  onOpenChange,
  store,
  searchEntries,
  onOpened,
}: DirectMessageDialogProps) {
  const { t, i18n } = useTranslation()
  const copy = directoryMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const listId = useId()
  const viewerId = store.getUserId()
  const snapshot = useStoreSlice(store.subscribe, store.getSnapshot, (value) => value)
  const roster = useMemo(
    () => workspaceRosterOf(store, snapshot, searchEntries, viewerId),
    [store, snapshot, searchEntries, viewerId]
  )
  const [term, setTerm] = useState('')
  const [directory, setDirectory] = useState<{
    store: EspaceStoreLike
    query: string
    members: readonly WorkspaceMember[]
    failed: boolean
  } | null>(null)
  const query = term.trim()
  useEffect(() => {
    if (!open || store.searchMembers === undefined || query.length < 2) return
    let current = true
    const timer = setTimeout(() => {
      void store.searchMembers!(query).then(
        (members) => {
          if (!current) return
          const checked = members.filter(
            (member) =>
              member.userId !== viewerId &&
              isMatrixUserId(member.userId) &&
              !/^@(kodera-agent|room-access):/.test(member.userId)
          )
          setDirectory({
            store,
            query,
            members: checked.slice(0, 30).map((member) => ({ ...member, channels: [] })),
            failed: false,
          })
        },
        () => {
          if (current) setDirectory({ store, query, members: [], failed: true })
        }
      )
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [open, store, query, viewerId])

  const [chosen, setChosen] = useState<readonly string[]>([])
  const [manual, setManual] = useState('')
  const [encrypted, setEncrypted] = useState(() =>
    defaultE2eeForConversationSurface('direct_message')
  )
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(!open)

  useEffect(() => {
    cancelled.current = !open
    return () => {
      cancelled.current = true
    }
  }, [open])

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) cancelled.current = true
    onOpenChange(nextOpen)
  }

  // The sync brings only the members it has seen; the whole list is a request per room, made once
  // the dialog is open — never while it is closed, so opening the workspace costs nothing.
  useEffect(() => {
    if (!open) return
    loadWorkspaceRoster(store, snapshot, searchEntries)
    // `snapshot` is read, not depended on: a new one must not fire the request again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, store, searchEntries])

  const matchingDirectory =
    directory?.store === store && directory.query === query ? directory : null
  const shown = useMemo(() => {
    const byId = new Map(
      filterWorkspaceRoster(roster, term).map((member) => [member.userId, member])
    )
    for (const member of matchingDirectory?.members ?? [])
      if (!byId.has(member.userId)) byId.set(member.userId, member)
    return [...byId.values()]
  }, [roster, term, matchingDirectory])
  const unnamed = t('console.workspace.members.unnamed')
  /**
   * The name a row draws. A display name is whatever the member set for themselves in a room, so
   * it is not an identity: two people can carry the same one, and a direction-override character
   * inside it can make it read as somebody else's. The characters are stripped (`cleanText`, the
   * same rule the link cards use) and the row draws the Matrix id underneath, which is what
   * `openDirect` is actually given.
   */
  const nameOf = (member: WorkspaceMember) => safeDisplayName(member.name, member.userId, unnamed)
  /** This member's own homeserver: anyone else's is another server's account. */
  const homeserver = viewerId.split(':').slice(1).join(':')

  const manualIds = manual
    .split(/[\s,;]+/u)
    .map((id) => id.trim())
    .filter((id) => id !== '')
  const people = [...chosen, ...manualIds.filter((id) => !chosen.includes(id))]
  const tooMany = people.length > MAX_PEOPLE

  function toggle(userId: string) {
    setProblem('')
    setChosen((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId].slice(0, MAX_PEOPLE)
    )
  }

  function start() {
    if (busy || store.openDirect === undefined || people.length === 0 || tooMany) return
    const invalid = manualIds.find((id) => !isMatrixUserId(id))
    if (invalid !== undefined) {
      setProblem(t('console.workspace.directs.problem-id'))
      return
    }
    setProblem('')
    setBusy(true)
    store.openDirect(people, { encrypted }).then(
      (roomId) => {
        if (cancelled.current) return
        setBusy(false)
        onOpenChange(false)
        onOpened(roomId)
      },
      (error: unknown) => {
        if (cancelled.current) return
        setBusy(false)
        setProblem(
          error instanceof Error && error.message === 'Invalid Matrix user ID'
            ? t('console.workspace.directs.problem-id')
            : t('console.workspace.directs.problem-open')
        )
      }
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('console.workspace.directs.title-new')}
      description={t('console.workspace.directs.help-new')}
      closeLabel={t('console.common.action-close')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => handleOpenChange(false)}>
            {t('console.common.action-cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={busy || people.length === 0 || tooMany}
            onClick={start}
          >
            {t('console.workspace.directs.action-open')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label={t('console.workspace.directs.field-search')}
          value={term}
          maxLength={80}
          onChange={(event) => setTerm(event.target.value)}
          {...(shown.length === 0 && roster.length > 0
            ? { help: t('console.workspace.directs.empty-search') }
            : {})}
        />
        {store.searchMembers === undefined ? null : (
          <p className="text-xs text-c-ink-3">
            {matchingDirectory?.failed ? copy.unavailable : copy.hint}
          </p>
        )}
        {shown.length === 0 ? (
          <p className="text-sm text-c-ink-3">
            {t(
              query.length > 0
                ? 'console.workspace.directs.empty-search'
                : 'console.workspace.directs.empty-roster'
            )}
          </p>
        ) : (
          <ul
            id={listId}
            aria-label={
              matchingDirectory?.members.length
                ? copy.label
                : t('console.workspace.directs.label-members')
            }
            className="flex max-h-[320px] flex-col gap-1 overflow-y-auto"
          >
            {shown.map((member) => {
              const picked = chosen.includes(member.userId)
              const online = store.isOnline?.(member.userId) === true
              return (
                <li key={member.userId}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    onClick={() => toggle(member.userId)}
                    className={cx(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left',
                      TOUCH_TARGET_HEIGHT,
                      'hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                      'motion-safe:transition-colors motion-safe:duration-150',
                      picked ? 'bg-c-accent-soft text-c-accent-ink' : 'text-c-ink'
                    )}
                  >
                    <Avatar
                      name={nameOf(member)}
                      identity={member.userId}
                      {...(online
                        ? { onlineLabel: t('console.workspace.members.state-online') }
                        : {})}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {nameOf(member)}
                        {member.userId.split(':').slice(1).join(':') === homeserver ? null : (
                          <span className="ml-2 rounded-sm border border-c-border-soft px-1 text-xs font-medium text-c-ink-3">
                            {t('console.workspace.directs.label-federated')}
                          </span>
                        )}
                      </span>
                      {/* The id, always: it is what the conversation is opened with, and the only
                          thing above it that nobody else can take. */}
                      <span className="truncate font-mono text-xs text-c-ink-3">
                        <bdi dir="ltr">{member.userId}</bdi>
                      </span>
                      <span className="truncate text-xs text-c-ink-3">
                        {member.channels.length === 0
                          ? copy.result
                          : member.channels.map((channel) => `#${channel}`).join(' · ')}
                      </span>
                    </span>
                    {picked ? (
                      <span className="shrink-0 text-xs font-semibold">
                        {t('console.workspace.directs.label-chosen')}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <details className="border-t border-c-border-soft pt-3">
          <summary className="cursor-pointer text-sm text-c-ink-2 focus-visible:ring focus-visible:outline-hidden">
            {t('console.workspace.directs.title-federated')}
          </summary>
          <div className="pt-3">
            <TextField
              label={t('console.workspace.directs.field-people')}
              help={t('console.workspace.directs.help-people')}
              value={manual}
              onChange={(event) => setManual(event.target.value)}
            />
          </div>
        </details>
        <div className="flex flex-col gap-1 rounded-md border border-c-border-soft p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-c-ink">
            <input
              type="checkbox"
              checked={encrypted}
              onChange={(event) => setEncrypted(event.target.checked)}
              className="h-4 w-4 rounded-sm border-c-border-input"
            />
            <span>{copy.e2eeLabel}</span>
          </label>
          <p className="text-xs text-c-ink-3">{copy.e2eeHelp}</p>
        </div>
        <p role="status" className="text-sm text-c-bad-ink empty:sr-only">
          {problem || (tooMany ? t('console.workspace.directs.problem-too-many') : '')}
        </p>
      </div>
    </Dialog>
  )
}
