// The public community's own host (split-origin contract B5): the static SPA is served at
// `community.{matrix domain}` — the same name as the community's Matrix server name — while the
// Core API, the identity provider and the homeserver each answer on their own origin. The host is
// derived from `VITE_MATRIX_DOMAIN`, so `kodera.io`, a staging base domain and a self-hosted
// `example.org` each recognise their own community and nothing else.

import { isDomainName } from '../api/domainName'
import { matrixDomain } from '../config'

/** `community.{matrix domain}`, or undefined when the deployment names no usable matrix domain. */
export function communityHostname(): string | undefined {
  const domain = matrixDomain()
  return domain !== undefined && isDomainName(domain) ? `community.${domain}` : undefined
}

/** Whether this page is the public community's, in a build that signs in for real. */
export function onCommunityHost(hostname: string = window.location.hostname): boolean {
  if (import.meta.env.VITE_AUTH_MODE !== 'oidc') return false
  const expected = communityHostname()
  return expected !== undefined && hostname === expected
}
