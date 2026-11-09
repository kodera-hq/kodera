import i18n from '../../i18n'
import { COMMUNITY_CATEGORIES, COMMUNITY_CHANNELS } from '../../features/docs/communityStructure'
import { developerDocsCopy } from '../../features/docs/developerDocsMessages'
// Local demo data for the routed first-party Community workspace. No server reservation changes.
import type { components } from '../../api/schema'
import { keycloakUrl } from '../../config'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import { createLocalWorkspaceStore } from './workspaceStore'
import * as seed from './seed'

export const COMMUNITY_SLUG = 'community'
export const COMMUNITY_NAME = 'Kodera Community'
const id = (index: number) => `5eed0075-0000-4000-8000-${String(index).padStart(12, '0')}`
export const COMMUNITY_ORGANISATION_ID = id(1)
export const COMMUNITY_TENANT_ID = id(5)
const EMAIL = 'member@community.kodera.io'
export const COMMUNITY_CHANNEL_NAMES = COMMUNITY_CHANNELS.map((channel) => channel.name)

export function communityOrganisation(now: Date): components['schemas']['Organisation'] {
  return {
    ...seed.organisation(now),
    id: COMMUNITY_ORGANISATION_ID,
    slug: COMMUNITY_SLUG,
    realm: COMMUNITY_SLUG,
    name: COMMUNITY_NAME,
    legal_name: 'Kodera Community',
    email_domains: ['community.kodera.io'],
    billing_email: EMAIL,
    vat_number: null,
    siren: null,
    billing_address: null,
  }
}
export function communityMe(now: Date): components['schemas']['Me'] {
  const me = seed.me(now)
  return {
    ...me,
    id: id(2),
    email: EMAIL,
    display_name: 'Community Member',
    identities: me.identities.map((identity) => ({
      ...identity,
      id: id(3),
      realm: COMMUNITY_SLUG,
      issuer: `${keycloakUrl()}/realms/${COMMUNITY_SLUG}`,
      subject: `mock-user-${COMMUNITY_SLUG}`,
      email: EMAIL,
    })),
    organisations: me.organisations.map((member) => ({
      ...member,
      membership_id: id(4),
      identity_id: id(3),
      organisation: {
        id: COMMUNITY_ORGANISATION_ID,
        slug: COMMUNITY_SLUG,
        realm: COMMUNITY_SLUG,
        name: COMMUNITY_NAME,
      },
    })),
  }
}
export function communityDiscovery(): components['schemas']['RealmDiscoveryResult'] {
  return {
    realm: COMMUNITY_SLUG,
    issuer: `${keycloakUrl()}/realms/${COMMUNITY_SLUG}`,
    openid_configuration_url: `${keycloakUrl()}/realms/${COMMUNITY_SLUG}/.well-known/openid-configuration`,
    organisation: {
      id: COMMUNITY_ORGANISATION_ID,
      slug: COMMUNITY_SLUG,
      realm: COMMUNITY_SLUG,
      name: COMMUNITY_NAME,
    },
    candidates: [],
  }
}
export function communityTenant(now: Date): components['schemas']['Tenant'] {
  return {
    ...seed.tenant(now),
    id: COMMUNITY_TENANT_ID,
    organisation_id: COMMUNITY_ORGANISATION_ID,
    slug: COMMUNITY_SLUG,
    realm: COMMUNITY_SLUG,
    name: COMMUNITY_NAME,
    apps: ['messaging', 'docs'],
    pack_code: 'messaging',
    capacity_tier_code: 'community',
    profile_ref: 'community',
    instance_id: id(500),
    observed: {
      ...seed.tenant(now).observed!,
      profile: { ...seed.tenant(now).observed!.profile!, app: 'messaging' },
    },
    default_urls: {
      messaging: 'https://community.kodera.io',
      docs: 'https://community.kodera.io/docs',
    },
  }
}
export function communityWorkspace(): components['schemas']['Workspace'] {
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const workspace = readyWorkspace()
  const channel = workspace.categories.flatMap((category) => category.channels)[0]!
  return {
    ...workspace,
    id: id(6),
    organisation_id: COMMUNITY_ORGANISATION_ID,
    categories: COMMUNITY_CATEGORIES.map((category, categoryIndex) => ({
      id: id(7 + categoryIndex),
      name: category.name,
      template_key: null,
      channels: category.channels.map((definition) => ({
        ...channel,
        id: id(20 + COMMUNITY_CHANNELS.findIndex((entry) => entry.id === definition.id)),
        name: definition.name,
        kind: definition.voice ? 'audio' : 'text',
        topic: `${copy[category.audience]} · ${copy[definition.description]}`,
        template_key: null,
        room_state: 'ready',
      })),
    })),
    uncategorised_channels: [],
  }
}
export const communityDemo = {
  slug: COMMUNITY_SLUG,
  landing: '/$org/workspace' as const,
  createStore: (workspace: components['schemas']['Workspace']) =>
    createLocalWorkspaceStore(workspace, 'community', true),
}

