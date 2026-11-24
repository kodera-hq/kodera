import { BookingPublicPage } from './BookingPublicPage'
import { publicBookingRoute } from './route'

export default function BookingPublicRouteScreen() {
  const { bookingSlug } = publicBookingRoute.useParams()
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-shell-document-max-width flex-col gap-6 px-4 py-8">
      <BookingPublicPage bookingSlug={bookingSlug} />
    </main>
  )
}
