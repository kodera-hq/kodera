import { useWorkspaceLogo } from '../useWorkspaceLogo'
// Administration › Profil de l'espace: how the workspace presents itself — description, banner,
// up to five traits — with a preview card that follows every keystroke. Saved in one PATCH under
// the profile's tag, so a change another administrator saved meanwhile is never overwritten.

import { useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useMemo } from 'react'
import { color } from '@kodera/design-tokens/tokens.json'
import { Button } from '../../../ui/Button/Button'
import { cx } from '../../../ui/cx'
import { TextField } from '../../../ui/TextField/TextField'
import { initialsOf } from '../../../ui/Avatar/Avatar'
import { updateWorkspaceProfile, type ProfileTrait, type WorkspaceProfile } from '../iamApi'
import { useWorkspaceQuery, workspaceQueryKey, type WorkspaceRead } from '../queries'
import { everyChannel } from '../workspace'
import { PlusIcon, TrashIcon } from './AdminIcons'
import { iamKeys, useWorkspaceProfile } from './useIam'
import { Loading, Notice, problemText, useDraft, Unsupported, useAdminCopy } from './shared'
import { isIamUnsupported } from '../iamApi'

export const MAX_TRAITS = 5

/** Banner presets: a contract-safe key and the token class that draws it. */
export const BANNER_PRESETS = {
  ink: 'bg-c-inverse',
  action: 'bg-c-action',
  violet: 'bg-c-tag-1-fg',
  lagoon: 'bg-c-tag-2-fg',
  rose: 'bg-c-tag-3-fg',
  cobalt: 'bg-c-tag-4-fg',
  orchid: 'bg-c-tag-5-fg',
  moss: 'bg-c-tag-6-fg',
} as const
export type BannerPreset = keyof typeof BANNER_PRESETS

export function bannerClass(preset: string): string {
  return preset in BANNER_PRESETS ? BANNER_PRESETS[preset as BannerPreset] : BANNER_PRESETS.ink
}

/**
 * The role colours offered by the role editor, taken from the design tokens' tag and cursor
 * inks: each reads at AA contrast on the light surfaces a role pill sits on.
 */
export const ROLE_SWATCHES: readonly string[] = (() => {
  const light = color['theme-light'] as unknown as Record<string, { $value?: unknown } | undefined>
  return [1, 2, 3, 4, 5, 6]
    .flatMap((n) => [light[`tag-${n}-fg`]?.$value, light[`cursor-${n}`]?.$value])
    .filter(
      (value): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/u.test(value)
    )
    .map((value) => value.toLowerCase())
})()

const TRAIT_PRESETS = [
  { icon: '💻', key: 'tech' },
  { icon: '🧪', key: 'research' },
  { icon: '🎨', key: 'design' },
  { icon: '📣', key: 'marketing' },
  { icon: '🤝', key: 'community' },
  { icon: '🔒', key: 'security' },
] as const

export function ServerPreviewCard({
  name,
  description,
  banner,
  traits,
  memberCount,
  logoUrl,
}: {
  name: string
  description: string
  banner: string
  traits: readonly ProfileTrait[]
  logoUrl?: string | undefined
  memberCount?: number | undefined
}) {
  const logoSrc = useWorkspaceLogo(logoUrl)
  const copy = useAdminCopy()
  return (
    <figure
      aria-label={copy.profilePreview}
      className="flex w-full flex-col overflow-hidden rounded-lg border border-c-border bg-c-elevated shadow-pop shadow-c-shadow-1"
    >
      <div
        data-testid="preview-banner"
        data-preset={banner}
        className={cx('h-[64px]', bannerClass(banner))}
      />
      <div className="-mt-6 flex flex-col gap-2 px-4 pb-4">
        <span
          aria-hidden="true"
          className="logo-tile-black flex h-12 w-12 items-center justify-center rounded-lg border-2 border-c-elevated text-sm font-bold"
        >
          {logoSrc ? (
            <img src={logoSrc} alt="" className="h-full w-full rounded-lg object-cover" />
          ) : (
            initialsOf(name)
          )}
        </span>
        <p className="truncate text-base font-semibold">{name}</p>
        <p className="line-clamp-3 text-sm break-words text-c-ink-2">
          {description.trim() === '' ? copy.profilePreviewEmpty : description}
        </p>
        {traits.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1" aria-label={copy.profileTraits}>
            {traits.map((trait, index) => (
              <li
                key={`${trait.label}-${index}`}
                className="rounded-full bg-c-sunken px-2 py-[2px] text-xs text-c-ink"
              >
                <span aria-hidden="true">{trait.icon}</span> {trait.label}
              </li>
            ))}
          </ul>
        )}
        {memberCount === undefined ? null : (
          <p className="text-xs text-c-ink-3">{copy.profileMembers(memberCount)}</p>
        )}
      </div>
    </figure>
  )
}

