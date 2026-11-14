import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { Badge } from '../../ui/Badge/Badge'
import { Button } from '../../ui/Button/Button'
import { Card } from '../../ui/Card/Card'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import type { PassportSwitchedWorkspace, PassportWorkspaceEntry } from './passportClient'
import { switchPassportWorkspace } from './passportClient'

export interface PassportWorkspaceSwitcherProps {
  readonly workspaces: readonly PassportWorkspaceEntry[]
  readonly activeOrganisationId: string | null
  readonly sessionToken?: string
  readonly onSwitched?: (result: PassportSwitchedWorkspace) => void
}

type RoleKey =
  | 'console.shell.passport.role-owner'
  | 'console.shell.passport.role-admin'
  | 'console.shell.passport.role-billing'
  | 'console.shell.passport.role-member'

function roleMessageKey(role: PassportWorkspaceEntry['role']): RoleKey {
  switch (role) {
    case 'org_owner':
      return 'console.shell.passport.role-owner'
    case 'org_admin':
      return 'console.shell.passport.role-admin'
    case 'org_billing':
      return 'console.shell.passport.role-billing'
    case 'org_member':
      return 'console.shell.passport.role-member'
  }
}

export function PassportWorkspaceSwitcher({
  workspaces,
  activeOrganisationId,
  sessionToken,
  onSwitched,
}: PassportWorkspaceSwitcherProps) {
  const { t } = useTranslation()
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState<
    'console.shell.passport.problem-forbidden' | 'console.shell.passport.problem-switch' | null
  >(null)

  async function handleSelect(organisationId: string) {
    if (switchingOrgId || organisationId === activeOrganisationId) return
    setSwitchingOrgId(organisationId)
    setErrorKey(null)
    try {
      const switched = await switchPassportWorkspace({
        organisationId,
        ...(sessionToken !== undefined ? { sessionToken } : {}),
      })
      onSwitched?.(switched)
    } catch (error: unknown) {
      if (error instanceof ApiProblem && error.status === 403) {
        setErrorKey('console.shell.passport.problem-forbidden')
      } else {
        setErrorKey('console.shell.passport.problem-switch')
      }
    } finally {
      setSwitchingOrgId(null)
    }
  }

  return (
    <section aria-labelledby="passport-workspaces-heading" className="flex flex-col gap-3">
      <h2 id="passport-workspaces-heading" className="text-base font-semibold text-c-ink">
        {t('console.shell.passport.title')}
      </h2>

      {errorKey ? <InlineAlert kind="error">{t(errorKey)}</InlineAlert> : null}

      {workspaces.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-c-ink-3">{t('console.shell.passport.empty')}</p>
        </Card>
      ) : (
        <Card className="overflow-hidden [&>:not([hidden])~:not([hidden])]:border-t [&>:not([hidden])~:not([hidden])]:border-c-border-soft">
          {workspaces.map((entry) => {
            const isActive =
              entry.organisation_id === activeOrganisationId ||
              (activeOrganisationId === null && entry.active)
            const isPending = switchingOrgId === entry.organisation_id

            return (
              <div
                key={entry.organisation_id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-c-ink">
                      {entry.organisation_name}
                    </span>
                    <Badge variant="neutral">{t(roleMessageKey(entry.role))}</Badge>
                  </div>
                  <span className="font-mono text-xs text-c-ink-3">{entry.organisation_slug}</span>
                </div>

                {isActive ? (
                  <Badge variant="accent">{t('console.shell.passport.badge-active')}</Badge>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={switchingOrgId !== null}
                    onClick={() => void handleSelect(entry.organisation_id)}
                  >
                    {isPending
                      ? t('console.shell.passport.action-switching')
                      : t('console.shell.passport.action-switch')}
                  </Button>
                )}
              </div>
            )
          })}
        </Card>
      )}
    </section>
  )
}
