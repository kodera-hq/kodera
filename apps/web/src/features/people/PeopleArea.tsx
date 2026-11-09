// The People route bodies (docs/specs/03-people.md §3), kept apart from
// `routes.tsx` so the role guard there can be tested without a router or a
// query client. Each body reads the URL and hands a router-free screen what
// to show plus `onNavigate`.

import { Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { authAdapter } from '../../auth/oidc'
import {
  canSaveInvitation,
  clearInvitation,
  readInvitation,
  resolveInvitationOwner,
  type InvitationOwner,
} from './invitationRecovery'
import { offers } from '../../app/capabilities'
import { orgRoute } from '../../app/org-route'
import { ImportScreen } from './ImportScreen'
import { InviteDrawer } from './InviteDrawer'
import { MemberDrawer } from './MemberDrawer'
import { OnSitePanel } from './OnSitePanel'
import { PeopleScreen, type PeopleTab, type PeopleTarget } from './PeopleScreen'

function useInvitationOwner(): InvitationOwner | undefined {
  const auth = useAuth()
  const { me, membership, meGeneration } = orgRoute.useLoaderData()
  const credential = authAdapter.getAccessToken() !== undefined
  const verified = useMemo(
    () =>
      resolveInvitationOwner({
        session: authAdapter.getSnapshot(),
        me,
        meGeneration,
        organisationId: membership.organisation.id,
        membershipId: membership.membership_id,
        credential,
      }),
    // The session snapshot is read from the adapter, not from `auth`, so these
    // `auth` fields are listed only to re-resolve the owner when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.generation, auth.status, auth.user, me, meGeneration, membership, credential]
  )
  const committed = useRef<InvitationOwner | undefined>(undefined)
  // Keep only the last committed owner through that same session's expiry.
  // A replacement or revoked membership resets the drawer instead of rebinding it.
  const structural = resolveInvitationOwner({
    session: authAdapter.getSnapshot(),
    me,
    meGeneration,
    organisationId: membership.organisation.id,
    membershipId: membership.membership_id,
    credential: true,
  })
  // Reading the last committed owner during render is deliberate: it is what lets
  // the same verified owner survive the expiry render, and it is only written in
  // the layout effect below, after a render commits.
  /* eslint-disable react-hooks/refs */
  const retained =
    committed.current !== undefined &&
    structural !== undefined &&
    canSaveInvitation(committed.current, authAdapter.getSnapshot()) &&
    structural.identityId === committed.current.identityId &&
    structural.membershipId === committed.current.membershipId &&
    structural.organisationId === committed.current.organisationId &&
    structural.role === committed.current.role
      ? committed.current
      : undefined
  /* eslint-enable react-hooks/refs */
  const owner = verified ?? retained
  useLayoutEffect(() => {
    committed.current = owner
  }, [owner])
  return owner
}

export function PeopleRecoveryGate({ children }: { children: ReactNode }) {
  const owner = useInvitationOwner()
  const auth = useAuth()
  const { meGeneration } = orgRoute.useLoaderData()
  useEffect(() => {
    if (
      auth.status === 'ready' &&
      auth.generation === meGeneration &&
      authAdapter.getAccessToken() !== undefined &&
      owner === undefined
    )
      clearInvitation()
  }, [auth.status, auth.generation, meGeneration, owner])
  return children
}

function usePeopleNavigate() {
  const navigate = useNavigate()
  const { org } = orgRoute.useParams()
  return (target: PeopleTarget) => {
    const base = `/${org}/people`
    switch (target.to) {
      case '':
        return navigate({ to: base })
      case 'invitations':
        return navigate({ to: base, search: { tab: 'invitations' } })
      case 'member':
        return navigate({ to: `${base}/${target.memberId}` })
      default:
        return navigate({ to: `${base}/${target.to}` })
    }
  }
}

function PeopleArea({
  tab,
  drawer,
  recoverInvitation = false,
}: {
  tab: PeopleTab
  drawer?: 'invite' | { memberId: string }
  recoverInvitation?: boolean
}) {
  const { membership } = orgRoute.useLoaderData()
  const onNavigate = usePeopleNavigate()
  const organisationId = membership.organisation.id
  const callerRole = membership.role
  const recoveryOwner = useInvitationOwner()
  const navigate = useNavigate()
  const { org } = orgRoute.useParams()
  useEffect(() => {
    if (
      recoverInvitation &&
      recoveryOwner !== undefined &&
      authAdapter.getAccessToken() !== undefined &&
      canSaveInvitation(recoveryOwner, authAdapter.getSnapshot()) &&
      readInvitation(recoveryOwner) !== undefined
    )
      void navigate({ to: `/${org}/people/invite`, replace: true })
  }, [recoverInvitation, recoveryOwner, navigate, org])
  return (
    <PeopleScreen
      organisationId={organisationId}
      callerRole={callerRole}
      callerMembershipId={membership.membership_id}
      tab={tab}
      onNavigate={(target) => void onNavigate(target)}
      onSite={
        <OnSitePanel
          organisationId={organisationId}
          organisationName={membership.organisation.name}
          callerRole={callerRole}
        />
      }
    >
      {drawer === 'invite' ? (
        <InviteDrawer
          key={recoveryOwner === undefined ? 'unverified' : JSON.stringify(recoveryOwner)}
          {...(recoveryOwner === undefined ? {} : { recoveryOwner })}
          organisationId={organisationId}
          callerRole={callerRole}
          onClose={() => void onNavigate({ to: '' })}
          onSent={() => void onNavigate({ to: 'invitations' })}
        />
      ) : drawer === undefined ? null : (
        <MemberDrawer
          organisationId={organisationId}
          callerRole={callerRole}
          memberId={drawer.memberId}
          onClose={() => void onNavigate({ to: '' })}
        />
      )}
    </PeopleScreen>
  )
}

function ImportArea({ importId, source }: { importId?: string; source?: 'order' | 'status' }) {
  const { membership } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const navigate = useNavigate()
  const onNavigate = usePeopleNavigate()
  return (
    <ImportScreen
      organisationId={membership.organisation.id}
      callerRole={membership.role}
      {...(importId === undefined ? {} : { importId })}
      {...(source === undefined ? {} : { source })}
      onImportStarted={(id) => void navigate({ to: `/${org}/people/import/${id}`, replace: true })}
      onNavigate={(target) => void onNavigate(target)}
    />
  )
}

export function PeopleListBody() {
  const { tab } = useSearch({ strict: false }) as { tab?: 'invitations' }
  return <PeopleArea tab={tab === 'invitations' ? 'invitations' : 'members'} recoverInvitation />
}

export function PeopleInviteBody() {
  return <PeopleArea tab="members" drawer="invite" />
}

/** A hidden surface's address (`src/app/capabilities.ts`) opens the member list instead. */
function ToMemberList() {
  const { org } = orgRoute.useParams()
  return <Navigate to="/$org/people" params={{ org }} replace />
}

export function PeopleOnSiteBody() {
  if (!offers('on-site-enrolment')) return <ToMemberList />
  return <PeopleArea tab="on-site" />
}

export function PeopleMemberBody() {
  const { memberId } = useParams({ strict: false }) as { memberId: string }
  return <PeopleArea tab="members" drawer={{ memberId }} />
}

export function PeopleImportBody() {
  const { from } = useSearch({ strict: false }) as { from?: 'order' | 'status' }
  if (!offers('member-import')) return <ToMemberList />
  return <ImportArea {...(from === undefined ? {} : { source: from })} />
}

export function PeopleImportResultBody() {
  const { importId } = useParams({ strict: false }) as { importId: string }
  if (!offers('member-import')) return <ToMemberList />
  return <ImportArea importId={importId} />
}
