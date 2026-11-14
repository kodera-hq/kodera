import { AcceptScreen } from './AcceptScreen'
import { invitationRoute } from './route'

export default function InvitationRoute() {
  const { organisationId, organisationSlug } = invitationRoute.useParams()
  return <AcceptScreen organisationId={organisationId} organisationSlug={organisationSlug} />
}
