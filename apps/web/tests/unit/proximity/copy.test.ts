// The words of the proximity channel: an everyday, voluntary, pseudonymous presence check-in.
//
// The panel is not an emergency service and must not read like one. Two rules, held on both
// catalogues (`src/i18n/{fr,en}.json`, generated from `docs/specs/copy/{fr,en}.md`):
//
//   1. no string that words the check-in (its statuses, its actions, its hints, the template's
//      name, the tour's line about the channel) uses the vocabulary of an alarm: emergency,
//      crisis, evacuation, safety, assistance, assembly point, report;
//   2. the strings that do speak of emergencies say only that this is not one: the panel's notice
//      says it is not an emergency service and does not replace emergency numbers.
//
// The frame's status values are frozen on the wire (`SafetyStatus`); only their labels are
// reworded. « Sur place / Here » and « Point de rencontre / Meeting point » are the landing
// site's words. For the third value the landing site proposes « Disponible / Available »; this
// catalogue does not take it, because the value means a request for help on every platform that
// reads the frame (it is relayed first, and the native apps label it as a need): « Disponible »
// would make one frame read as an offer here and as a request there. It says « Besoin d’un coup
// de main / Could use a hand » instead: the same meaning, in everyday words.
//
// The mutants at the end each break one rule in a copy of the catalogue; the check must refuse
// each by the key at fault.

import { describe, expect, it } from 'vitest'
import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'

type Catalogue = Readonly<Record<string, string>>

/** The strings that word the check-in itself. */
function wordsTheCheckIn(key: string): boolean {
  return (
    key.startsWith('console.workspace.proximity.') ||
    key.startsWith('console.onboarding.tour.proximity-') ||
    key === 'console.onboarding.tour.channels-subtitle' ||
    key === 'console.onboarding.studio.proximity' ||
    key === 'console.onboarding.studio.channel-proximity' ||
    key === 'console.workspace.channel.proximity'
  )
}

/** The only strings that may speak of emergencies, and what each must say when it does. */
const DISCLAIMERS: Readonly<Record<string, readonly RegExp[]>> = {
  'console.workspace.proximity.notice': [
    /pas un service d’urgence|not an emergency service/,
    /ne remplace pas les numéros d’urgence|does not replace emergency numbers/,
  ],
  'console.onboarding.tour.proximity-description': [
    /pas un service d’urgence|not an emergency service/,
  ],
}

const ALARM =
  /urgen|emergenc|crise|crisis|évacu|evacuat|alerte|alert|alarm|sécurité|safety|\bsafe\b|assistance|rassembl|assembly|muster|signalement|secours|rescue|danger|sinistre|incident|\bsos\b/i

/** Why a catalogue's proximity copy reads as an alarm, one sentence per key at fault; or []. */
function alarmWording(catalogue: Catalogue): string[] {
  const found: string[] = []
  for (const [key, mustSay] of Object.entries(DISCLAIMERS)) {
    const text = catalogue[key]
    if (text === undefined) {
      found.push(`${key} is missing: the panel no longer says it is not an emergency service`)
      continue
    }
    for (const sentence of mustSay)
      if (!sentence.test(text))
        found.push(`${key} speaks of emergencies without saying ${String(sentence)}: « ${text} »`)
  }
  for (const [key, text] of Object.entries(catalogue)) {
    if (!wordsTheCheckIn(key) || Object.hasOwn(DISCLAIMERS, key)) continue
    const word = ALARM.exec(text)?.[0]
    if (word !== undefined)
      found.push(`${key} words a presence check-in as an alarm (« ${word} »): « ${text} »`)
  }
  return found
}

