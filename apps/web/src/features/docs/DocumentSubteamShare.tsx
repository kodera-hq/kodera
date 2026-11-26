import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '@/api/client'
import { Button } from '@/ui/Button/Button'
import {
  availableDocumentSubteams,
  isDocumentRoleGrantConflict,
  listDocumentRoleGrants,
  listDocumentSubteams,
  putDocumentRoleGrant,
  revokeDocumentRoleGrant,
  type DocumentGrantRole,
  type DocumentRoleGrantsState,
  type DocumentSubteam,
} from './documentRoleGrantsApi'

interface DocumentSubteamShareProps {
  readonly organisationId?: string | undefined
  readonly documentId?: string | undefined
  readonly remote: boolean
  readonly plaintextBlocked: boolean
  readonly canManageSharing: boolean
}

const DOCUMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SELECT_CLASS =
  'min-h-[44px] rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden disabled:opacity-50'

/** Each authority scope owns its snapshot and retires all pending work when it changes. */
export function DocumentSubteamShare({
  organisationId,
  documentId,
  remote,
  plaintextBlocked,
  canManageSharing,
}: DocumentSubteamShareProps) {
  if (
    !remote ||
    plaintextBlocked ||
    !organisationId ||
    !documentId ||
    !DOCUMENT_UUID.test(documentId)
  )
    return null
  return (
    <SubteamGrants
      key={JSON.stringify([organisationId, documentId, canManageSharing])}
      organisationId={organisationId}
      documentId={documentId}
      canManageSharing={canManageSharing}
    />
  )
}

