// `/{org}/order` — 01-order.md: not a sidebar item (00-shell-and-login.md
// §4.5 lists six, and order is not one of them); reached from actions
// elsewhere ("Commander", home's empty state, the capacity gauge's upgrade
// prompt). `/{org}/order` itself only ever redirects — to a resumed draft's
// furthest step, or to a fresh one — the same shape `src/app/index-route.tsx`
// uses for its own redirect-only route. It is its own index route (a
// sibling of `$draftId`, not `orderRoute`'s own `component`) so the
// redirect fires only on the exact `/order` path and not on every deeper
// match under it, the same layout-plus-index split `src/app/org-route.tsx`'s
// tree does not need but a plain redirect route always does.
//
// The public, pre-login entry (`/order?plan={code}`, 01-order.md §3) is
// deliberately not built here: `plan` and `contacts` need no
// organisation, but `agreements` needs a generated, per-organisation DPA
// (`POST /organisations/{id}/dpa`) and a submit needs `POST /organisations`
// — both calls this contract only allows an authenticated caller to make,
// and account/realm creation for a buyer with no organisation yet is
// 00-shell-and-login.md §4.1, Wave 1, explicitly not this unit's scope
// (docs/dev/BASELINE.md "What is not here yet"). This unit ships the
// organisation-scoped entry the other five entry points all resolve to —
// "an organisation created, no subscription", "resume", "upgrade", "an
// expired quote email" — which is where the four steps actually run.

import {
  Navigate,
  Outlet,
  createRoute,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { isIdentityUnknown, isUnauthenticated, RouteError } from '../../app/RouteError'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { useAuth } from '../../auth/AuthProvider'
import { SessionLoading } from '../../app/SessionLoading'
import { Button } from '../../ui/Button/Button'
import { Banner } from '../../ui/Banner/Banner'
import { loadFreshOrderContext, OrderOwnershipUnavailable } from './freshOwner'
import { useStatusSummaryQuery } from '../home/queries'
import type { OrderStep } from './draft'
import { ORDER_STEPS } from './draft'
import { OrderWizard } from './OrderWizard'
import type { OrderRole } from './PlanStep'
import { latestEditableId, readEditable, ownerTuple } from './editableStorage'
import { furthestStep } from './draft'

function isOrderStep(value: string): value is OrderStep {
  return (ORDER_STEPS as readonly string[]).includes(value)
}

function OrderStepScreen() {
  const { t } = useTranslation()
  const { org, draftId, step } = orderStepRoute.useParams()
  const navigate = useNavigate()
  const {
    orderContext: { me, membership, owner },
  } = orderRoute.useRouteContext()
  const auth = useAuth()
  if (
    auth.status !== 'ready' ||
    auth.generation !== owner.generation ||
    membership.organisation.slug !== org
  )
    return <SessionLoading />

  if (step !== 'quote' && !isOrderStep(step)) {
    throw notFound()
  }

  // Owning a saved draft is not permission to create orders or generate DPAs.
  if (membership.role !== 'org_owner') {
    return (
      <div>
        <h1 className="sr-only">{t('console.order._.title')}</h1>
        <Banner kind="info" headline={t('console.order._.error-owner-role')} />
      </div>
    )
  }
  const role: OrderRole = 'org_owner'

  return (
    <div>
      <h1 className="sr-only">{t('console.order._.title')}</h1>
      <OrderWizard
        key={JSON.stringify([
          ...ownerTuple(owner),
          owner.membershipId,
          owner.identityId,
          owner.generation,
          draftId,
        ])}
        org={org}
        owner={owner}
        draftId={draftId}
        step={step === 'quote' ? 'quote' : step}
        organisationId={membership.organisation.id}
        role={role}
        signatoryName={me.display_name ?? me.email}
        signatoryEmail={me.email}
        onNavigate={(nextStep, nextDraftId) => {
          void navigate({
            to: '/$org/order/$draftId/$step',
            params: { org, draftId: nextDraftId ?? draftId, step: nextStep },
          })
        }}
        onGoToStatus={() => {
          void navigate({ to: '/$org/status', params: { org } })
        }}
      />
    </div>
  )
}

/**
 * On a deployment that does not bill there is no order to place (run-notes quick-workspace SPEC
 * §2.2): the order's pages send the owner home, where « Créez votre espace » is. Read from the
 * status summary, as the home reads it; a summary that cannot be read leaves the order as it is,
 * since Core refuses an order itself when billing is off (`billing-disabled`).
 */
/** Where the order's pages send the owner while billing is off: the home, which has a screen
 *  (the bare `/{org}` has none). Proved against the route table in `app/routeTree.test.ts`. */
export const BILLING_OFF_TARGET = '/$org/home'

export function OrderGate() {
  const { membership } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const summary = useStatusSummaryQuery(membership.organisation.id)
  if (summary.isLoading) return <SessionLoading />
  if (summary.data?.billing_enabled === false) {
    return <Navigate to={BILLING_OFF_TARGET} params={{ org }} replace />
  }
  return <Outlet />
}

export const orderRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'order',
  component: OrderGate,
  pendingComponent: SessionLoading,
  pendingMs: 0,
  pendingMinMs: 0,
  beforeLoad: async ({ params, abortController }) => {
    try {
      return {
        orderContext: await loadFreshOrderContext({
          organisationSlug: params.org,
          signal: abortController.signal,
        }),
      }
    } catch (error) {
      // A 401 is the session, not the order: the console's expired-session
      // screen. A 403 identity-unknown is the person, not the order: the
      // console's "no organisation yet" screen. Any other failure to establish
      // the owner — Core unreachable, a session that changed while it was
      // read — is this route's own case.
      if (isUnauthenticated(error) || isIdentityUnknown(error)) throw error
      throw error instanceof OrderOwnershipUnavailable
        ? error
        : new OrderOwnershipUnavailable({ cause: error })
    }
  },
  errorComponent: OrderOwnerError,
})