describe('the proximity copy is an everyday presence check-in', () => {
  it.each([
    ['fr', fr],
    ['en', en],
  ] as const)(
    'uses no alarm wording, and says it is not an emergency service (%s)',
    (_, catalogue) => {
      expect(alarmWording(catalogue)).toEqual([])
    }
  )

  it('checks a real set of strings, not an empty one', () => {
    const checked = Object.keys(fr).filter(wordsTheCheckIn)
    expect(checked.length).toBeGreaterThanOrEqual(24)
    expect(Object.keys(en).filter(wordsTheCheckIn)).toEqual(checked)
  })

  it('labels the three statuses for presence, in both languages', () => {
    expect([
      fr['console.workspace.proximity.status-safe'],
      fr['console.workspace.proximity.status-assistance'],
      fr['console.workspace.proximity.status-muster'],
    ]).toEqual(['Sur place', 'Besoin d’un coup de main', 'Point de rencontre'])
    expect([
      en['console.workspace.proximity.status-safe'],
      en['console.workspace.proximity.status-assistance'],
      en['console.workspace.proximity.status-muster'],
    ]).toEqual(['Here', 'Could use a hand', 'Meeting point'])
  })

  it('does not word a request for help as an offer of help', () => {
    for (const catalogue of [fr, en])
      expect(catalogue['console.workspace.proximity.status-assistance']).not.toMatch(
        /disponible|available/i
      )
  })

  it('says the check-in is voluntary and shown under a pseudonym, dedicated or generated', () => {
    expect(fr['console.workspace.proximity.pseudonym-hint']).toMatch(
      /volontaire.*pseudonyme, dédié ou généré/
    )
    expect(en['console.workspace.proximity.pseudonym-hint']).toMatch(
      /voluntary.*pseudonym, dedicated or generated/
    )
  })

  it('names the channel « proximité » and « proximity », and keeps no key of the old area', () => {
    expect(fr['console.workspace.channel.proximity']).toBe('proximité')
    expect(en['console.workspace.channel.proximity']).toBe('proximity')
    expect(fr['console.onboarding.tour.proximity-label']).toBe('#proximité')
    expect(en['console.onboarding.tour.proximity-label']).toBe('#proximity')
    for (const catalogue of [fr, en]) {
      expect(Object.keys(catalogue).filter((key) => /\.emergency\.|\.crisis$/.test(key))).toEqual(
        []
      )
    }
  })
})

/**
 * Each mutant rewrites one string the way it read before, or removes the notice. The value is
 * the key the check must name when it refuses the catalogue.
 */
const MUTANTS: Readonly<Record<string, { key: string; text: string | undefined }>> = {
  'status-worded-as-a-need-for-assistance': {
    key: 'console.workspace.proximity.status-assistance',
    text: 'Besoin d’assistance',
  },
  'status-worded-as-safety': {
    key: 'console.workspace.proximity.status-safe',
    text: 'En sécurité',
  },
  'placeholder-worded-as-an-evacuation': {
    key: 'console.workspace.proximity.message-placeholder',
    text: 'Ex. Étage 2 évacué',
  },
  'template-named-a-crisis-cell': {
    key: 'console.onboarding.studio.proximity',
    text: 'Cellule de crise',
  },
  'notice-that-claims-an-emergency-service': {
    key: 'console.workspace.proximity.notice',
    text: 'Service d’urgence de proximité.',
  },
  'notice-silent-on-emergency-numbers': {
    key: 'console.workspace.proximity.notice',
    text: 'Ceci n’est pas un service d’urgence.',
  },
  'notice-removed': { key: 'console.workspace.proximity.notice', text: undefined },
}

describe('refusal: a catalogue that words the check-in as an alarm', () => {
  it.each(Object.entries(MUTANTS))('mutant %s is refused by its key', (_, mutant) => {
    const mutated: Record<string, string> = { ...fr }
    if (mutant.text === undefined) delete mutated[mutant.key]
    else mutated[mutant.key] = mutant.text
    const found = alarmWording(mutated)
    expect(found).not.toEqual([])
    expect(found.every((sentence) => sentence.startsWith(`${mutant.key} `))).toBe(true)
  })
})