function SubteamGrants({
  organisationId,
  documentId,
  canManageSharing,
}: {
  readonly organisationId: string
  readonly documentId: string
  readonly canManageSharing: boolean
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<DocumentRoleGrantsState | null>(null)
  const [subteams, setSubteams] = useState<readonly DocumentSubteam[]>([])
  const [rolesUnavailable, setRolesUnavailable] = useState(false)
  const [notice, setNotice] = useState<'unavailable' | 'conflict' | 'save-failed' | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const restoreSelect = useRef<HTMLSelectElement | null>(null)
  const [selectedTeam, setSelectedTeam] = useState('')
  const [selectedLevel, setSelectedLevel] = useState<DocumentGrantRole>('viewer')
  const lifetime = useRef<AbortController | null>(null)
  const writing = useRef(false)

  useEffect(() => {
    if (!canManageSharing) return
    const controller = new AbortController()
    lifetime.current = controller
    void listDocumentRoleGrants(organisationId, documentId, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) setState(snapshot)
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice('unavailable')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    void listDocumentSubteams(organisationId, controller.signal)
      .then((roles) => {
        if (!controller.signal.aborted) setSubteams(roles)
      })
      .catch(() => {
        if (!controller.signal.aborted) setRolesUnavailable(true)
      })
    return () => controller.abort()
  }, [organisationId, documentId, canManageSharing])

  useLayoutEffect(() => {
    if (!pending && restoreSelect.current) {
      restoreSelect.current.focus()
      restoreSelect.current = null
    }
  }, [pending])

  async function changeGrant(
    workspaceRoleId: string,
    level: DocumentGrantRole | null,
    select?: HTMLSelectElement
  ) {
    const controller = lifetime.current
    if (!canManageSharing || !state || writing.current || !controller || controller.signal.aborted)
      return
    heading.current?.focus()
    writing.current = true
    setSaved(false)
    setPending(true)
    setNotice(null)
    try {
      const next = await (level === null
        ? revokeDocumentRoleGrant(organisationId, documentId, workspaceRoleId, state.etag)
        : putDocumentRoleGrant(organisationId, documentId, workspaceRoleId, level, state.etag))
      if (controller.signal.aborted) return
      setState(next)
      setSelectedTeam('')
      setSelectedLevel('viewer')
      setSaved(true)
      restoreSelect.current = select ?? null
    } catch (error) {
      if (controller.signal.aborted) return
      if (isDocumentRoleGrantConflict(error)) {
        // Do not reapply a write against permissions the editor has never reviewed.
        setState(null)
        setNotice('conflict')
        try {
          const fresh = await listDocumentRoleGrants(organisationId, documentId, controller.signal)
          if (!controller.signal.aborted) {
            setState(fresh)
          }
        } catch {
          if (!controller.signal.aborted) setNotice('unavailable')
        }
      } else if (error instanceof ApiProblem && [401, 403, 404].includes(error.status)) {
        setState(null)
        setSubteams([])
        setNotice('unavailable')
      } else {
        setNotice('save-failed')
        restoreSelect.current = select ?? null
      }
    } finally {
      if (!controller.signal.aborted) {
        writing.current = false
        setPending(false)
      }
    }
  }

  const available = state ? availableDocumentSubteams(subteams, state) : []
  const team = available.find((entry) => entry.id === selectedTeam)?.id ?? ''
  const levelLabel = (level: DocumentGrantRole) =>
    level === 'editor' ? t('console.docs.share.editor') : t('console.docs.share.viewer')
  const status = saved
    ? t('console.docs.share.saved')
    : loading
      ? t('console.docs.share.loading')
      : ''

  if (!canManageSharing) return <p>{t('console.docs.share.readonly')}</p>

  return (
    <section aria-label={t('console.docs.share.subteams')} className="flex flex-col gap-3">
      <h3 ref={heading} tabIndex={-1} className="font-semibold text-c-ink">
        {t('console.docs.share.subteams')}
      </h3>
      <p role="status" aria-live="polite" className={status ? 'text-c-ink-2' : 'sr-only'}>
        {status}
      </p>
      {notice ? <p role="alert">{t(`console.docs.share.${notice}`)}</p> : null}
      {rolesUnavailable && state ? (
        <p role="alert">{t('console.docs.share.roles-unavailable')}</p>
      ) : null}
      {state?.grants.length === 0 ? <p>{t('console.docs.share.empty')}</p> : null}
      {state && state.grants.length > 0 ? (
        <ul className="flex max-h-[352px] flex-col gap-3 overflow-y-auto">
          {state.grants.map((grant) => (
            <li key={grant.workspaceRoleId} className="flex flex-wrap items-center gap-3">
              <span className="text-c-ink">
                @{grant.slug} · {grant.name}
              </span>
              {canManageSharing ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="sr-only">
                      {t('console.docs.share.grant-level', { mention: `@${grant.slug}` })}
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={grant.role}
                      disabled={pending}
                      onChange={(event) =>
                        void changeGrant(
                          grant.workspaceRoleId,
                          event.target.value as DocumentGrantRole,
                          event.currentTarget
                        )
                      }
                    >
                      <option value="editor">{levelLabel('editor')}</option>
                      <option value="viewer">{levelLabel('viewer')}</option>
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    aria-label={t('console.docs.share.revoke-label', { mention: `@${grant.slug}` })}
                    onClick={() => void changeGrant(grant.workspaceRoleId, null)}
                  >
                    {t('console.docs.share.revoke')}
                  </Button>
                </>
              ) : (
                <span>{levelLabel(grant.role)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canManageSharing && state && available.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (team) void changeGrant(team, selectedLevel)
          }}
        >
          <label className="flex flex-col gap-1">
            <span>{t('console.docs.share.subteam')}</span>
            <select
              className={SELECT_CLASS}
              value={team}
              disabled={pending}
              onChange={(event) => setSelectedTeam(event.target.value)}
            >
              <option value="">{t('console.docs.share.choose-subteam')}</option>
              {available.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.mention} · {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('console.docs.share.level')}</span>
            <select
              className={SELECT_CLASS}
              value={selectedLevel}
              disabled={pending}
              onChange={(event) => setSelectedLevel(event.target.value as DocumentGrantRole)}
            >
              <option value="viewer">{levelLabel('viewer')}</option>
              <option value="editor">{levelLabel('editor')}</option>
            </select>
          </label>
          <Button type="submit" disabled={pending || !team}>
            {t('console.docs.share.grant')}
          </Button>
        </form>
      ) : null}
    </section>
  )
}
