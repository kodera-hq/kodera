// Administration › Profil de l'espace: how the workspace presents itself — description, banner,
// up to five traits — with a preview card that follows every keystroke. Saved in one PATCH under
// the profile's tag, so a change another administrator saved meanwhile is never overwritten.

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { color } from '@kodera/design-tokens/tokens.json'
import { Button } from '../../../ui/Button/Button'
import { cx } from '../../../ui/cx'
import { TextField } from '../../../ui/TextField/TextField'
import { initialsOf } from '../../../ui/Avatar/Avatar'
import { updateWorkspaceProfile, type ProfileTrait, type WorkspaceProfile } from '../iamApi'
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
}: {
  name: string
  description: string
  banner: string
  traits: readonly ProfileTrait[]
  memberCount?: number | undefined
}) {
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
          {initialsOf(name)}
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
  const [draft, setDraft] = useDraft<WorkspaceProfile>(query.data?.value)
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.value)
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
        description: draft.description,
        banner_preset: draft.banner_preset,
        traits: draft.traits,
      },
      etag
    )
      .then(
        (saved) => {
          client.setQueryData(iamKeys.profile(organisationId), saved)
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
          value={organisationName}
          readOnly
          help={copy.profileNameHint}
        />
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
            <Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>
              {copy.save}
            </Button>
            {dirty ? (
              <Button variant="tertiary" onClick={() => setDraft(query.data.value)}>
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
          name={organisationName}
          description={draft.description}
          banner={draft.banner_preset}
          traits={draft.traits}
        />
      </div>
    </div>
  )
}
