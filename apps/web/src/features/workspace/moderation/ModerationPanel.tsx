// Administration › Sécurité & modération, for the workspace's owners and administrators
// (docs/specs/messaging-media-and-notifications.md): the reports members filed, a member's
// moderation (chosen by name from a search, never by typing an identifier), and the ban list with
// one-click unban. Invite links live in Administration › Invitations. Every change is Core's to accept: a refusal is said in place,
// and nothing is shown as done before Core says so.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/Button/Button'
import { Select } from '../../../ui/Select/Select'
import { TextField } from '../../../ui/TextField/TextField'
import {
  listReports,
  moderateMember,
  ReportAlreadyDecided,
  resolveReport,
  type AbuseReport,
  type ModerationAction,
} from './moderationApi'
import { MemberPicker } from './MemberPicker'
import { BanList } from './BanList'

const SECTION = 'flex flex-col gap-4 rounded-lg border border-c-border p-5'

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

function ModerateMember({
  organisationId,
  onDone,
}: {
  organisationId: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [member, setMember] = useState<{ id: string; name: string } | null>(null)
  const [action, setAction] = useState<ModerationAction>('mute')
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('1')
  const [notice, setNotice] = useState('')
  const validId = member !== null
  // A ban stands until an unban; only a mute takes a duration (Core refuses `expiresAt` otherwise).
  const lasting = action === 'mute'
  return (
    <section className={SECTION} aria-labelledby="moderate-title">
      <h3 id="moderate-title" className="font-semibold">
        {t('console.workspace.moderation.title')}
      </h3>
      <p className="text-sm text-c-ink-2">{t('console.workspace.moderation.hint')}</p>
      <MemberPicker
        organisationId={organisationId}
        value={member}
        onChange={(next) => {
          setMember(next)
          setNotice('')
        }}
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
              membershipId: member?.id ?? '',
              action,
              reason: reason.trim(),
              ...(lasting ? { days: Number(days) } : {}),
            }).then(
              () => {
                setNotice(t('console.workspace.moderation.label-done'))
                setReason('')
                onDone()
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
  // A moderation applied above changes the ban list below: it is read again.
  const [bansEpoch, setBansEpoch] = useState(0)
  return (
    <div className="flex flex-col gap-6">
      <Reports organisationId={organisationId} />
      <ModerateMember organisationId={organisationId} onDone={() => setBansEpoch((n) => n + 1)} />
      <BanList organisationId={organisationId} epoch={bansEpoch} />
    </div>
  )
}
