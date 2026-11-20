// Administration › Membres: the organisation's people as Core knows them — a name, never a raw
// Matrix address — their organisation role (changed in two clicks: open, choose), and the
// workspace roles, sub-teams and tags assigned to them, as pills.
//
// An organisation role change is a PATCH under the tag of a fresh read (`membersApi`). Core
// projects the new
// role onto every room's Matrix power levels (owner 100, administrator 75, moderator 50,
// member 0); the console never writes power levels itself.

import { useMemo, useState } from 'react'
import { Avatar } from '../../../ui/Avatar/Avatar'
import { Button } from '../../../ui/Button/Button'
import { TextField } from '../../../ui/TextField/TextField'
import { useQueryClient } from '@tanstack/react-query'
import {
  changeOrganisationRole,
  directoryKeys,
  roleChangeProblem,
  useDirectory,
  type Membership,
} from './membersApi'
import { roleChangeTargets, type OrganisationRole } from '../../people/roles'
import { isIamUnsupported, setMemberRoles, type WorkspaceRole } from '../iamApi'
import { DownIcon, PlusIcon } from './AdminIcons'
import { useInvalidateIam, useWorkspaceRoles } from './useIam'
import { mayManage, type RoleAuthority } from './WorkspaceRolesPanel'
import { MenuButton, Notice, Panel, problemText, RolePill, useAdminCopy } from './shared'

/** The Matrix power level Core projects for each organisation role. */
export const MATRIX_POWER_LEVEL: Record<OrganisationRole | 'moderator', number> = {
  org_owner: 100,
  org_admin: 75,
  moderator: 50,
  org_billing: 0,
  org_member: 0,
}

/** A person's name as members read it: never an account id or a Matrix address. */
export function memberName(member: Pick<Membership, 'display_name' | 'email'>, unnamed: string) {
  const name = member.display_name?.trim()
  if (name !== undefined && name !== '' && !name.startsWith('@')) return name
  const local = member.email?.split('@')[0]?.trim()
  return local !== undefined && local !== '' ? local : unnamed
}

