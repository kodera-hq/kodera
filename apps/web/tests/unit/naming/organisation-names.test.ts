// No organisation outside Kodera is named in the product without a review.
//
// The console once named two outside organisations: in the community's partner rooms, in the
// example addresses of the invitation dialog, and in the name it gave a document product. None
// had agreed to it. This guard does not hold a list of names to refuse, and never writes one: it
// holds the lists of what MAY be written, and names whatever is outside them.
//
// Three places are read (the message catalogues, the community structure with its descriptions
// and demo messages, and the extension catalogue), with three rules:
//
//   1. STRUCTURE. Every word of an identifier (a community category or room, its description
//      key, an extension's id, slug and command) is a purpose word of `structure-vocabulary.txt`.
//      A room named after anyone is outside it, however it is spelt. This is the server's rule
//      (`apps/server/tests/test_community_layout.py`), with the same two partner rooms.
//   2. NAMES. In prose, every word written as a name (a capital inside a sentence, an acronym, a
//      camel-case identifier) is in `allowed-names.txt`: the products and standards the console
//      is entitled to name, and the ordinary words its title-case labels capitalise.
//   3. HOSTS. Every host a string shows (a domain, a Matrix server, a link) ends with a suffix
//      of `allowed-hosts.txt`: Kodera's own, reserved example domains, and a few services the
//      console links to.
//
// A failure names the word and the string that holds it. To add a name, add it to the list, in
// review: that is the point at which someone asks whether its owner agreed.
//
// What this does not see: an organisation's name written exactly like an ordinary word, in lower
// case or as the first word of a sentence, inside prose. Rules 1 and 3 cover the identifiers and
// addresses where lower case is the norm; in prose a name is written as one.
//
// The mutants at the end put a stand-in organisation back in each place; every one must be
// refused, by name.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_CATEGORIES } from '@/features/docs/communityStructure'
import { developerDocsMessages } from '@/features/docs/developerDocsMessages'
import {
  EXTENSION_CATEGORY_FILTERS,
  OFFICIAL_EXTENSIONS_CATALOG,
} from '@/features/extensions/catalog'
import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'
import { workspaceDemoMessages } from '@/mocks/demo/workspaceMessages'

function list(name: string): ReadonlySet<string> {
  return new Set(
    readFileSync(join(import.meta.dirname, name), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  )
}

const STRUCTURE_VOCABULARY = list('structure-vocabulary.txt')
const ALLOWED_NAMES = list('allowed-names.txt')
const ALLOWED_HOSTS = list('allowed-hosts.txt')
/** The two partner rooms, as the server provisions them. */
const PARTNER_ROOMS = ['partner-onboarding', 'partner-feedback']

/** A string and where it was read, for the sentence that reports it. */
type Entry = readonly [where: string, text: string]

// --- rule 1: identifiers are made of purpose words ---------------------------------------------

/** The words of an identifier: split at anything that is not a letter or digit, and at humps. */
function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
}

function structureViolations(
  entries: readonly Entry[],
  vocabulary: ReadonlySet<string> = STRUCTURE_VOCABULARY
): string[] {
  return entries.flatMap(([where, identifier]) =>
    identifierWords(identifier)
      .filter((word) => !vocabulary.has(word))
      .map(
        (word) =>
          `${where} is named « ${identifier} »: « ${word} » is not a purpose word, and no organisation outside Kodera is named in the product`
      )
  )
}

interface Category {
  readonly id: string
  readonly name: string
  readonly audience: string
  readonly channels: readonly {
    readonly id: string
    readonly name: string
    readonly description: string
  }[]
}

/** The structure, read as plain categories: the mutants below rename a room in a copy. */
const COMMUNITY: readonly Category[] = COMMUNITY_CATEGORIES

function communityIdentifiers(categories: readonly Category[]): Entry[] {
  return categories.flatMap((category) => [
    [`community category ${category.id}`, category.id] as const,
    [`community category ${category.id} (name)`, category.name] as const,
    [`community category ${category.id} (audience)`, category.audience] as const,
    ...category.channels.flatMap((channel) => [
      [`community room ${channel.id}`, channel.id] as const,
      [`community room ${channel.id} (name)`, channel.name] as const,
      [`community room ${channel.id} (description key)`, channel.description] as const,
    ]),
  ])
}

