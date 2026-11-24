// Feature-local FR/EN copy and deterministic integer quote helpers for H3.1
// Community Monetization: Volet A (Samourai Coop Workspace Boosts & Hosting Credits)
// and Volet B (Paid VIP Servers & Channels via Stripe Connect + DAC7).

import { resolveBillingLocale, type BillingLocale } from './billingMessages'

export type CustomerKind = 'b2c' | 'b2b'
export type CommunityVatRegimeCode =
  | 'fr_standard'
  | 'eu_oss'
  | 'eu_reverse_charge'
  | 'outside_eu'

export const EU_OSS_RATES_BP: Readonly<Record<string, number>> = {
  AT: 2000,
  BE: 2100,
  BG: 2000,
  CY: 1900,
  CZ: 2100,
  DE: 1900,
  DK: 2500,
  EE: 2400,
  ES: 2100,
  FI: 2550,
  FR: 2000,
  GR: 2400,
  HR: 2500,
  HU: 2700,
  IE: 2300,
  IT: 2200,
  LT: 2100,
  LU: 1700,
  LV: 2100,
  MT: 1800,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  RO: 2100,
  SE: 2500,
  SI: 2200,
  SK: 2300,
}

export const SUPPORTED_BILLING_COUNTRIES: readonly string[] = [
  ...Object.keys(EU_OSS_RATES_BP),
  'CH',
]

export const EU_OSS_LEGAL_MENTION =
  "TVA de l'État membre de consommation — régime UE OSS (art. 259 D CGI / art. 369 bis directive 2006/112/CE)"

export const DAC7_MIN_TRANSACTIONS = 30
export const DAC7_MIN_CONSIDERATION_MINOR = 200_000

export interface CommunityVatQuote {
  regimeCode: CommunityVatRegimeCode
  vatRateBp: number
  netMinor: number
  vatMinor: number
  grossMinor: number
  legalMention: string | null
}

export function computeCommunityVatQuote(params: {
  netMinor: number
  country: string
  customerKind: CustomerKind
  vatNumberValidated?: boolean
}): CommunityVatQuote {
  const code = params.country.toUpperCase()
  const ossRate = EU_OSS_RATES_BP[code]
  let regimeCode: CommunityVatRegimeCode = 'outside_eu'
  let vatRateBp = 0
  let legalMention: string | null = 'TVA non applicable — art. 259-1 du CGI'

  if (params.customerKind === 'b2c') {
    if (code === 'FR') {
      regimeCode = 'fr_standard'
      vatRateBp = 2000
      legalMention = null
    } else if (ossRate !== undefined) {
      regimeCode = 'eu_oss'
      vatRateBp = ossRate
      legalMention = EU_OSS_LEGAL_MENTION
    }
  } else if (code === 'FR') {
    regimeCode = 'fr_standard'
    vatRateBp = 2000
    legalMention = null
  } else if (ossRate !== undefined) {
    if (params.vatNumberValidated) {
      regimeCode = 'eu_reverse_charge'
      vatRateBp = 0
      legalMention = 'Autoliquidation — art. 283-2 du CGI / art. 196 directive 2006/112/CE'
    } else {
      regimeCode = 'fr_standard'
      vatRateBp = 2000
      legalMention = null
    }
  }

  const vatMinor = Math.floor((params.netMinor * vatRateBp + 5000) / 10_000)
  return {
    regimeCode,
    vatRateBp,
    netMinor: params.netMinor,
    vatMinor,
    grossMinor: params.netMinor + vatMinor,
    legalMention,
  }
}

export function evaluateDac7Status(params: {
  transactionCount: number
  netConsiderationMinor: number
}): { reportable: boolean; byTransactions: boolean; byConsideration: boolean } {
  const byTransactions = params.transactionCount >= DAC7_MIN_TRANSACTIONS
  const byConsideration = params.netConsiderationMinor > DAC7_MIN_CONSIDERATION_MINOR
  return {
    reportable: byTransactions || byConsideration,
    byTransactions,
    byConsideration,
  }
}

