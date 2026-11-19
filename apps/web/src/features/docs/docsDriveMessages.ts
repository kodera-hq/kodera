export interface DocsDriveCopy {
  readonly modeDrive: string
  readonly modeEditor: string
  readonly driveRoot: string
  readonly backToDrive: string
  readonly toolbarLabel: string
  readonly bold: string
  readonly italic: string
  readonly underline: string
  readonly strike: string
  readonly inlineCode: string
  readonly insertLink: string
  readonly removeLink: string
  readonly linkUrlLabel: string
  readonly linkUrlPlaceholder: string
  readonly linkApply: string
  readonly linkInvalid: string
  readonly exportMarkdown: string
  readonly saveStateSaved: string
  readonly saveStateSaving: string
  readonly outlineTitle: string
  readonly outlineToggle: string
  readonly outlineEmpty: string
  readonly newFolder: string
  readonly newFolderLabel: string
  readonly newFolderPlaceholder: string
  readonly createFolderConfirm: string
  readonly cancelAction: string
  readonly newDocHere: string
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly filterGroupLabel: string
  readonly filterAll: string
  readonly filterFolders: string
  readonly filterDocuments: string
  readonly filterFiles: string
  readonly viewGrid: string
  readonly viewList: string
  readonly sortByName: string
  readonly sortByUpdated: string
  readonly foldersHeading: string
  readonly documentsHeading: string
  readonly filesHeading: string
  readonly emptyDrive: string
  readonly emptyFolder: string
  readonly emptySearch: string
  readonly locationRoot: string
  readonly columnName: string
  readonly columnLocation: string
  readonly columnUpdated: string
  readonly columnRole: string
  readonly roleEditor: string
  readonly roleViewer: string
  readonly folderCount: (count: number) => string
  readonly openFolderNamed: (title: string) => string
  readonly openDocumentNamed: (title: string) => string
  readonly openFolderIndexNamed: (title: string) => string
}

