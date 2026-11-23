import type { BugComponent, BugNoteRefusalCode } from './bugReportScrubber'

const messages = {
  en: {
    trigger: 'Report a technical bug (zero-PII)',
    hintTrigger: 'Send an anonymised diagnostic snapshot without personal or workspace data.',
    title: 'Report a technical bug',
    description:
      'Only the exact JSON payload shown below is sent. Personal identifiers, tokens, and URLs are never stored.',
    close: 'Close bug report dialog',
    cancel: 'Cancel',
    submit: 'Send diagnostic report',
    submitting: 'Sending diagnostic report…',
    componentLabel: 'Affected area',
    errorCodeLabel: 'Diagnostic error code',
    errorCodeInvalid: 'Use 1–80 uppercase letters, digits, dots, colons, underscores, or hyphens.',
    buildLabel: 'Build',
    deviceLabel: 'Device class',
    noteLabel: 'Optional diagnostic note (max 500 characters)',
    notePlaceholder: 'Describe the technical symptom without URLs, tokens, or personal details…',
    noteScrubbedHint: 'Detected identifiers are automatically masked before transmission.',
    noteTooLong: 'Diagnostic note cannot exceed 500 characters.',
    screenshotLabel: 'Optional blurred screenshot (blurred locally with blur(12px), max 256 KiB)',
    screenshotRemove: 'Remove screenshot',
    screenshotPreviewAlt: 'Blurred diagnostic screenshot preview',
    screenshotError: 'The image could not be blurred or exceeds the 256 KiB metadata-free limit.',
    payloadPreviewTitle: 'Exact outgoing JSON payload',
    consentLabel:
      'I explicitly consent to sending the scrubbed note and/or blurred screenshot shown in the preview above.',
    consentHelp:
      'Required whenever an optional note or blurred screenshot is included. Unchecked by default.',
    refusalPrefix: 'Remove sensitive tokens or links from the note before sending:',
    refusalReasons: {
      bearer_token: 'Bearer authorization header',
      jwt_token: 'JWT token',
      api_credential: 'API key or secret token',
      pem_material: 'PEM private key header',
      invite_or_auth_link: 'invitation, claim, or sign-in token path',
      url_forbidden: 'URL or deep link',
    } satisfies Record<BugNoteRefusalCode, string>,
    components: {
      workspace: 'Workspace',
      messaging: 'Messaging',
      calls: 'Audio & video calls',
      docs: 'Documents & collections',
      files: 'Files & media',
      auth: 'Sign-in & authentication',
      billing: 'Billing & invoices',
      settings: 'Settings & roles',
      confidential: 'Confidential rooms',
      desktop: 'Desktop app',
      mobile: 'Mobile app',
      other: 'Other',
    } satisfies Record<BugComponent, string>,
    errorGeneric: 'The diagnostic report could not be sent. Please try again.',
    errorRateLimited: 'Too many diagnostic reports were sent recently. Please wait before retrying.',
    errorUnavailable: 'The diagnostic triage queue is temporarily full. Please retry shortly.',
    receiptTitle: 'Diagnostic report recorded',
    receiptDeduplicated: 'Matched an existing recent report (occurrence count incremented).',
    receiptQueued: 'Queued for engineering triage.',
    receiptId: 'Reference',
    receiptFingerprint: 'Fingerprint',
  },
  fr: {
    trigger: 'Signaler un bug technique (zéro donnée personnelle)',
    hintTrigger:
      'Transmettez un diagnostic technique anonymisé sans identifiant personnel ni nom d’espace.',
    title: 'Signaler un bug technique',
    description:
      'Seul le JSON exact affiché ci-dessous est transmis. Aucun jeton, lien ni identifiant personnel n’est conservé.',
    close: 'Fermer la fenêtre de signalement',
    cancel: 'Annuler',
    submit: 'Envoyer le diagnostic',
    submitting: 'Envoi du diagnostic…',
    componentLabel: 'Zone concernée',
    errorCodeLabel: 'Code d’erreur diagnostique',
    errorCodeInvalid:
      'Utilisez 1 à 80 lettres majuscules, chiffres, points, deux-points, tirets ou underscores.',
    buildLabel: 'Version',
    deviceLabel: 'Classe d’appareil',
    noteLabel: 'Note diagnostique facultative (500 caractères max.)',
    notePlaceholder:
      'Décrivez le symptôme technique sans URL, jeton d’accès ni donnée personnelle…',
    noteScrubbedHint:
      'Les identifiants détectés sont automatiquement masqués avant tout envoi.',
    noteTooLong: 'La note diagnostique ne peut pas dépasser 500 caractères.',
    screenshotLabel:
      'Capture floutée facultative (floutage local blur(12px), sans métadonnées, 256 Kio max.)',
    screenshotRemove: 'Retirer la capture',
    screenshotPreviewAlt: 'Aperçu de la capture diagnostique floutée',
    screenshotError:
      'L’image n’a pas pu être floutée ou dépasse la limite de 256 Kio sans métadonnées.',
    payloadPreviewTitle: 'Charge JSON exacte transmise',
    consentLabel:
      'Je consens explicitement à transmettre la note nettoyée et/ou la capture floutée affichées dans l’aperçu ci-dessus.',
    consentHelp:
      'Requis dès qu’une note facultative ou une capture floutée est jointe. Décoché par défaut.',
    refusalPrefix: 'Retirez les jetons ou liens sensibles de la note avant l’envoi :',
    refusalReasons: {
      bearer_token: 'en-tête Bearer',
      jwt_token: 'jeton JWT',
      api_credential: 'clé API ou jeton secret',
      pem_material: 'clé privée PEM',
      invite_or_auth_link: 'lien d’invitation ou jeton de connexion',
      url_forbidden: 'URL ou lien profond',
    } satisfies Record<BugNoteRefusalCode, string>,
    components: {
      workspace: 'Espace de travail',
      messaging: 'Messagerie',
      calls: 'Appels audio et vidéo',
      docs: 'Documents et collections',
      files: 'Fichiers et médias',
      auth: 'Connexion et authentification',
      billing: 'Facturation',
      settings: 'Paramètres et rôles',
      confidential: 'Salons confidentiels',
      desktop: 'Application bureau',
      mobile: 'Application mobile',
      other: 'Autre',
    } satisfies Record<BugComponent, string>,
    errorGeneric: 'Le rapport diagnostique n’a pas pu être envoyé. Réessayez.',
    errorRateLimited: 'Trop de rapports diagnostiques récents. Patientez avant de réessayer.',
    errorUnavailable:
      'La file de triage diagnostique est temporairement pleine. Réessayez dans un instant.',
    receiptTitle: 'Rapport diagnostique enregistré',
    receiptDeduplicated: 'Rattaché à un signalement récent identique (compteur incrémenté).',
    receiptQueued: 'Ajouté à la file de triage technique.',
    receiptId: 'Référence',
    receiptFingerprint: 'Empreinte',
  },
} as const

export type BugReportCopy = (typeof messages)['en'] | (typeof messages)['fr']

export const bugReportCopy = (language: string | undefined): BugReportCopy =>
  language?.startsWith('en') ? messages.en : messages.fr
