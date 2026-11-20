// Administration › Rôles & Tags: roles, sub-teams and tags, ranked by position, each with a
// colour, an optional badge, its member count and the capabilities it grants. The console only
// offers what Core would accept — a delegated manager edits roles below their own highest role
// and grants only capabilities they hold — and Core re-checks every write.

import { useMemo, useState } from 'react'
import { Button } from '../../../ui/Button/Button'
import { Checkbox } from '../../../ui/Checkbox/Checkbox'
import { cx } from '../../../ui/cx'
import { RadioGroup } from '../../../ui/RadioGroup/RadioGroup'
import { Switch } from '../../../ui/Switch/Switch'
import { TextField } from '../../../ui/TextField/TextField'
import {
  byRank,
  createWorkspaceRole,
  deleteWorkspaceRole,
  isIamUnsupported,
  ROLE_KINDS,
  roleSlug,
  updateWorkspaceRole,
  type RoleDraft,
  type RoleKind,
  type WorkspaceCapability,
  type WorkspaceRole,
} from '../iamApi'
import {
  DownIcon,
  EditIcon,
  PersonIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  UpIcon,
} from './AdminIcons'
import { useInvalidateIam, useWorkspaceRoles } from './useIam'
import { ROLE_SWATCHES } from './WorkspaceProfilePanel'
import {
  ConfirmIconAction,
  Loading,
  Notice,
  Panel,
  problemText,
  RoleDot,
  Unsupported,
  useAdminCopy,
} from './shared'

export const CAPABILITY_GROUPS: readonly {
  key: 'channels' | 'messages' | 'files' | 'voice' | 'moderation' | 'administration'
  items: readonly WorkspaceCapability[]
}[] = [
  { key: 'channels', items: ['channel.view', 'channel.history'] },
  {
    key: 'messages',
    items: [
      'message.post',
      'message.reply',
      'message.react',
      'message.edit_own',
      'message.delete_own',
      'message.pin',
      'message.search',
    ],
  },
  { key: 'files', items: ['file.read', 'file.upload', 'file.delete_own'] },
  { key: 'voice', items: ['media.connect', 'media.speak', 'media.video', 'media.share'] },
  { key: 'moderation', items: ['message.delete_any', 'file.delete_any', 'media.moderate'] },
  { key: 'administration', items: ['manage_roles', 'view_audit_log'] },
]

export interface RoleAuthority {
  /** Owners manage every role; anyone else only below their own highest assigned position. */
  owner: boolean
  /** Workspace administrators (`org_admin`) manage every custom role below their ceiling and
   * grant any capability, exactly as Core 0.50.0 allows them to. */
  admin: boolean
  ceiling: number
  held: ReadonlySet<WorkspaceCapability>
}

type ManagedRole = Pick<WorkspaceRole, 'position' | 'is_default' | 'permissions'>

/**
 * Core 0.50.0's rule: a default role is never edited from the console, a role at or above the
 * caller's highest assigned position is out of reach, and a delegated manager (no `org_admin`)
 * only manages roles whose capabilities they hold themselves. Owners and administrators bypass
 * the capability check.
 */
export function mayManage(authority: RoleAuthority, role: ManagedRole): boolean {
  if (role.is_default) return false
  if (authority.owner) return true
  if (role.position >= authority.ceiling) return false
  return (
    authority.admin || role.permissions.every((permission) => authority.held.has(permission))
  )
}

/** Delegates cannot grant capabilities they do not hold; owners and administrators can. */
export function mayGrant(authority: RoleAuthority, capability: WorkspaceCapability): boolean {
  return Boolean(authority.owner || authority.admin || authority.held.has(capability))
}

const EMPTY_DRAFT: RoleDraft = {
  name: '',
  kind: 'role',
  color: ROLE_SWATCHES[0] ?? '',
  icon: '',
  position: 0,
  is_hoisted: false,
  is_mentionable: false,
  permissions: [
    'channel.view',
    'channel.history',
    'message.post',
    'message.reply',
    'message.react',
  ],
}

