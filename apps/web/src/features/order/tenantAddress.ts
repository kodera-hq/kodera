// The address a tenant gets, as the order's contacts step previews it (01-order.md §4.2).
//
// Core assigns it, not the console: each application's default URL is a template from
// `KODERA_TENANT_APP_URLS`, `https://{slug}.<dns name>`, with `{slug}` the tenant slug the order
// places (kodera-core `config/environment.py` `tenant_app_urls`, `apps/tenancy/selectors.py`
// `default_urls`). The preview shows one address: the domain of the tenant's main application
// template, `messaging` today. Core also allows `{slug}-suffix.<dns name>` and a different domain
// per application, which one build-time domain cannot express; a preview Core computes itself
// (on the slug availability answer, say) would replace this. The console learns `<dns name>` at build time from `VITE_TENANT_DOMAIN`, which
// whoever deploys it sets to the same value Core's templates carry. Unset or malformed, the order
// names no domain at all: a preview of an address the tenant will not get is worse than none.

import { isDomainName } from '../../api/domainName'
import { tenantDomain } from '../../config'

/** Whether `value` is a usable tenant domain: the matrix domain's rule (`src/api/domainName.ts`). */
export function isTenantDomain(value: string): boolean {
  return isDomainName(value)
}

/** The configured tenant domain, or `undefined` when it is unset or not a DNS name. */
export function configuredTenantDomain(): string | undefined {
  const domain = tenantDomain()
  return domain !== undefined && isTenantDomain(domain) ? domain : undefined
}
