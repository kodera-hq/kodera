// Administration › Logs d'audit: the workspace's governance events, newest first, filtered by
// category and by who acted. Core returns identifiers only; the console names an actor from the
// organisation directory when it can, and says « Kodera » for the platform's own actions.

import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button } from '../../../ui/Button/Button'
import { Select } from '../../../ui/Select/Select'
import {
  isIamUnsupported,
  listWorkspaceAuditLogs,
  type AuditEvent,
  type Page,
} from '../iamApi'
import { iamKeys, retryUnlessUnsupported } from './useIam'
import { useDirectory } from './membersApi'
import { memberName } from './WorkspaceMembersPanel'
import {
  Loading,
  Notice,
  Panel,
  problemText,
  Unsupported,
  useAdminCopy,
  useDateTime,
} from './shared'

export const AUDIT_CATEGORIES = [
  'all',
  'role',
  'member',
  'channel',
  'invite',
  'moderation',
  'profile',
  'workspace',
  'quota',
  'document',
  'content',
  'notification',
  'security',
] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

/**
 * The verb of a Core audit action. Core emits dot-separated actions (`workspace.role.created`,
 * `workspace.member.roles_updated`) and underscore-suffixed ones (`workspace.channel_created`,
 * `workspace.invite_link_revoked`): the verb is the longest known verb the action ends with, so
 * `channel_created` reads as `created` and `channel_set_refused` as `refused`, never as an
 * unknown fallback.
 */
const AUDIT_VERBS = [
  'overrides_updated',
  'channel_granted',
  'access_changed',
  'roles_updated',
  'initialised',
  'configured',
  'registered',
  'unarchived',
  'reactivated',
  'completed',
  'previewed',
  'published',
  'suspended',
  'unbanned',
  'unmuted',
  'refused',
  'claimed',
  'redeemed',
  'resolved',
  'dismissed',
  'created',
  'deleted',
  'archived',
  'revoked',
  'banned',
  'kicked',
  'muted',
  'removed',
  'updated',
  'assigned',
  'replaced',
  'unmute',
  'ban',
  'unban',
  'kick',
  'mute',
].sort((a, b) => b.length - a.length)

export function auditActionVerb(action: string): string {
  const token = action.split('.').at(-1) ?? action
  return AUDIT_VERBS.find((verb) => token === verb || token.endsWith(`_${verb}`)) ?? token
}

/** The category an action belongs to, from its dotted name (`workspace.role.created`). */
export function auditCategory(action: string): Exclude<AuditCategory, 'all'> | null {
  const part = action.split('.')[1] ?? ''
  const verb = action.split('.').at(-1) ?? ''
  // A member action that moderates (ban, unban, kick, mute, unmute) is moderation, not membership.
  if (part === 'member' && ['ban', 'unban', 'kick', 'mute', 'unmute'].includes(verb))
    return 'moderation'
  if (part.startsWith('role')) return 'role'
  if (part.startsWith('member')) return 'member'
  if (part.startsWith('channel') || part.startsWith('categor')) return 'channel'
  if (part.startsWith('invite')) return 'invite'
  if (part.startsWith('moderation') || part.startsWith('ban') || part.startsWith('report'))
    return 'moderation'
  if (part.startsWith('profile')) return 'profile'
  if (part.startsWith('initialised')) return 'workspace'
  if (part.startsWith('quota')) return 'quota'
  if (part.startsWith('document') || part.startsWith('collection')) return 'document'
  if (part.startsWith('attachment') || part.startsWith('url')) return 'content'
  if (part.startsWith('notification') || part.startsWith('push')) return 'notification'
  if (part.startsWith('e2ee')) return 'security'
  return null
}

const ALL_ACTORS = 'all'