type Extension = (typeof OFFICIAL_EXTENSIONS_CATALOG)[number]

function extensionIdentifiers(extensions: readonly Extension[]): Entry[] {
  return extensions.flatMap((extension) => [
    [`extension ${extension.slug} (id)`, extension.id] as const,
    [`extension ${extension.slug} (slug)`, extension.slug] as const,
    [`extension ${extension.slug} (command)`, extension.slashCommand] as const,
    ...extension.commands.flatMap((command) => [
      [`extension ${extension.slug} (command name)`, command.name] as const,
      [`extension ${extension.slug} (command)`, command.slashCommand] as const,
    ]),
  ])
}

// --- rules 2 and 3: names and hosts in prose ---------------------------------------------------

const HOST = /(?<![\p{L}\p{N}._-])(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2}[a-z0-9-]*(?![\p{L}\p{N}-])/giu
/** A file's name is written like a host, and is not one. */
const FILE = /\.(?:csv|json|txt)$/
const INTERPOLATION = /\{\{[^}]*\}\}|\$\{[^}]*\}|<[^>]*>/g
const WORD = /\p{L}[\p{L}\p{N}]*/gu
/** After one of these, a capital only opens a sentence, a clause or a list item. */
const OPENS_A_SENTENCE = /(?:^|[.!?:;«“"([\]\n·•—–/|>#*-])$/u

/** The hosts a string shows, in lower case: not a file's name, nor the local part of an address. */
function hostsIn(text: string): string[] {
  const hosts: string[] = []
  for (const match of text.matchAll(HOST)) {
    const host = match[0].toLowerCase()
    const next = text[match.index + host.length]
    // `@first.last:server` and `first.last@domain`: the part before the separator names a person.
    const localPart = next === '@' || (next === ':' && text[match.index - 1] === '@')
    if (!FILE.test(host) && !localPart) hosts.push(host)
  }
  return hosts
}

function hostViolations(
  entries: readonly Entry[],
  allowed: ReadonlySet<string> = ALLOWED_HOSTS
): string[] {
  const found: string[] = []
  for (const [where, text] of entries)
    for (const host of hostsIn(text)) {
      const lower = host
      const known = [...allowed].some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))
      if (!known)
        found.push(
          `${where} shows the host « ${host} », which is not in allowed-hosts.txt: an example address uses a reserved example domain, never an organisation's own`
        )
    }
  return found
}

/** The words of a string that are written as names. */
function namesIn(text: string): string[] {
  const prose = text.replace(INTERPOLATION, ' ').replace(HOST, ' ')
  const names: string[] = []
  for (const match of prose.matchAll(WORD)) {
    const word = match[0]
    if (word.length < 2) continue
    const capitals = [...word].filter((letter) => letter !== letter.toLowerCase()).length
    if (capitals === 0) continue
    const before = prose.slice(0, match.index).trimEnd()
    const opensASentence = OPENS_A_SENTENCE.test(before)
    const capitalisedOnly = capitals === 1 && word[0] !== word[0]!.toLowerCase()
    if (capitalisedOnly && opensASentence) continue
    names.push(word)
  }
  return names
}

function nameViolations(
  entries: readonly Entry[],
  allowed: ReadonlySet<string> = ALLOWED_NAMES
): string[] {
  return entries.flatMap(([where, text]) =>
    namesIn(text)
      .filter((name) => !allowed.has(name))
      .map(
        (name) =>
          `${where} names « ${name} », which is not in allowed-names.txt: no organisation outside Kodera is named in the product without a review`
      )
  )
}

// --- what is read ------------------------------------------------------------------------------

function strings(value: unknown, where: string): Entry[] {
  if (typeof value === 'string') return [[where, value]]
  if (Array.isArray(value))
    return value.flatMap((item, index) => strings(item, `${where}[${index}]`))
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => strings(item, `${where}.${key}`))
  return []
}

const catalogueProse = (catalogue: Readonly<Record<string, string>>, language: string): Entry[] =>
  Object.entries(catalogue).map(([key, text]) => [`${language} catalogue, ${key}`, text] as const)

