export interface CalendarCopy {
  readonly surfaceTitle: string
  readonly surfaceSubtitle: string
  readonly views: {
    readonly week: string
    readonly month: string
  }
  readonly nav: {
    readonly previous: string
    readonly today: string
    readonly next: string
  }
  readonly weekdaysShort: readonly [string, string, string, string, string, string, string]
  readonly weekdaysLong: readonly [string, string, string, string, string, string, string]
  readonly actions: {
    readonly newEvent: string
    readonly caldavDrawer: string
    readonly bookingDrawer: string
    readonly exportIcs: string
    readonly closeDrawer: string
    readonly deleteEvent: string
  }
  readonly eventForm: {
    readonly heading: string
    readonly titleLabel: string
    readonly titlePlaceholder: string
    readonly startLabel: string
    readonly endLabel: string
    readonly recurrenceLabel: string
    readonly recurrenceNone: string
    readonly recurrenceDaily: string
    readonly recurrenceWeekly: string
    readonly recurrenceMonthly: string
    readonly visibilityLabel: string
    readonly visibilityWorkspace: string
    readonly visibilityPrivate: string
    readonly visioLabel: string
    readonly visioPlaceholder: string
    readonly agendaLabel: string
    readonly agendaPlaceholder: string
    readonly submit: string
  }
  readonly caldav: {
    readonly heading: string
    readonly subtitle: string
    readonly providerLabel: string
    readonly providers: {
      readonly lasuite: string
      readonly open_xchange: string
      readonly nextcloud: string
      readonly generic: string
    }
    readonly nameLabel: string
    readonly namePlaceholder: string
    readonly urlLabel: string
    readonly urlPlaceholder: string
    readonly usernameLabel: string
    readonly passwordLabel: string
    readonly addSource: string
    readonly syncNow: string
    readonly removeSource: string
    readonly syncedBadge: string
    readonly pendingBadge: string
    readonly emptySources: string
    readonly syncSummary: (upserted: number, removed: number) => string
  }
  readonly bookingBuilder: {
    readonly heading: string
    readonly subtitle: string
    readonly slugLabel: string
    readonly slugPlaceholder: string
    readonly titleLabel: string
    readonly titlePlaceholder: string
    readonly durationLabel: string
    readonly bufferLabel: string
    readonly weekdayLabel: string
    readonly startLabel: string
    readonly endLabel: string
    readonly visioLabel: string
    readonly createPage: string
    readonly previewPublic: string
    readonly deactivatePage: string
    readonly emptyPages: string
  }
  readonly publicBooking: {
    readonly regionLabel: string
    readonly subtitleZeroPii: string
    readonly durationBadge: (minutes: number) => string
    readonly visioIncluded: string
    readonly availableSlotsHeading: string
    readonly noSlotsAvailable: string
    readonly guestNameLabel: string
    readonly guestEmailLabel: string
    readonly guestNotesLabel: string
    readonly confirmSlot: string
    readonly confirmedHeading: string
    readonly cancellationTokenLabel: string
    readonly downloadInvite: string
    readonly cancelHeading: string
    readonly cancelTokenInputLabel: string
    readonly cancelAction: string
    readonly cancelledNotice: string
    readonly downloadCancelIcs: string
  }
  readonly badges: {
    readonly recurring: string
    readonly visioLink: string
    readonly agendaDoc: string
    readonly privateEvent: string
  }
  readonly emptyDay: string
  readonly loading: string
  readonly errorGeneric: string
}