export function AuditLogPanel({ organisationId }: { organisationId: string }) {
  const copy = useAdminCopy()
  const date = useDateTime()
  const [category, setCategory] = useState<AuditCategory>('all')
  const [actor, setActor] = useState(ALL_ACTORS)
  const directory = useDirectory(organisationId)
  // Core names an audit actor by its identity id; the directory may key a row by either its
  // person id or its identity id, so both resolve to the member's name.
  const people = useMemo(() => {
    const names = new Map<string, string>()
    for (const member of (directory.data?.pages ?? []).flatMap((page) => page.data)) {
      const label = memberName(member, copy.unnamed)
      if (member.person_id) names.set(member.person_id, label)
      if (member.identity_id) names.set(member.identity_id, label)
    }
    return names
  }, [directory.data, copy.unnamed])
  const events = useInfiniteQuery({
    queryKey: iamKeys.audit(organisationId, '', actor),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listWorkspaceAuditLogs(organisationId, {
        ...(actor === ALL_ACTORS ? {} : { actorId: actor }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    retry: retryUnlessUnsupported,
  })
  const rows = useMemo(
    () =>
      (events.data?.pages ?? [])
        .flatMap((page) => page.data)
        .filter((event) => category === 'all' || auditCategory(event.action) === category),
    [events.data, category]
  )
  const actorName = (event: Pick<AuditEvent, 'actor_id' | 'actor_type'>) =>
    event.actor_type !== 'tenant'
      ? copy.auditPlatform
      : event.actor_id === null
        ? copy.unnamed
        : (people.get(event.actor_id) ?? copy.auditUnknownMember)
  // The dropdown lists the directory's identity ids plus every actor seen in any cached audit
  // page: once an actor filter is applied, its query returns only that actor, but the
  // unfiltered pages stay in the cache, so the other actors do not disappear.
  const queryClient = useQueryClient()
  const actors = useMemo(() => {
    const ids = new Set<string>()
    const collect = (event: AuditEvent) => {
      if (event.actor_type === 'tenant' && event.actor_id !== null) ids.add(event.actor_id)
    }
    for (const event of (events.data?.pages ?? []).flatMap((page) => page.data)) collect(event)
    for (const member of (directory.data?.pages ?? []).flatMap((page) => page.data)) {
      if (member.identity_id) ids.add(member.identity_id)
    }
    for (const [, data] of queryClient.getQueriesData<InfiniteData<Page<AuditEvent>>>({
      queryKey: ['workspace-iam', organisationId, 'audit'],
    })) {
      for (const event of (data?.pages ?? []).flatMap((page) => page.data)) collect(event)
    }
    return [...ids].map((id) => [id, people.get(id) ?? copy.auditUnknownMember] as const)
  }, [queryClient, directory.data, events.data, organisationId, people, copy])

  if (events.isError && isIamUnsupported(events.error)) return <Unsupported />

  return (
    <Panel title={copy.sections.audit} hint={copy.auditHint}>
      <div className="grid grid-cols-2 gap-3 narrow:grid-cols-1">
        <Select
          label={copy.auditFilterCategory}
          value={category}
          onValueChange={(value) => setCategory(value as AuditCategory)}
          options={AUDIT_CATEGORIES.map((item) => ({
            value: item,
            label: copy.auditCategory[item],
          }))}
        />
        <Select
          label={copy.auditFilterActor}
          value={actor}
          onValueChange={setActor}
          options={[
            { value: ALL_ACTORS, label: copy.auditAllActors },
            ...(actor !== ALL_ACTORS && !actors.some(([id]) => id === actor)
              ? [{ value: actor, label: people.get(actor) ?? copy.auditUnknownMember }]
              : []),
            ...actors.map(([id, name]) => ({ value: id, label: name })),
          ]}
        />
      </div>
      {events.isError ? (
        <Notice tone="bad" text={problemText(events.error, copy)} />
      ) : events.data === undefined ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-c-ink-2">{copy.auditEmpty}</p>
      ) : (
        <ol
          className="flex flex-col divide-y divide-c-border-soft"
          aria-label={copy.sections.audit}
        >
          {rows.map((event) => {
            const kind = auditCategory(event.action)
            const verb = auditActionVerb(event.action)
            return (
              <li key={event.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p>
                    <span className="font-semibold">{actorName(event)}</span> {copy.auditVerb(verb)}{' '}
                    <span className="text-c-ink-2">
                      {kind === null ? copy.auditCategory.all : copy.auditCategory[kind]}
                    </span>
                  </p>
                </div>
                <time dateTime={event.occurred_at} className="shrink-0 text-xs text-c-ink-3">
                  {date(event.occurred_at, true)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
      {events.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {copy.loadMore}
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}
