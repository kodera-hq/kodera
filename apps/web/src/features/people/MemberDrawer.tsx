// docs/specs/03-people.md §4.5: one person — role, state, dates, and one
// destructive action. `can_change_role`, `can_remove` and `blocked_reason`
// are the API's rendering advice: an unavailable control is disabled and
// says why. The API re-checks every write regardless.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ApiProblem, coreApi } from '../../api/client'
import { authAdapter } from '../../auth/oidc'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import { formatDate } from '../../i18n/format'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { ConfirmDestructive } from '../../ui/ConfirmDestructive/ConfirmDestructive'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { Dialog } from '../../ui/Dialog/Dialog'
import { Drawer } from '../../ui/Drawer/Drawer'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Select } from '../../ui/Select/Select'
import { useToast } from '../../ui/Toast/Toast'
import { useLocale } from '../invoices/useLocale'
import { trackMemberRemoved, trackRoleChanged } from './analytics'
import {
  disclosedEmail,
  formatLastSeen,
  personLabel,
  ROLE_LABEL,
  seesPrivateFacts,
  STATE_LABEL,
} from './format'
import type { FocusTarget } from '../../ui/returnFocus'
import { membershipProblem, sameAsShown, staleRecord } from './memberActions'
import { boundMember, record } from './memberWire'
import {
  changeMembership,
  changeRole,
  removeMembership,
  useInvalidatePeople,
  peopleKeys,
  type Tagged,
  type MembershipDetail,
} from './queries'
import { mayRemove, roleChangeTargets, type OrganisationRole } from './roles'

export interface MemberDrawerProps {
  organisationId: string
  callerRole: OrganisationRole
  /**
   * The caller's own membership. Core discloses a person's private facts (address, last sign-in)
   * to that person and to those who manage people; to anyone else they are withheld, and the
   * drawer then says nothing about them (`seesPrivateFacts`).
   */
  callerMembershipId?: string
  memberId: string
  onClose: () => void
}

const BLOCKED_REASON: Record<string, MessageKey> = {
  last_owner: 'console.people.members.error-last-owner',
  self: 'console.people.members.error-self-change',
  staff_managed: 'console.people.members.error-staff-managed',
}

/**
 * The drawer opens from a route, without a Radix trigger, and its close
 * navigates away: focus goes back to the person's row in the list, found by
 * `data-member-id` at close time, when that row is on screen.
 */
function memberRow(memberId: string): FocusTarget {
  return {
    get current() {
      for (const row of document.querySelectorAll<HTMLElement>('[data-member-id]')) {
        if (row.dataset['memberId'] === memberId) return row
      }
      return null
    },
  }
}

/** Why the role control is unavailable, or `null` when it is available. */
function roleBlocked(caller: OrganisationRole, member: MembershipDetail): MessageKey | null {
  if (!member.can_change_role) {
    return (
      BLOCKED_REASON[member.blocked_reason ?? ''] ??
      'console.people.members.error-role-change-failed'
    )
  }
  if (roleChangeTargets(caller, member.role).length === 0) {
    return 'console.people.members.error-owner-only-role'
  }
  return null
}

function removeBlocked(caller: OrganisationRole, member: MembershipDetail): MessageKey | null {
  if (!member.can_remove) {
    return member.blocked_reason === 'self'
      ? 'console.people.members.error-self-removal'
      : (BLOCKED_REASON[member.blocked_reason ?? ''] ??
          'console.people.members.error-role-change-failed')
  }
  if (!mayRemove(caller, member.role)) return 'console.people.members.error-owner-only-role'
  return null
}

function detail(
  value: unknown,
  tag: string | null,
  organisationId: string,
  memberId: string
): Tagged<MembershipDetail> {
  if (!record(value)) throw new Error('Membership detail is unavailable.')
  const fields: Record<string, unknown> = value
  if (
    !boundMember(value, organisationId, memberId) ||
    typeof fields['can_change_role'] !== 'boolean' ||
    typeof fields['can_remove'] !== 'boolean' ||
    !(
      fields['blocked_reason'] == null ||
      (typeof fields['blocked_reason'] === 'string' &&
        ['self', 'last_owner', 'staff_managed'].includes(fields['blocked_reason']))
    ) ||
    tag === null ||
    !/^"[^"\r\n]+"$/.test(tag)
  )
    throw new Error('Membership detail is unavailable.')
  return { value: value as MembershipDetail, etag: tag }
}

