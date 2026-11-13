// Settings › Invitations et modération, for the workspace's owners and administrators
// (docs/specs/messaging-media-and-notifications.md): the active invite links, the reports members
// filed, and a member's moderation. Every change is Core's to accept: a refusal is said in place,
// and nothing is shown as done before Core says so.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/Button/Button'
import { CopyableField } from '../../../ui/CopyableField/CopyableField'
import { Select } from '../../../ui/Select/Select'
import { TextField } from '../../../ui/TextField/TextField'
import {
  createInviteLink,
  inviteUrl,
  listInviteLinks,
  listReports,
  moderateMember,
  ReportAlreadyDecided,
  resolveReport,
  revokeInviteLink,
  type AbuseReport,
  type InviteLink,
  type ModerationAction,
} from './moderationApi'

const SECTION = 'flex flex-col gap-4 rounded-lg border border-c-border p-5'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

type Load<T> = { state: 'loading' } | { state: 'ready'; items: T[] } | { state: 'unavailable' }

function useList<T>(read: () => Promise<T[]>): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    let live = true
    read().then(
      (items) => live && setLoad({ state: 'ready', items }),
      () => live && setLoad({ state: 'unavailable' })
    )
    return () => {
      live = false
    }
  }, [read, epoch])
  return [load, useCallback(() => setEpoch((value) => value + 1), [])]
}

function Status({ text }: { text: string }) {
  return (
    <p role="status" className="text-sm text-c-ink-2 empty:sr-only">
      {text}
    </p>
  )
}

