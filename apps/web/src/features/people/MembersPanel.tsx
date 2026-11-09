// docs/specs/03-people.md §4.1 and §5 (`list` row): search, role filter,
// the "Inviter" menu, the members table with its row menu, the cursor "load
// more", and the empty, error and offline states.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import type { MessageKey } from '../../i18n'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Badge } from '../../ui/Badge/Badge'
import { Button } from '../../ui/Button/Button'
import { ConfirmDestructive } from '../../ui/ConfirmDestructive/ConfirmDestructive'
import { Dialog } from '../../ui/Dialog/Dialog'
import { DropdownMenu, type DropdownMenuEntry } from '../../ui/DropdownMenu/DropdownMenu'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Select } from '../../ui/Select/Select'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowActions,
  TableStatusCell,
} from '../../ui/Table/Table'
import { TextField } from '../../ui/TextField/TextField'
import { useToast } from '../../ui/Toast/Toast'
import { useLocale } from '../invoices/useLocale'
import { trackMemberRemoved, trackRoleChanged } from './analytics'
import { formatLastSeen, personName, ROLE_ACTION, ROLE_LABEL } from './format'
import type { PeopleTarget } from './PeopleScreen'
import {
  changeRole,
  PAGE_SIZE,
  removeMembership,
  useInvalidatePeople,
  useMembershipsQuery,
  type MemberFilter,
  type Membership,
} from './queries'
import { fetchMembership, membershipProblem, sameAsShown, staleRecord } from './memberActions'
import { mayRemove, roleChangeTargets, type OrganisationRole } from './roles'
import { resendFailureKey, useResendInvitation } from './resendInvitation'
import { offers } from '../../app/capabilities'

export interface MembersPanelProps {
  organisationId: string
  callerRole: OrganisationRole
  callerMembershipId: string
  onNavigate: (target: PeopleTarget) => void
}