/** Fixture selection only: an unsigned mock token never grants authority outside the mock tree. */
export function isCommunityDemoRequest(request: Request): boolean {
  try {
    const token = request.headers.get('Authorization')?.split(' ')[1]
    if (!token) return false
    const payload = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    ) as { sub?: unknown }
    return payload.sub === `mock-user-${COMMUNITY_SLUG}`
  } catch {
    return false
  }
}

/** One consistent roster for the community console and its count. */
export function communityMemberships(now: Date): components['schemas']['Membership'][] {
  const names = [
    'Community Member',
    'Kodera Maintainer',
    'SDK Contributor',
    'Sam Laurent',
    'Camille Robert',
    'Morgan Petit',
  ]
  const base = seed.memberships(now)[0]!
  return names.map((name, index) => ({
    ...base,
    id: index === 0 ? id(4) : id(100 + index),
    organisation_id: COMMUNITY_ORGANISATION_ID,
    person_id: index === 0 ? id(2) : id(200 + index),
    identity_id: index === 0 ? id(3) : id(300 + index),
    display_name: name,
    email: index === 0 ? EMAIL : `${name.toLowerCase().replaceAll(' ', '.')}@community.kodera.io`,
    role: index === 0 ? 'org_owner' : 'org_member',
  }))
}
export function communityDomains(now: Date): components['schemas']['Domain'][] {
  const base = seed.domains(now)[0]!
  return [
    {
      ...base,
      id: id(400),
      tenant_id: COMMUNITY_TENANT_ID,
      fqdn: 'community.kodera.io',
      app: 'messaging',
      verification: {
        ...base.verification,
        record_name: '_kodera-verification.community.kodera.io',
      },
      is_canonical: true,
      target: {
        ...base.target,
        record_name: 'community.kodera.io',
        record_value: 'community.kodera.io.',
        observed_value: 'community.kodera.io.',
      },
    },
  ]
}
export function communityStatusComponents(now: Date) {
  return seed.statusComponents(now).map((component) => ({
    ...component,
    tenant_id: COMMUNITY_TENANT_ID,
    id: id(600 + seed.statusComponents(now).findIndex((item) => item.id === component.id)),
    state: 'operational' as const,
    message_key: `status.${component.key}.operational`,
    incident_ref: null,
  }))
}
export function communityTenantStatus(now: Date): components['schemas']['TenantStatusView'] {
  return {
    ...seed.tenantStatus(now),
    tenant_id: COMMUNITY_TENANT_ID,
    apps: [
      {
        ...seed.apps()[0]!,
        code: 'messaging',
        url: 'https://community.kodera.io',
        default_url: 'https://community.kodera.io',
        custom_domain: 'community.kodera.io',
      },
    ],
    capacity: null,
    components: communityStatusComponents(now),
    domains: communityDomains(now),
  }
}
export function communityAvailability(now: Date) {
  return seed.availability(now).map((day) => ({
    ...day,
    components: day.components.map((component) => ({
      ...component,
      state: 'operational' as const,
      degraded_minutes: 0,
      down_minutes: 0,
    })),
  }))
}

export function communityHelpContext(): components['schemas']['HelpContext'] {
  return {
    area: 'support',
    screen: 'overview',
    articles: [
      { id: 'community-docs', title: 'Kodera Community', url: 'https://community.kodera.io/docs' },
    ],
    incident: null,
  }
}