export function WorkspaceProfilePanel({
  organisationId,
  organisationName,
  canEdit,
}: {
  organisationId: string
  organisationName: string
  canEdit: boolean
}) {
  const copy = useAdminCopy()
  const client = useQueryClient()
  const query = useWorkspaceProfile(organisationId)
  const workspace = useWorkspaceQuery(organisationId)
  const logoInput = useRef<HTMLInputElement>(null)
  const profile = useMemo(
    () =>
      query.data
        ? { ...query.data.value, display_name: query.data.value.display_name ?? '' }
        : undefined,
    [query.data]
  )
  const [draft, setDraft] = useDraft<WorkspaceProfile>(profile)
  const [newTrait, setNewTrait] = useState({ icon: '', label: '' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })

  if (query.isError)
    return isIamUnsupported(query.error) ? (
      <Unsupported />
    ) : (
      <Notice tone="bad" text={problemText(query.error, copy)} />
    )
  if (draft === undefined || query.data === undefined) return <Loading />

  const etag = query.data.etag
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile)
  const trimmedDisplayName = (draft.display_name ?? '').trim()
  const displayNameValid = trimmedDisplayName === '' || trimmedDisplayName.length >= 2
  const addTrait = (trait: ProfileTrait) => {
    const icon = trait.icon.trim()
    const label = trait.label.trim()
    if (label === '' || icon === '' || draft.traits.length >= MAX_TRAITS) return
    setDraft({
      ...draft,
      traits: [...draft.traits, { icon: icon.slice(0, 32), label: label.slice(0, 50) }],
    })
  }

  function save() {
    if (draft === undefined || busy) return
    setBusy(true)
    setNotice({ text: copy.saving, tone: 'neutral' })
    void updateWorkspaceProfile(
      organisationId,
      {
        display_name: trimmedDisplayName,
        logo_url: draft.logo_url ?? '',
        default_ui_mode: draft.default_ui_mode ?? 'pro',
        default_channel_id: draft.default_channel_id ?? null,
        allow_member_channel_creation: draft.allow_member_channel_creation ?? false,
        allow_member_invites: draft.allow_member_invites ?? true,
        allow_link_previews: draft.allow_link_previews ?? true,
        description: draft.description,
        banner_preset: draft.banner_preset,
        traits: draft.traits,
      },
      etag
    )
      .then(
        (saved) => {
          client.setQueryData(iamKeys.profile(organisationId), saved)
          client.setQueryData<WorkspaceRead>(workspaceQueryKey(organisationId), (previous) =>
            previous
              ? {
                  ...previous,
                  workspace: { ...previous.workspace, ...saved.value },
                }
              : previous
          )
          void client.invalidateQueries({ queryKey: workspaceQueryKey(organisationId) })
          setNotice({ text: copy.saved, tone: 'neutral' })
        },
        (error: unknown) => {
          setNotice({ text: problemText(error, copy), tone: 'bad' })
          void query.refetch()
        }
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_18rem] gap-6 narrow:grid-cols-1">
      <div className="flex flex-col gap-5">
        <TextField
          label={copy.profileName}
          value={draft.display_name ?? ''}
          placeholder={organisationName}
          disabled={!canEdit}
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
          help={copy.profileNameHint}
        />
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="workspace-logo-upload">
            {copy.profileLogo}
          </label>
          <input
            id="workspace-logo-upload"
            ref={logoInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={!canEdit || busy}
            className="min-h-[44px] text-sm text-c-ink file:mr-3 file:rounded-md file:border file:border-c-border file:bg-c-surface file:px-3 file:py-2 file:text-c-ink"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              if (
                !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
                file.size > 2 * 1024 * 1024 ||
                file.size === 0
              ) {
                setNotice({ text: copy.profileLogoError, tone: 'bad' })
                return
              }
              const reader = new FileReader()
              reader.onload = () => {
                if (typeof reader.result === 'string')
                  setDraft((current) => ({ ...current, logo_url: reader.result as string }))
              }
              reader.onerror = () => setNotice({ text: copy.profileLogoError, tone: 'bad' })
              reader.readAsDataURL(file)
            }}
          />
          <p className="text-xs text-c-ink-3">{copy.profileLogoHint}</p>
          {draft.logo_url && canEdit ? (
            <Button variant="secondary" onClick={() => setDraft({ ...draft, logo_url: '' })}>
              {copy.profileLogoRemove}
            </Button>
          ) : null}
        </div>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {copy.profileDefaultMode}
          <select
            disabled={!canEdit}
            value={draft.default_ui_mode ?? 'pro'}
            onChange={(event) =>
              setDraft({ ...draft, default_ui_mode: event.target.value as 'pro' | 'messages' })
            }
            className="min-h-[44px] rounded-md border border-c-border bg-c-surface px-3 text-c-ink focus-visible:ring"
          >
            <option value="pro">{copy.profilePro}</option>
            <option value="messages">{copy.profileMessages}</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {copy.profileLanding}
          <select
            disabled={!canEdit}
            value={draft.default_channel_id ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, default_channel_id: event.target.value || null })
            }
            className="min-h-[44px] rounded-md border border-c-border bg-c-surface px-3 text-c-ink focus-visible:ring"
          >
            <option value="">{copy.profileLandingArrivals}</option>
            {(workspace.data ? everyChannel(workspace.data.workspace) : [])
              .filter((channel) => channel.kind === 'text' && channel.lifecycle === 'active')
              .map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{copy.profilePermissions}</legend>
          {(
            [
              ['allow_member_channel_creation', copy.profileChannelCreation, false],
              ['allow_member_invites', copy.profileInvites, true],
              ['allow_link_previews', copy.profileLinkPreviews, true],
            ] as const
          ).map(([key, label, fallback]) => (
            <label key={key} className="flex min-h-[44px] items-center gap-3 text-sm">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={draft[key] ?? fallback}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <TextField
          label={copy.profileDescription}
          value={draft.description}
          maxLength={500}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{copy.profileBanner}</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(BANNER_PRESETS) as BannerPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={!canEdit}
                aria-pressed={draft.banner_preset === preset}
                aria-label={copy.bannerName[preset]}
                title={copy.bannerName[preset]}
                onClick={() => setDraft({ ...draft, banner_preset: preset })}
                className={cx(
                  'h-10 w-10 rounded-md border border-c-border focus-visible:ring focus-visible:outline-hidden aria-pressed:ring-2 aria-pressed:ring-c-accent-ink',
                  BANNER_PRESETS[preset]
                )}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">
            {copy.profileTraits} ({draft.traits.length}/{MAX_TRAITS})
          </legend>
          <ul className="flex flex-col gap-2">
            {draft.traits.map((trait, index) => (
              <li key={`${trait.label}-${index}`} className="flex items-center gap-2 text-sm">
                <span aria-hidden="true">{trait.icon}</span>
                <span className="min-w-0 flex-1 truncate">{trait.label}</span>
                {canEdit ? (
                  <Button
                    variant="tertiary"
                    size="sm"
                    iconOnly
                    icon={<TrashIcon />}
                    aria-label={copy.traitRemove(trait.label)}
                    onClick={() =>
                      setDraft({ ...draft, traits: draft.traits.filter((_, at) => at !== index) })
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {canEdit && draft.traits.length < MAX_TRAITS ? (
            <>
              <div className="flex flex-wrap gap-1">
                {TRAIT_PRESETS.map((preset) => ({
                  icon: preset.icon,
                  label: copy.traitPreset[preset.key],
                }))
                  .filter((preset) => !draft.traits.some((trait) => trait.label === preset.label))
                  .map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => addTrait(preset)}
                      className="rounded-full border border-c-border px-2 py-1 text-xs hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
                    >
                      <span aria-hidden="true">{preset.icon}</span> {preset.label}
                    </button>
                  ))}
              </div>
              <div className="flex items-end gap-2">
                <TextField
                  label={copy.traitIcon}
                  value={newTrait.icon}
                  maxLength={32}
                  className="w-[96px]"
                  onChange={(event) => setNewTrait({ ...newTrait, icon: event.target.value })}
                />
                <TextField
                  label={copy.traitLabel}
                  value={newTrait.label}
                  maxLength={50}
                  className="flex-1"
                  onChange={(event) => setNewTrait({ ...newTrait, label: event.target.value })}
                />
                <Button
                  variant="secondary"
                  iconOnly
                  icon={<PlusIcon />}
                  aria-label={copy.traitAdd}
                  disabled={newTrait.label.trim() === '' || newTrait.icon.trim() === ''}
                  onClick={() => {
                    addTrait(newTrait)
                    setNewTrait({ icon: '', label: '' })
                  }}
                />
              </div>
            </>
          ) : null}
        </fieldset>
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={!dirty || !displayNameValid}
              loading={busy}
              onClick={save}
            >
              {copy.save}
            </Button>
            {dirty ? (
              <Button variant="tertiary" onClick={() => setDraft(profile!)}>
                {copy.discard}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-c-ink-3">{copy.readOnlyHint}</p>
        )}
        <Notice text={notice.text} tone={notice.tone} />
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold text-c-ink-3">{copy.profilePreview}</p>
        <ServerPreviewCard
          name={trimmedDisplayName || organisationName}
          logoUrl={draft.logo_url}
          description={draft.description}
          banner={draft.banner_preset}
          traits={draft.traits}
        />
      </div>
    </div>
  )
}