type Pending = { kind: 'remove'; member: Membership } | { kind: 'owner'; member: Membership } | null

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function MembersPanel({
  organisationId,
  callerRole,
  callerMembershipId,
  onNavigate,
}: MembersPanelProps) {
  const { t } = useTranslation()
  const locale = useLocale()
  const notify = useToast()
  const online = useOnlineStatus()
  const invalidate = useInvalidatePeople(organisationId)
  const resendInvitation = useResendInvitation(organisationId)
  const [filter, setFilter] = useState<MemberFilter>('all')
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim().toLowerCase(), 300)
  const [pending, setPending] = useState<Pending>(null)
  // "Dernière connexion" is relative to when the list was opened.
  const [now] = useState(Date.now)
  const searchRef = useRef<HTMLInputElement>(null)

  // §10: "/" focuses the search from anywhere on the screen, unless the
  // person is already typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const memberships = useMembershipsQuery(organisationId, filter)

  const rows = (memberships.data?.pages ?? []).flatMap((page) => page.data)
  // No search parameter in the contract: the search narrows the rows loaded.
  const visible =
    query.length === 0
      ? rows
      : rows.filter((m) => `${m.display_name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(query))
  const alone =
    filter === 'all' && query.length === 0 && !memberships.hasNextPage && rows.length <= 1

  /** A refusal; when the row moved or went meanwhile, the list shows it as the server holds it. */
  const refused = (error: unknown, otherwise: MessageKey) => {
    if (staleRecord(error)) void invalidate()
    notify({ kind: 'error', title: t(membershipProblem(error, otherwise)) })
  }

  /** A read made now, for its tag. When the row changed since it was shown, nothing is sent: the
   * list shows it again and says why (03-people.md §4.5). */
  async function readAsShown(member: Membership) {
    const fresh = await fetchMembership(organisationId, member.id)
    if (sameAsShown(fresh, member)) return fresh
    await invalidate()
    notify({ kind: 'error', title: t('console.people.members.error-changed-meanwhile') })
    return null
  }

  async function applyRole(member: Membership, role: OrganisationRole) {
    try {
      const fresh = await readAsShown(member)
      if (fresh === null) return
      await changeRole(organisationId, fresh, role)
      trackRoleChanged(fresh.value.role, role)
      await invalidate()
      notify({
        kind: 'success',
        title: t('console.people.members.toast-role-changed', {
          person: personName(member),
          role: t(ROLE_LABEL[role]).toLowerCase(),
        }),
      })
    } catch (error) {
      refused(error, 'console.people.members.error-role-change-failed')
    }
  }

  async function remove(member: Membership) {
    try {
      // Only the row as shown is removed, and only when Core still offers it; a change landing
      // after this read is refused (`412`).
      const fresh = await readAsShown(member)
      if (fresh === null) return
      if (!fresh.value.can_remove) {
        await invalidate()
        notify({
          kind: 'error',
          title: t(
            fresh.value.blocked_reason === 'last_owner'
              ? 'console.people.members.error-last-owner'
              : 'console.people.members.error-forbidden'
          ),
        })
        return
      }
      await removeMembership(organisationId, fresh)
      trackMemberRemoved()
      await invalidate()
      notify({
        kind: 'success',
        title: t('console.people.members.toast-removed', { person: personName(member) }),
      })
    } catch (error) {
      refused(error, 'console.common.error-unavailable')
    }
  }

  function menuFor(member: Membership): DropdownMenuEntry[] {
    // The API refuses a change to one's own membership (`blocked_reason:
    // self`); the drawer, not a menu that fails on confirm, says why.
    if (member.id === callerMembershipId) return []
    const entries: DropdownMenuEntry[] = roleChangeTargets(callerRole, member.role).map((role) => ({
      label: t(ROLE_ACTION[role]),
      disabled: !online,
      onSelect: () =>
        role === 'org_owner' ? setPending({ kind: 'owner', member }) : void applyRole(member, role),
    }))
    if (member.state === 'invited') {
      entries.push({
        label: t('console.people.members.action-resend'),
        disabled: !online,
        onSelect: () => void resendPending(member),
      })
    }
    if (mayRemove(callerRole, member.role)) {
      if (entries.length > 0) entries.push({ type: 'separator' })
      entries.push({
        label: t('console.people.members.action-remove'),
        destructive: true,
        disabled: !online,
        onSelect: () => setPending({ kind: 'remove', member }),
      })
    }
    return entries
  }

  async function resendPending(member: Membership) {
    try {
      const fresh = await fetchMembership(organisationId, member.id)
      const invitationId = fresh.value.invitation_id
      if (invitationId === null || invitationId === undefined) throw new Error('No invitation.')
      await resendInvitation(invitationId)
      notify({
        kind: 'success',
        title: t('console.people.members.toast-resent', { person: personName(member) }),
      })
    } catch (error) {
      notify({ kind: 'error', title: t(resendFailureKey(error)) })
    }
  }

  // Each tab panel opens with its own h2 so the empty state's h3 and the
  // On-site panel's h2 sit in one outline under the page h1.
  const heading = <h2 className="sr-only">{t('console.people.list.label-tab-members')}</h2>

  if (alone && !memberships.isLoading && !memberships.isError) {
    return (
      <>
        {heading}
        <EmptyState
          title={t('console.people.list.empty-title')}
          body={t(
            offers('member-import')
              ? 'console.people.list.empty-body'
              : 'console.people.list.empty-body-email'
          )}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button onClick={() => onNavigate({ to: 'invite' })}>
                {t('console.people.list.action-invite-email')}
              </Button>
              {offers('member-import') ? (
                <Button variant="secondary" onClick={() => onNavigate({ to: 'import' })}>
                  {t('console.people.list.action-invite-import')}
                </Button>
              ) : null}
            </div>
          }
        />
      </>
    )
  }

  const canInvite = callerRole === 'org_owner' || callerRole === 'org_admin'
  const inviteItems: DropdownMenuEntry[] = [
    {
      label: t('console.people.list.action-invite-email'),
      onSelect: () => onNavigate({ to: 'invite' }),
    },
    // Each hidden while Core does not serve it (`src/app/capabilities.ts`).
    ...(offers('member-import')
      ? [
          {
            label: t('console.people.list.action-invite-import'),
            onSelect: () => onNavigate({ to: 'import' }),
          },
        ]
      : []),
    ...(offers('on-site-enrolment')
      ? [
          {
            label: t('console.people.list.action-invite-on-site'),
            onSelect: () => onNavigate({ to: 'on-site' }),
          },
        ]
      : []),
  ]

  return (
    <div className="flex flex-col gap-4">
      {heading}
      {online ? null : (
        <InlineAlert kind="warning">{t('console.common.error-offline')}</InlineAlert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <TextField
            ref={searchRef}
            type="search"
            label={t('console.people.list.placeholder-search')}
            placeholder={t('console.people.list.placeholder-search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search.length > 0) {
                event.stopPropagation()
                setSearch('')
              }
            }}
          />
        </div>
        <Select
          label={t('console.people.list.label-filter-role')}
          value={filter}
          onValueChange={(value) => setFilter(value as MemberFilter)}
          options={[
            { value: 'all', label: t('console.people.list.label-filter-all') },
            { value: 'admins', label: t('console.people.list.label-filter-admins') },
            { value: 'pending', label: t('console.people.list.label-filter-pending') },
          ]}
        />
        {canInvite && inviteItems.length === 1 ? (
          // One way to invite (the pilot, `src/app/capabilities.ts`): a menu of one is a wasted click.
          <Button onClick={() => onNavigate({ to: 'invite' })}>
            {t('console.people.list.action-invite')}
          </Button>
        ) : canInvite ? (
          <DropdownMenu
            label={t('console.people.list.action-invite')}
            trigger={<Button>{t('console.people.list.action-invite')}</Button>}
            items={inviteItems}
          />
        ) : null}
      </div>

      {memberships.isError && rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <InlineAlert kind="error">{t('console.people.list.error-load-failed')}</InlineAlert>
          <Button variant="secondary" onClick={() => void memberships.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : (
        <Table caption={t('console.people.list.title')}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('console.people.list.label-column-name')}</TableHeaderCell>
              <TableHeaderCell>{t('console.people.list.label-column-email')}</TableHeaderCell>
              <TableHeaderCell>{t('console.people.list.label-column-role')}</TableHeaderCell>
              <TableHeaderCell status>
                {t('console.people.list.label-column-last-sign-in')}
              </TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">{t('console.people.list.label-column-actions')}</span>
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody aria-busy={memberships.isLoading ? true : undefined}>
            {memberships.isLoading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <span role="status" className="sr-only">
                    {t('console.common.a11y-loading')}
                  </span>
                  <span
                    aria-hidden="true"
                    className="block h-4 w-2/3 animate-pulse rounded-sm bg-c-muted-2"
                  />
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <p>{t('console.people.list.empty-search', { query: search.trim() })}</p>
                    <Button variant="secondary" onClick={() => setSearch('')}>
                      {t('console.people.list.action-clear-search')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((member) => {
                const name = personName(member)
                const menu = menuFor(member)
                return (
                  <TableRow key={member.id}>
                    <TableHeaderCell
                      scope="row"
                      className="text-md font-regular text-c-ink normal-case"
                    >
                      <span className="flex items-center gap-3">
                        <Avatar
                          aria-hidden="true"
                          name={name}
                          variant={
                            member.state === 'invited'
                              ? 'pending'
                              : member.role === 'org_owner' || member.role === 'org_admin'
                                ? 'admin'
                                : 'member'
                          }
                        />
                        <button
                          type="button"
                          data-member-id={member.id}
                          className="text-left font-medium text-c-ink"
                          onClick={() => onNavigate({ to: 'member', memberId: member.id })}
                        >
                          {name}
                        </button>
                      </span>
                    </TableHeaderCell>
                    <TableCell className="max-w-[240px] truncate">
                      {member.email === undefined || member.email.length === 0 ? '—' : member.email}
                    </TableCell>
                    <TableCell>
                      <Badge>{t(ROLE_LABEL[member.role])}</Badge>
                    </TableCell>
                    <TableStatusCell>
                      {member.state === 'invited' ? (
                        <StatusPill state="info">
                          {t('console.people.list.status-invited')}
                        </StatusPill>
                      ) : member.account_kind === 'on_site' ? (
                        <StatusPill state="neutral">
                          {t('console.people.list.status-on-site')}
                        </StatusPill>
                      ) : member.last_seen_at === null || member.last_seen_at === undefined ? (
                        <StatusPill state="neutral">
                          {t('console.people.list.status-never-signed-in')}
                        </StatusPill>
                      ) : (
                        formatLastSeen(member.last_seen_at, now, locale)
                      )}
                    </TableStatusCell>
                    <TableRowActions>
                      {menu.length === 0 ? null : (
                        <DropdownMenu
                          label={t('console.people.list.a11y-row-actions', { person: name })}
                          items={menu}
                          trigger={
                            <Button
                              variant="tertiary"
                              size="sm"
                              aria-label={t('console.people.list.a11y-row-actions', {
                                person: name,
                              })}
                            >
                              ⋯
                            </Button>
                          }
                        />
                      )}
                    </TableRowActions>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      )}

      {memberships.hasNextPage ? (
        <div className="flex flex-col items-center gap-2">
          {memberships.isFetchNextPageError ? (
            <InlineAlert kind="error">{t('console.people.list.error-load-failed')}</InlineAlert>
          ) : null}
          <Button
            variant="secondary"
            loading={memberships.isFetchingNextPage}
            onClick={() => void memberships.fetchNextPage()}
          >
            {t('console.common.action-load-more', { count: PAGE_SIZE })}
          </Button>
        </div>
      ) : null}

      {pending?.kind === 'remove' ? (
        <ConfirmDestructive
          key={`remove-${pending.member.id}`}
          defaultOpen
          initialFocus="title"
          onOpenChange={(open) => (open ? undefined : setPending(null))}
          title={t('console.people.members.confirm-remove-title', {
            person: personName(pending.member),
          })}
          consequence={t('console.people.members.confirm-remove-body', {
            person: personName(pending.member),
          })}
          confirmLabel={t('console.people.members.action-confirm-remove', {
            person: personName(pending.member),
          })}
          cancelLabel={t('console.common.action-cancel')}
          closeLabel={t('console.common.action-close')}
          onConfirm={() => void remove(pending.member)}
        />
      ) : null}
      {pending?.kind === 'owner' ? (
        <Dialog
          key={`owner-${pending.member.id}`}
          open
          initialFocus="title"
          onOpenChange={(open) => (open ? undefined : setPending(null))}
          size="sm"
          title={t('console.people.members.confirm-owner-title', {
            person: personName(pending.member),
          })}
          description={t('console.people.members.confirm-owner-body')}
          closeLabel={t('console.common.action-close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {t('console.common.action-cancel')}
              </Button>
              <Button
                onClick={() => {
                  const member = pending.member
                  setPending(null)
                  void applyRole(member, 'org_owner')
                }}
              >
                {t('console.people.members.action-confirm-owner')}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </div>
  )
}
