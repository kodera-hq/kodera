// Bilingual copy for Wave 4 unified workspace offer, VIES consultation status,
// and Factur-X 1.0 (type 380 invoice and type 381 credit-note) controls.
// Prices, VAT amounts, and tax regimes always come from Core snapshots.

import type { components } from '../../api/schema'

type AppCode = components['schemas']['AppCode']
type VatRegime = components['schemas']['VatRegime']
type CreditNoteReason = components['schemas']['CreditNoteReason']
type ViesStatus = components['schemas']['BillingVatStatus']['status']

const messages = {
  fr: {
    offerTitle: 'Offre Workspace et guides de capacité',
    offerUnifiedBadge: 'Pack unifié Workspace',
    includedAppsLabel: 'Applications incluses',
    appNames: {
      messaging: 'Messagerie',
      visio: 'Visio',
      docs: 'Docs',
      drive: 'Fichiers',
      grist: 'Tableaux',
    } satisfies Record<AppCode, string>,
    seatsIncluded: (count: number) => `${count.toLocaleString('fr-FR')} sièges inclus`,
    concurrentParticipantsIncluded: (count: number) =>
      `${count.toLocaleString('fr-FR')} participants simultanés inclus`,
    storageIncluded: (formatted: string) => `${formatted} de stockage inclus`,
    snapshotPricingTitle: 'Instantané tarifaire Core',
    unitAmountExclVat: 'Montant unitaire HT',
    totalExclVat: 'Total HT',
    vatAmountLabel: (ratePercent: string) => `TVA (${ratePercent})`,
    totalInclVat: 'Total TTC',
    taxRegimeLabel: 'Régime fiscal',
    taxRegimes: {
      fr_standard: 'TVA française standard',
      eu_reverse_charge: 'Autoliquidation UE (0\u00a0% TVA)',
      exempt: 'Exonération de TVA',
      outside_eu: 'Export hors UE',
    } satisfies Record<VatRegime, string>,
    viesSectionTitle: 'TVA intracommunautaire et preuve VIES',
    viesStatusLabel: 'Statut VIES',
    viesBadges: {
      valid: 'VIES vérifié',
      unavailable: 'En attente VIES (revue opérateur)',
      invalid: 'Numéro de TVA invalide',
      not_checked: 'Non vérifié',
    } satisfies Record<ViesStatus, string>,
    viesHoldNotice:
      'Le service européen VIES est momentanément indisponible. Aucune autoliquidation à 0\u00a0% de TVA n’est accordée automatiquement en cas d’indisponibilité\u00a0: le dossier reste en attente d’une revue opérateur ou de la prochaine vérification planifiée.',
    viesInvalidNotice:
      'Le numéro de TVA intracommunautaire soumis a été rejeté par VIES. La TVA française standard reste appliquée tant qu’un numéro valide n’est pas vérifié.',
    viesValidDetail:
      'Consultation VIES enregistrée par Core. Le régime fiscal d’une facture émise reste figé à sa date d’émission.',
    viesNotCheckedDetail:
      'Aucun numéro de TVA intracommunautaire vérifié n’est associé à ce profil de facturation.',
    viesVatNumberLabel: 'Numéro de TVA',
    viesCountryLabel: 'Pays UE (ISO-2)',
    viesCheckedAtLabel: 'Dernière vérification',
    viesNextCheckAtLabel: 'Prochaine relance planifiée',
    viesEvidenceIdLabel: 'Référence de preuve VIES',
    viesValidateAction: 'Vérifier le numéro de TVA',
    viesValidateInputError:
      'Saisissez un code pays UE à 2 lettres (ex. DE, BE) et un numéro de TVA complet.',
    viesValidateFailed:
      'La vérification du numéro de TVA est momentanément indisponible. Réessayez ultérieurement.',
    facturxSectionTitle: 'Pièces comptables Factur-X 1.0',
    facturxInvoiceBadge: 'Factur-X 1.0 · Facture (380)',
    facturxCreditNoteBadge: 'Factur-X 1.0 · Avoir (381)',
    facturxDocRefLabel: 'Référence documentaire',
    facturxFilenameLabel: 'Fichier certifié',
    facturxSha256Label: 'Empreinte SHA-256',
    facturxDownloadInvoicePdf: 'Télécharger Factur-X PDF/A-3 (380)',
    facturxDownloadInvoiceXml: 'Télécharger le XML Factur-X (380)',
    facturxXmlDownloadFailed: 'Le téléchargement du XML Factur-X a échoué. Réessayez.',
    creditNoteTitle: (number: string) => `Avoir ${number}`,
    creditNoteIssuedLabel: 'Émis le',
    creditNoteLinkedInvoiceLabel: 'Facture créditée',
    creditNoteReasonLabel: 'Motif de l’avoir',
    creditNoteReasons: {
      customer_cancellation: 'Annulation à la demande du client',
      unpaid_lapse: 'Annulation pour échéance impayée',
      complimentary: 'Régularisation commerciale sans frais',
    } satisfies Record<CreditNoteReason, string>,
    creditNoteDownloadPdf: 'Télécharger l’avoir PDF/A-3 (381)',
    creditNoteDownloadXml: 'Télécharger le XML de l’avoir (381)',
    creditNoteLoadFailed:
      'Les détails de l’avoir associé sont momentanément indisponibles.',
    creditNoteDownloadFailed: 'Le téléchargement de l’avoir a échoué. Réessayez.',
  },
  en: {
    offerTitle: 'Workspace offer and capacity guides',
    offerUnifiedBadge: 'Unified Workspace pack',
    includedAppsLabel: 'Included applications',
    appNames: {
      messaging: 'Messaging',
      visio: 'Visio',
      docs: 'Docs',
      drive: 'Drive',
      grist: 'Tables',
    } satisfies Record<AppCode, string>,
    seatsIncluded: (count: number) => `${count.toLocaleString('en-GB')} seats included`,
    concurrentParticipantsIncluded: (count: number) =>
      `${count.toLocaleString('en-GB')} concurrent participants included`,
    storageIncluded: (formatted: string) => `${formatted} included storage`,
    snapshotPricingTitle: 'Core price snapshot',
    unitAmountExclVat: 'Unit amount excl. VAT',
    totalExclVat: 'Total excl. VAT',
    vatAmountLabel: (ratePercent: string) => `VAT (${ratePercent})`,
    totalInclVat: 'Total incl. VAT',
    taxRegimeLabel: 'Tax regime',
    taxRegimes: {
      fr_standard: 'French standard VAT',
      eu_reverse_charge: 'EU reverse charge (0% VAT)',
      exempt: 'VAT exempt',
      outside_eu: 'Export outside EU',
    } satisfies Record<VatRegime, string>,
    viesSectionTitle: 'Intra-EU VAT and VIES evidence',
    viesStatusLabel: 'VIES status',
    viesBadges: {
      valid: 'VIES verified',
      unavailable: 'VIES pending hold (operator review)',
      invalid: 'Invalid VAT number',
      not_checked: 'Not checked',
    } satisfies Record<ViesStatus, string>,
    viesHoldNotice:
      'The upstream EU VIES service is temporarily unavailable. Reverse-charge 0% VAT is never silently granted on timeout or outage: your VAT validation remains on hold for operator review or the next scheduled check.',
    viesInvalidNotice:
      'The submitted intra-EU VAT number was rejected by VIES. Standard French VAT remains in force until a valid VAT number is verified.',
    viesValidDetail:
      'Persisted VIES consultation recorded by Core. Issued invoice tax snapshots remain immutable.',
    viesNotCheckedDetail:
      'No verified intra-EU VAT number is currently recorded on this billing profile.',
    viesVatNumberLabel: 'VAT number',
    viesCountryLabel: 'EU country (ISO-2)',
    viesCheckedAtLabel: 'Last checked',
    viesNextCheckAtLabel: 'Next scheduled check',
    viesEvidenceIdLabel: 'VIES evidence ID',
    viesValidateAction: 'Validate VAT number',
    viesValidateInputError:
      'Enter a 2-letter EU country code (e.g. DE, BE) and a complete VAT number.',
    viesValidateFailed: 'VAT validation is temporarily unavailable. Please try again later.',
    facturxSectionTitle: 'Factur-X 1.0 accounting artifacts',
    facturxInvoiceBadge: 'Factur-X 1.0 · Invoice (380)',
    facturxCreditNoteBadge: 'Factur-X 1.0 · Credit note (381)',
    facturxDocRefLabel: 'Document reference',
    facturxFilenameLabel: 'Certified filename',
    facturxSha256Label: 'SHA-256 digest',
    facturxDownloadInvoicePdf: 'Download Factur-X PDF/A-3 (380)',
    facturxDownloadInvoiceXml: 'Download Factur-X XML (380)',
    facturxXmlDownloadFailed: 'Factur-X XML download failed. Please try again.',
    creditNoteTitle: (number: string) => `Credit note ${number}`,
    creditNoteIssuedLabel: 'Issued on',
    creditNoteLinkedInvoiceLabel: 'Credited invoice',
    creditNoteReasonLabel: 'Credit note reason',
    creditNoteReasons: {
      customer_cancellation: 'Cancelled at customer request',
      unpaid_lapse: 'Cancelled after unpaid due date',
      complimentary: 'Complimentary commercial settlement',
    } satisfies Record<CreditNoteReason, string>,
    creditNoteDownloadPdf: 'Download credit note PDF/A-3 (381)',
    creditNoteDownloadXml: 'Download credit note XML (381)',
    creditNoteLoadFailed: 'Linked credit note details are temporarily unavailable.',
    creditNoteDownloadFailed: 'Credit note download failed. Please try again.',
  },
} as const

export type BillingLocale = 'fr' | 'en'

export function resolveBillingLocale(language: string | undefined): BillingLocale {
  return language?.startsWith('en') ? 'en' : 'fr'
}

export function billingCopy(language: string | undefined) {
  return messages[resolveBillingLocale(language)]
}
