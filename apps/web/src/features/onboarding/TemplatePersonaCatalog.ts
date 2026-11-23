import {
  canonicalTemplateId,
  CONNECTOR_IDS,
  CUSTOM_CHANNEL_NAME_PATTERN,
  dbChannelKey,
  isClaimConnectorId,
  slugifyChannelKey,
  TEMPLATE_CATEGORY_KEYS,
  TEMPLATE_CHANNEL_BLUEPRINTS,
  type CanonicalTemplateId,
  type ClaimConnectorId,
  type TemplateChannelBlueprint,
  type TemplateId,
} from './instantClaimClient'

export { CUSTOM_CHANNEL_NAME_PATTERN, dbChannelKey, slugifyChannelKey }

export const CUSTOMIZABLE_PERSONA_IDS = [
  'tech-studio',
  'b2b-advisory',
  'association-coop',
  'open-source-community',
  'public-sector',
  'blank',
] as const satisfies readonly CanonicalTemplateId[]

export type CustomizablePersonaId = (typeof CUSTOMIZABLE_PERSONA_IDS)[number]

export type TemplateSelectionId =
  | 'audiovisual'
  | 'studio-tech'
  | 'conseil-b2b'
  | 'association-coop'
  | 'open-source'
  | 'secteur-public'
  | 'blank'
  | 'proximity'

export type StarterChannelDescriptor = TemplateChannelBlueprint

export interface LocalizedText {
  readonly fr: string
  readonly en: string
}

export interface TemplatePersonaMetadata {
  readonly templateId: CanonicalTemplateId
  readonly selectionId: TemplateSelectionId
  readonly isCustomizablePersona: boolean
  readonly previewOnly?: boolean | undefined
  readonly estimatedSetupSeconds: 45
  readonly categoryKeys: readonly string[]
  readonly defaultCategoryKey: string
  readonly defaultAudioCategoryKey: string
  readonly summary: LocalizedText
  readonly starterChannels: readonly StarterChannelDescriptor[]
  readonly starterTextChannels: readonly string[]
  readonly starterAudioChannels: readonly string[]
  readonly recommendedRoles: {
    readonly fr: readonly string[]
    readonly en: readonly string[]
  }
  readonly starterDocsSummary: LocalizedText
  readonly starterCollectionsSummary: LocalizedText
  readonly defaultConnectors: readonly ClaimConnectorId[]
}

export const CONNECTOR_LABELS: Record<ClaimConnectorId, LocalizedText> = {
  'frameio-review-bridge': {
    fr: 'Frame.io · Revue vidéo',
    en: 'Frame.io · Video review',
  },
  'github-webhook': {
    fr: 'GitHub · Webhooks',
    en: 'GitHub · Webhooks',
  },
  'linear-sync': {
    fr: 'Linear · Suivi tickets',
    en: 'Linear · Issue sync',
  },
  'sentry-alerts': {
    fr: 'Sentry · Alertes prod',
    en: 'Sentry · Production alerts',
  },
  'qonto-treasury-alerts': {
    fr: 'Qonto · Trésorerie',
    en: 'Qonto · Treasury alerts',
  },
  'stripe-revenue-events': {
    fr: 'Stripe · Revenus',
    en: 'Stripe · Revenue events',
  },
  'calcom-booking-sync': {
    fr: 'Cal.com · Rendez-vous',
    en: 'Cal.com · Booking sync',
  },
  'nextcloud-drive-notifier': {
    fr: 'Nextcloud · Fichiers',
    en: 'Nextcloud · Drive updates',
  },
}

function buildStarterChannels(templateId: CanonicalTemplateId): {
  categoryKeys: readonly string[]
  starterChannels: readonly StarterChannelDescriptor[]
  starterTextChannels: readonly string[]
  starterAudioChannels: readonly string[]
} {
  const starterChannels = TEMPLATE_CHANNEL_BLUEPRINTS[templateId]
  return {
    categoryKeys: TEMPLATE_CATEGORY_KEYS[templateId],
    starterChannels,
    starterTextChannels: starterChannels.filter((ch) => ch.kind === 'text').map((ch) => ch.name),
    starterAudioChannels: starterChannels.filter((ch) => ch.kind === 'audio').map((ch) => ch.name),
  }
}

function validatedConnectors(ids: readonly ClaimConnectorId[]): readonly ClaimConnectorId[] {
  return ids.filter((id) => isClaimConnectorId(id) && CONNECTOR_IDS.includes(id))
}