type RoleReceipt = {
  id: number
  role: OrganisationRole
  acknowledged: boolean
  from: OrganisationRole
  query: object
}
type RoleView = { receipt: RoleReceipt; phase: 'refreshing' | 'unavailable' | 'different' }
type ReadTicket = {
  id: number
  credential: number
  kind: 'prewrite' | 'readback'
  controller: AbortController
  query: object | undefined
}

/** A replacement session/target gets a new owner; token renewal keeps the save receipt. */
export function MemberDrawer(props: MemberDrawerProps) {
  const client = useQueryClient()
  // A replacement provider must not inherit the previous client's operation/observer.
  const clientOwner = useMemo(() => ({ client, id: crypto.randomUUID() }), [client])
  const session = useSyncExternalStore(authAdapter.subscribe, authAdapter.getSnapshot)
  return (
    <OwnedMemberDrawer
      key={JSON.stringify([
        clientOwner.id,
        props.organisationId,
        props.memberId,
        props.callerRole,
        session.generation,
        session.status,
      ])}
      {...props}
      session={session}
    />
  )
}

function OwnedMemberDrawer({
  organisationId,
  callerRole,
  callerMembershipId,
  memberId,
  onClose,
  session,
}: MemberDrawerProps & { session: AuthSessionSnapshot }) {
  const { t } = useTranslation()
  const locale = useLocale()
  const notify = useToast()
  const online = useOnlineStatus()
  const invalidate = useInvalidatePeople(organisationId)
  const client = useQueryClient()
  const [mountOwner] = useState(() => crypto.randomUUID())
  const active = useRef(true)
  const operation = useRef(0)
  const readSequence = useRef(0)
  const querySequence = useRef(0)
  const read = useRef<ReadTicket | null>(null)
  const receipt = useRef<RoleReceipt | null>(null)
  const [roleView, setRoleView] = useState<RoleView | null>(null)
  const [reading, setReading] = useState(false)
  const pendingRole = roleView !== null && roleView.phase !== 'different'
  const keyForCredential = useCallback(
    (credential: number) =>
      [
        ...peopleKeys.member(organisationId, memberId),
        'drawer',
        mountOwner,
        callerRole,
        session.generation,
        credential,
      ] as const,
    [organisationId, memberId, mountOwner, callerRole, session.generation]
  )
  const queryKey = useMemo(
    () => keyForCredential(session.credentialGeneration),
    [keyForCredential, session.credentialGeneration]
  )
  const ready = useCallback(() => {
    const current = authAdapter.getSnapshot()
    return (
      active.current &&
      current.status === 'ready' &&
      current.generation === session.generation &&
      authAdapter.getAccessToken() !== undefined
    )
  }, [session.generation])
  const sameCredential = useCallback(
    (credential: number) =>
      ready() && authAdapter.getSnapshot().credentialGeneration === credential,
    [ready]
  )
  const readDetail = async (signal: AbortSignal) => {
    const { data, response } = await coreApi().GET(
      '/organisations/{organisation_id}/memberships/{membership_id}',
      {
        params: { path: { organisation_id: organisationId, membership_id: memberId } },
        signal,
      }
    )
    if (signal.aborted || response.status !== 200) throw new Error('Membership read retired.')
    return detail(data, response.headers.get('ETag'), organisationId, memberId)
  }
  const queryRead = async (signal: AbortSignal, credential: number) => {
    const ticket = ++querySequence.current
    if (!sameCredential(credential) || signal.aborted) throw new Error('Membership read retired.')
    const value = await readDetail(signal)
    if (!sameCredential(credential) || signal.aborted || querySequence.current !== ticket)
      throw new Error('Membership read retired.')
    return value
  }
  const queryOptions = {
    queryKey,
    enabled: session.status === 'ready' && !pendingRole,
    staleTime: Infinity,
    placeholderData: (previous: Tagged<MembershipDetail> | undefined) => previous,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      queryRead(signal, session.credentialGeneration),
  }
  const membership = useQuery(queryOptions)
  const [failure, setFailure] = useState<MessageKey | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState<'remove' | 'owner' | 'suspend' | null>(null)
  const [now] = useState(Date.now)
  const returnFocusTo = useMemo(() => memberRow(memberId), [memberId])
  const roleReasonId = useId()

  useLayoutEffect(() => {
    active.current = true
    const retireRead = () => {
      const previous = read.current
      if (previous === null) return
      read.current = null
      previous.controller.abort()
      if (previous.kind === 'prewrite') {
        operation.current += 1
        receipt.current = null
        setSaving(false)
      } else {
        setReading(false)
        setRoleView((value) => (value === null ? null : { ...value, phase: 'unavailable' }))
      }
    }
    const unsubscribe = authAdapter.subscribe(() => {
      if (read.current !== null && !sameCredential(read.current.credential)) retireRead()
    })
    const unsubscribeCache = client.getQueryCache().subscribe((event) => {
      if (event.type === 'removed' && read.current?.query === event.query) retireRead()
    })
    return () => {
      active.current = false
      operation.current += 1
      querySequence.current += 1
      read.current?.controller.abort()
      read.current = null
      unsubscribe()
      unsubscribeCache()
    }
  }, [client, sameCredential])
  // Cancel only this mount's captured credential key, never a replacement owner.
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey, exact: true })
    },
    [client, queryKey]
  )

  const member = membership.data?.value
  const name = member === undefined ? '' : personLabel(member, t)
  const email = member === undefined ? undefined : disclosedEmail(member)
  // Decided by who is asking, never by a fact's absence: a withheld sign-in is not « never ».
  const privateFacts = seesPrivateFacts(callerRole, callerMembershipId, memberId)

  /** A read made now, for its tag: the drawer's own read may be minutes old. When the person
   * changed since they were shown, nothing is sent: the drawer and the list show them again and
   * the sentence says why (03-people.md §4.5). */
  async function readAsShown() {
    const credential = authAdapter.getSnapshot().credentialGeneration
    const fresh = await readDetail(new AbortController().signal)
    if (!sameCredential(credential)) return null
    if (member !== undefined && !sameAsShown(fresh, member)) {
      void invalidate()
      setFailure('console.people.members.error-changed-meanwhile')
      return null
    }
    return fresh
  }

  /** A refusal: someone else may have changed this person first, so the drawer and the list
   * show what the server holds now. */
  function refused(error: unknown, otherwise: MessageKey) {
    if (staleRecord(error)) void invalidate()
    setFailure(membershipProblem(error, otherwise))
  }

  const owns = (intent: RoleReceipt) =>
    ready() && receipt.current === intent && operation.current === intent.id
  const ownsRead = (intent: RoleReceipt, ticket: ReadTicket) =>
    owns(intent) &&
    read.current === ticket &&
    sameCredential(ticket.credential) &&
    ticket.query !== undefined &&
    client
      .getQueryCache()
      .getAll()
      .some((query) => query === ticket.query) &&
    !ticket.controller.signal.aborted

  async function refreshRole(intent: RoleReceipt) {
    if (!owns(intent) || read.current !== null) return
    const credential = authAdapter.getSnapshot().credentialGeneration
    const readKey = keyForCredential(credential)
    const query =
      client.getQueryCache().find({ queryKey: readKey, exact: true }) ??
      client.getQueryCache().build(
        client,
        client.defaultQueryOptions({
          queryKey: readKey,
          queryFn: ({ signal }: { signal: AbortSignal }) => queryRead(signal, credential),
          staleTime: Infinity,
        })
      )
    const ticket: ReadTicket = {
      id: ++readSequence.current,
      credential,
      kind: 'readback',
      controller: new AbortController(),
      query,
    }
    read.current = ticket
    setReading(true)
    setRoleView({ receipt: intent, phase: 'refreshing' })
    try {
      await client.cancelQueries({ queryKey: readKey, exact: true })
      if (!ownsRead(intent, ticket)) return
      // This is a new HTTP read, never a refetch promise that can resolve reverted cache data.
      const current = await readDetail(ticket.controller.signal)
      if (!ownsRead(intent, ticket)) return
      if (client.getQueryCache().find({ queryKey: readKey, exact: true }) !== query) {
        setRoleView({ receipt: intent, phase: 'unavailable' })
        return
      }
      client.setQueryData(readKey, current)
      // This current successful read supersedes an earlier readback refusal.
      setFailure(null)
      if (intent.acknowledged && current.value.role === intent.role) {
        setRoleView(null)
        notify({
          kind: 'success',
          title: t('console.people.members.toast-role-changed', {
            person: personLabel(current.value, t),
            role: t(ROLE_LABEL[current.value.role]).toLowerCase(),
          }),
        })
      } else if (intent.acknowledged) {
        setRoleView({ receipt: intent, phase: 'different' })
        setFailure('console.people.members.error-changed-meanwhile')
      } else setRoleView(null)
      receipt.current = null
    } catch (error) {
      if (!ownsRead(intent, ticket)) return
      setRoleView({ receipt: intent, phase: 'unavailable' })
      if (error instanceof ApiProblem && [401, 403, 404].includes(error.status)) {
        setFailure(membershipProblem(error, 'console.common.error-unavailable'))
      }
    } finally {
      if (read.current === ticket) {
        read.current = null
        if (ready()) setReading(false)
      }
    }
  }

  async function applyRole(role: OrganisationRole) {
    if (
      member === undefined ||
      saving ||
      pendingRole ||
      receipt.current !== null ||
      membership.isError ||
      membership.isPlaceholderData ||
      !sameCredential(session.credentialGeneration)
    )
      return
    const writeQuery = client.getQueryCache().find({ queryKey, exact: true })
    if (writeQuery === undefined) return
    const intent: RoleReceipt = {
      id: ++operation.current,
      role,
      from: member.role,
      acknowledged: false,
      query: writeQuery,
    }
    receipt.current = intent
    setRoleView(null)
    setFailure(null)
    setSaving(true)
    const ticket: ReadTicket = {
      id: ++readSequence.current,
      credential: authAdapter.getSnapshot().credentialGeneration,
      kind: 'prewrite',
      controller: new AbortController(),
      query: client.getQueryCache().find({ queryKey, exact: true }),
    }
    read.current = ticket
    let sent = false
    try {
      const fresh = await readDetail(ticket.controller.signal)
      if (!ownsRead(intent, ticket)) return
      if (!sameAsShown(fresh, member)) {
        void invalidate()
        setFailure('console.people.members.error-changed-meanwhile')
        receipt.current = null
        return
      }
      const reason = roleBlocked(callerRole, fresh.value)
      if (reason !== null) {
        client.setQueryData(queryKey, fresh)
        setFailure(reason)
        receipt.current = null
        return
      }
      read.current = null
      sent = true
      const answer = await changeRole(organisationId, fresh, role)
      if (!owns(intent)) return
      intent.acknowledged = boundMember(answer, organisationId, memberId) && answer.role === role
      if (intent.acknowledged) trackRoleChanged(intent.from, role)
      setSaving(false)
      setRoleView({ receipt: intent, phase: 'refreshing' })
      // Other People reads may refresh, but cannot replace the explicit confirmation read.
      const confirmationKey = keyForCredential(authAdapter.getSnapshot().credentialGeneration)
      void client.invalidateQueries({
        queryKey: peopleKeys.all(organisationId),
        predicate: (query) => JSON.stringify(query.queryKey) !== JSON.stringify(confirmationKey),
      })
      if (
        client
          .getQueryCache()
          .getAll()
          .some((query) => query === intent.query)
      ) {
        await refreshRole(intent)
      } else setRoleView({ receipt: intent, phase: 'unavailable' })
    } catch (error) {
      if (!owns(intent)) return
      if (
        !sent ||
        (error instanceof ApiProblem && [400, 401, 403, 404, 409, 412, 428].includes(error.status))
      ) {
        refused(error, 'console.people.members.error-role-change-failed')
        receipt.current = null
      } else {
        // A lost/invalid answer cannot prove the write failed. Recovery is a read only.
        setRoleView({ receipt: intent, phase: 'unavailable' })
      }
    } finally {
      if (read.current === ticket) read.current = null
      if (active.current && operation.current === intent.id) setSaving(false)
    }
  }

  /** Suspends or restores the person's access: their rights in the organisation, not Visio or
   * Docs sign-in, which follows a separate realm delivery (03-people.md §4.5). */
  async function applyState(state: 'active' | 'suspended') {
    setFailure(null)
    setSaving(true)
    try {
      const fresh = await readAsShown()
      if (fresh === null) return
      await changeMembership(organisationId, fresh, { state })
      await invalidate()
      notify({
        kind: 'success',
        title: t(
          state === 'suspended'
            ? 'console.people.members.toast-suspended'
            : 'console.people.members.toast-reactivated',
          { person: name }
        ),
      })
    } catch (error) {
      refused(error, 'console.people.members.error-state-change-failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setFailure(null)
    setSaving(true)
    try {
      // A change landing between this read and the removal is refused by Core (`412`).
      const fresh = await readAsShown()
      if (fresh === null) return
      await removeMembership(organisationId, fresh)
      trackMemberRemoved()
      await invalidate()
      notify({
        kind: 'success',
        title: t('console.people.members.toast-removed', { person: name }),
      })
      onClose()
    } catch (error) {
      refused(error, 'console.common.error-unavailable')
    } finally {
      setSaving(false)
    }
  }

  const sessionReady = session.status === 'ready' && authAdapter.getAccessToken() !== undefined
  const locked =
    saving || pendingRole || membership.isError || membership.isPlaceholderData || !sessionReady
  const roleReason = member === undefined ? null : roleBlocked(callerRole, member)
  const removeReason = member === undefined ? null : removeBlocked(callerRole, member)
  const roleOptions =
    member === undefined
      ? []
      : (['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)
          .filter(
            (role) =>
              role === member.role || roleChangeTargets(callerRole, member.role).includes(role)
          )
          .map((role) => ({ value: role, label: t(ROLE_LABEL[role]) }))

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (open) return
        active.current = false
        operation.current += 1
        read.current?.controller.abort()
        onClose()
      }}
      title={name}
      {...(email === undefined ? {} : { description: email })}
      closeLabel={t('console.common.action-close')}
      returnFocusTo={returnFocusTo}
    >
      {member === undefined ? (
        membership.isError ? (
          <div className="flex flex-col items-start gap-3">
            <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
            <Button variant="secondary" onClick={() => void membership.refetch()}>
              {t('console.common.action-retry')}
            </Button>
          </div>
        ) : (
          <span role="status" className="block h-12 animate-pulse rounded-md bg-c-muted-2">
            <span className="sr-only">{t('console.common.a11y-loading')}</span>
          </span>
        )
      ) : (
        <div className="flex flex-col gap-6">
          {online ? null : (
            <InlineAlert kind="warning">{t('console.common.error-offline')}</InlineAlert>
          )}
          <div className="flex flex-col gap-2">
            <Select
              label={t('console.people.members.label-role')}
              value={member.role}
              {...(pendingRole || membership.isPlaceholderData
                ? { help: t('console.people.members.label-last-known-role') }
                : {})}
              disabled={roleReason !== null || locked || !online}
              options={roleOptions}
              onValueChange={(value) => {
                const role = value as OrganisationRole
                if (role === member.role) return
                if (role === 'org_owner') setConfirming('owner')
                else void applyRole(role)
              }}
            />
            <div role="status" className={roleView === null ? '-mt-2' : undefined}>
              {roleView === null ? null : (
                <InlineAlert
                  kind={roleView.phase === 'unavailable' ? 'warning' : 'info'}
                  inLiveRegion
                >
                  {t(
                    roleView.receipt.acknowledged
                      ? roleView.phase === 'unavailable'
                        ? 'console.people.members.status-role-saved-refresh-failed'
                        : 'console.people.members.status-role-saved-refreshing'
                      : 'console.people.members.status-role-unconfirmed',
                    { refreshing: reading ? ` ${t('console.common.a11y-loading')}` : '' }
                  )}
                </InlineAlert>
              )}
            </div>
            {roleView === null ? null : (
              <div className="flex flex-col items-start gap-2">
                {roleView.phase !== 'different' ? (
                  <Button
                    variant="secondary"
                    disabled={saving || !online || !sessionReady}
                    loading={reading}
                    onClick={() => {
                      const current = receipt.current
                      if (current !== null) void refreshRole(current)
                    }}
                  >
                    {t('console.people.members.action-refresh-member')}
                  </Button>
                ) : null}
              </div>
            )}
            {membership.isError && roleView === null ? (
              <div className="flex flex-col items-start gap-2">
                <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
                <Button variant="secondary" onClick={() => void membership.refetch()}>
                  {t('console.common.action-retry')}
                </Button>
              </div>
            ) : null}
            {roleReason === null ? null : (
              <p id={roleReasonId} className="text-sm text-c-ink-2">
                {t(roleReason)}
              </p>
            )}
            {failure === null ? null : (
              <InlineAlert kind="error" inLiveRegion>
                {t(failure)}
              </InlineAlert>
            )}
          </div>
          <div className="flex flex-col gap-1 text-sm text-c-ink-2">
            <DefinitionList
              items={[
                {
                  term: t('console.people.members.label-state'),
                  description: t(STATE_LABEL[member.state]),
                },
              ]}
            />
            <p>
              {t('console.people.members.label-joined', {
                date: formatDate(member.created_at, locale),
              })}
            </p>
            {privateFacts ? (
              <p>
                {member.last_seen_at === null || member.last_seen_at === undefined
                  ? t('console.people.list.status-never-signed-in')
                  : t('console.people.members.label-last-sign-in', {
                      duration: formatLastSeen(member.last_seen_at, now, locale),
                    })}
              </p>
            ) : null}
          </div>
          {member.state === 'active' || member.state === 'suspended' ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                variant="secondary"
                disabled={roleReason !== null || locked || !online}
                // The same reason as the role control's, said where the button is reached.
                {...(roleReason === null ? {} : { 'aria-describedby': roleReasonId })}
                onClick={() =>
                  member.state === 'active' ? setConfirming('suspend') : void applyState('active')
                }
              >
                {t(
                  member.state === 'active'
                    ? 'console.people.members.action-suspend'
                    : 'console.people.members.action-reactivate'
                )}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col items-start gap-2 border-t border-c-hairline pt-4">
            <Button
              variant="destructive"
              // One removal at a time: the button waits for the one in flight.
              disabled={removeReason !== null || locked || !online}
              onClick={() => setConfirming('remove')}
            >
              {t('console.people.members.action-remove')}
            </Button>
            {removeReason === null ? null : (
              <p className="text-sm text-c-ink-2">{t(removeReason)}</p>
            )}
          </div>
        </div>
      )}
      {confirming === 'remove' ? (
        <ConfirmDestructive
          defaultOpen
          initialFocus="title"
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          title={t('console.people.members.confirm-remove-title', { person: name })}
          consequence={t('console.people.members.confirm-remove-body', { person: name })}
          confirmLabel={t('console.people.members.action-confirm-remove', { person: name })}
          cancelLabel={t('console.common.action-cancel')}
          closeLabel={t('console.common.action-close')}
          onConfirm={() => void remove()}
        />
      ) : null}
      {confirming === 'suspend' ? (
        <ConfirmDestructive
          defaultOpen
          initialFocus="title"
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          title={t('console.people.members.confirm-suspend-title', { person: name })}
          consequence={t('console.people.members.confirm-suspend-body', { person: name })}
          confirmLabel={t('console.people.members.action-confirm-suspend', { person: name })}
          cancelLabel={t('console.common.action-cancel')}
          closeLabel={t('console.common.action-close')}
          onConfirm={() => void applyState('suspended')}
        />
      ) : null}
      {confirming === 'owner' ? (
        <Dialog
          open
          initialFocus="title"
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          size="sm"
          title={t('console.people.members.confirm-owner-title', { person: name })}
          description={t('console.people.members.confirm-owner-body')}
          closeLabel={t('console.common.action-close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                {t('console.common.action-cancel')}
              </Button>
              <Button
                onClick={() => {
                  setConfirming(null)
                  void applyRole('org_owner')
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
    </Drawer>
  )
}