const FR: CalendarCopy = {
  surfaceTitle: 'Agenda souverain',
  surfaceSubtitle: 'Synchronisation CalDAV La Suite Numérique, export RFC 5545 et pages de réservation sans fuite de données.',
  views: {
    week: 'Semaine',
    month: 'Mois',
  },
  nav: {
    previous: 'Période précédente',
    today: 'Aujourd’hui',
    next: 'Période suivante',
  },
  weekdaysShort: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'],
  weekdaysLong: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
  actions: {
    newEvent: 'Nouvel événement',
    caldavDrawer: 'Sources CalDAV',
    bookingDrawer: 'Pages de réservation',
    exportIcs: 'Exporter .ics',
    closeDrawer: 'Fermer le panneau',
    deleteEvent: 'Supprimer',
  },
  eventForm: {
    heading: 'Planifier un événement',
    titleLabel: 'Titre de l’événement',
    titlePlaceholder: 'Comité produit hebdomadaire',
    startLabel: 'Début (UTC)',
    endLabel: 'Fin (UTC)',
    recurrenceLabel: 'Récurrence',
    recurrenceNone: 'Aucune récurrence',
    recurrenceDaily: 'Quotidienne (DAILY)',
    recurrenceWeekly: 'Hebdomadaire (WEEKLY)',
    recurrenceMonthly: 'Mensuelle (MONTHLY)',
    visibilityLabel: 'Visibilité',
    visibilityWorkspace: 'Espace partagé',
    visibilityPrivate: 'Privé (hôte uniquement)',
    visioLabel: 'Salle Kodera Visio (HTTPS)',
    visioPlaceholder: 'https://visio.kodera.io/point-equipe',
    agendaLabel: 'Ordre du jour Docs (HTTPS)',
    agendaPlaceholder: 'https://console.kodera.io/docs/ordre-du-jour',
    submit: 'Enregistrer l’événement',
  },
  caldav: {
    heading: 'Connecteurs CalDAV souverains',
    subtitle: 'Identifiants chiffrés par organisation (HKDF-AEAD) et synchronisation HTTPS sans redirection.',
    providerLabel: 'Fournisseur CalDAV',
    providers: {
      lasuite: 'DINUM La Suite Numérique',
      open_xchange: 'Open-Xchange',
      nextcloud: 'Nextcloud Calendar',
      generic: 'CalDAV standard (RFC 4791)',
    },
    nameLabel: 'Nom de la source',
    namePlaceholder: 'Agenda Équipe La Suite',
    urlLabel: 'URL HTTPS de la collection CalDAV',
    urlPlaceholder: 'https://agenda.numerique.gouv.fr/caldav/equipe/',
    usernameLabel: 'Identifiant principal',
    passwordLabel: 'Mot de passe d’application',
    addSource: 'Connecter la source',
    syncNow: 'Synchroniser',
    removeSource: 'Retirer',
    syncedBadge: 'Jeton delta actif',
    pendingBadge: 'Synchronisation initiale',
    emptySources: 'Aucune source CalDAV configurée pour cet espace.',
    syncSummary: (upserted, removed) =>
      `Synchronisation terminée : ${String(upserted)} mis à jour, ${String(removed)} annulé(s).`,
  },
  bookingBuilder: {
    heading: 'Pages de réservation souveraines',
    subtitle: 'Publiez vos créneaux disponibles sans exposer aucun titre ni participant de votre agenda.',
    slugLabel: 'Identifiant public (slug)',
    slugPlaceholder: 'point-architecture-kodera',
    titleLabel: 'Titre public de la page',
    titlePlaceholder: 'Point architecture 30 min',
    durationLabel: 'Durée du créneau',
    bufferLabel: 'Marge tampon (min)',
    weekdayLabel: 'Jour ouvré',
    startLabel: 'Ouverture',
    endLabel: 'Fermeture',
    visioLabel: 'Lien Kodera Visio attaché (optionnel)',
    createPage: 'Créer la page de réservation',
    previewPublic: 'Aperçu public',
    deactivatePage: 'Désactiver',
    emptyPages: 'Aucune page de réservation active.',
  },
  publicBooking: {
    regionLabel: 'Page publique de réservation souveraine',
    subtitleZeroPii: 'Seules les plages libres sont publiées. Aucune information privée du calendrier hôte n’est transmise.',
    durationBadge: (minutes) => `${String(minutes)} min`,
    visioIncluded: 'Visio Kodera incluse',
    availableSlotsHeading: 'Créneaux disponibles',
    noSlotsAvailable: 'Aucun créneau disponible sur cette période.',
    guestNameLabel: 'Votre nom',
    guestEmailLabel: 'Votre adresse courriel',
    guestNotesLabel: 'Objet ou notes (optionnel)',
    confirmSlot: 'Confirmer la réservation',
    confirmedHeading: 'Créneau réservé avec succès',
    cancellationTokenLabel: 'Jeton d’annulation unique (conservez-le)',
    downloadInvite: 'Télécharger l’invitation .ics',
    cancelHeading: 'Annuler cette réservation',
    cancelTokenInputLabel: 'Jeton d’annulation',
    cancelAction: 'Confirmer l’annulation',
    cancelledNotice: 'La réservation a été annulée et le créneau a été libéré.',
    downloadCancelIcs: 'Télécharger l’annulation .ics',
  },
  badges: {
    recurring: 'Récurrent',
    visioLink: 'Rejoindre Visio',
    agendaDoc: 'Ordre du jour',
    privateEvent: 'Privé',
  },
  emptyDay: 'Aucun événement',
  loading: 'Chargement de l’agenda…',
  errorGeneric: 'L’opération sur l’agenda n’a pas pu aboutir.',
}

