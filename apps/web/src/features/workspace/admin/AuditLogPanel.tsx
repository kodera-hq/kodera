// Administration › Logs d'audit: the workspace's governance events, newest first, filtered by
// category and by who acted. Core returns identifiers only; the console names an actor from the
// organisation directory when it can, and says « Kodera » for the platform's own actions.

import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button } from '../../../ui/Button/Button'
import { Select } from '../../../ui/Select/Select'
import { isIamUnsupported, listWorkspaceAuditLogs, type AuditEvent } from '../iamApi'
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
] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

/** The category an action belongs to, from its dotted name (`workspace.role.created`). */
export function auditCategory(action: string): Exclude<AuditCategory, 'all'> | null {
  const part = action.split('.')[1] ?? ''
  if (part.startsWith('role')) return 'role'
  if (part.startsWith('member')) return 'member'
  if (part.startsWith('channel') || part.startsWith('categor')) return 'channel'
  if (part.startsWith('invite')) return 'invite'
  if (part.startsWith('moderation') || part.startsWith('ban') || part.startsWith('report'))
    return 'moderation'
  if (part.startsWith('profile')) return 'profile'
  return null
}

const ALL_ACTORS = 'all'

export function AuditLogPanel({ organisationId }: { organisationId: string }) {
  const copy = useAdminCopy()
  const date = useDateTime()
  const [category, setCategory] = useState<AuditCategory>('all')
  const [actor, setActor] = useState(ALL_ACTORS)
  const directory = useDirectory(organisationId)
  const people = useMemo(() => {
    const names = new Map<string, string>()
    for (const member of (directory.data?.pages ?? []).flatMap((page) => page.data)) {
      if (member.person_id) names.set(member.person_id, memberName(member, copy.unnamed))
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
        : (people.get(event.actor_id) ?? copy.auditFormerMember)
  const actors = useMemo(() => {
    const seen = new Map<string, string>()
    for (const event of (events.data?.pages ?? []).flatMap((page) => page.data)) {
      if (event.actor_type === 'tenant' && event.actor_id !== null)
        seen.set(event.actor_id, people.get(event.actor_id) ?? copy.auditFormerMember)
    }
    return [...seen]
  }, [events.data, people, copy.auditFormerMember])

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
              ? [{ value: actor, label: people.get(actor) ?? copy.auditFormerMember }]
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
            const verb = event.action.split('.').at(-1) ?? ''
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