function extensionProse(extensions: readonly Extension[]): Entry[] {
  return [
    ...EXTENSION_CATEGORY_FILTERS.flatMap((filter) => [
      [`extension filter ${filter.id}`, filter.label] as const,
      [`extension filter ${filter.id} (en)`, filter.labelEn] as const,
    ]),
    ...extensions.flatMap((extension) => [
      [`extension ${extension.slug} (name)`, extension.name] as const,
      [`extension ${extension.slug} (name en)`, extension.nameEn] as const,
      [`extension ${extension.slug} (description)`, extension.description] as const,
      [`extension ${extension.slug} (description en)`, extension.descriptionEn] as const,
      [`extension ${extension.slug} (webhook example)`, extension.defaultWebhookExample] as const,
      ...extension.commands.flatMap((command) => [
        [`extension ${extension.slug} (command description)`, command.description] as const,
        [`extension ${extension.slug} (command description en)`, command.descriptionEn] as const,
        [`extension ${extension.slug} (command usage)`, command.usage] as const,
      ]),
    ]),
  ]
}

const PROSE: readonly Entry[] = [
  ...catalogueProse(fr, 'fr'),
  ...catalogueProse(en, 'en'),
  ...strings(developerDocsMessages, 'developer docs messages'),
  ...strings(workspaceDemoMessages, 'demo workspace messages'),
  ...extensionProse(OFFICIAL_EXTENSIONS_CATALOG),
]

const IDENTIFIERS: readonly Entry[] = [
  ...communityIdentifiers(COMMUNITY),
  ...Object.keys(workspaceDemoMessages.fr.community).map(
    (room) => [`demo messages of room ${room} (fr)`, room] as const
  ),
  ...Object.keys(workspaceDemoMessages.en.community).map(
    (room) => [`demo messages of room ${room} (en)`, room] as const
  ),
  ...extensionIdentifiers(OFFICIAL_EXTENSIONS_CATALOG),
]

describe('no outside organisation is named in the product', () => {
  it('names the community structure and the extensions for their purpose only', () => {
    expect(structureViolations(IDENTIFIERS)).toEqual([])
  })

  it('has the two partner rooms the server provisions, and describes each', () => {
    const partners = COMMUNITY.find((category) => category.id === 'design-partners')
    expect(partners?.channels.map((channel) => channel.name)).toEqual(PARTNER_ROOMS)
    expect(partners?.channels.map((channel) => channel.id)).toEqual(PARTNER_ROOMS)
    for (const language of ['fr', 'en'] as const) {
      const copy: Readonly<Record<string, unknown>> = developerDocsMessages[language]
      for (const channel of COMMUNITY.flatMap((category) => category.channels))
        expect(typeof copy[channel.description], `${language}: ${channel.description}`).toBe(
          'string'
        )
      expect(Object.keys(workspaceDemoMessages[language].community)).toEqual(
        expect.arrayContaining(PARTNER_ROOMS)
      )
    }
  })

  it('writes no name outside the reviewed list, in the catalogues, the community or the extensions', () => {
    expect(nameViolations(PROSE)).toEqual([])
  })

  it('shows no host outside the reviewed list', () => {
    expect(hostViolations(PROSE)).toEqual([])
  })

  it('reads real sources: both catalogues, every room and every extension', () => {
    expect(Object.keys(fr).length).toBeGreaterThan(1000)
    expect(Object.keys(en)).toEqual(Object.keys(fr))
    expect(COMMUNITY.flatMap((category) => category.channels)).toHaveLength(12)
    expect(OFFICIAL_EXTENSIONS_CATALOG).toHaveLength(22)
    expect(PROSE.length).toBeGreaterThan(3000)
    // The rules do find names and hosts in these sources: the lists are what lets them pass.
    expect(nameViolations(PROSE, new Set()).length).toBeGreaterThan(100)
    expect(hostViolations(PROSE, new Set()).length).toBeGreaterThan(10)
    expect(structureViolations(IDENTIFIERS, new Set()).length).toBeGreaterThan(50)
  })

  it('keeps the lists free of anything unused, so a withdrawn name leaves them too', () => {
    const written = new Set(PROSE.flatMap(([, text]) => namesIn(text)))
    expect([...ALLOWED_NAMES].filter((name) => !written.has(name))).toEqual([])
    const words = new Set(IDENTIFIERS.flatMap(([, identifier]) => identifierWords(identifier)))
    expect([...STRUCTURE_VOCABULARY].filter((word) => !words.has(word))).toEqual([])
    const hosts = PROSE.flatMap(([, text]) => hostsIn(text))
    expect(
      [...ALLOWED_HOSTS].filter(
        (suffix) => !hosts.some((host) => host === suffix || host.endsWith(`.${suffix}`))
      )
    ).toEqual([])
  })
})

