// French and English copy for Custom Emojis, Send Later, Personal Reminders, Waiting-Room Ambience, and Kodera Labs.

const fr = {
  customEmojis: {
    heading: 'Émojis personnalisés de l’espace',
    subtitle:
      'Ajoutez des émojis WebP assainis (128×128 max, sans métadonnées EXIF/XMP/ICCP) utilisables par tous les membres.',
    paletteHeading: 'Émojis de l’espace',
    shortcodeLabel: 'Nom court (sans les deux-points)',
    shortcodePlaceholder: 'ex. bravo_equipe',
    shortcodeHint: '2 à 32 caractères : lettres minuscules, chiffres et tirets bas uniquement.',
    chooseFile: 'Choisir une image',
    selectedFile: (name: string) => `Image prête : ${name}`,
    uploadAction: 'Ajouter l’émoji',
    uploading: 'Ajout…',
    deleteAction: (code: string) => `Supprimer :${code}:`,
    empty: 'Aucun émoji personnalisé dans cet espace pour le moment.',
    readOnly: 'Seuls les propriétaires et administrateurs ajoutent ou retirent des émojis.',
    errShortcodeInvalid:
      'Utilisez 2 à 32 lettres minuscules, chiffres ou tirets bas (le préfixe kodera_ est réservé).',
    errShortcodeConflict: 'Ce nom court est déjà utilisé dans cet espace.',
    errImageInvalid: 'Choisissez une image PNG, JPEG, WebP ou GIF valide (max 256 Ko après réduction).',
    errGeneric: 'L’opération sur l’émoji n’a pas abouti. Réessayez dans un instant.',
  },
  sendLater: {
    triggerLabel: 'Programmer l’envoi',
    popoverLabel: 'Programmer l’envoi du message',
    heading: 'Envoyer plus tard',
    preset30m: 'Dans 30 minutes',
    preset2h: 'Dans 2 heures',
    presetTomorrow: 'Demain à 09:00',
    customLabel: 'Date et heure personnalisées',
    scheduleAction: 'Programmer',
    scheduling: 'Programmation…',
    scheduledBanner: (count: number) =>
      count === 1 ? '1 message programmé' : `${count} messages programmés`,
    showScheduled: 'Voir',
    hideScheduled: 'Masquer',
    cancelAction: 'Annuler l’envoi',
    emptyDraftHint: 'Rédigez d’abord un message texte pour programmer son envoi.',
    errConfidential: 'L’envoi différé est désactivé dans les salons confidentiels ou chiffrés.',
    errPast: 'Choisissez une heure future d’au moins quelques secondes.',
    errGeneric: 'Impossible de programmer ce message. Réessayez.',
  },
  reminders: {
    menuAction: 'Me le rappeler',
    dialogTitle: 'Programmer un rappel personnel',
    preset20m: 'Dans 20 minutes',
    preset1h: 'Dans 1 heure',
    presetTomorrow: 'Demain à 09:00',
    customLabel: 'Date et heure du rappel',
    noteLabel: 'Note personnelle (optionnelle)',
    notePlaceholder: 'Pourquoi revenir sur ce message…',
    saveAction: 'Enregistrer le rappel',
    saving: 'Enregistrement…',
    headerButton: 'Rappels personnels',
    headerButtonCount: (count: number) => `Rappels personnels (${count})`,
    panelHeading: 'Mes rappels',
    empty: 'Aucun rappel actif pour le moment.',
    firedBadge: 'Échu',
    snoozedBadge: 'Reporté',
    pendingBadge: 'Prévu',
    snooze1hAction: '+1 h',
    completeAction: 'Terminé',
    deleteAction: 'Supprimer',
    jumpAction: 'Aller au message',
    closeAction: 'Fermer',
    errConfidential: 'Les rappels serveur sont désactivés dans les salons confidentiels.',
    errPast: 'Choisissez une échéance dans le futur.',
    errGeneric: 'Impossible d’enregistrer ce rappel. Réessayez.',
  },
  labs: {
    intro:
      'Activez ou masquez les fonctionnalités expérimentales de votre espace personnel. Les garanties de confidentialité restent intégralement appliquées.',
    betaBadge: 'Expérimental',
    saving: 'Enregistrement…',
    saved: 'Préférences Kodera Labs enregistrées.',
    errGeneric: 'Impossible d’enregistrer vos préférences Kodera Labs.',
    flags: {
      send_later: {
        title: 'Envoi différé (Send Later)',
        description:
          'Programmez l’envoi d’un message à une date choisie dans les salons non confidentiels.',
      },
      custom_emojis: {
        title: 'Émojis personnalisés WebP',
        description:
          'Affichez et insérez les émojis personnalisés de votre espace dans les messages et réactions.',
      },
      personal_reminders: {
        title: 'Rappels personnels sur message',
        description:
          'Ajoutez une échéance et une note personnelle sur un message pour recevoir un rappel dans votre boîte.',
      },
      waiting_room_ambience: {
        title: 'Ambiance sonore de salle d’attente',
        description:
          'Activez une nappe sonore douce lorsque vous êtes seul dans un salon vocal, atténuée automatiquement dès que vous parlez.',
      },
    },
    defaultAmbienceLabel: 'Activer automatiquement l’ambiance sonore en salle d’attente',
  },
  ambience: {
    enable: 'Activer l’ambiance de salle d’attente',
    disable: 'Couper l’ambiance de salle d’attente',
  },
}

