// Starting a direct conversation by choosing people, not by typing their ids. Until this existed
// the only way in was a free-text field: a member had to open someone's profile, copy an
// `@uuid:host` and paste it — so the people already in the workspace were the hardest to reach.
//
// The list is the union of every resolved channel's roster (`workspaceRoster.ts`): the closest
// thing to a member directory the Matrix layer can answer without a new Core surface. The field
// stays, below the list and clearly secondary, because a federated peer is in no room here and
// can only be named by id.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import { TextField } from '../../ui/TextField/TextField'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
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
  const { t } = useTranslation()
  const listId = useId()
  const viewerId = store.getUserId()
  const snapshot = useStoreSlice(store.subscribe, store.getSnapshot, (value) => value)
  const roster = useMemo(
    () => workspaceRosterOf(store, snapshot, searchEntries, viewerId),
    [store, snapshot, searchEntries, viewerId]
  )
  const [term, setTerm] = useState('')
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [manual, setManual] = useState('')
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

  const shown = useMemo(() => filterWorkspaceRoster(roster, term), [roster, term])
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
    store.openDirect(people).then(
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
          onChange={(event) => setTerm(event.target.value)}
          {...(shown.length === 0 && roster.length > 0
            ? { help: t('console.workspace.directs.empty-search') }
            : {})}
        />
        {roster.length === 0 ? (
          <p className="text-sm text-c-ink-3">{t('console.workspace.directs.empty-roster')}</p>
        ) : (
          <ul
            id={listId}
            aria-label={t('console.workspace.directs.label-members')}
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
                        {member.channels.map((channel) => `#${channel}`).join(' · ')}
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
        <p role="status" className="text-sm text-c-bad-ink empty:sr-only">
          {problem || (tooMany ? t('console.workspace.directs.problem-too-many') : '')}
        </p>
      </div>
    </Dialog>
  )
}
