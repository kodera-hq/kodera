// docs/specs/03-people.md §3 (`?tab=invitations`) and §6: pending
// invitations, each with resend and revoke. The expiry comes from
// `Invitation.expires_at`, never from a number written into the copy.

import { useLayoutEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import { formatDate } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
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
import { useToast } from '../../ui/Toast/Toast'
import { useLocale } from '../invoices/useLocale'
import { ROLE_LABEL } from './format'
import {
  PAGE_SIZE,
  peopleKeys,
  revokeInvitation,
  useInvalidatePeople,
  useInvitationsQuery,
  type Invitation,
} from './queries'
import { resendFailureKey, useResendInvitation } from './resendInvitation'

type InvitationData = NonNullable<ReturnType<typeof useInvitationsQuery>['data']>
type RevocationOwner = {
  client: ReturnType<typeof useQueryClient>
  organisationId: string
  live: boolean
}

export function InvitationsPanel({ organisationId }: { organisationId: string }) {
  const { t } = useTranslation()
  const locale = useLocale()
  const notify = useToast()
  const online = useOnlineStatus()
  const client = useQueryClient()
  const revocationOwner = useRef<RevocationOwner | null>(null)
  useLayoutEffect(() => {
    const owner = { client, organisationId, live: true }
    revocationOwner.current = owner
    return () => {
      owner.live = false
      if (revocationOwner.current === owner) revocationOwner.current = null
    }
  }, [client, organisationId])
  const invalidate = useInvalidatePeople(organisationId)
  const resendInvitation = useResendInvitation(organisationId)
  const invitations = useInvitationsQuery(organisationId)
  const rows = (invitations.data?.pages ?? []).flatMap((page) => page.data)

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      await invalidate()
      notify({ kind: 'success', title: success })
    } catch (error) {
      notify({ kind: 'error', title: t(resendFailureKey(error)) })
    }
  }

  if (invitations.isError && rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <InlineAlert kind="error">{t('console.people.list.error-load-failed')}</InlineAlert>
        <Button variant="secondary" onClick={() => void invitations.refetch()}>
          {t('console.common.action-retry')}
        </Button>
      </div>
    )
  }

  const resend = (invitation: Invitation) =>
    run(
      () => resendInvitation(invitation.id),
      t('console.people.members.toast-resent', { person: invitation.email })
    )
  async function revoke(invitation: Invitation) {
    const originalClient = client
    const originalOrg = organisationId
    const invitationId = invitation.id
    const queryKey = peopleKeys.invitations(originalOrg)
    const owner = revocationOwner.current
    if (!owner?.live || owner.client !== originalClient || owner.organisationId !== originalOrg)
      return
    const ownsUI = () => owner.live && revocationOwner.current === owner
    let acknowledged = false
    try {
      // The declared cancellation is void204; it needs no invented body receipt.
      await revokeInvitation(invitationId)
      acknowledged = true
      // Cancel old query publication BEFORE changing its revertible cache data.
      // This is not a claim that the underlying HTTP transport was aborted.
      await originalClient.cancelQueries({ queryKey, exact: true })
      originalClient.setQueryData<InvitationData>(queryKey, (data) =>
        data === undefined
          ? undefined
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                data: page.data.filter(
                  (row) =>
                    !(
                      typeof row.id === 'string' &&
                      row.id === invitationId &&
                      typeof row.organisation_id === 'string' &&
                      row.organisation_id === originalOrg
                    )
                ),
              })),
            }
      )
      // Cache truth belongs to the captured client even when its UI has retired.
      if (!ownsUI()) return
      await invalidate()
    } catch {
      // Ancillary refresh processing cannot undo an acknowledged cancellation.
      // Unexpected cache failures are not an exception-proof presentation promise.
    }
    if (!ownsUI()) return
    notify({
      kind: acknowledged ? 'success' : 'error',
      title: acknowledged
        ? t('console.people.members.toast-revoked', { person: invitation.email })
        : t('console.common.error-unavailable'),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="sr-only">{t('console.people.list.label-tab-invitations')}</h2>
      <Table caption={t('console.people.list.label-tab-invitations')}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('console.people.list.label-column-email')}</TableHeaderCell>
            <TableHeaderCell>{t('console.people.list.label-column-role')}</TableHeaderCell>
            <TableHeaderCell>{t('console.people.list.label-column-expires')}</TableHeaderCell>
            <TableHeaderCell status>{t('console.people.members.label-state')}</TableHeaderCell>
            <TableHeaderCell>
              <span className="sr-only">{t('console.people.list.label-column-actions')}</span>
            </TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody aria-busy={invitations.isLoading ? true : undefined}>
          {invitations.isLoading ? (
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
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center">
                {t('console.people.list.empty-invitations')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((invitation) => (
              <TableRow key={invitation.id}>
                <TableHeaderCell
                  scope="row"
                  className="max-w-[240px] truncate text-md font-medium text-c-ink normal-case"
                >
                  {invitation.email}
                </TableHeaderCell>
                <TableCell>{t(ROLE_LABEL[invitation.role])}</TableCell>
                <TableCell>{formatDate(invitation.expires_at, locale)}</TableCell>
                <TableStatusCell>
                  <StatusPill state="info">{t('console.people.list.status-invited')}</StatusPill>
                </TableStatusCell>
                <TableRowActions>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!online}
                      onClick={() => void resend(invitation)}
                    >
                      {t('console.people.members.action-resend')}
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      disabled={!online}
                      onClick={() => void revoke(invitation)}
                    >
                      {t('console.people.members.action-revoke')}
                    </Button>
                  </div>
                </TableRowActions>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {invitations.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-center"
          loading={invitations.isFetchingNextPage}
          onClick={() => void invitations.fetchNextPage()}
        >
          {t('console.common.action-load-more', { count: PAGE_SIZE })}
        </Button>
      ) : null}
    </div>
  )
}
