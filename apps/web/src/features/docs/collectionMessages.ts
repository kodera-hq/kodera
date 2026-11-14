export interface CollectionCopy {
  readonly regionLabel: string
  readonly heading: string
  readonly subtitle: string
  readonly localBadge: string
  readonly readOnlyBadge: string
  readonly modeEditor: string
  readonly modeCollections: string
  readonly loadingCollections: string
  readonly viewsGroupLabel: string
  readonly viewTable: string
  readonly viewBoard: string
  readonly viewList: string
  readonly groupByLabel: string
  readonly showEmptyGroupsLabel: string
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly clearFilters: string
  readonly activeFiltersLabel: string
  readonly filterStatusLabel: string
  readonly filterPriorityLabel: string
  readonly filterAssigneeLabel: string
  readonly filterTagLabel: string
  readonly filterAllOption: string
  readonly sortPropertyLabel: string
  readonly sortDirectionAsc: string
  readonly sortDirectionDesc: string
  readonly sortByTitle: string
  readonly sortByUpdated: string
  readonly addRowAction: string
  readonly newRowTitlePlaceholder: string
  readonly newRowLabel: string
  readonly openPageAction: string
  readonly openPageNamed: (title: string) => string
  readonly columnDocument: string
  readonly emptyCollection: string
  readonly emptyFiltered: string
  readonly unassignedOption: string
  readonly unsetOption: string
  readonly emptyGroupHeading: string
  readonly cardMoveLeft: (title: string) => string
  readonly cardMoveRight: (title: string) => string
  readonly cardMoveToColumn: (title: string) => string
  readonly propertyTypes: {
    readonly status: string
    readonly select: string
    readonly multi_select: string
    readonly assignee: string
    readonly due_date: string
    readonly priority: string
    readonly number: string
    readonly checkbox: string
    readonly url: string
    readonly tags: string
    readonly text: string
  }
  readonly defaultSchema: {
    readonly collectionTitle: string
    readonly statusName: string
    readonly priorityName: string
    readonly assigneeName: string
    readonly dueDateName: string
    readonly verifiedName: string
    readonly estimateName: string
    readonly referenceUrlName: string
    readonly tagsName: string
    readonly statusTodo: string
    readonly statusInProgress: string
    readonly statusReview: string
    readonly statusDone: string
    readonly priorityLow: string
    readonly priorityMedium: string
    readonly priorityHigh: string
    readonly priorityUrgent: string
    readonly tagArchitecture: string
    readonly tagSecurity: string
    readonly tagProduct: string
    readonly tagOperations: string
  }
  readonly rollups: {
    readonly summaryRegion: string
    readonly count: (visible: number, total: number) => string
    readonly donePercent: (percent: number, done: number, total: number) => string
    readonly checkedPercent: (name: string, percent: number) => string
    readonly numericSumAvg: (name: string, sum: string, avg: string) => string
    readonly footerTotal: (count: number) => string
    readonly footerDone: (percent: number) => string
    readonly footerChecked: (percent: number) => string
    readonly footerSumAvg: (sum: string, avg: string) => string
  }
  readonly exportActions: {
    readonly groupLabel: string
    readonly csv: string
    readonly json: string
    readonly markdown: string
    readonly exportedNotice: (format: string) => string
    readonly exportFailed: string
  }
  readonly conflict: {
    readonly message: string
    readonly reloadAction: string
  }
  readonly validation: {
    readonly invalidUrl: string
    readonly invalidDate: string
    readonly invalidNumber: string
    readonly invalidValue: string
    readonly dismissAction: string
  }
  readonly editCellLabel: (docTitle: string, propName: string) => string
  readonly toggleTagLabel: (docTitle: string, propName: string, tagLabel: string) => string
  readonly urlPlaceholder: string
  readonly saveUrlAction: string
  readonly clearUrlAction: string
  readonly openExternalUrlNamed: (docTitle: string, propName: string) => string
  readonly removeFilterChip: (label: string) => string
  readonly boardColumnLabel: (columnLabel: string, count: number) => string
}

