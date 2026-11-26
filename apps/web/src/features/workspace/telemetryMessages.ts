const messages = {
  en: {
    title: 'Optional usage diagnostics',
    hint: 'Share technical errors, performance measurements and feature milestones with our EU analytics service. Messages, documents, files, names and account identifiers are excluded. No session recording. This choice applies to your account in this workspace on this browser.',
    unconfiguredHint:
      'Telemetry is disabled and unconfigured on this instance. No collection adapter is active and 0 network bytes are ever sent.',
    policyDisabled:
      'Optional diagnostics are disabled by this workspace’s hosting policy. Your saved choice is preserved.',
    confidentialHold:
      'Diagnostics are paused in this confidential channel. Collection resumes with a new anonymous session when you leave; your saved choice is preserved.',
    label: 'Allow optional diagnostics for this workspace',
    unavailable:
      'Optional diagnostics are unavailable on this deployment (0 network bytes transmitted).',
    enabled: 'Enabled. You can withdraw consent at any time.',
    disabled:
      'Disabled. Collection is stopped and local diagnostic session data is cleared. Data already delivered is not deleted by this switch.',
  },
  fr: {
    title: 'Diagnostics d’utilisation facultatifs',
    hint: 'Partagez des erreurs techniques, des mesures de performance et des étapes d’utilisation avec notre service d’analyse européen. Messages, documents, fichiers, noms et identifiants de compte sont exclus. Aucun enregistrement de session. Ce choix concerne votre compte dans cet espace, sur ce navigateur.',
    unconfiguredHint:
      'La télémétrie est désactivée et non configurée sur cette instance. Aucun adaptateur de collecte n’est actif et 0 octet réseau n’est jamais envoyé.',
    policyDisabled:
      'Les diagnostics facultatifs sont désactivés par la politique d’hébergement de cet espace. Votre choix est conservé.',
    confidentialHold:
      'Les diagnostics sont suspendus dans ce canal confidentiel. La collecte reprend avec une nouvelle session anonyme à votre sortie ; votre choix est conservé.',
    label: 'Autoriser les diagnostics facultatifs pour cet espace',
    unavailable:
      'Les diagnostics facultatifs sont indisponibles sur cette installation (0 octet réseau transmis).',
    enabled: 'Activés. Vous pouvez retirer votre consentement à tout moment.',
    disabled:
      'Désactivés. La collecte est arrêtée et les données locales de session de diagnostic sont effacées. Ce bouton ne supprime pas les données déjà transmises.',
  },
} as const
export function telemetryCopy(language: string | undefined) {
  return messages[language?.startsWith('en') ? 'en' : 'fr']
}
