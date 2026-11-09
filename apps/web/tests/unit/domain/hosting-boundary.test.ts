// @vitest-environment node
//
// docs/specs/domain-addresses-list.md, "One module for what depends on how an
// instance is hosted". A second hosting model and a change of provider are
// being studied, so the Domain area must be able to follow either by changing
// ONE file. Two rules make that true, and neither fails on its own when it is
// broken — the screen keeps working, with a fact in the wrong place:
//
//   1. no file of the area, of its fixtures, of its overlays or of its
//      end-to-end spec writes an IP address, a host name of ours, a hosting
//      provider's name or a place. They reach the screen from the Core API;
//   2. the contract fields that describe DNS records and the hosting of an
//      instance are named in `src/features/domain/hosting.ts` and in no other
//      source file of the area.
//
// The list of providers and places cannot be complete. It holds the ones the
// product's own documents and catalogues already name — the ones a copy-paste
// would bring — and it is proven below to refuse each kind.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOSTING_MODULE,
  fieldLeaks,
  hostingFieldsNamedIn,
  literalLeaks,
  type SourceFile,
} from './hostingBoundary'

const ROOT = join(import.meta.dirname, '..', '..', '..')

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function read(path: string): SourceFile {
  return { path: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }
}

const FEATURE = walk(join(ROOT, 'src', 'features', 'domain')).map(read)
const OVERLAYS = readdirSync(join(ROOT, 'src', 'mocks', 'overlays'))
  .filter((name) => /^domain\.[a-z0-9-]+\.ts$/.test(name))
  .map((name) => read(join(ROOT, 'src', 'mocks', 'overlays', name)))
const FIXTURES = [read(join(ROOT, 'src', 'mocks', 'fixtures', 'domainFixtures.ts'))]
const END_TO_END = [read(join(ROOT, 'tests', 'e2e', '04-domain.spec.ts'))]
const AREA = [...FEATURE, ...OVERLAYS, ...FIXTURES, ...END_TO_END]

describe('the Domain area and how an instance is hosted', () => {
  it('judges the files of the area, not an empty list', () => {
    // Floors, at what the first slice measured: a walk that stopped finding
    // files would pass every rule below by judging nothing.
    expect(FEATURE.length).toBeGreaterThanOrEqual(15)
    expect(OVERLAYS.length).toBeGreaterThanOrEqual(4)
    expect(AREA.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        HOSTING_MODULE,
        'src/features/domain/AddressList.tsx',
        'src/features/domain/responseValidation.ts',
        'src/mocks/overlays/domain.none.ts',
        'src/mocks/fixtures/domainFixtures.ts',
        'tests/e2e/04-domain.spec.ts',
      ])
    )
    expect(AREA.every((file) => file.text.length > 0)).toBe(true)
  })

  it('writes no IP address, no host name of ours, no provider and no place', () => {
    expect(literalLeaks(AREA)).toEqual([])
  })

  it('names the fields that describe records and hosting in one module only', () => {
    expect(fieldLeaks(AREA)).toEqual([])
  })

  it('does name them in that module: the rule is about something', () => {
    const hosting = AREA.find((file) => file.path === HOSTING_MODULE) as SourceFile
    expect(hostingFieldsNamedIn(hosting).join('\n')).toContain('default_urls')
  })
})