function RoleEditor({
  initial,
  authority,
  busy,
  onCancel,
  onSave,
}: {
  initial: RoleDraft
  authority: RoleAuthority
  busy: boolean
  onCancel: () => void
  onSave: (draft: RoleDraft) => void
}) {
  const copy = useAdminCopy()
  const [draft, setDraft] = useState<RoleDraft>(initial)
  const toggle = (capability: WorkspaceCapability, on: boolean) =>
    setDraft({
      ...draft,
      permissions: on
        ? [...new Set([...draft.permissions, capability])]
        : draft.permissions.filter((item) => item !== capability),
    })
  // A custom colour joins the swatches only when the contract's pattern accepts it; anything
  // else (an empty colour, a name) would draw a broken dot at the head of the row.
  const swatches =
    /^#[0-9a-fA-F]{6}$/u.test(draft.color) && !ROLE_SWATCHES.includes(draft.color.toLowerCase())
      ? [draft.color, ...ROLE_SWATCHES]
      : ROLE_SWATCHES
  return (
    <form
      aria-label={copy.roleEditor}
      className="flex flex-col gap-5 rounded-md bg-c-sunken p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.name.trim() !== '') onSave({ ...draft, name: draft.name.trim() })
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 narrow:grid-cols-1">
        <TextField
          label={copy.roleName}
          value={draft.name}
          maxLength={100}
          required
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextField
          label={copy.roleIcon}
          help={copy.roleIconHint}
          value={draft.icon}
          maxLength={32}
          onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
        />
      </div>
      <RadioGroup
        label={copy.roleKind}
        value={draft.kind}
        orientation="horizontal"
        options={ROLE_KINDS.map((kind) => ({ value: kind, label: copy.kind[kind] }))}
        onValueChange={(value) => setDraft({ ...draft, kind: value as RoleKind })}
      />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{copy.roleColor}</legend>
        <div className="flex flex-wrap gap-2">
          {swatches.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-pressed={draft.color.toLowerCase() === swatch.toLowerCase()}
              aria-label={copy.roleSwatch(swatch)}
              title={swatch}
              onClick={() => setDraft({ ...draft, color: swatch })}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-c-border focus-visible:ring focus-visible:outline-hidden aria-pressed:ring-2 aria-pressed:ring-c-accent-ink"
            >
              <RoleDot color={swatch} className="h-6 w-6" />
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-3">
        <Switch
          label={copy.roleHoisted}
          help={copy.roleHoistedHint}
          checked={draft.is_hoisted}
          onCheckedChange={(checked) => setDraft({ ...draft, is_hoisted: checked })}
        />
        <Switch
          label={copy.roleMentionable}
          help={copy.roleMentionableHint}
          checked={draft.is_mentionable}
          onCheckedChange={(checked) => setDraft({ ...draft, is_mentionable: checked })}
        />
      </div>
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium">{copy.roleCapabilities}</p>
        {CAPABILITY_GROUPS.map((group) => (
          <fieldset key={group.key} className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-semibold text-c-ink-3">
              {copy.capabilityGroup[group.key]}
            </legend>
            <div className="grid grid-cols-2 gap-2 narrow:grid-cols-1">
              {group.items.map((capability) => (
                <Checkbox
                  key={capability}
                  label={copy.capability[capability]}
                  checked={draft.permissions.includes(capability)}
                  disabled={!mayGrant(authority, capability)}
                  onCheckedChange={(checked) => toggle(capability, checked === true)}
                />
              ))}
            </div>
          </fieldset>
        ))}
        {authority.owner || authority.admin ? null : (
          <p className="text-xs text-c-ink-3">{copy.roleGrantHint}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={busy} disabled={draft.name.trim() === ''}>
          {copy.save}
        </Button>
        <Button type="button" variant="tertiary" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </form>
  )
}

export function WorkspaceRolesPanel({
  organisationId,
  authority,
}: {
  organisationId: string
  authority: RoleAuthority
}) {
  const copy = useAdminCopy()
  const query = useWorkspaceRoles(organisationId)
  const invalidate = useInvalidateIam(organisationId)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })
  const roles = useMemo(() => [...(query.data?.roles ?? [])].sort(byRank), [query.data])
  const shown = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return needle === ''
      ? roles
      : roles.filter((role) => role.name.toLocaleLowerCase().includes(needle))
  }, [roles, search])

  if (query.isError)
    return isIamUnsupported(query.error) ? (
      <Unsupported />
    ) : (
      <Notice tone="bad" text={problemText(query.error, copy)} />
    )
  if (query.data === undefined) return <Loading />

  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setNotice({ text: copy.saving, tone: 'neutral' })
    void work()
      .then(
        () => {
          setNotice({ text: done, tone: 'neutral' })
          setEditing(null)
        },
        (error: unknown) => setNotice({ text: problemText(error, copy), tone: 'bad' })
      )
      .finally(() => {
        setBusy(false)
        void invalidate()
      })
  }

  const topPosition = roles.reduce((max, role) => Math.max(max, role.position), -1)
  const newPosition = authority.owner
    ? topPosition + 1
    : Math.max(0, Math.min(topPosition + 1, authority.ceiling - 1))
  const canCreate = authority.owner || authority.ceiling > 0

  /**
   * Equal positions at the caller's ceiling cannot be separated upward — Core rejects a move to
   * the ceiling itself (403) — so the pair is separated downward instead, and at the floor
   * (position 0) the move is not offered at all.
   */
  const blockedAtCeiling = (above: WorkspaceRole, below: WorkspaceRole) => {
    const high = Math.max(above.position, below.position)
    const low = Math.min(above.position, below.position)
    return (
      high === low && !authority.owner && low === 0 && high + 1 >= authority.ceiling
    )
  }

  function move(role: WorkspaceRole, direction: 'up' | 'down') {
    const index = roles.findIndex((item) => item.id === role.id)
    const neighbour = roles[direction === 'up' ? index - 1 : index + 1]
    if (neighbour === undefined) return
    const [above, below] = direction === 'up' ? [role, neighbour] : [neighbour, role]
    // `above` takes the higher slot; equal positions are separated rather than swapped.
    const high = Math.max(above.position, below.position)
    const low = Math.min(above.position, below.position)
    const atCeiling = high === low && !authority.owner && high + 1 >= authority.ceiling
    // Upward separation past the ceiling is refused by Core: keep the slot and separate down.
    const nextAbove = high === low && !atCeiling ? high + 1 : high
    const nextBelow = high === low && atCeiling && low > 0 ? low - 1 : low
    run(async () => {
      if (nextAbove !== above.position)
        await updateWorkspaceRole(organisationId, above, { position: nextAbove })
      if (nextBelow !== below.position)
        await updateWorkspaceRole(organisationId, below, { position: nextBelow })
    }, copy.roleMoved)
  }

  return (
    <Panel
      title={copy.sections.roles}
      hint={copy.rolesHint}
      actions={
        canCreate ? (
          <Button
            variant="primary"
            size="sm"
            icon={<PlusIcon />}
            onClick={() => setEditing('new')}
            disabled={editing === 'new'}
          >
            {copy.roleCreate}
          </Button>
        ) : undefined
      }
    >
      <div className="relative">
        <TextField
          label={copy.roleSearch}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="pointer-events-none absolute right-3 bottom-3 text-c-ink-3">
          <SearchIcon />
        </span>
      </div>
      {editing === 'new' ? (
        <RoleEditor
          // A delegated manager starts with only the default capabilities they hold themselves.
          initial={{
            ...EMPTY_DRAFT,
            position: newPosition,
            permissions: EMPTY_DRAFT.permissions.filter((permission) =>
              mayGrant(authority, permission)
            ),
          }}
          authority={authority}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(draft) =>
            run(
              () =>
                createWorkspaceRole(organisationId, {
                  ...draft,
                  position: newPosition,
                  slug: roleSlug(
                    draft.name,
                    roles.map((role) => role.slug)
                  ),
                }),
              copy.roleCreated(draft.name)
            )
          }
        />
      ) : null}
      <Notice text={notice.text} tone={notice.tone} />
      {shown.length === 0 ? (
        <p className="text-sm text-c-ink-2">
          {roles.length === 0 ? copy.rolesEmpty : copy.noMatch}
        </p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-c-border-soft"
          aria-label={copy.sections.roles}
        >
          {shown.map((role) => {
            const index = roles.findIndex((item) => item.id === role.id)
            const manageable = mayManage(authority, role)
            const above = roles[index - 1]
            const below = roles[index + 1]
            return (
              <li key={role.id} className="flex flex-col gap-3 py-3">
                <div className="flex items-center gap-3">
                  <RoleDot color={role.color} />
                  {role.icon === '' ? null : <span aria-hidden="true">{role.icon}</span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{role.name}</p>
                    <p className="flex flex-wrap gap-x-2 text-xs text-c-ink-3">
                      <span>{copy.kind[role.kind]}</span>
                      {role.is_hoisted ? <span>{copy.roleHoistedShort}</span> : null}
                      {role.is_mentionable ? <span>@{role.slug}</span> : null}
                    </p>
                  </div>
                  <span
                    className="flex items-center gap-1 text-xs text-c-ink-2"
                    aria-label={copy.roleMembers(role.member_count)}
                  >
                    <span aria-hidden="true">{role.member_count}</span>
                    <PersonIcon />
                  </span>
                  {manageable ? (
                    <div className={cx('flex shrink-0 items-center gap-1', busy && 'opacity-60')}>
                      <Button
                        variant="tertiary"
                        size="sm"
                        iconOnly
                        icon={<UpIcon />}
                        aria-label={copy.roleUp(role.name)}
                        disabled={
                          busy ||
                          above === undefined ||
                          !mayManage(authority, above) ||
                          blockedAtCeiling(role, above)
                        }
                        onClick={() => move(role, 'up')}
                      />
                      <Button
                        variant="tertiary"
                        size="sm"
                        iconOnly
                        icon={<DownIcon />}
                        aria-label={copy.roleDown(role.name)}
                        disabled={
                          busy ||
                          below === undefined ||
                          !mayManage(authority, below) ||
                          blockedAtCeiling(below, role)
                        }
                        onClick={() => move(role, 'down')}
                      />
                      <Button
                        variant="tertiary"
                        size="sm"
                        iconOnly
                        icon={<EditIcon />}
                        aria-label={copy.roleEdit(role.name)}
                        aria-expanded={editing === role.id}
                        onClick={() => setEditing(editing === role.id ? null : role.id)}
                      />
                      <ConfirmIconAction
                        icon={<TrashIcon />}
                        label={copy.roleDelete(role.name)}
                        title={copy.roleDeleteTitle(role.name)}
                        consequence={copy.roleDeleteConsequence}
                        confirmLabel={copy.roleDeleteConfirm}
                        busy={busy}
                        onConfirm={() =>
                          run(
                            () => deleteWorkspaceRole(organisationId, role.id),
                            copy.roleDeleted(role.name)
                          )
                        }
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-c-ink-3">{copy.roleAboveYou}</span>
                  )}
                </div>
                {editing === role.id ? (
                  <RoleEditor
                    initial={role}
                    authority={authority}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(draft) =>
                      run(
                        () =>
                          updateWorkspaceRole(organisationId, role, {
                            name: draft.name,
                            kind: draft.kind,
                            color: draft.color,
                            icon: draft.icon,
                            is_hoisted: draft.is_hoisted,
                            is_mentionable: draft.is_mentionable,
                            permissions: draft.permissions,
                          }),
                        copy.roleSaved(draft.name)
                      )
                    }
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
