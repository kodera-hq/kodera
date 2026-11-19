// Administration › Communauté & #arrivées: which text channel greets newcomers, which one holds
// the rules, and where moderator updates and security alerts are posted. Saved in one PATCH of
// the workspace profile under its tag.

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button } from '../../../ui/Button/Button'
import { Select } from '../../../ui/Select/Select'
import { isIamUnsupported, updateWorkspaceProfile, type WorkspaceProfile } from '../iamApi'
import { iamKeys, useWorkspaceChannels, useWorkspaceProfile } from './useIam'
import { Loading, Notice, Panel, problemText, Unsupported, useAdminCopy, useDraft } from './shared'

export const COMMUNITY_CHANNELS = [
  'arrivals_channel_id',
  'rules_channel_id',
  'moderator_updates_channel_id',
  'security_alerts_channel_id',
] as const satisfies readonly (keyof WorkspaceProfile)[]
type CommunityKey = (typeof COMMUNITY_CHANNELS)[number]

const NONE = 'none'

export function CommunityPanel({
  organisationId,
  canEdit,
}: {
  organisationId: string
  canEdit: boolean
}) {
  const copy = useAdminCopy()
  const client = useQueryClient()
  const profile = useWorkspaceProfile(organisationId)
  const channels = useWorkspaceChannels(organisationId).filter((channel) => channel.kind === 'text')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'bad' }>({
    text: '',
    tone: 'neutral',
  })
  const loaded = profile.data?.value
  const source = useMemo(
    () =>
      loaded === undefined
        ? undefined
        : (Object.fromEntries(COMMUNITY_CHANNELS.map((key) => [key, loaded[key]])) as Record<
            CommunityKey,
            string | null
          >),
    [loaded]
  )
  const [draft, setDraft] = useDraft(source)

  if (profile.isError)
    return isIamUnsupported(profile.error) ? (
      <Unsupported />
    ) : (
      <Notice tone="bad" text={problemText(profile.error, copy)} />
    )
  if (profile.data === undefined || draft === undefined) return <Loading />
  const current = profile.data
  const dirty = COMMUNITY_CHANNELS.some((key) => draft[key] !== current.value[key])

  return (
    <Panel title={copy.sections.community} hint={copy.communityHint}>
      <div className="grid grid-cols-2 gap-4 narrow:grid-cols-1">
        {COMMUNITY_CHANNELS.map((key) => (
          <Select
            key={key}
            label={copy.communityChannel[key]}
            help={copy.communityChannelHint[key]}
            disabled={!canEdit}
            value={draft[key] ?? NONE}
            onValueChange={(value) => setDraft({ ...draft, [key]: value === NONE ? null : value })}
            options={[
              { value: NONE, label: copy.communityNone },
              ...channels.map((channel) => ({ value: channel.id, label: `#${channel.name}` })),
            ]}
          />
        ))}
      </div>
      {canEdit ? (
        <div>
          <Button
            variant="primary"
            disabled={!dirty}
            loading={busy}
            onClick={() => {
              setBusy(true)
              setNotice({ text: copy.saving, tone: 'neutral' })
              void updateWorkspaceProfile(organisationId, draft, current.etag)
                .then(
                  (saved) => {
                    client.setQueryData(iamKeys.profile(organisationId), saved)
                    setNotice({ text: copy.saved, tone: 'neutral' })
                  },
                  (error: unknown) => {
                    setNotice({ text: problemText(error, copy), tone: 'bad' })
                    void profile.refetch()
                  }
                )
                .finally(() => setBusy(false))
            }}
          >
            {copy.save}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-c-ink-3">{copy.readOnlyHint}</p>
      )}
      <Notice text={notice.text} tone={notice.tone} />
    </Panel>
  )
}