/**
 * Each mutant puts a stand-in organisation back where one was once named. `found` is what the
 * guard reports for the mutated source; `names` is the word it must name.
 */
const withRoom = (id: string, description: string): Category[] =>
  COMMUNITY.map((category) =>
    category.id === 'design-partners'
      ? {
          ...category,
          channels: category.channels.map((channel, index) =>
            index === 0 ? { ...channel, id, name: id, description } : channel
          ),
        }
      : category
  )

const withExtension = (patch: Partial<Extension>): Extension[] => [
  { ...OFFICIAL_EXTENSIONS_CATALOG[0]!, ...patch },
  ...OFFICIAL_EXTENSIONS_CATALOG.slice(1),
]

const MUTANTS: Readonly<Record<string, { found: () => string[]; names: string }>> = {
  'a partner room named after an organisation': {
    found: () =>
      structureViolations(
        communityIdentifiers(withRoom('partner-examplecorp', 'partnerOnboarding'))
      ),
    names: 'examplecorp',
  },
  'a room description keyed by an organisation': {
    found: () =>
      structureViolations(
        communityIdentifiers(withRoom('partner-onboarding', 'partnerExamplecorp'))
      ),
    names: 'examplecorp',
  },
  'an extension slug named after an organisation': {
    found: () =>
      structureViolations(
        extensionIdentifiers(withExtension({ slug: 'examplecorp-docs-announcer' }))
      ),
    names: 'examplecorp',
  },
  'an organisation acronym in a catalogue string': {
    found: () =>
      nameViolations(
        catalogueProse(
          { ...fr, 'console.workspace.channel.topic': 'Boucle de retours privée EXCORP.' },
          'fr'
        )
      ),
    names: 'EXCORP',
  },
  'an organisation named mid-sentence in a room description': {
    found: () =>
      nameViolations(
        strings(
          {
            ...developerDocsMessages.en,
            partnerFeedback:
              'Private Examplecorp feedback loop, interoperable with standard Matrix clients.',
          },
          'developer docs messages.en'
        )
      ),
    names: 'Examplecorp',
  },
  'a product named after its maker in an extension description': {
    found: () =>
      nameViolations(
        extensionProse(
          withExtension({ description: 'Partage les documents collaboratifs EXCORP Docs.' })
        )
      ),
    names: 'EXCORP',
  },
  'a camel-case organisation name in a demo message': {
    found: () => nameViolations([['demo workspace messages', 'Bienvenue à l’équipe ExampleCorp.']]),
    names: 'ExampleCorp',
  },
  'an example address on an organisation’s own domain': {
    found: () =>
      hostViolations(
        catalogueProse(
          {
            ...fr,
            'console.workspace.channel-invite.id-help':
              'Par exemple : @prenom.nom:agent.examplecorp.gouv.fr ou @architecte:example.com',
          },
          'fr'
        )
      ),
    names: 'agent.examplecorp.gouv.fr',
  },
  'a webhook example on an organisation’s own domain': {
    found: () =>
      hostViolations(
        extensionProse(
          withExtension({ defaultWebhookExample: 'https://hooks.examplecorp.com/kodera' })
        )
      ),
    names: 'hooks.examplecorp.com',
  },
}

describe('refusal: an organisation named again', () => {
  it.each(Object.entries(MUTANTS))('mutant: %s is refused by name', (_, mutant) => {
    const found = mutant.found()
    // Refused, and for nothing else: every sentence names the stand-in.
    expect(found).not.toEqual([])
    for (const sentence of found) expect(sentence).toContain(`« ${mutant.names} »`)
  })

  it('refuses a name only because it is absent from the lists, not because it is listed here', () => {
    // The same stand-in, once listed, passes: the guard holds no deny-list at all.
    expect(nameViolations([['a string', 'Boucle privée EXCORP.']], new Set(['EXCORP']))).toEqual([])
    expect(
      structureViolations([['a room', 'partner-examplecorp']], new Set(['partner', 'examplecorp']))
    ).toEqual([])
    expect(
      hostViolations([['a string', '@a:hooks.examplecorp.com']], new Set(['examplecorp.com']))
    ).toEqual([])
  })
})
