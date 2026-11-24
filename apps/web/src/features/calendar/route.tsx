import { createRoute, lazyRouteComponent } from '@tanstack/react-router'
import { rootRoute } from '../../app/root-route'

export const publicBookingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/booking/$bookingSlug',
  component: lazyRouteComponent(() => import('./BookingPublicRouteScreen')),
})
