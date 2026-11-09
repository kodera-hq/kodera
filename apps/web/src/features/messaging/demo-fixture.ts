// The content of the messaging demo preview, taken as-is from the product
// design handoff ("Produit - Mock complet.dc.html") so the console's preview
// and the product mock describe the same company on the same morning: Groupe
// Vercelli, a civil-works group, and the #chantier-a13 conversation of
// Tuesday 8 September.
//
// Why the French lives here and not in the message catalogues. This is
// *data*, not copy: the names of fictional people, the names of their
// channels and the words they say are the demo's subject matter, the same way
// `src/mocks/demo/seed.ts` holds a fictional customer's invoices. Copy — every
// label, heading, button and notice the surface puts AROUND this data — is in
// `docs/specs/copy/{fr,en}.md` under `console.messaging.demo.*` and is reached
// only through `t()`, per docs/dev/I18N.md. Code, identifiers and comments are
// English (AGENTS.md).
//
// This module is reachable only through the dynamic `import()` in
// `src/app/routeTree.ts`, so none of it exists in a production bundle —
// `scripts/check-production-bundle.sh` greps the emitted JavaScript for
// `Coulage de la dalle R+2` to prove it.

/** Which of the six `--c-t*-bg` / `--c-t*-fg` tint pairs an avatar uses. The
 * surface maps these to literal Tailwind classes; a computed class name would
 * not survive Tailwind's content scan. */
export type DemoTint = 't1' | 't2' | 't3' | 't4' | 't5' | 't6'

export interface DemoPerson {
  /** Stable identifier, and the React key. */
  readonly id: string
  readonly name: string
  /** The long form shown in the member list ("Conducteur de travaux"). */
  readonly role: string
  /** The short form shown as a chip beside a message ("Conducteur"). */
  readonly shortRole: string
  readonly tint: DemoTint
}

export interface DemoChannel {
  readonly id: string
  /** Written with its leading `#`, the way a member reads it. */
  readonly name: string
  readonly unread?: number
}

export type DemoRoomKind = 'audio' | 'video' | 'screen'

/** What someone is doing in a room right now. Rendered from the catalogue
 * (`console.messaging.demo.state-*`), never from this identifier. */
export type DemoOccupantState = 'speaking' | 'muted' | 'sharing' | 'available' | 'listening'

export interface DemoOccupant {
  readonly personId: string
  readonly state: DemoOccupantState
}

export interface DemoRoom {
  readonly id: string
  readonly name: string
  readonly kind: DemoRoomKind
  readonly capacity: number
  readonly occupants: readonly DemoOccupant[]
}

export interface DemoMessage {
  readonly id: string
  readonly personId: string
  /** Full ISO timestamp with the Europe/Paris offset, so the clock reading is
   * produced by `Intl` for the active locale rather than written by hand
   * (docs/dev/I18N.md). */
  readonly at: string
  readonly text: string
}

export const DEMO_ORGANISATION = 'Groupe Vercelli'
export const DEMO_WORKSPACE = 'Espace Travaux'

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  {
    id: 'sylvain',
    name: 'Sylvain Ellenstein',
    role: 'Conducteur de travaux',
    shortRole: 'Conducteur',
    tint: 't1',
  },
  {
    id: 'paul',
    name: 'Paul Ferrand',
    role: 'Assistant travaux',
    shortRole: 'Travaux',
    tint: 't2',
  },
  {
    id: 'nadia',
    name: 'Nadia Chevalier',
    role: 'QSE · prévention',
    shortRole: 'QSE',
    tint: 't3',
  },
  {
    id: 'henri',
    name: 'Henri Duflot',
    role: 'Bureau d’études',
    shortRole: 'Études',
    tint: 't4',
  },
  {
    id: 'ines',
    name: 'Inès Kaci',
    role: 'Chargée d’affaires',
    shortRole: 'Affaires',
    tint: 't5',
  },
  {
    id: 'guillaume',
    name: 'Guillaume Debailly',
    role: 'DSI · administrateur de l’instance',
    shortRole: 'DSI',
    tint: 't6',
  },
]

