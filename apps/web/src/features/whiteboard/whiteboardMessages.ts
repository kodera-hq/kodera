export interface WhiteboardCopy {
  readonly tabLabel: string
  readonly regionLabel: string
  readonly canvasLabel: string
  readonly toolbarLabel: string
  readonly colorGroupLabel: string
  readonly zoomGroupLabel: string
  readonly collaboratorsLabel: (count: number) => string
  readonly elementCountLabel: (count: number, max: number) => string
  readonly reducedMotionBadge: string
  readonly tools: {
    readonly select: string
    readonly pen: string
    readonly rect: string
    readonly ellipse: string
    readonly arrow: string
    readonly sticky: string
    readonly text: string
    readonly eraser: string
    readonly pan: string
  }
  readonly colors: {
    readonly ink: string
    readonly muted: string
    readonly accent: string
    readonly success: string
    readonly warning: string
    readonly danger: string
  }
  readonly actions: {
    readonly undo: string
    readonly redo: string
    readonly zoomIn: string
    readonly zoomOut: string
    readonly resetView: string
    readonly deleteSelected: string
    readonly addSticky: string
    readonly updateText: string
  }
  readonly textInputLabel: string
  readonly textInputPlaceholder: string
  readonly defaultStickyText: string
  readonly defaultLabelText: string
  readonly shortcutsHint: string
}

const FR: WhiteboardCopy = {
  tabLabel: 'Tableau blanc',
  regionLabel: 'Espace tableau blanc collaboratif',
  canvasLabel: 'Zone de dessin du tableau blanc',
  toolbarLabel: 'Outils du tableau blanc',
  colorGroupLabel: 'Palette de jetons de couleur',
  zoomGroupLabel: 'Contrôles de vue et historique',
  collaboratorsLabel: (count) =>
    count <= 1 ? '1 participant actif' : `${String(count)} participants actifs`,
  elementCountLabel: (count, max) => `${String(count)} / ${String(max)} éléments`,
  reducedMotionBadge: 'Mouvement réduit',
  tools: {
    select: 'Sélection (V)',
    pen: 'Crayon (P)',
    rect: 'Rectangle (R)',
    ellipse: 'Ellipse (O)',
    arrow: 'Flèche (A)',
    sticky: 'Post-it (S)',
    text: 'Texte (T)',
    eraser: 'Gomme (E)',
    pan: 'Déplacer (H)',
  },
  colors: {
    ink: 'Encre',
    muted: 'Ardoise',
    accent: 'Cobalt',
    success: 'Succès',
    warning: 'Alerte',
    danger: 'Critique',
  },
  actions: {
    undo: 'Annuler',
    redo: 'Rétablir',
    zoomIn: 'Zoom avant',
    zoomOut: 'Zoom arrière',
    resetView: 'Réinitialiser la vue',
    deleteSelected: 'Supprimer la sélection',
    addSticky: 'Poser une note',
    updateText: 'Mettre à jour le texte',
  },
  textInputLabel: 'Texte de la note ou étiquette',
  textInputPlaceholder: 'Saisir une note concise (512 caractères max.)…',
  defaultStickyText: 'Idée clé',
  defaultLabelText: 'Annotation',
  shortcutsHint: 'Raccourcis : V sélection, P crayon, R rectangle, O ellipse, A flèche, S note, E gomme',
}

const EN: WhiteboardCopy = {
  tabLabel: 'Whiteboard',
  regionLabel: 'Collaborative whiteboard surface',
  canvasLabel: 'Whiteboard drawing canvas',
  toolbarLabel: 'Whiteboard tools',
  colorGroupLabel: 'Semantic color tokens',
  zoomGroupLabel: 'Viewport and history controls',
  collaboratorsLabel: (count) =>
    count <= 1 ? '1 active participant' : `${String(count)} active participants`,
  elementCountLabel: (count, max) => `${String(count)} / ${String(max)} elements`,
  reducedMotionBadge: 'Reduced motion',
  tools: {
    select: 'Select (V)',
    pen: 'Pen (P)',
    rect: 'Rectangle (R)',
    ellipse: 'Ellipse (O)',
    arrow: 'Arrow (A)',
    sticky: 'Sticky (S)',
    text: 'Text (T)',
    eraser: 'Eraser (E)',
    pan: 'Pan (H)',
  },
  colors: {
    ink: 'Ink',
    muted: 'Muted',
    accent: 'Cobalt',
    success: 'Success',
    warning: 'Warning',
    danger: 'Danger',
  },
  actions: {
    undo: 'Undo',
    redo: 'Redo',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset view',
    deleteSelected: 'Delete selected',
    addSticky: 'Place sticky',
    updateText: 'Update text',
  },
  textInputLabel: 'Sticky or text content',
  textInputPlaceholder: 'Write a concise note (max 512 chars)…',
  defaultStickyText: 'Key takeaway',
  defaultLabelText: 'Label',
  shortcutsHint: 'Shortcuts: V select, P pen, R rect, O ellipse, A arrow, S sticky, E eraser',
}

export function whiteboardCopy(language: string | undefined): WhiteboardCopy {
  return language?.toLowerCase().startsWith('en') ? EN : FR
}
