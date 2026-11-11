import { coreApi } from '../../api/client'

/** Resolve server-owned IDs only on explicit activation, never from a guessed Matrix alias. */
export async function communitySupportPath(): Promise<string | undefined> {
  const { data: me } = await coreApi().GET('/me')
  const membership = me?.organisations.find((entry) => entry.organisation.slug === 'community')
  if (!membership) return undefined
  const { data: workspace } = await coreApi().GET('/organisations/{organisation_id}/workspace', {
    params: { path: { organisation_id: membership.organisation.id } },
  })
  const channel = [
    ...(workspace?.categories.flatMap((category) => category.channels) ?? []),
    ...(workspace?.uncategorised_channels ?? []),
  ].find(
    (entry) =>
      entry.kind === 'text' &&
      entry.lifecycle === 'active' &&
      (entry.template_key === 'support' || entry.name === 'support')
  )
  return channel ? `/community/workspace/${encodeURIComponent(channel.id)}` : undefined
}