/** Ownership that could not be established is this route's own screen;
 * everything else — a 401, a render error in the wizard — is the console's
 * general one. */
function OrderOwnerError(props: ErrorComponentProps) {
  if (!(props.error instanceof OrderOwnershipUnavailable)) return <RouteError {...props} />
  return <OwnershipUnavailable />
}

function OwnershipUnavailable() {
  const { t } = useTranslation()
  const router = useRouter()
  return (
    <div>
      <h1 className="sr-only">{t('console.order._.title')}</h1>
      <Banner
        kind="incident"
        headline={t('console.order._.error-owner-unavailable')}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void router.invalidate()
            }}
          >
            {t('console.common.action-retry')}
          </Button>
        }
      />
    </div>
  )
}

/** Resume only a validated owned editable record; all purchase outcomes remain held. */
export const orderIndexRoute = createRoute({
  getParentRoute: () => orderRoute,
  path: '/',
  beforeLoad: ({ params, context }) => {
    const owner = context.orderContext.owner
    const draftId = latestEditableId(owner) ?? crypto.randomUUID()
    const recovered = readEditable(draftId, owner)
    const step = recovered.status === 'saved' ? furthestStep(recovered.draft) : 'plan'
    throw redirect({
      to: '/$org/order/$draftId/$step',
      params: { org: params.org, draftId, step },
      replace: true,
    })
  },
})

export const orderDraftRoute = createRoute({
  getParentRoute: () => orderRoute,
  path: '$draftId',
  component: Outlet,
})

export const orderStepRoute = createRoute({
  getParentRoute: () => orderDraftRoute,
  path: '$step',
  component: OrderStepScreen,
})

export const orderRouteWithChildren = orderRoute.addChildren([
  orderIndexRoute,
  orderDraftRoute.addChildren([orderStepRoute]),
])