const MESSAGES: Readonly<Record<'fr' | 'en', DocsDriveCopy>> = {
  fr: {
    modeDrive: 'Explorateur Drive',
    modeEditor: 'Éditeur',
    driveRoot: 'Mon Drive',
    backToDrive: 'Retour au dossier Drive',
    toolbarLabel: 'Ruban de mise en forme',
    bold: 'Gras (⌘B)',
    italic: 'Italique (⌘I)',
    underline: 'Souligné (⌘U)',
    strike: 'Barré',
    inlineCode: 'Code en ligne',
    insertLink: 'Insérer une adresse web (⌘K)',
    removeLink: 'Retirer l’adresse web',
    linkUrlLabel: 'Adresse web (https://)',
    linkUrlPlaceholder: 'https://exemple.org/ressource',
    linkApply: 'Appliquer l’adresse',
    linkInvalid: 'Seules les adresses https:// ou http:// sans identifiants sont autorisées.',
    exportMarkdown: 'Télécharger en Markdown (.md)',
    saveStateSaved: 'Enregistré',
    saveStateSaving: 'Enregistrement…',
    outlineTitle: 'Plan de la page',
    outlineToggle: 'Afficher ou masquer le plan de la page',
    outlineEmpty: 'Ajoutez un titre H1, H2 ou H3 pour structurer le plan.',
    newFolder: 'Nouveau dossier',
    newFolderLabel: 'Nom du nouveau dossier',
    newFolderPlaceholder: 'Architecture, Produit, Contrats…',
    createFolderConfirm: 'Créer le dossier',
    cancelAction: 'Annuler',
    newDocHere: 'Nouveau document',
    searchLabel: 'Rechercher dans Drive',
    searchPlaceholder: 'Rechercher un dossier, un document ou du contenu…',
    filterGroupLabel: 'Filtrer par type',
    filterAll: 'Tout',
    filterFolders: 'Dossiers',
    filterDocuments: 'Documents',
    filterFiles: 'Fichiers',
    viewGrid: 'Vue grille',
    viewList: 'Vue liste',
    sortByName: 'Trier par nom',
    sortByUpdated: 'Trier par date de modification',
    foldersHeading: 'Dossiers',
    documentsHeading: 'Documents',
    filesHeading: 'Fichiers partagés',
    emptyDrive: 'Aucun dossier ni document dans cet espace. Créez un dossier ou une première page.',
    emptyFolder: 'Ce dossier est vide. Créez un sous-dossier ou un nouveau document ici.',
    emptySearch: 'Aucun élément ne correspond à votre recherche ou au filtre sélectionné.',
    locationRoot: 'Mon Drive',
    columnName: 'Nom',
    columnLocation: 'Emplacement',
    columnUpdated: 'Modifié',
    columnRole: 'Accès',
    roleEditor: 'Édition',
    roleViewer: 'Lecture',
    folderCount: (count) => (count <= 1 ? `${count} élément` : `${count} éléments`),
    openFolderNamed: (title) => `Ouvrir le dossier ${title}`,
    openDocumentNamed: (title) => `Ouvrir le document ${title} dans l’éditeur`,
    openFolderIndexNamed: (title) => `Éditer la note d’accueil du dossier ${title}`,
  },
  en: {
    modeDrive: 'Drive Explorer',
    modeEditor: 'Editor',
    driveRoot: 'My Drive',
    backToDrive: 'Back to Drive folder',
    toolbarLabel: 'Formatting ribbon',
    bold: 'Bold (⌘B)',
    italic: 'Italic (⌘I)',
    underline: 'Underline (⌘U)',
    strike: 'Strikethrough',
    inlineCode: 'Inline code',
    insertLink: 'Insert web address (⌘K)',
    removeLink: 'Remove web address',
    linkUrlLabel: 'Web address (https://)',
    linkUrlPlaceholder: 'https://example.org/resource',
    linkApply: 'Apply web address',
    linkInvalid: 'Only https:// or http:// addresses without credentials are allowed.',
    exportMarkdown: 'Download Markdown (.md)',
    saveStateSaved: 'Saved',
    saveStateSaving: 'Saving…',
    outlineTitle: 'Page outline',
    outlineToggle: 'Show or hide page outline',
    outlineEmpty: 'Add an H1, H2, or H3 heading to populate the outline.',
    newFolder: 'New folder',
    newFolderLabel: 'New folder name',
    newFolderPlaceholder: 'Architecture, Product, Contracts…',
    createFolderConfirm: 'Create folder',
    cancelAction: 'Cancel',
    newDocHere: 'New document',
    searchLabel: 'Search in Drive',
    searchPlaceholder: 'Search folders, documents, or content…',
    filterGroupLabel: 'Filter by type',
    filterAll: 'All',
    filterFolders: 'Folders',
    filterDocuments: 'Documents',
    filterFiles: 'Files',
    viewGrid: 'Grid view',
    viewList: 'List view',
    sortByName: 'Sort by name',
    sortByUpdated: 'Sort by last modified',
    foldersHeading: 'Folders',
    documentsHeading: 'Documents',
    filesHeading: 'Shared files',
    emptyDrive: 'No folders or documents in this workspace yet. Create a folder or first page.',
    emptyFolder: 'This folder is empty. Create a subfolder or a new document here.',
    emptySearch: 'No items match your search or active filter.',
    locationRoot: 'My Drive',
    columnName: 'Name',
    columnLocation: 'Location',
    columnUpdated: 'Modified',
    columnRole: 'Access',
    roleEditor: 'Can edit',
    roleViewer: 'View only',
    folderCount: (count) => (count === 1 ? '1 item' : `${count} items`),
    openFolderNamed: (title) => `Open folder ${title}`,
    openDocumentNamed: (title) => `Open document ${title} in editor`,
    openFolderIndexNamed: (title) => `Edit index note of folder ${title}`,
  },
}

export function getDocsDriveCopy(language?: string): DocsDriveCopy {
  return MESSAGES[language?.startsWith('en') ? 'en' : 'fr']
}