export const TEMPLATE_PERSONA_CATALOG: Record<CanonicalTemplateId, TemplatePersonaMetadata> = {
  'audiovisual-production': {
    templateId: 'audiovisual-production',
    selectionId: 'audiovisual',
    isCustomizablePersona: false,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'production',
    defaultAudioCategoryKey: 'plateaux',
    summary: {
      fr: 'Tournage, rushes quotidiens, régie plateau et salle de montage.',
      en: 'Shoot coordination, dailies review, stage control and editing rooms.',
    },
    ...buildStarterChannels('audiovisual-production'),
    recommendedRoles: {
      fr: ['Producteur', 'Réalisateur', 'post-production', 'Superviseur VFX/Son'],
      en: ['Producer', 'Director', 'post-production', 'VFX/Sound Supervisor'],
    },
    starterDocsSummary: {
      fr: 'Feuille de service — Modèle',
      en: 'Call Sheet — Starter Template',
    },
    starterCollectionsSummary: {
      fr: 'Suivi de Post-Production (Tableau & Kanban)',
      en: 'Post-Production Tracker (Table & Board)',
    },
    defaultConnectors: validatedConnectors(['frameio-review-bridge']),
  },
  'tech-studio': {
    templateId: 'tech-studio',
    selectionId: 'studio-tech',
    isCustomizablePersona: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'engineering',
    defaultAudioCategoryKey: 'voice',
    summary: {
      fr: 'Produit, releases, incidents de production, standup et pair-programming.',
      en: 'Product delivery, releases, incident response, standups and pairing.',
    },
    ...buildStarterChannels('tech-studio'),
    recommendedRoles: {
      fr: ['Lead Tech', 'Product', 'SRE', 'Sécurité'],
      en: ['Tech Lead', 'Product', 'SRE', 'Security'],
    },
    starterDocsSummary: {
      fr: 'Guide Produit & Runbook d’astreinte',
      en: 'Product Handbook & Incident Runbook',
    },
    starterCollectionsSummary: {
      fr: 'Roadmap & Releases (Tableau & Kanban)',
      en: 'Product Roadmap & Releases (Table & Board)',
    },
    defaultConnectors: validatedConnectors(['github-webhook', 'linear-sync', 'sentry-alerts']),
  },
  'b2b-advisory': {
    templateId: 'b2b-advisory',
    selectionId: 'conseil-b2b',
    isCustomizablePersona: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'missions',
    defaultAudioCategoryKey: 'salles',
    summary: {
      fr: 'Mandats clients, comités de pilotage, livrables et ponts réunions.',
      en: 'Client engagements, steering committees, deliverables and briefing rooms.',
    },
    ...buildStarterChannels('b2b-advisory'),
    recommendedRoles: {
      fr: ['Associé', 'Directeur de mission', 'Consultant', 'Finance'],
      en: ['Partner', 'Engagement Lead', 'Consultant', 'Finance'],
    },
    starterDocsSummary: {
      fr: 'Cadre de mission & Comité de pilotage',
      en: 'Engagement Charter & Steering Brief',
    },
    starterCollectionsSummary: {
      fr: 'Portefeuille Missions & Livrables',
      en: 'Client Engagements & Deliverables',
    },
    defaultConnectors: validatedConnectors([
      'qonto-treasury-alerts',
      'stripe-revenue-events',
      'calcom-booking-sync',
    ]),
  },
  'association-coop': {
    templateId: 'association-coop',
    selectionId: 'association-coop',
    isCustomizablePersona: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'vie-collective',
    defaultAudioCategoryKey: 'salons-vocaux',
    summary: {
      fr: 'Vie collective, gouvernance partagée, commissions et assemblées.',
      en: 'Collective life, shared governance, working groups and assemblies.',
    },
    ...buildStarterChannels('association-coop'),
    recommendedRoles: {
      fr: ['Bureau', 'Sociétaire', 'Référent commission', 'Bénévole'],
      en: ['Board', 'Member', 'Committee Lead', 'Volunteer'],
    },
    starterDocsSummary: {
      fr: 'Charte & Gouvernance partagée',
      en: 'Collective Charter & Governance Guide',
    },
    starterCollectionsSummary: {
      fr: 'Registre des décisions & actions',
      en: 'Collective Decisions & Actions Register',
    },
    defaultConnectors: validatedConnectors(['nextcloud-drive-notifier', 'calcom-booking-sync']),
  },
  'open-source-community': {
    templateId: 'open-source-community',
    selectionId: 'open-source',
    isCustomizablePersona: true,
    previewOnly: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'community',
    defaultAudioCategoryKey: 'voice',
    summary: {
      fr: 'Annonces, accueil des contributeurs, entraide et salon vocal ouvert.',
      en: 'Release announcements, contributor onboarding, support and community lounge.',
    },
    ...buildStarterChannels('open-source-community'),
    recommendedRoles: {
      fr: ['Mainteneur', 'Triage', 'Contributeur', 'Membre'],
      en: ['Maintainer', 'Triage', 'Contributor', 'Member'],
    },
    starterDocsSummary: {
      fr: 'Guide de contribution (CONTRIBUTING)',
      en: 'Contributor Guide (CONTRIBUTING)',
    },
    starterCollectionsSummary: {
      fr: 'RFCs & Propositions communautaires',
      en: 'Community RFCs & Proposals',
    },
    defaultConnectors: validatedConnectors(['github-webhook', 'sentry-alerts']),
  },
  'public-sector': {
    templateId: 'public-sector',
    selectionId: 'secteur-public',
    isCustomizablePersona: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'collectivite',
    defaultAudioCategoryKey: 'permanence',
    summary: {
      fr: 'Coordination inter-services, délibérations, conseil et permanence vocale.',
      en: 'Cross-department coordination, deliberations, council room and on-call.',
    },
    ...buildStarterChannels('public-sector'),
    recommendedRoles: {
      fr: ['Direction', 'Secrétariat général', 'Agent', 'Astreinte'],
      en: ['Directorate', 'General Secretariat', 'Officer', 'On-call'],
    },
    starterDocsSummary: {
      fr: 'Trame de note de service & délibération',
      en: 'Service Memorandum & Deliberation Template',
    },
    starterCollectionsSummary: {
      fr: 'Suivi des dossiers & délibérations',
      en: 'Casework & Deliberations Tracker',
    },
    defaultConnectors: validatedConnectors(['nextcloud-drive-notifier']),
  },
  blank: {
    templateId: 'blank',
    selectionId: 'blank',
    isCustomizablePersona: true,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'general',
    defaultAudioCategoryKey: 'general',
    summary: {
      fr: 'Un espace épuré avec un salon général pour composer votre structure.',
      en: 'A clean workspace with one general channel to shape at your own pace.',
    },
    ...buildStarterChannels('blank'),
    recommendedRoles: {
      fr: ['Administrateur', 'Membre'],
      en: ['Admin', 'Member'],
    },
    starterDocsSummary: {
      fr: 'Page d’accueil vierge prête à éditer',
      en: 'Clean welcome page ready to edit',
    },
    starterCollectionsSummary: {
      fr: 'Aucune collection pré-remplie',
      en: 'No pre-populated collections',
    },
    defaultConnectors: [],
  },
  proximity: {
    templateId: 'proximity',
    selectionId: 'proximity',
    isCustomizablePersona: false,
    estimatedSetupSeconds: 45,
    defaultCategoryKey: 'proximity',
    defaultAudioCategoryKey: 'proximity',
    summary: {
      fr: 'Pointage volontaire et pseudonyme par zones nommées pour équipes terrain.',
      en: 'Voluntary, pseudonymous check-in by named zones for field teams.',
    },
    ...buildStarterChannels('proximity'),
    recommendedRoles: {
      fr: ['Référent', 'Membre'],
      en: ['Coordinator', 'Member'],
    },
    starterDocsSummary: {
      fr: 'Repères de zone & consignes terrain',
      en: 'Zone landmarks & field notes',
    },
    starterCollectionsSummary: {
      fr: 'Un salon texte initial dédié',
      en: 'Single dedicated starter text channel',
    },
    defaultConnectors: [],
  },
}