export type ExperienceCopy = typeof fr

const en: ExperienceCopy = {
  customEmojis: {
    heading: 'Workspace custom emojis',
    subtitle:
      'Add sanitized WebP emojis (up to 128×128, stripped of EXIF/XMP/ICCP metadata) available to every member.',
    paletteHeading: 'Workspace emojis',
    shortcodeLabel: 'Shortcode (without colons)',
    shortcodePlaceholder: 'e.g. ship_it',
    shortcodeHint: '2 to 32 characters: lowercase letters, digits, and underscores only.',
    chooseFile: 'Choose image',
    selectedFile: (name: string) => `Ready image: ${name}`,
    uploadAction: 'Add emoji',
    uploading: 'Adding…',
    deleteAction: (code: string) => `Remove :${code}:`,
    empty: 'No custom emojis in this workspace yet.',
    readOnly: 'Only workspace owners and administrators can add or remove custom emojis.',
    errShortcodeInvalid:
      'Use 2 to 32 lowercase letters, digits, or underscores (the kodera_ prefix is reserved).',
    errShortcodeConflict: 'That shortcode is already used in this workspace.',
    errImageInvalid: 'Choose a valid PNG, JPEG, WebP, or GIF image (up to 256 KB after resize).',
    errGeneric: 'Could not update custom emoji. Please try again.',
  },
  sendLater: {
    triggerLabel: 'Schedule send',
    popoverLabel: 'Schedule message delivery',
    heading: 'Send later',
    preset30m: 'In 30 minutes',
    preset2h: 'In 2 hours',
    presetTomorrow: 'Tomorrow at 09:00',
    customLabel: 'Custom date and time',
    scheduleAction: 'Schedule',
    scheduling: 'Scheduling…',
    scheduledBanner: (count: number) =>
      count === 1 ? '1 scheduled message' : `${count} scheduled messages`,
    showScheduled: 'View',
    hideScheduled: 'Hide',
    cancelAction: 'Cancel send',
    emptyDraftHint: 'Write a text message first to schedule delivery.',
    errConfidential: 'Scheduled messages are disabled in confidential or encrypted rooms.',
    errPast: 'Pick a future time at least a few seconds ahead.',
    errGeneric: 'Could not schedule this message. Please try again.',
  },
  reminders: {
    menuAction: 'Remind me',
    dialogTitle: 'Set a personal reminder',
    preset20m: 'In 20 minutes',
    preset1h: 'In 1 hour',
    presetTomorrow: 'Tomorrow at 09:00',
    customLabel: 'Reminder date and time',
    noteLabel: 'Personal note (optional)',
    notePlaceholder: 'Why follow up on this message…',
    saveAction: 'Save reminder',
    saving: 'Saving…',
    headerButton: 'Personal reminders',
    headerButtonCount: (count: number) => `Personal reminders (${count})`,
    panelHeading: 'My reminders',
    empty: 'No active reminders right now.',
    firedBadge: 'Due',
    snoozedBadge: 'Snoozed',
    pendingBadge: 'Scheduled',
    snooze1hAction: '+1h',
    completeAction: 'Done',
    deleteAction: 'Remove',
    jumpAction: 'Jump to message',
    closeAction: 'Close',
    errConfidential: 'Server reminders are disabled in confidential rooms.',
    errPast: 'Pick a reminder time in the future.',
    errGeneric: 'Could not save this reminder. Please try again.',
  },
  labs: {
    intro:
      'Enable or hide experimental features for your personal workspace experience. Room confidentiality boundaries remain strictly enforced.',
    betaBadge: 'Experimental',
    saving: 'Saving…',
    saved: 'Kodera Labs preferences saved.',
    errGeneric: 'Could not save your Kodera Labs preferences.',
    flags: {
      send_later: {
        title: 'Send Later scheduled messages',
        description:
          'Schedule messages for future delivery in non-confidential channels and direct messages.',
      },
      custom_emojis: {
        title: 'Sanitized WebP custom emojis',
        description:
          'Render and insert workspace custom emojis across messages, composer palettes, and reactions.',
      },
      personal_reminders: {
        title: 'Personal message reminders',
        description:
          'Attach a due time and personal note to any non-confidential message to receive an inbox reminder.',
      },
      waiting_room_ambience: {
        title: 'Waiting-room ambient audio',
        description:
          'Play gentle ambient audio while waiting alone in a voice room, with automatic speech ducking.',
      },
    },
    defaultAmbienceLabel: 'Automatically start ambient audio when entering an empty waiting room',
  },
  ambience: {
    enable: 'Enable waiting-room ambience',
    disable: 'Stop waiting-room ambience',
  },
}

export function experienceCopy(locale?: string): ExperienceCopy {
  return locale?.startsWith('en') ? en : fr
}