const EN: CalendarCopy = {
  surfaceTitle: 'Sovereign Calendar',
  surfaceSubtitle: 'La Suite Numerique CalDAV sync, RFC 5545 .ics export, and zero-PII booking pages.',
  views: {
    week: 'Week',
    month: 'Month',
  },
  nav: {
    previous: 'Previous period',
    today: 'Today',
    next: 'Next period',
  },
  weekdaysShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  weekdaysLong: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  actions: {
    newEvent: 'New event',
    caldavDrawer: 'CalDAV sources',
    bookingDrawer: 'Booking pages',
    exportIcs: 'Export .ics',
    closeDrawer: 'Close panel',
    deleteEvent: 'Delete',
  },
  eventForm: {
    heading: 'Schedule an event',
    titleLabel: 'Event title',
    titlePlaceholder: 'Weekly product sync',
    startLabel: 'Starts at (UTC)',
    endLabel: 'Ends at (UTC)',
    recurrenceLabel: 'Recurrence',
    recurrenceNone: 'Does not repeat',
    recurrenceDaily: 'Daily (DAILY)',
    recurrenceWeekly: 'Weekly (WEEKLY)',
    recurrenceMonthly: 'Monthly (MONTHLY)',
    visibilityLabel: 'Visibility',
    visibilityWorkspace: 'Shared workspace',
    visibilityPrivate: 'Private (host only)',
    visioLabel: 'Kodera Visio room (HTTPS)',
    visioPlaceholder: 'https://visio.kodera.io/team-sync',
    agendaLabel: 'Docs agenda link (HTTPS)',
    agendaPlaceholder: 'https://console.kodera.io/docs/agenda',
    submit: 'Save event',
  },
  caldav: {
    heading: 'Sovereign CalDAV connectors',
    subtitle: 'Per-organisation HKDF-AEAD sealed credentials and pinned-IP no-redirect HTTPS sync.',
    providerLabel: 'CalDAV provider',
    providers: {
      lasuite: 'DINUM La Suite Numerique',
      open_xchange: 'Open-Xchange',
      nextcloud: 'Nextcloud Calendar',
      generic: 'Standard CalDAV (RFC 4791)',
    },
    nameLabel: 'Source name',
    namePlaceholder: 'La Suite Team Calendar',
    urlLabel: 'CalDAV collection HTTPS URL',
    urlPlaceholder: 'https://agenda.numerique.gouv.fr/caldav/team/',
    usernameLabel: 'Principal username',
    passwordLabel: 'Application password',
    addSource: 'Connect source',
    syncNow: 'Sync now',
    removeSource: 'Remove',
    syncedBadge: 'Delta token active',
    pendingBadge: 'Initial sync pending',
    emptySources: 'No CalDAV source configured for this workspace.',
    syncSummary: (upserted, removed) =>
      `Sync complete: ${String(upserted)} upserted, ${String(removed)} cancelled.`,
  },
  bookingBuilder: {
    heading: 'Sovereign booking pages',
    subtitle: 'Publish free time slots without disclosing calendar event titles or attendee PII.',
    slugLabel: 'Public booking slug',
    slugPlaceholder: 'kodera-architecture-office-hours',
    titleLabel: 'Public page title',
    titlePlaceholder: '30-minute architecture review',
    durationLabel: 'Slot duration',
    bufferLabel: 'Buffer (min)',
    weekdayLabel: 'Weekday',
    startLabel: 'Start time',
    endLabel: 'End time',
    visioLabel: 'Attached Kodera Visio URL (optional)',
    createPage: 'Create booking page',
    previewPublic: 'Public preview',
    deactivatePage: 'Deactivate',
    emptyPages: 'No active booking pages.',
  },
  publicBooking: {
    regionLabel: 'Public sovereign booking page',
    subtitleZeroPii: 'Only free intervals are published. Zero private calendar metadata is exposed.',
    durationBadge: (minutes) => `${String(minutes)} min`,
    visioIncluded: 'Kodera Visio included',
    availableSlotsHeading: 'Available slots',
    noSlotsAvailable: 'No available slots in this window.',
    guestNameLabel: 'Your name',
    guestEmailLabel: 'Your email address',
    guestNotesLabel: 'Notes (optional)',
    confirmSlot: 'Confirm booking',
    confirmedHeading: 'Booking confirmed',
    cancellationTokenLabel: 'One-time cancellation token (keep safe)',
    downloadInvite: 'Download .ics invite',
    cancelHeading: 'Cancel this reservation',
    cancelTokenInputLabel: 'Cancellation token',
    cancelAction: 'Confirm cancellation',
    cancelledNotice: 'Reservation cancelled and slot released.',
    downloadCancelIcs: 'Download cancellation .ics',
  },
  badges: {
    recurring: 'Recurring',
    visioLink: 'Join Visio',
    agendaDoc: 'Agenda doc',
    privateEvent: 'Private',
  },
  emptyDay: 'No events',
  loading: 'Loading calendar…',
  errorGeneric: 'Calendar request could not be completed.',
}

export function calendarCopy(language: string | undefined): CalendarCopy {
  return language?.toLowerCase().startsWith('en') ? EN : FR
}