const SELECTION_TO_TEMPLATE: Record<TemplateSelectionId, CanonicalTemplateId> = {
  audiovisual: 'audiovisual-production',
  'studio-tech': 'tech-studio',
  'conseil-b2b': 'b2b-advisory',
  'association-coop': 'association-coop',
  'open-source': 'open-source-community',
  'secteur-public': 'public-sector',
  blank: 'blank',
  proximity: 'proximity',
}

export function resolveSelectionTemplateId(selection: string): CanonicalTemplateId {
  if (Object.hasOwn(SELECTION_TO_TEMPLATE, selection)) {
    return SELECTION_TO_TEMPLATE[selection as TemplateSelectionId]
  }
  return 'tech-studio'
}

export function getTemplatePersona(id: TemplateId): TemplatePersonaMetadata {
  return TEMPLATE_PERSONA_CATALOG[canonicalTemplateId(id)]
}

export function listCustomizablePersonas(): readonly TemplatePersonaMetadata[] {
  return CUSTOMIZABLE_PERSONA_IDS.map((id) => TEMPLATE_PERSONA_CATALOG[id])
}

/**
 * Validates and resolves a custom starter channel draft against Core `WorkspaceTemplateCustomization`
 * rules: printable `1..64` chars with `>= 1` ASCII `[A-Za-z0-9]`, derived `1..32` `template_key`
 * (`c-<digits>` prefix when starting with a digit), and zero `db_template_key` or `name` collisions.
 */
export function resolveCustomChannelDraft(
  rawDraft: string,
  existingChannels: readonly StarterChannelDescriptor[]
): string | null {
  const derivedKey = slugifyChannelKey(rawDraft)
  if (derivedKey === null) return null
  const candidateDbKey = dbChannelKey(derivedKey)
  for (const existing of existingChannels) {
    if (dbChannelKey(existing.templateKey) === candidateDbKey || existing.name === derivedKey) {
      return null
    }
  }
  return derivedKey
}