export const DEMO_CHANNELS: readonly DemoChannel[] = [
  { id: 'general', name: '#général' },
  { id: 'annonces', name: '#annonces' },
  { id: 'chantier-a13', name: '#chantier-a13', unread: 3 },
  { id: 'securite-qse', name: '#sécurité-qse', unread: 1 },
  { id: 'bureau-etudes', name: '#bureau-études' },
  { id: 'appels-offres', name: '#appels-offres' },
  { id: 'sous-traitants', name: '#sous-traitants' },
]

/** The channel whose conversation the preview actually carries. Every other
 * channel in the list above renders the honest empty state rather than
 * invented content. */
export const DEMO_SEEDED_CHANNEL_ID = 'chantier-a13'

/**
 * Permanent audio and video rooms — the part of the suite that is not a
 * meeting you schedule. They are open continuously; people come and go.
 */
export const DEMO_ROOMS: readonly DemoRoom[] = [
  {
    id: 'conduite',
    name: 'Conduite de travaux',
    kind: 'audio',
    capacity: 8,
    occupants: [
      { personId: 'sylvain', state: 'speaking' },
      { personId: 'paul', state: 'listening' },
      { personId: 'guillaume', state: 'muted' },
    ],
  },
  {
    id: 'plans',
    name: 'Bureau d’études — plans',
    kind: 'screen',
    capacity: 6,
    occupants: [
      { personId: 'henri', state: 'sharing' },
      { personId: 'ines', state: 'listening' },
    ],
  },
  {
    id: 'vercelli',
    name: 'Salon Vercelli',
    kind: 'video',
    capacity: 20,
    occupants: [],
  },
  {
    id: 'qse',
    name: 'Permanence QSE',
    kind: 'audio',
    capacity: 6,
    occupants: [{ personId: 'nadia', state: 'available' }],
  },
  {
    id: 'silencieux',
    name: 'Bureau silencieux',
    kind: 'audio',
    capacity: 12,
    occupants: [],
  },
]

export const DEMO_MESSAGES: readonly DemoMessage[] = [
  {
    id: 'm1',
    personId: 'sylvain',
    at: '2026-09-08T06:52:00+02:00',
    text: 'Coulage de la dalle R+2 maintenu ce matin : la pompe arrive à 7 h 30, première toupie à 7 h 45. Trois toupies suivantes espacées de 25 min.',
  },
  {
    id: 'm2',
    personId: 'paul',
    at: '2026-09-08T07:04:00+02:00',
    text: 'Reçu. Grue mobilisée pour les banches à partir de 10 h, la zone de stockage est dégagée côté nord.',
  },
  {
    id: 'm3',
    personId: 'nadia',
    at: '2026-09-08T07:31:00+02:00',
    text: 'Rappel : nacelle interdite au-delà de 60 km/h de rafales. Météo annonce 45 km/h vers 15 h, on reste sous le seuil mais je passe faire un point à 14 h.',
  },
  {
    id: 'm4',
    personId: 'henri',
    at: '2026-09-08T08:12:00+02:00',
    text: 'Plan de ferraillage modifié hier soir : l’about de poutre P12 passe en HA16. Version 6 déposée, l’ancienne est archivée.',
  },
  {
    id: 'm5',
    personId: 'ines',
    at: '2026-09-08T09:20:00+02:00',
    text: 'La MOE demande un compte rendu photo hebdomadaire. Je propose de le générer depuis l’album partagé du chantier plutôt que par mail.',
  },
]

/** The six people above, in the order the mock's member list shows them.
 * The count the surface prints is this list's own length, never a number
 * written beside it that nothing keeps true. */
export const DEMO_MEMBERS: readonly DemoPerson[] = DEMO_PEOPLE

export function demoChannel(channelId: string): DemoChannel {
  const channel = DEMO_CHANNELS.find((candidate) => candidate.id === channelId)
  if (channel === undefined) {
    throw new Error(`demo fixture: unknown channel "${channelId}"`)
  }
  return channel
}

export function demoPerson(personId: string): DemoPerson {
  const person = DEMO_PEOPLE.find((candidate) => candidate.id === personId)
  if (person === undefined) {
    // A fixture that references a person it does not define would otherwise
    // render a blank avatar and no name, which reads as a styling bug rather
    // than as the data mistake it is.
    throw new Error(`demo fixture: unknown person "${personId}"`)
  }
  return person
}