describe('the check can fail', () => {
  const planted = (path: string, line: string): SourceFile[] => [
    { path, text: `// first line\nexport const value = 1\n${line}\n` },
  ]
  const SCREEN = 'src/features/domain/AddressList.tsx'

  it.each([
    [
      'an address of ours, written in a screen',
      planted(SCREEN, "const FALLBACK = 'acme.visio.kodera.io'"),
      [`${SCREEN}:3: a host name of ours (kodera.io)`],
    ],
    [
      'an address under the product’s own name, in a fixture',
      planted('src/mocks/fixtures/domainFixtures.ts', "const TARGET = 'edge.Kodera.io.'"),
      ['src/mocks/fixtures/domainFixtures.ts:3: a host name of ours (Kodera.io)'],
    ],
    [
      'an IPv4 address',
      planted(SCREEN, "const MEDIA = '51.159.0.12'"),
      [`${SCREEN}:3: an IP address (51.159.0.12)`],
    ],
    [
      'an IPv6 address',
      planted(SCREEN, "const EDGE = '2001:bc8:710:4a69::1'"),
      [`${SCREEN}:3: an IP address (2001:bc8:710:4a69::1)`],
    ],
    [
      'an IPv6 address starting with compression',
      planted(SCREEN, "const EDGE = '::abcd'"),
      [`${SCREEN}:3: an IP address (::abcd)`],
    ],
    [
      'an IPv6 loopback literal',
      planted(SCREEN, "const EDGE = '::1'"),
      [`${SCREEN}:3: an IP address (::1)`],
    ],
    [
      'an IPv4-mapped compressed IPv6 literal',
      planted(SCREEN, "const EDGE = '::ffff:339f:c'"),
      [`${SCREEN}:3: an IP address (::ffff:339f:c)`],
    ],
    [
      'a compressed IPv6 address ending a comment sentence',
      planted(SCREEN, '// target ::abcd.'),
      [`${SCREEN}:3: an IP address (::abcd)`],
    ],
    [
      'a full IPv6 address ending a comment sentence',
      planted(SCREEN, '// target 2001:bc8:710:4a69::1.'),
      [`${SCREEN}:3: an IP address (2001:bc8:710:4a69::1)`],
    ],
    [
      'an IPv4-embedded IPv6 address ending a comment sentence',
      planted(SCREEN, '// target ::ffff:51.159.0.12.'),
      [
        `${SCREEN}:3: an IP address (51.159.0.12)`,
        `${SCREEN}:3: an IP address (::ffff:51.159.0.12)`,
      ],
    ],
    [
      'a provider, in a comment',
      planted('src/mocks/overlays/domain.none.ts', '// the retained address at Scaleway'),
      ['src/mocks/overlays/domain.none.ts:3: the name of a hosting provider (Scaleway)'],
    ],
    [
      'a place, in the end-to-end spec',
      planted('tests/e2e/04-domain.spec.ts', "await expect(page.getByText('hébergé à Paris'))"),
      ['tests/e2e/04-domain.spec.ts:3: a place (Paris)'],
    ],
    [
      'a region code',
      planted(SCREEN, "if (tenant.region === 'fr-par') return null"),
      [`${SCREEN}:3: a place (fr-par)`],
    ],
  ])('refuses %s', (_name, files, expected) => {
    expect(literalLeaks(files)).toEqual(expected)
  })

  it.each([
    [
      'the provided addresses read in a screen',
      planted(SCREEN, 'const urls = tenant.default_urls'),
      [`${SCREEN}:3: default_urls`],
    ],
    [
      'a record read in the queries',
      planted(
        'src/features/domain/queries.ts',
        'return domain.target.record_type + domain.target.record_value'
      ),
      [
        'src/features/domain/queries.ts:3: record_type',
        'src/features/domain/queries.ts:3: record_value',
      ],
    ],
    [
      'a rule about a bare domain decided in a screen',
      planted(SCREEN, "const warn = domain.kind === 'apex'"),
      [`${SCREEN}:3: 'apex'`],
    ],
    [
      'the purpose of an address compared outside the module',
      planted('src/features/domain/DomainScreen.tsx', 'if (row.purpose === "media") return null'),
      ['src/features/domain/DomainScreen.tsx:3: "media"'],
    ],
  ])('refuses %s', (_name, files, expected) => {
    expect(fieldLeaks(files)).toEqual(expected)
  })

  it('refuses a real screen of the area once a hosting field is read in it', () => {
    const screen = AREA.find((file) => file.path === SCREEN) as SourceFile
    const lines = screen.text.split('\n').length
    const mutated = { ...screen, text: `${screen.text}const ttl = record.ttl_s\n` }
    expect(fieldLeaks(AREA.map((file) => (file === screen ? mutated : file)))).toEqual([
      `${SCREEN}:${String(lines)}: ttl_s`,
    ])
  })

  it('lets through what is not a statement about hosting', () => {
    // Over-strict is a defect too: each of these is in the area today.
    expect(
      literalLeaks(
        planted(
          'src/mocks/fixtures/domainFixtures.ts',
          [
            "record_value: '203.0.113.20', // a documentation address",
            "const other = '2001:db8::1'",
            '// documentation example 2001:db8::1.',
            "issued_at: '2026-12-03T09:40:00Z'",
            "baseDomain('visio.acme.fr')",
            '// assertions on the rendered French',
            "id: 'b3c4d5e6-f708-491a-8b2c-000000000001'",
          ].join('\n')
        )
      )
    ).toEqual([])
    // The one module and the tests may name the fields.
    expect(
      fieldLeaks([
        ...planted(HOSTING_MODULE, 'const urls = tenant.default_urls'),
        ...planted('src/features/domain/hosting.test.ts', "role: 'media', record_type: 'A'"),
        ...planted('src/mocks/fixtures/domainFixtures.ts', "record_type: 'A'"),
      ])
    ).toEqual([])
  })
})
