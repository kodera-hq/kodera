// Feature-local FR/EN copy for the Workspace Cybersecurity Posture Advisor (0–100 + 1-click fix).
// Never exposes raw HTTP status codes, internal UUIDs, or wire role identifiers.

export type PostureCheckId =
  | 'invite_hygiene'
  | 'sovereign_ai_boundary'
  | 'security_alert_routing'
  | 'extension_secret_rotation'
  | 'least_privilege_roles'
  | 'confidential_room_readiness'

export type PostureGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

export interface CheckCopy {
  title: string
  why: string
  passDetail: string
  warnDetail: (affectedCount: number) => string
  remediationLabel: string
}

const fr = {
  subtitle:
    'Évaluation déterministe sur 100 points couvrant la gouvernance des accès, la frontière IA souveraine, le routage d’alertes, l’hygiène des secrets et la préparation des salons confidentiels.',
  loading: 'Calcul de la posture de cybersécurité…',
  unsupported:
    'Le conseiller de posture de cybersécurité arrivera avec la prochaine mise à jour du serveur de votre espace.',
  loadError: 'Impossible de charger la posture de cybersécurité pour le moment.',
  actionForbidden: 'Seuls les propriétaires et administrateurs de l’espace peuvent appliquer une remédiation.',
  actionConflict: 'L’état de l’espace a évolué pendant la remédiation. Rechargez puis réessayez.',
  actionFailed: 'La remédiation n’a pas abouti. Réessayez dans un instant.',
  scoreLabel: 'Score de posture',
  outOf: (max: number) => `/ ${max}`,
  gradePrefix: (grade: PostureGrade) => `Note ${grade}`,
  gradeSummary: {
    A: 'Posture exemplaire',
    B: 'Posture solide',
    C: 'Posture perfectible',
    D: 'Points d’attention',
    E: 'Exposition élevée',
    F: 'Action immédiate requise',
  } satisfies Record<PostureGrade, string>,
  passingSummary: (passing: number, total: number) =>
    `${passing} sur ${total} contrôles conformes`,
  fixableSummary: (fixable: number) =>
    fixable === 0
      ? 'Aucune action corrective en attente'
      : fixable === 1
        ? '1 remédiation sûre disponible en 1 clic'
        : `${fixable} remédiations sûres disponibles en 1 clic`,
  pointsBadge: (earned: number, max: number) => `${earned} / ${max} pts`,
  statusPass: 'Conforme',
  statusWarn: 'À renforcer',
  fixOneClick: 'Corriger en 1 clic',
  fixingOne: 'Correction…',
  fixAllSafe: 'Appliquer toutes les remédiations sûres',
  fixingAll: 'Application en cours…',
  manualDeviceRekeyNote:
    'Les salons chiffrés en attente de rotation requièrent un commit MLS signé depuis un appareil membre.',
  manualBridgeRotationNote:
    'La rotation des secrets de ponts Slack ou Discord requiert une mise à jour coordonnée du webhook externe.',
  manualRoleCeilingNote:
    'Seul le propriétaire de l’espace (ou un rôle supérieur) peut modifier un rôle situé à votre rang ou au-dessus.',
  remediatedNotice: (before: number, after: number, count: number) =>
    count === 0
      ? `Posture déjà conforme (${after} / 100).`
      : `Posture mise à jour de ${before} à ${after} / 100 (${count === 1 ? '1 contrôle corrigé' : `${count} contrôles corrigés`}).`,
  checks: {
    invite_hygiene: {
      title: 'Hygiène des liens d’invitation',
      why: 'Les liens d’invitation actifs doivent expirer sous 7 jours pour éviter toute réutilisation non maîtrisée.',
      passDetail: 'Aucun lien d’invitation actif ne dépasse l’horizon de 7 jours.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 lien d’invitation actif dépasse la durée maximale recommandée de 7 jours.'
          : `${n} liens d’invitation actifs dépassent la durée maximale recommandée de 7 jours.`,
      remediationLabel: 'Plafonne immédiatement l’expiration des liens actifs à 7 jours.',
    },
    sovereign_ai_boundary: {
      title: 'Frontière IA souveraine & budget borné',
      why: 'L’IA optionnelle doit rester désactivée ou strictement cantonnée à l’Union européenne avec un plafond mensuel maîtrisé.',
      passDetail: 'Frontière souveraine UE active et enveloppe mensuelle bornée.',
      warnDetail: () =>
        'La politique IA autorise une région hors UE ou un plafond mensuel non borné.',
      remediationLabel:
        'Verrouille l’hébergement IA en région UE souveraine avec un plafond mensuel sécurisé.',
    },
    security_alert_routing: {
      title: 'Routage des alertes sécurité & confidentialité',
      why: 'Les contacts sécurité/RGPD et un salon dédié garantissent la réception immédiate des avis d’incident.',
      passDetail: 'Contacts sécurité, confidentialité et salon d’alertes opérationnels.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 point de contact ou salon d’alertes sécurité reste à configurer.'
          : `${n} points de contact ou salon d’alertes sécurité restent à configurer.`,
      remediationLabel:
        'Renseigne les contacts manquants et crée ou relie le salon #security-alerts.',
    },
    extension_secret_rotation: {
      title: 'Rotation des secrets d’extensions & ponts',
      why: 'Les jetons d’installations et secrets de ponts actifs doivent être renouvelés au moins tous les 90 jours.',
      passDetail: 'Aucun secret d’extension ou de pont actif n’a dépassé 90 jours.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 intégration active possède une clé non renouvelée depuis plus de 90 jours.'
          : `${n} intégrations actives possèdent des clés non renouvelées depuis plus de 90 jours.`,
      remediationLabel:
        'Renouvelle atomiquement les générations et secrets des intégrations de plus de 90 jours.',
    },
    least_privilege_roles: {
      title: 'Moindre privilège sur les rôles personnalisés',
      why: 'Les permissions d’administration, d’audit ou de modération globale doivent rester réservées aux rôles d’administration désignés.',
      passDetail: 'Aucun rôle non administrateur ne détient de capacité de gouvernance excessive.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 rôle, sous-équipe ou tag non administrateur détient des permissions sensibles.'
          : `${n} rôles, sous-équipes ou tags non administrateurs détiennent des permissions sensibles.`,
      remediationLabel:
        'Retire les permissions de gouvernance excessives des rôles non administrateurs.',
    },
    confidential_room_readiness: {
      title: 'Préparation des salons confidentiels E2EE',
      why: 'Disposer d’au moins un salon confidentiel prêt et sans rotation de clés en souffrance protège les échanges sensibles.',
      passDetail: 'Au moins un salon confidentiel est actif et aucune rotation n’est en attente.',
      warnDetail: (n: number) =>
        n === 1
          ? 'Aucun salon confidentiel actif ou 1 salon attend une rotation de clés.'
          : `${n} éléments confidentiels requièrent une mise en conformité.`,
      remediationLabel: 'Provisionne un salon #confidentiel chiffré de bout en bout.',
    },
  } satisfies Record<PostureCheckId, CheckCopy>,
}