function InviteLinks({ organisationId }: { organisationId: string }) {
  const { t, i18n } = useTranslation()
  const read = useCallback(() => listInviteLinks(organisationId), [organisationId])
  const [links, reload] = useList<InviteLink>(read)
  const [days, setDays] = useState('7')
  const [maxUses, setMaxUses] = useState('25')
  const [role, setRole] = useState<'org_member' | 'moderator'>('org_member')
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' }).format(new Date(iso))

  function create() {
    setNotice('')
    void createInviteLink(organisationId, {
      days: Number(days),
      maxUses: Number(maxUses),
      role,
    }).then(
      ({ code }) => {
        // The code is shown once: Core keeps only its digest.
        setCreated(inviteUrl(code))
        setCopied(false)
        reload()
      },
      () => setNotice(t('console.workspace.invite-links.problem-create'))
    )
  }

  return (
    <section className={SECTION} aria-labelledby="invite-links-title">
      <h3 id="invite-links-title" className="font-semibold">
        {t('console.workspace.invite-links.title')}
      </h3>
      <p className="text-sm text-c-ink-2">{t('console.workspace.invite-links.hint')}</p>
      <div className="grid grid-cols-3 gap-3 narrow:grid-cols-1">
        <TextField
          label={t('console.workspace.invite-links.field-days')}
          type="number"
          min={1}
          max={30}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <TextField
          label={t('console.workspace.invite-links.field-uses')}
          type="number"
          min={1}
          max={10000}
          value={maxUses}
          onChange={(event) => setMaxUses(event.target.value)}
        />
        <Select
          label={t('console.workspace.invite-links.field-role')}
          value={role}
          onValueChange={(value) => setRole(value === 'moderator' ? 'moderator' : 'org_member')}
          options={[
            { value: 'org_member', label: t('console.workspace.invite-links.role-member') },
            { value: 'moderator', label: t('console.workspace.invite-links.role-moderator') },
          ]}
        />
      </div>
      <div>
        <Button variant="primary" onClick={create}>
          {t('console.workspace.invite-links.action-create')}
        </Button>
      </div>
      {created === null ? null : (
        <div className="flex flex-col gap-2">
          <CopyableField
            label={t('console.workspace.invite-links.label-new')}
            value={created}
            layout="stacked"
            status={copied ? 'copied' : 'idle'}
            copyLabel={t('console.workspace.invite-links.action-copy')}
            copiedLabel={t('console.workspace.invite-links.label-copied')}
            onCopy={() => {
              void navigator.clipboard?.writeText(created).then(
                () => setCopied(true),
                () => setNotice(t('console.workspace.invite-links.problem-copy'))
              )
            }}
          />
          <p className="text-xs text-c-ink-3">{t('console.workspace.invite-links.hint-once')}</p>
        </div>
      )}
      <Status text={notice} />
      {links.state === 'unavailable' ? (
        <p className="text-sm text-c-ink-2">{t('console.workspace.invite-links.problem-list')}</p>
      ) : links.state === 'ready' && links.items.length === 0 ? (
        <p className="text-sm text-c-ink-2">{t('console.workspace.invite-links.empty')}</p>
      ) : links.state === 'ready' ? (
        <ul className="flex flex-col divide-y divide-c-border-soft">
          {links.items.map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                {t('console.workspace.invite-links.label-row', {
                  uses: String(link.usesCount),
                  max: String(link.maxUses),
                  date: date(link.expiresAt),
                })}
                {' · '}
                {link.role === 'moderator'
                  ? t('console.workspace.invite-links.role-moderator')
                  : t('console.workspace.invite-links.role-member')}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void revokeInviteLink(organisationId, link.id).then(reload, () =>
                    setNotice(t('console.workspace.invite-links.problem-revoke'))
                  )
                }
              >
                {t('console.workspace.invite-links.action-revoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function Reports({ organisationId }: { organisationId: string }) {
  const { t, i18n } = useTranslation()
  const read = useCallback(() => listReports(organisationId), [organisationId])
  const [reports, reload] = useList<AbuseReport>(read)
  const [resolution, setResolution] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  function decide(report: AbuseReport, status: 'resolved' | 'dismissed') {
    const text = (resolution[report.id] ?? '').trim()
    if (text === '') {
      setNotice(t('console.workspace.reports.problem-resolution'))
      return
    }
    setNotice('')
    void resolveReport(organisationId, report.id, status, text).then(
      () => {
        setNotice(t('console.workspace.reports.label-decided'))
        reload()
      },
      (error) => {
        setNotice(
          error instanceof ReportAlreadyDecided
            ? t('console.workspace.reports.problem-decided')
            : t('console.workspace.reports.problem-resolve')
        )
        reload()
      }
    )
  }
  const open = reports.state === 'ready' ? reports.items.filter((r) => r.status === 'open') : []
  return (
    <section className={SECTION} aria-labelledby="reports-title">
      <h3 id="reports-title" className="font-semibold">
        {t('console.workspace.reports.title')}
      </h3>
      <Status text={notice} />
      {reports.state === 'unavailable' ? (
        <p className="text-sm text-c-ink-2">{t('console.workspace.reports.problem-list')}</p>
      ) : reports.state === 'ready' && open.length === 0 ? (
        <p className="text-sm text-c-ink-2">{t('console.workspace.reports.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {open.map((report) => (
            <li key={report.id} className="flex flex-col gap-2 rounded-md bg-c-sunken p-3">
              <p className="text-sm text-c-ink">{report.reason}</p>
              <p className="text-xs text-c-ink-3">
                {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(report.createdAt))}
              </p>
              <TextField
                label={t('console.workspace.reports.field-resolution')}
                maxLength={1000}
                value={resolution[report.id] ?? ''}
                onChange={(event) =>
                  setResolution((current) => ({ ...current, [report.id]: event.target.value }))
                }
              />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={() => decide(report, 'resolved')}>
                  {t('console.workspace.reports.action-resolve')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => decide(report, 'dismissed')}>
                  {t('console.workspace.reports.action-dismiss')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ModerateMember({ organisationId }: { organisationId: string }) {
  const { t } = useTranslation()
  const [membershipId, setMembershipId] = useState('')
  const [action, setAction] = useState<ModerationAction>('mute')
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('1')
  const [notice, setNotice] = useState('')
  const validId = UUID.test(membershipId.trim())
  // A ban stands until an unban; only a mute takes a duration (Core refuses `expiresAt` otherwise).
  const lasting = action === 'mute'
  return (
    <section className={SECTION} aria-labelledby="moderate-title">
      <h3 id="moderate-title" className="font-semibold">
        {t('console.workspace.moderation.title')}
      </h3>
      <p className="text-sm text-c-ink-2">{t('console.workspace.moderation.hint')}</p>
      <TextField
        label={t('console.workspace.moderation.field-membership')}
        value={membershipId}
        onChange={(event) => setMembershipId(event.target.value)}
        {...(membershipId !== '' && !validId
          ? { error: t('console.workspace.moderation.problem-membership') }
          : {})}
      />
      <Select
        label={t('console.workspace.moderation.field-action')}
        value={action}
        onValueChange={(value) => setAction(value as ModerationAction)}
        options={[
          { value: 'mute', label: t('console.workspace.moderation.action-mute') },
          { value: 'kick', label: t('console.workspace.moderation.action-kick') },
          { value: 'ban', label: t('console.workspace.moderation.action-ban') },
          { value: 'unban', label: t('console.workspace.moderation.action-unban') },
        ]}
      />
      {lasting ? (
        <TextField
          label={t('console.workspace.moderation.field-days')}
          type="number"
          min={1}
          max={30}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
      ) : null}
      <TextField
        label={t('console.workspace.moderation.field-reason')}
        maxLength={1000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div>
        <Button
          variant="primary"
          disabled={!validId || reason.trim() === ''}
          onClick={() => {
            setNotice('')
            void moderateMember(organisationId, {
              membershipId: membershipId.trim(),
              action,
              reason: reason.trim(),
              ...(lasting ? { days: Number(days) } : {}),
            }).then(
              () => {
                setNotice(t('console.workspace.moderation.label-done'))
                setReason('')
              },
              () => setNotice(t('console.workspace.moderation.problem-apply'))
            )
          }}
        >
          {t('console.workspace.moderation.action-apply')}
        </Button>
      </div>
      <Status text={notice} />
    </section>
  )
}

export function ModerationPanel({ organisationId }: { organisationId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <InviteLinks organisationId={organisationId} />
      <Reports organisationId={organisationId} />
      <ModerateMember organisationId={organisationId} />
    </div>
  )
}