function MemberRow({
  member,
  organisationId,
  callerRole,
  callerMembershipId,
  authority,
  roles,
  assigned,
  onNotice,
}: {
  member: Membership
  organisationId: string
  callerRole: OrganisationRole
  callerMembershipId: string | undefined
  authority: RoleAuthority
  roles: readonly WorkspaceRole[] | undefined
  assigned: readonly string[]
  onNotice: (text: string, tone?: 'neutral' | 'bad') => void
}) {
  const copy = useAdminCopy()
  const client = useQueryClient()
  const invalidateIam = useInvalidateIam(organisationId)
  const [busy, setBusy] = useState(false)
  const name = memberName(member, copy.unnamed)
  const self = member.id === callerMembershipId
  const targets = self ? [] : roleChangeTargets(callerRole, member.role)
  const assignedRoles = (roles ?? []).filter((role) => assigned.includes(role.id))
  // Only the owner bypasses the target checks (Core 0.50.0): an administrator or a delegated
  // manager changes neither their own assignments, nor an owner's/admin's, nor a role set that
  // includes a role above their ceiling or with capabilities they do not hold.
  const mayAssign =
    roles !== undefined &&
    (callerRole === 'org_owner' ||
      (authority.ceiling >= 0 &&
        !self &&
        member.role !== 'org_owner' &&
        member.role !== 'org_admin' &&
        assignedRoles.every((role) => mayManage(authority, role))))

  function applyRole(role: OrganisationRole) {
    setBusy(true)
    onNotice(copy.saving)
    void changeOrganisationRole(organisationId, member, role)
      .then(
        () => onNotice(copy.memberRoleChanged(name, copy.orgRole[role])),
        (error: unknown) => onNotice(copy.roleChangeProblem[roleChangeProblem(error)], 'bad')
      )
      .finally(() => {
        setBusy(false)
        void client.invalidateQueries({ queryKey: directoryKeys.all(organisationId) })
      })
  }

  function assign(next: readonly string[]) {
    setBusy(true)
    onNotice(copy.saving)
    void setMemberRoles(organisationId, member.id, next)
      .then(
        () => onNotice(copy.memberRolesSaved(name)),
        (error: unknown) => onNotice(problemText(error, copy), 'bad')
      )
      .finally(() => {
        setBusy(false)
        void invalidateIam()
      })
  }

  const addable = (roles ?? []).filter(
    (role) => !assigned.includes(role.id) && mayManage(authority, role)
  )

  return (
    <li className="flex flex-col gap-2 py-3" aria-busy={busy || undefined}>
      <div className="flex items-center gap-3">
        <Avatar name={name} identity={member.id} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {name}
            {self ? (
              <span className="ml-2 text-xs font-regular text-c-ink-3">{copy.you}</span>
            ) : null}
          </p>
          {member.state === 'active' ? null : (
            <p className="text-xs text-c-ink-3">{copy.memberState[member.state]}</p>
          )}
        </div>
        <MenuButton
          label={copy.memberChangeRole(name, copy.orgRole[member.role])}
          disabled={busy || targets.length === 0}
          content={
            <>
              {copy.orgRole[member.role]}
              {targets.length === 0 ? null : <DownIcon />}
            </>
          }
          items={targets.map((role) => ({
            key: role,
            label: copy.orgRoleAction[role],
            onSelect: () => applyRole(role),
          }))}
        />
      </div>
      {assignedRoles.length === 0 && !mayAssign ? null : (
        <ul
          className="flex flex-wrap items-center gap-1 pl-[44px]"
          aria-label={copy.memberRoles(name)}
        >
          {assignedRoles.map((role) => (
            <li key={role.id}>
              <RolePill role={role}>
                {mayAssign && mayManage(authority, role) ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={copy.memberRoleRemove(role.name, name)}
                    title={copy.memberRoleRemove(role.name, name)}
                    className="ml-1 flex h-4 w-4 items-center justify-center rounded-full text-c-ink-3 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden"
                    onClick={() => assign(assigned.filter((id) => id !== role.id))}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </RolePill>
            </li>
          ))}
          {mayAssign && addable.length > 0 ? (
            <li>
              <MenuButton
                label={copy.memberRoleAdd(name)}
                disabled={busy}
                content={<PlusIcon />}
                items={addable.map((role) => ({
                  key: role.id,
                  label: `${role.icon === '' ? '' : `${role.icon} `}${role.name} · ${copy.kind[role.kind]}`,
                  onSelect: () => assign([...assigned, role.id]),
                }))}
              />
            </li>
          ) : null}
        </ul>
      )}
    </li>
  )
}

export function WorkspaceMembersPanel({
  organisationId,
  callerRole,
  callerMembershipId,
  authority,
}: {
  organisationId: string
  callerRole: OrganisationRole
  callerMembershipId: string | undefined
  authority: RoleAuthority
}) {
  const copy = useAdminCopy()
  const [search, setSearch] = useState('')
  const members = useDirectory(organisationId, search)
  const roles = useWorkspaceRoles(organisationId)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })
  const rows = useMemo(
    () => (members.data?.pages ?? []).flatMap((page) => page.data),
    [members.data]
  )
  const assignments = useMemo(
    () => new Map((roles.data?.assignments ?? []).map((row) => [row.membership_id, row.role_ids])),
    [roles.data]
  )

  return (
    <Panel title={copy.sections.members} hint={copy.membersHint}>
      <TextField
        label={copy.memberSearch}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {roles.isError && isIamUnsupported(roles.error) ? (
        <p className="text-xs text-c-ink-3">{copy.unsupportedRoles}</p>
      ) : null}
      <Notice text={notice.text} tone={notice.tone} />
      {members.isError ? (
        <Notice tone="bad" text={copy.problemGeneric} />
      ) : members.data === undefined ? (
        <p className="text-sm text-c-ink-3">{copy.loading}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-c-ink-2">{copy.noMatch}</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-c-border-soft"
          aria-label={copy.sections.members}
        >
          {rows.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              organisationId={organisationId}
              callerRole={callerRole}
              callerMembershipId={callerMembershipId}
              authority={authority}
              roles={roles.data?.roles}
              assigned={assignments.get(member.id) ?? []}
              onNotice={(text, tone = 'neutral') => setNotice({ text, tone })}
            />
          ))}
        </ul>
      )}
      {members.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
          >
            {copy.loadMore}
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}