export type SecurityPostureCopy = typeof fr

const en: SecurityPostureCopy = {
  subtitle:
    'Deterministic 100-point assessment covering invite governance, EU sovereign AI boundaries, security alert routing, secret hygiene, and confidential room readiness.',
  loading: 'Evaluating cybersecurity posture…',
  unsupported:
    'The cybersecurity posture advisor will arrive with the next server update for your workspace.',
  loadError: 'Unable to load the cybersecurity posture right now.',
  actionForbidden: 'Only workspace owners and administrators can apply posture remediations.',
  actionConflict: 'The workspace changed while applying the remediation. Reload and try again.',
  actionFailed: 'The remediation could not be completed. Try again shortly.',
  scoreLabel: 'Posture score',
  outOf: (max: number) => `/ ${max}`,
  gradePrefix: (grade: PostureGrade) => `Grade ${grade}`,
  gradeSummary: {
    A: 'Exemplary posture',
    B: 'Strong posture',
    C: 'Room for hardening',
    D: 'Needs attention',
    E: 'Elevated exposure',
    F: 'Immediate action needed',
  },
  passingSummary: (passing: number, total: number) => `${passing} of ${total} checks passing`,
  fixableSummary: (fixable: number) =>
    fixable === 0
      ? 'No pending safe remediations'
      : fixable === 1
        ? '1 safe 1-click remediation available'
        : `${fixable} safe 1-click remediations available`,
  pointsBadge: (earned: number, max: number) => `${earned} / ${max} pts`,
  statusPass: 'Passing',
  statusWarn: 'Needs hardening',
  fixOneClick: 'Fix in 1 click',
  fixingOne: 'Fixing…',
  fixAllSafe: 'Apply all safe remediations',
  fixingAll: 'Applying…',
  manualDeviceRekeyNote:
    'Encrypted rooms awaiting rotation require a client-signed MLS commit from a member device.',
  manualBridgeRotationNote:
    'Rotating live Slack or Discord coexistence bridge secrets requires coordinated external webhook updates.',
  manualRoleCeilingNote:
    'Only the workspace owner (or a higher-ranked role) can modify a role at or above your hierarchy ceiling.',
  remediatedNotice: (before: number, after: number, count: number) =>
    count === 0
      ? `Posture already compliant (${after} / 100).`
      : `Posture updated from ${before} to ${after} / 100 (${count === 1 ? '1 check fixed' : `${count} checks fixed`}).`,
  checks: {
    invite_hygiene: {
      title: 'Invite link hygiene',
      why: 'Active invite links should expire within 7 days to prevent unbounded external reuse.',
      passDetail: 'No active invite link exceeds the 7-day expiry horizon.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 active invite link exceeds the recommended 7-day expiry horizon.'
          : `${n} active invite links exceed the recommended 7-day expiry horizon.`,
      remediationLabel: 'Caps all unbounded active invite links to a 7-day expiry.',
    },
    sovereign_ai_boundary: {
      title: 'Sovereign AI boundary & budget cap',
      why: 'Optional AI must stay disabled or strictly pinned to European Union infrastructure with a bounded monthly budget.',
      passDetail: 'EU sovereign boundary enforced and monthly budget bounded.',
      warnDetail: () =>
        'Workspace AI policy permits a non-EU region or an unbounded monthly spend ceiling.',
      remediationLabel: 'Pins AI routing to EU sovereign providers with a safe monthly cap.',
    },
    security_alert_routing: {
      title: 'Security & privacy alert routing',
      why: 'Dedicated security/privacy contacts and an alert channel ensure incident notices reach administrators.',
      passDetail: 'Security contact, privacy contact, and alert channel are configured.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 security contact or alert channel binding is still missing.'
          : `${n} security contact or alert channel bindings are still missing.`,
      remediationLabel: 'Populates missing notice contacts and provisions #security-alerts.',
    },
    extension_secret_rotation: {
      title: 'Extension & bridge secret rotation',
      why: 'Active extension installation tokens and coexistence bridge secrets should rotate at least every 90 days.',
      passDetail: 'No active extension or bridge key is older than 90 days.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 active integration holds a secret unrotated for over 90 days.'
          : `${n} active integrations hold secrets unrotated for over 90 days.`,
      remediationLabel: 'Atomically rotates active integration keys older than 90 days.',
    },
    least_privilege_roles: {
      title: 'Least-privilege custom roles',
      why: 'Role management, audit log access, and global moderation belong exclusively to designated admin roles.',
      passDetail: 'No non-admin role grants excess governance capabilities.',
      warnDetail: (n: number) =>
        n === 1
          ? '1 non-admin role, subteam, or tag grants elevated governance permissions.'
          : `${n} non-admin roles, subteams, or tags grant elevated governance permissions.`,
      remediationLabel: 'Strips excess governance permissions from non-admin roles.',
    },
    confidential_room_readiness: {
      title: 'Confidential E2EE room readiness',
      why: 'Keeping at least one confidential channel ready and zero stale rekey rooms protects sensitive exchanges.',
      passDetail: 'Confidential channel provisioned with zero pending key rotations.',
      warnDetail: (n: number) =>
        n === 1
          ? 'No active confidential channel or 1 encrypted room requires key rotation.'
          : `${n} confidential readiness items require attention.`,
      remediationLabel: 'Provisions an end-to-end encrypted #confidentiel channel.',
    },
  },
}

export function securityPostureCopy(language: string | undefined): SecurityPostureCopy {
  return language?.startsWith('en') ? en : fr
}
