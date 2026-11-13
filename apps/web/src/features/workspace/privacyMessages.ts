// Bilingual copy for GDPR Art. 20 portability exports and Art. 17 erasure self-service,
// including explicit statutory ten-year accounting retention (`Code de commerce L123-22`)
// and 0.44.0 held / proof-unavailable lifecycle states.

import { resolveBillingLocale } from '../billing/billingMessages'
import type {
  PrivacyDeletionStatus,
  PrivacyExportStatus,
  PrivacyFailureCode,
} from './privacyApi'

const messages = {
  fr: {
    intro:
      'Exercez vos droits RGPD en libre-service : portabilité des données (article 20) et effacement vérifié (article 17). Aucune opération incomplète ou sans preuve durable n’est annoncée comme terminée.',
    exportSectionTitle: 'Portabilité des données (RGPD Art. 20)',
    accountExportTitle: 'Export de mes données de compte',
    accountExportHint:
      'Archive ZIP signée contenant uniquement vos données personnelles autorisées, votre manifeste d’intégrité et vos sommes de contrôle.',
    workspaceExportTitle: 'Export complet de l’espace de travail',
    workspaceExportHint:
      'Archive ZIP signée de l’espace (documents, collections et pièces autorisées). Réservé au propriétaire actuel de l’organisation.',
    workspaceOwnerOnlyNotice:
      'Seul le propriétaire actuel de l’organisation (`org_owner`) peut demander l’export complet ou la suppression de l’espace.',
    includeMediaLabel: 'Inclure les fichiers médias et pièces jointes dans l’archive ZIP',
    requestAccountExportAction: 'Préparer mon export personnel',
    requestWorkspaceExportAction: 'Préparer l’export de l’espace',
    refreshStatusAction: 'Actualiser l’état',
    downloadExportAction: 'Télécharger l’archive ZIP signée',
    exportStatuses: {
      queued: 'En file d’attente',
      running: 'Préparation en cours',
      ready: 'Prêt au téléchargement',
      failed: 'En attente / échec',
      expired: 'Lien expiré',
      cancelled: 'Annulé',
    } satisfies Record<PrivacyExportStatus, string>,
    deletionStatuses: {
      queued: 'En file d’attente',
      running: 'Purge en cours',
      retention_pending: 'Contenu purgé · Rétention légale comptable active',
      completed: 'Effacement terminé',
      failed: 'Bloqué / échec',
      cancelled: 'Annulé',
    } satisfies Record<PrivacyDeletionStatus, string>,
    failureReasons: {
      legal_hold:
        'Conservation légale active (legal hold) : l’opération est explicitement suspendue et ne peut pas aboutir tant que la mesure conservatoire s’applique.',
      storage_unavailable:
        'Stockage privé ou service de signature momentanément indisponible : reprise sûre à partir du dernier point de contrôle enregistré.',
      identity_conflict:
        'Conflit d’autorité ou dernier propriétaire : transférez d’abord la propriété de l’organisation avant de supprimer votre compte.',
      build_failed:
        'La génération ou la preuve d’exécution a échoué. Relancez une nouvelle demande.',
    } satisfies Record<PrivacyFailureCode, string>,
    proofUnavailableHoldBanner:
      'En attente (HTTP 503 — preuve ou stockage indisponible) : une source requise, le stockage privé, la signature ou la preuve durable de cycle de vie est momentanément indisponible. Aucune archive partielle ni suppression non prouvée n’est validée.',
    conflictLastOwnerError:
      'Suppression refusée (HTTP 409) : en tant que dernier propriétaire de l’organisation, transférez la propriété ou supprimez d’abord l’espace.',
    reauthRequiredError:
      'Réauthentification récente requise par Core avant de confirmer cette suppression irréversible.',
    genericActionError:
      'L’opération RGPD n’a pas pu aboutir pour le moment. Vérifiez l’état et réessayez.',
    downloadExpiredNotice:
      'La fenêtre de téléchargement de cette archive a expiré. Demandez un nouvel export.',
    requestedAtLabel: 'Demandé le',
    updatedAtLabel: 'Dernier point de contrôle',
    expiresAtLabel: 'Disponible jusqu’au',
    purgeAfterLabel: 'Échéance légale de purge comptable (`purge_after`)',
    requestIdLabel: 'Référence de demande',
    erasureSectionTitle: 'Droit à l’effacement (RGPD Art. 17)',
    statutoryRetentionTitle:
      'Conservation légale obligatoire des pièces comptables (Code de commerce L123-22)',
    statutoryRetentionBody:
      'Lors de la suppression d’un espace ou d’un compte, les sessions, jetons et téléversements sont révoqués puis les documents, collections, médias et messages actifs sont purgés de façon irréversible. Conformément à l’article L123-22 du Code de commerce, les enregistrements comptables et contractuels détachés (`Invoice`, `CreditNote`, `Payment` ainsi que les documents `LegalDocument` / `Dpa` acceptés) demeurent immuables et à accès restreint pendant 10 ans jusqu’à leur date légale `purge_after`.',
    workspaceErasureTitle: 'Supprimer définitivement l’espace de travail',
    workspaceErasureHint:
      'Action irréversible réservée au propriétaire de l’organisation. Saisissez l’identifiant exact de l’espace pour déverrouiller la confirmation.',
    accountErasureTitle: 'Supprimer mon compte personnel',
    accountErasureHint:
      'Révoque vos sessions et purge vos données personnelles hors obligations légales comptables. Saisissez l’identifiant de l’espace pour confirmer.',
    confirmSlugLabel: (slug: string) => `Saisissez « ${slug} » pour confirmer la suppression`,
    deletionReasonLabel: 'Motif (facultatif)',
    confirmWorkspaceDeletionAction: 'Confirmer la suppression de l’espace',
    confirmAccountDeletionAction: 'Confirmer la suppression de mon compte',
  },
  en: {
    intro:
      'Self-service GDPR rights: data portability (Article 20) and verified erasure (Article 17). No incomplete archive or unproved deletion is ever reported complete.',
    exportSectionTitle: 'Data portability (GDPR Art. 20)',
    accountExportTitle: 'Export my account data',
    accountExportHint:
      'Signed ZIP archive containing only your authorized personal account records, signed manifest, and entry checksums.',
    workspaceExportTitle: 'Export full workspace data',
    workspaceExportHint:
      'Signed ZIP archive of authorized workspace documents, collections, and attachments. Restricted to the current organisation owner.',
    workspaceOwnerOnlyNotice:
      'Only the current organisation owner (`org_owner`) may request a full workspace export or workspace deletion.',
    includeMediaLabel: 'Include media files and attachments in the ZIP archive',
    requestAccountExportAction: 'Request my account export',
    requestWorkspaceExportAction: 'Request workspace export',
    refreshStatusAction: 'Refresh checkpoint',
    downloadExportAction: 'Download signed ZIP archive',
    exportStatuses: {
      queued: 'Queued',
      running: 'Running',
      ready: 'Ready to download',
      failed: 'Held / failed',
      expired: 'Expired',
      cancelled: 'Cancelled',
    } satisfies Record<PrivacyExportStatus, string>,
    deletionStatuses: {
      queued: 'Queued',
      running: 'Purging active data',
      retention_pending: 'Content purged · Statutory accounting retention active',
      completed: 'Erasure completed',
      failed: 'Held / blocked',
      cancelled: 'Cancelled',
    } satisfies Record<PrivacyDeletionStatus, string>,
    failureReasons: {
      legal_hold:
        'Active legal hold: this request is explicitly held and cannot complete while legal preservation applies.',
      storage_unavailable:
        'Private storage or archive signing is temporarily unavailable: the worker resumes safely from its persisted checkpoint.',
      identity_conflict:
        'Ownership or identity conflict: transfer organisation ownership before deleting the last owner account.',
      build_failed: 'Archive build or purge verification failed. Submit a new request to retry.',
    } satisfies Record<PrivacyFailureCode, string>,
    proofUnavailableHoldBanner:
      'Held (HTTP 503 — proof or private storage unavailable): a required data source, private storage, signing service, or durable lifecycle proof is currently unavailable. No incomplete export or unproved deletion is marked complete.',
    conflictLastOwnerError:
      'Deletion refused (HTTP 409): as the last organisation owner, transfer ownership or delete the workspace first.',
    reauthRequiredError:
      'Recent verified reauthentication is required by Core before confirming irreversible deletion.',
    genericActionError:
      'The privacy request could not be completed right now. Check its status and try again.',
    downloadExpiredNotice:
      'The time-bounded download window for this archive has expired. Request a fresh export.',
    requestedAtLabel: 'Requested on',
    updatedAtLabel: 'Last checkpoint',
    expiresAtLabel: 'Download expires on',
    purgeAfterLabel: 'Statutory accounting retention (`purge_after`)',
    requestIdLabel: 'Request reference',
    erasureSectionTitle: 'Right to erasure (GDPR Art. 17)',
    statutoryRetentionTitle:
      'Mandatory statutory accounting retention (Code de commerce L123-22)',
    statutoryRetentionBody:
      'When a workspace or account is deleted, active sessions, tickets, and pending uploads are revoked first, then workspace documents, collections, media attachments, and messages are irreversibly purged. Detached statutory accounting and contractual snapshots (`Invoice`, `CreditNote`, `Payment`, and accepted `LegalDocument` / `Dpa`) remain immutable and access-restricted for 10 years until their legal `purge_after` retention date under French commercial law (`Code de commerce L123-22`).',
    workspaceErasureTitle: 'Permanently delete workspace',
    workspaceErasureHint:
      'Irreversible action restricted to the organisation owner. Re-enter the exact workspace slug to unlock confirmation.',
    accountErasureTitle: 'Permanently delete my account',
    accountErasureHint:
      'Revokes your sessions and purges your personal data outside statutory accounting retention. Re-enter the workspace slug to confirm.',
    confirmSlugLabel: (slug: string) => `Type "${slug}" to confirm permanent deletion`,
    deletionReasonLabel: 'Reason (optional)',
    confirmWorkspaceDeletionAction: 'Confirm workspace deletion',
    confirmAccountDeletionAction: 'Confirm my account deletion',
  },
} as const

export function privacyCopy(language: string | undefined) {
  return messages[resolveBillingLocale(language)]
}