const copyCatalog = {
  fr: {
    webCheckoutBadge: 'Checkout Web uniquement · 0 % commission mobile',
    voletATitle: 'Boosts Workspace et crédits d’hébergement',
    voletASubtitle:
      'Facturation directe Samouraï Coop (Factur-X 380 / 381) dédiée à la capacité serveur, aux sièges et au stockage.',
    packSelectLabel: 'Choisir un pack Boost',
    customerKindLabel: 'Profil acheteur',
    customerKinds: {
      b2c: 'Particulier / Membre communauté (B2C)',
      b2b: 'Organisation assujettie (B2B)',
    },
    countryLabel: 'Pays de résidence fiscale',
    boostBenefits: (seats: number, storageGib: number) =>
      `+${seats} sièges · +${storageGib} Gio de stockage média`,
    hostingCreditIncluded: 'Crédit d’hébergement alloué',
    quoteBreakdownTitle: 'Décompte fiscal instantané',
    regimeLabels: {
      fr_standard: 'TVA française standard (20 %)',
      eu_oss: 'Guichet unique UE OSS (État de consommation)',
      eu_reverse_charge: 'Autoliquidation B2B UE (0 %)',
      outside_eu: 'Hors Union européenne (0 %)',
    } satisfies Record<CommunityVatRegimeCode, string>,
    netExclVat: 'Montant HT',
    vatLine: (pct: string) => `TVA (${pct})`,
    totalInclVat: 'Total TTC à régler',
    waiverLabel:
      'Je demande l’exécution immédiate du Boost ou du Pass VIP et je renonce expressément à mon droit de rétractation de 14 jours (art. L221-28 du Code de la consommation).',
    waiverHelp:
      'Obligatoire pour toute activation immédiate B2C. Sans cette acceptation horodatée, l’activation immédiate est refusée.',
    waiverError:
      'Vous devez accepter la renonciation expresse au délai de 14 jours (art. L221-28) avant le paiement.',
    boostCheckoutCta: 'Régler et activer le Boost sur le Web',
    activeLedgerTitle: 'Registre des Boosts et crédits actifs',
    emptyLedger: 'Aucun crédit d’hébergement actif sur cet espace.',
    creditRemaining: 'Crédit restant',
    creditConsumed: 'Consommé',
    creditRefunded: 'Remboursé (avoir 381)',
    facturxAuthorityBadge: 'Autorité Factur-X 380/381 Core',
    voletBTitle: 'Salons VIP payants · Stripe Connect et DAC7',
    voletBSubtitle:
      'Encaissement partagé créateur via Stripe Connect (frais plateforme retenus à la source, accès Matrix et LiveKit synchronisés atomiquement).',
    connectStatusLabel: 'Compte Stripe Connect créateur',
    connectStates: {
      intent_recorded: 'Intention enregistrée',
      account_created: 'Compte créé · lien requis',
      onboarding_link_issued: 'Vérification KYC en cours',
      restricted: 'Restreint · pièces requises',
      active: 'Actif · paiements autorisés',
      outcome_unknown: 'État incertain · réconciliation opérateur requise',
      disabled: 'Désactivé',
    },
    connectResumeCta: 'Poursuivre l’onboarding Stripe Connect',
    connectOutcomeUnknownWarning:
      'La dernière création de compte n’a pas reçu de confirmation réseau. Aucune relance aveugle n’est effectuée afin d’éviter tout doublon : réconciliez d’abord l’identifiant.',
    negativeBalanceWarning: (formatted: string) =>
      `Solde négatif créateur à résorber suite à litige ou remboursement : ${formatted}`,
    platformFeeLabel: 'Commission plateforme',
    creatorNetLabel: 'Revenu net créateur (hors TVA)',
    tierConfigTitle: 'Configurer une offre Pass VIP',
    tierNameLabel: 'Nom du palier VIP',
    tierPriceLabel: 'Prix mensuel HT (centimes EUR)',
    tierRoleLabel: 'Rôle Workspace attribué',
    tierChannelsLabel: 'Salons Matrix / LiveKit réservés',
    saveTierCta: 'Enregistrer le palier VIP',
    memberPassTitle: 'Souscrire un Pass VIP membre',
    vipCheckoutCta: 'Souscrire au Pass VIP sur le Web',
    dac7Title: 'Conformité fiscale annuelle DAC7 (Directive UE 2021/514)',
    dac7Subtitle:
      'Déclaration annuelle requise dès 30 transactions ou plus de 2 000 € de contrepartie nette annuelle.',
    dac7ReportableBadge: 'Seuil DAC7 atteint · Déclarable',
    dac7BelowThresholdBadge: 'Sous les seuils annuels DAC7',
    dac7TransactionsLabel: 'Activités nettes sur l’année',
    dac7ConsiderationLabel: 'Contrepartie nette cumulée',
    dac7FeesLabel: 'Frais plateforme retenus',
    dac7TaxesLabel: 'TVA collectée / reversée',
    dac7TinSealedBadge: 'NIF scellé AES-256-GCM',
    dac7TinMissingBadge: 'NIF fiscal requis',
    dac7DownloadJsonCta: 'Télécharger le rapport JSON DAC7',
    dac7DownloadXmlCta: 'Télécharger le rapport XML DAC7',
    hostingMonetizationSummary: 'Boosts communautaires et salons VIP (Web)',
  },
  en: {
    webCheckoutBadge: 'Web Checkout only · 0% mobile store fee',
    voletATitle: 'Workspace Boosts and hosting credits',
    voletASubtitle:
      'Direct Samourai Coop billing (Factur-X 380 / 381) funding dedicated server capacity, seats, and media storage.',
    packSelectLabel: 'Select a Boost pack',
    customerKindLabel: 'Buyer profile',
    customerKinds: {
      b2c: 'Individual / Community member (B2C)',
      b2b: 'Business entity (B2B)',
    },
    countryLabel: 'Tax residence country',
    boostBenefits: (seats: number, storageGib: number) =>
      `+${seats} seats · +${storageGib} GiB media storage`,
    hostingCreditIncluded: 'Allocated hosting credit',
    quoteBreakdownTitle: 'Live VAT quote breakdown',
    regimeLabels: {
      fr_standard: 'French standard VAT (20%)',
      eu_oss: 'EU OSS One-Stop Shop (consumption member state)',
      eu_reverse_charge: 'Intra-EU B2B reverse charge (0%)',
      outside_eu: 'Outside European Union (0%)',
    } satisfies Record<CommunityVatRegimeCode, string>,
    netExclVat: 'Net excl. VAT',
    vatLine: (pct: string) => `VAT (${pct})`,
    totalInclVat: 'Total incl. VAT due',
    waiverLabel:
      'I request immediate performance of the Boost or VIP Pass and expressly waive my 14-day withdrawal right (French Consumer Code Art. L221-28).',
    waiverHelp:
      'Mandatory for immediate B2C digital activation. Immediate activation is refused without timestamped waiver evidence.',
    waiverError:
      'You must accept the explicit 14-day withdrawal waiver (Art. L221-28) before checkout.',
    boostCheckoutCta: 'Checkout and activate Boost on Web',
    activeLedgerTitle: 'Active Boosts and hosting credit ledger',
    emptyLedger: 'No active hosting credits on this workspace.',
    creditRemaining: 'Remaining credit',
    creditConsumed: 'Consumed',
    creditRefunded: 'Refunded (381 credit note)',
    facturxAuthorityBadge: 'Core Factur-X 380/381 authority',
    voletBTitle: 'Paid VIP channels · Stripe Connect and DAC7',
    voletBSubtitle:
      'Creator split settlement via Stripe Connect (platform fee retained at source, atomic Matrix and LiveKit role convergence).',
    connectStatusLabel: 'Creator Stripe Connect account',
    connectStates: {
      intent_recorded: 'Intent recorded',
      account_created: 'Account persisted · link needed',
      onboarding_link_issued: 'KYC onboarding in progress',
      restricted: 'Restricted · verification required',
      active: 'Active · charges enabled',
      outcome_unknown: 'Outcome unknown · operator reconciliation required',
      disabled: 'Disabled',
    },
    connectResumeCta: 'Resume Stripe Connect onboarding',
    connectOutcomeUnknownWarning:
      'The previous account creation call timed out without confirmation. Blind retries are blocked to prevent duplicate Connect accounts: reconcile first.',
    negativeBalanceWarning: (formatted: string) =>
      `Creator negative balance carried from dispute or refund: ${formatted}`,
    platformFeeLabel: 'Platform fee',
    creatorNetLabel: 'Creator net payout (excl. VAT)',
    tierConfigTitle: 'Configure VIP Tier Offer',
    tierNameLabel: 'VIP tier name',
    tierPriceLabel: 'Monthly price excl. VAT (EUR cents)',
    tierRoleLabel: 'Granted Workspace role',
    tierChannelsLabel: 'Gated Matrix / LiveKit channels',
    saveTierCta: 'Save VIP tier offer',
    memberPassTitle: 'Purchase Member VIP Pass',
    vipCheckoutCta: 'Checkout VIP Pass on Web',
    dac7Title: 'Annual DAC7 tax compliance (Directive EU 2021/514)',
    dac7Subtitle:
      'Annual seller reporting applies at 30 or more transactions or above EUR 2,000 net annual consideration.',
    dac7ReportableBadge: 'DAC7 threshold reached · Reportable',
    dac7BelowThresholdBadge: 'Below annual DAC7 thresholds',
    dac7TransactionsLabel: 'Net annual activities',
    dac7ConsiderationLabel: 'Net cumulative consideration',
    dac7FeesLabel: 'Retained platform fees',
    dac7TaxesLabel: 'Collected / remitted VAT',
    dac7TinSealedBadge: 'AES-256-GCM sealed TIN',
    dac7TinMissingBadge: 'Tax TIN required',
    dac7DownloadJsonCta: 'Download DAC7 JSON report',
    dac7DownloadXmlCta: 'Download DAC7 XML report',
    hostingMonetizationSummary: 'Community Boosts and VIP channels (Web)',
  },
} as const

export function boostVipCopy(language: string | undefined) {
  const locale: BillingLocale = resolveBillingLocale(language)
  return copyCatalog[locale]
}