export const collectionMessages: Readonly<Record<'fr' | 'en', CollectionCopy>> = {
  fr: {
    regionLabel: 'Collection de documents',
    heading: 'Collection structurée',
    subtitle: 'Propriétés typées, vues instantanées et ouverture directe dans l’éditeur.',
    localBadge: 'Mode brouillon local',
    readOnlyBadge: 'Lecture seule',
    modeEditor: 'Éditeur de page',
    modeCollections: 'Collections',
    loadingCollections: 'Chargement de la collection…',
    viewsGroupLabel: 'Vues de la collection',
    viewTable: 'Tableau',
    viewBoard: 'Kanban',
    viewList: 'Liste',
    groupByLabel: 'Grouper par',
    showEmptyGroupsLabel: 'Colonnes vides',
    searchLabel: 'Filtrer les pages',
    searchPlaceholder: 'Rechercher par titre ou propriété…',
    clearFilters: 'Effacer les filtres',
    activeFiltersLabel: 'Filtres actifs',
    filterStatusLabel: 'Statut',
    filterPriorityLabel: 'Priorité',
    filterAssigneeLabel: 'Responsable',
    filterTagLabel: 'Étiquette',
    filterAllOption: 'Tous',
    sortPropertyLabel: 'Trier par',
    sortDirectionAsc: 'Croissant',
    sortDirectionDesc: 'Décroissant',
    sortByTitle: 'Titre',
    sortByUpdated: 'Mis à jour',
    addRowAction: 'Nouvelle entrée',
    newRowTitlePlaceholder: 'Titre de la nouvelle page…',
    newRowLabel: 'Nouvelle entrée de collection',
    openPageAction: 'Ouvrir',
    openPageNamed: (title) => `Ouvrir ${title} dans l’éditeur collaboratif`,
    columnDocument: 'Document',
    emptyCollection: 'Aucune page dans cette collection.',
    emptyFiltered: 'Aucune entrée ne correspond aux filtres actifs.',
    unassignedOption: 'Non assigné',
    unsetOption: 'Non défini',
    emptyGroupHeading: 'Sans valeur',
    cardMoveLeft: (title) => `Déplacer ${title} vers la colonne précédente`,
    cardMoveRight: (title) => `Déplacer ${title} vers la colonne suivante`,
    cardMoveToColumn: (title) => `Déplacer ${title} vers la colonne`,
    propertyTypes: {
      status: 'Statut',
      select: 'Sélection',
      multi_select: 'Sélection multiple',
      assignee: 'Responsable',
      due_date: 'Échéance',
      priority: 'Priorité',
      number: 'Nombre',
      checkbox: 'Case à cocher',
      url: 'Lien URL',
      tags: 'Étiquettes',
      text: 'Texte',
    },
    defaultSchema: {
      collectionTitle: 'Suivi documentaire',
      statusName: 'Statut',
      priorityName: 'Priorité',
      assigneeName: 'Responsable',
      dueDateName: 'Échéance',
      verifiedName: 'Validé',
      estimateName: 'Charge',
      referenceUrlName: 'Lien de référence',
      tagsName: 'Étiquettes',
      statusTodo: 'À faire',
      statusInProgress: 'En cours',
      statusReview: 'En revue',
      statusDone: 'Terminé',
      priorityLow: 'Basse',
      priorityMedium: 'Moyenne',
      priorityHigh: 'Haute',
      priorityUrgent: 'Critique',
      tagArchitecture: 'Architecture',
      tagSecurity: 'Sécurité',
      tagProduct: 'Produit',
      tagOperations: 'Exploitation',
    },
    rollups: {
      summaryRegion: 'Synthèse de la collection',
      count: (visible, total) =>
        visible === total ? `${visible} entrées` : `${visible} / ${total} entrées`,
      donePercent: (percent, done, total) => `Terminés : ${percent}% (${done}/${total})`,
      checkedPercent: (name, percent) => `${name} : ${percent}% cochés`,
      numericSumAvg: (name, sum, avg) => `${name} : somme ${sum} · moy. ${avg}`,
      footerTotal: (count) => `Total : ${count}`,
      footerDone: (percent) => `${percent}% terminés`,
      footerChecked: (percent) => `${percent}% cochés`,
      footerSumAvg: (sum, avg) => `Σ ${sum} · x̄ ${avg}`,
    },
    exportActions: {
      groupLabel: 'Exporter la collection filtrée',
      csv: 'Exporter CSV',
      json: 'Exporter JSON',
      markdown: 'Exporter Markdown',
      exportedNotice: (format) => `Export ${format} prêt.`,
      exportFailed: 'Impossible de copier l’export.',
    },
    conflict: {
      message:
        'Conflit de version détecté (412) : cette entrée a été modifiée par un autre membre. Rechargez les données avant de réappliquer votre changement.',
      reloadAction: 'Recharger la collection',
    },
    validation: {
      invalidUrl:
        'Lien refusé : seules les adresses commençant par https:// ou http:// sans identifiants sont autorisées.',
      invalidDate: 'Date invalide : utilisez le format AAAA-MM-JJ.',
      invalidNumber: 'Nombre invalide : saisissez une valeur numérique finie.',
      invalidValue: 'Valeur incompatible avec le schéma de la propriété.',
      dismissAction: 'Fermer',
    },
    editCellLabel: (docTitle, propName) => `${propName} pour ${docTitle}`,
    toggleTagLabel: (docTitle, propName, tagLabel) =>
      `Basculer ${tagLabel} dans ${propName} pour ${docTitle}`,
    urlPlaceholder: 'https://exemple.org/spec',
    saveUrlAction: 'Valider',
    clearUrlAction: 'Effacer',
    openExternalUrlNamed: (docTitle, propName) => `Ouvrir ${propName} de ${docTitle}`,
    removeFilterChip: (label) => `Retirer le filtre ${label}`,
    boardColumnLabel: (columnLabel, count) => `${columnLabel} (${count})`,
  },
  en: {
    regionLabel: 'Document collection',
    heading: 'Structured collection',
    subtitle: 'Typed properties, instant views, and one-step opening in the page editor.',
    localBadge: 'Local draft mode',
    readOnlyBadge: 'Read only',
    modeEditor: 'Page editor',
    modeCollections: 'Collections',
    loadingCollections: 'Loading collection…',
    viewsGroupLabel: 'Collection views',
    viewTable: 'Table',
    viewBoard: 'Kanban',
    viewList: 'List',
    groupByLabel: 'Group by',
    showEmptyGroupsLabel: 'Empty columns',
    searchLabel: 'Filter pages',
    searchPlaceholder: 'Search by title or property…',
    clearFilters: 'Clear filters',
    activeFiltersLabel: 'Active filters',
    filterStatusLabel: 'Status',
    filterPriorityLabel: 'Priority',
    filterAssigneeLabel: 'Assignee',
    filterTagLabel: 'Tag',
    filterAllOption: 'All',
    sortPropertyLabel: 'Sort by',
    sortDirectionAsc: 'Ascending',
    sortDirectionDesc: 'Descending',
    sortByTitle: 'Title',
    sortByUpdated: 'Updated',
    addRowAction: 'New entry',
    newRowTitlePlaceholder: 'New page title…',
    newRowLabel: 'New collection entry',
    openPageAction: 'Open',
    openPageNamed: (title) => `Open ${title} in collaborative editor`,
    columnDocument: 'Document',
    emptyCollection: 'No pages in this collection yet.',
    emptyFiltered: 'No entries match the active filters.',
    unassignedOption: 'Unassigned',
    unsetOption: 'Unset',
    emptyGroupHeading: 'No value',
    cardMoveLeft: (title) => `Move ${title} to previous column`,
    cardMoveRight: (title) => `Move ${title} to next column`,
    cardMoveToColumn: (title) => `Move ${title} to column`,
    propertyTypes: {
      status: 'Status',
      select: 'Select',
      multi_select: 'Multi-select',
      assignee: 'Assignee',
      due_date: 'Due date',
      priority: 'Priority',
      number: 'Number',
      checkbox: 'Checkbox',
      url: 'URL',
      tags: 'Tags',
      text: 'Text',
    },
    defaultSchema: {
      collectionTitle: 'Document tracker',
      statusName: 'Status',
      priorityName: 'Priority',
      assigneeName: 'Assignee',
      dueDateName: 'Due date',
      verifiedName: 'Verified',
      estimateName: 'Effort',
      referenceUrlName: 'Reference URL',
      tagsName: 'Tags',
      statusTodo: 'To do',
      statusInProgress: 'In progress',
      statusReview: 'In review',
      statusDone: 'Done',
      priorityLow: 'Low',
      priorityMedium: 'Medium',
      priorityHigh: 'High',
      priorityUrgent: 'Urgent',
      tagArchitecture: 'Architecture',
      tagSecurity: 'Security',
      tagProduct: 'Product',
      tagOperations: 'Operations',
    },
    rollups: {
      summaryRegion: 'Collection summary',
      count: (visible, total) =>
        visible === total ? `${visible} entries` : `${visible} / ${total} entries`,
      donePercent: (percent, done, total) => `Done: ${percent}% (${done}/${total})`,
      checkedPercent: (name, percent) => `${name}: ${percent}% checked`,
      numericSumAvg: (name, sum, avg) => `${name}: sum ${sum} · avg ${avg}`,
      footerTotal: (count) => `Total: ${count}`,
      footerDone: (percent) => `${percent}% done`,
      footerChecked: (percent) => `${percent}% checked`,
      footerSumAvg: (sum, avg) => `Σ ${sum} · x̄ ${avg}`,
    },
    exportActions: {
      groupLabel: 'Export filtered collection',
      csv: 'Export CSV',
      json: 'Export JSON',
      markdown: 'Export Markdown',
      exportedNotice: (format) => `${format} export ready.`,
      exportFailed: 'Could not copy export.',
    },
    conflict: {
      message:
        'Version conflict detected (412): this entry was updated by another member. Reload the collection before re-applying your change.',
      reloadAction: 'Reload collection',
    },
    validation: {
      invalidUrl:
        'Rejected URL: only https:// and http:// addresses without embedded credentials are allowed.',
      invalidDate: 'Invalid date: use YYYY-MM-DD format.',
      invalidNumber: 'Invalid number: enter a finite numeric value.',
      invalidValue: 'Value does not match the property schema.',
      dismissAction: 'Dismiss',
    },
    editCellLabel: (docTitle, propName) => `${propName} for ${docTitle}`,
    toggleTagLabel: (docTitle, propName, tagLabel) =>
      `Toggle ${tagLabel} in ${propName} for ${docTitle}`,
    urlPlaceholder: 'https://example.org/spec',
    saveUrlAction: 'Save',
    clearUrlAction: 'Clear',
    openExternalUrlNamed: (docTitle, propName) => `Open ${propName} for ${docTitle}`,
    removeFilterChip: (label) => `Remove filter ${label}`,
    boardColumnLabel: (columnLabel, count) => `${columnLabel} (${count})`,
  },
}

export function getCollectionCopy(language?: string): CollectionCopy {
  return collectionMessages[language?.startsWith('en') ? 'en' : 'fr']
}
