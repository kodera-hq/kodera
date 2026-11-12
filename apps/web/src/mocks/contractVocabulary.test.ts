// What contract 0.42.0 decided, read from the pinned document the mocks are generated from.
//
// Three decisions live in the contract's schemas and prose, where nothing generated carries
// them: which facts of a colleague the People directory withholds, that `crisis-cell` stays a
// permanent alias of `proximity`, and which five theme identifiers exist. Each check below is
// run against the pinned contract and then against isolated in-memory mutations of it, so a
// later edit that drops one of the rules fails here by name rather than passing every
// byte-pin after a routine rebind.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { EXAMPLES } from './generated/examples'

type Json = Record<string, unknown>

const WEB_ROOT = join(import.meta.dirname, '..', '..')
const REPOSITORY_ROOT = join(WEB_ROOT, '..', '..')
const pinned = parse(
  readFileSync(join(WEB_ROOT, 'contracts', 'core-api.openapi.yaml'), 'utf8')
) as Json

function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

function object(value: unknown, reason = 'object required'): Json {
  requireThat(typeof value === 'object' && value !== null && !Array.isArray(value), reason)
  return value as Json
}

function list(value: unknown, reason: string): unknown[] {
  requireThat(Array.isArray(value), reason)
  return value
}

function schema(document: Json, name: string): Json {
  return object(object(object(document['components'])['schemas'])[name], `schema ${name}`)
}

function operation(document: Json, path: string, method: string): Json {
  return object(object(object(document['paths'])[path], path)[method], `${method} ${path}`)
}

/** Prose with its line breaks folded, so a re-wrapped paragraph still says what it said. */
function prose(value: unknown, reason: string): string {
  requireThat(typeof value === 'string', reason)
  return value.replace(/\s+/g, ' ')
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// --- directory privacy ------------------------------------------------------------------

const PRIVATE_MEMBER_FACTS = [
  'email',
  'identity_id',
  'account_kind',
  'mfa_enrolled',
  'last_seen_at',
]
const MEMBERSHIPS = '/organisations/{organisation_id}/memberships'
const MEMBERSHIP = `${MEMBERSHIPS}/{membership_id}`
const PRIVACY_RULE = {
  'five private member facts named':
    'private member facts: `email`, `identity_id`, `account_kind`, `mfa_enrolled` and `last_seen_at`',
  'both reads governed alike': 'On `listMemberships` and on `getMembership` alike',
  'own membership disclosed':
    'is the person the row describes (the caller reads their own membership)',
  'administrators disclosed': 'holds `org_owner` or `org_admin`',
  'withheld as omitted or null':
    '`email`, `identity_id` and `last_seen_at` are omitted or `null`, and `account_kind` and `mfa_enrolled`, which have no `null`, are omitted',
  'never masked or partial':
    'A withheld fact is never replaced by a placeholder, a masked value or a partial one',
  'row by row': 'The rule is applied row by row',
} as const

function checkDirectoryPrivacy(document: Json) {
  const membership = schema(document, 'Membership')
  const required = list(membership['required'], 'Membership required list')
  const properties = object(membership['properties'])
  for (const fact of PRIVATE_MEMBER_FACTS) {
    requireThat(fact in properties, `private fact ${fact} declared`)
    requireThat(!required.includes(fact), `private fact ${fact} optional`)
  }
  const email = object(properties['email'])
  requireThat(same(email['type'], ['string', 'null']), 'withheld email may be null')
  requireThat(email['format'] === 'email', 'disclosed email is an address')
  requireThat(
    same(object(properties['identity_id'])['type'], ['string', 'null']),
    'withheld identity may be null'
  )
  requireThat(required.includes('id') && required.includes('role'), 'directory facts required')
  const rule = prose(membership['description'], 'Membership description')
  for (const [reason, sentence] of Object.entries(PRIVACY_RULE)) {
    requireThat(rule.includes(sentence), reason)
  }

  const listing = operation(document, MEMBERSHIPS, 'get')
  requireThat(listing['operationId'] === 'listMemberships', 'listMemberships identity')
  requireThat(
    prose(listing['description'], 'listMemberships description').includes(
      'Directory privacy applies row by row'
    ),
    'listMemberships bound to directory privacy'
  )
  const detail = operation(document, MEMBERSHIP, 'get')
  requireThat(detail['operationId'] === 'getMembership', 'getMembership identity')
  requireThat(
    prose(detail['description'], 'getMembership description').includes(
      'Directory privacy applies exactly as on `listMemberships`'
    ),
    'getMembership bound to directory privacy'
  )
  // getMembership answers MembershipDetail, which must stay the same projection plus flags.
  const composed = list(schema(document, 'MembershipDetail')['allOf'], 'MembershipDetail allOf')
  requireThat(
    object(composed[0])['$ref'] === '#/components/schemas/Membership',
    'one projection for both reads'
  )
  requireThat(
    prose(
      operation(document, `${MEMBERSHIPS}/count`, 'get')['description'],
      'countMemberships description'
    ).includes('refuses it `forbidden` for every other caller'),
    'count cannot disclose a private fact'
  )
}

// --- proximity ---------------------------------------------------------------------------

const TEMPLATES = [
  'audiovisual-production',
  'tech-studio',
  'b2b-advisory',
  'public-sector',
  'proximity',
  'crisis-cell',
]
const HANDLE_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])'

function instantClaimMember(document: Json, name: string): Json {
  return object(object(schema(document, 'InstantClaimTenantRequest')['properties'])[name], name)
}

function checkProximity(document: Json) {
  requireThat(
    instantClaimMember(document, 'templateId')['$ref'] ===
      '#/components/schemas/WorkspaceTemplateId',
    'instant claim takes a WorkspaceTemplateId'
  )
  const template = schema(document, 'WorkspaceTemplateId')
  const identifiers = list(template['enum'], 'template identifiers')
  requireThat(identifiers.includes('proximity'), 'proximity is a template identifier')
  requireThat(identifiers.includes('crisis-cell'), 'crisis-cell stays accepted')
  requireThat(same(identifiers, TEMPLATES), 'template identifiers as decided')
  requireThat(
    identifiers.every((value) => typeof value === 'string' && /^[a-z0-9-]+$/.test(value)),
    'template identifiers are ASCII'
  )
  const rule = prose(template['description'], 'WorkspaceTemplateId description')
  requireThat(
    rule.includes('`crisis-cell` is a deprecated alias of `proximity`'),
    'alias documented'
  )
  requireThat(rule.includes('it is permanent'), 'alias permanent')
  requireThat(rule.includes('`#proximité` in French'), 'French label is display only')

  const handle = schema(document, 'ProximityCheckInHandle')
  requireThat(handle['type'] === 'string', 'handle is a string')
  requireThat(handle['minLength'] === 3 && handle['maxLength'] === 24, 'handle length bounded')
  requireThat(handle['pattern'] === HANDLE_PATTERN, 'handle charset bounded')
  const pattern = new RegExp(String(handle['pattern']))
  for (const accepted of ['heron-4821', 'abc', 'a-b-c'])
    requireThat(pattern.test(accepted), `handle accepts ${accepted}`)
  for (const refused of ['Heron', 'jean dupont', 'zoé', '-abc', 'abc-', 'a--b', 'a.b', 'abc\n'])
    requireThat(!pattern.test(refused), `handle refuses ${JSON.stringify(refused)}`)
  const reserved = prose(handle['description'], 'handle description')
  requireThat(
    reserved.startsWith('Reserved for the proximity check-in model'),
    'handle reserved for check-in'
  )
  requireThat(
    reserved.includes('never requires a real first or last name'),
    'no real name required'
  )

  const pseudonym = schema(document, 'ProximityCheckInPseudonym')
  requireThat(pseudonym['additionalProperties'] === false, 'pseudonym carries nothing else')
  requireThat(same(pseudonym['required'], ['handle', 'origin']), 'pseudonym members required')
  const members = object(pseudonym['properties'])
  requireThat(
    same(Object.keys(members), ['handle', 'origin']),
    'pseudonym holds no name or contact'
  )
  requireThat(
    object(members['handle'])['$ref'] === '#/components/schemas/ProximityCheckInHandle',
    'pseudonym handle constrained'
  )
  requireThat(
    same(object(members['origin'])['enum'], ['dedicated', 'generated']),
    'handle origin dedicated or generated'
  )
  requireThat(
    !JSON.stringify(document['paths']).includes('ProximityCheckIn'),
    'check-in seam adds no operation'
  )
}

// --- themes ------------------------------------------------------------------------------

const THEMES = ['light', 'dark', 'black', 'ciel', 'ciel-nuit']
const THEME_ALIASES = ['givre', 'ardoise', 'real-black']

function checkThemes(document: Json) {
  const theme = schema(document, 'ThemeId')
  requireThat(same(theme['enum'], THEMES), 'exactly the five theme identifiers')
  requireThat(theme['deprecated'] !== true, 'theme identifiers are current')
  const alias = schema(document, 'ThemeIdAlias')
  requireThat(same(alias['enum'], THEME_ALIASES), 'exactly the three legacy aliases')
  requireThat(alias['deprecated'] === true, 'aliases deprecated')
  const mapping = prose(alias['description'], 'ThemeIdAlias description')
  for (const row of [
    '| `givre` | `light` |',
    '| `ardoise` | `dark` |',
    '| `real-black` | `black` |',
  ])
    requireThat(mapping.includes(row), `alias mapping ${row}`)
  const member = instantClaimMember(document, 'themeId')
  requireThat(
    same(member['enum'], [...THEMES, ...THEME_ALIASES]),
    'instant claim accepts every theme and alias'
  )
  requireThat(
    same(member['anyOf'], [
      { $ref: '#/components/schemas/ThemeId' },
      { $ref: '#/components/schemas/ThemeIdAlias' },
    ]),
    'instant claim names both vocabularies'
  )
}

// --- byte parity ---------------------------------------------------------------------------

const CANONICAL = 'packages/api-contract'
const COPIES = ['apps/server/contracts', 'apps/web/contracts']
const CONTRACTS = ['core-api.openapi.yaml', 'agent-api.openapi.yaml']
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fromDisk = (path: string) => readFileSync(join(REPOSITORY_ROOT, path))

function checkParity(read: (path: string) => Buffer) {
  for (const name of CONTRACTS) {
    const canonical = digest(read(`${CANONICAL}/${name}`))
    for (const copy of COPIES)
      requireThat(digest(read(`${copy}/${name}`)) === canonical, `${copy}/${name} byte parity`)
  }
}

function refusal<Mutation extends string>(
  check: (document: Json) => void,
  mutate: (document: Json, mutation: Mutation) => void,
  mutation: Mutation
): string {
  check(pinned)
  const changed = structuredClone(pinned)
  mutate(changed, mutation)
  try {
    check(changed)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'accepted'
}

function rewrite(target: Json, key: string, before: string, after: string) {
  const text = String(target[key])
  requireThat(text.includes(before), `mutation site ${before}`)
  target[key] = text.replace(before, after)
}

describe('directory privacy in the pinned contract', () => {
  it('withholds the five private member facts on both reads, except from the person and administrators', () => {
    checkDirectoryPrivacy(pinned)
  })

  it('keeps the base mocks on the administrator projection, where the facts are disclosed', () => {
    const page = object(EXAMPLES['listMemberships'].body)
    const row = object(list(page['data'], 'listMemberships page')[0])
    expect(typeof row['email']).toBe('string')
    expect(typeof object(EXAMPLES['getMembership'].body)['email']).toBe('string')
  })

  const reasons = {
    'email-required': 'private fact email optional',
    'email-never-null': 'withheld email may be null',
    'fact-undeclared': 'private fact last_seen_at declared',
    'own-row-dropped': 'own membership disclosed',
    'administrators-dropped': 'administrators disclosed',
    'masking-allowed': 'never masked or partial',
    'list-unbound': 'listMemberships bound to directory privacy',
    'detail-unbound': 'getMembership bound to directory privacy',
    'detail-reprojected': 'one projection for both reads',
    'count-discloses': 'count cannot disclose a private fact',
  } as const
  type Mutation = keyof typeof reasons

  function mutate(document: Json, mutation: Mutation) {
    const membership = schema(document, 'Membership')
    const properties = object(membership['properties'])
    if (mutation === 'email-required')
      list(membership['required'], 'Membership required list').push('email')
    else if (mutation === 'email-never-null') object(properties['email'])['type'] = 'string'
    else if (mutation === 'fact-undeclared') delete properties['last_seen_at']
    else if (mutation === 'own-row-dropped')
      rewrite(membership, 'description', 'is the person the row describes', 'is a member')
    else if (mutation === 'administrators-dropped')
      rewrite(membership, 'description', 'holds `org_owner` or `org_admin`', 'holds any role')
    else if (mutation === 'masking-allowed')
      rewrite(membership, 'description', 'is never replaced by', 'may be replaced by')
    else if (mutation === 'list-unbound')
      rewrite(
        operation(document, MEMBERSHIPS, 'get'),
        'description',
        'Directory privacy',
        'Nothing'
      )
    else if (mutation === 'detail-unbound')
      rewrite(operation(document, MEMBERSHIP, 'get'), 'description', 'Directory privacy', 'Nothing')
    else if (mutation === 'detail-reprojected')
      object(list(schema(document, 'MembershipDetail')['allOf'], 'allOf')[0])['$ref'] =
        '#/components/schemas/Me'
    else
      rewrite(
        operation(document, `${MEMBERSHIPS}/count`, 'get'),
        'description',
        'refuses it `forbidden`',
        'answers it'
      )
  }

  it.each(Object.keys(reasons) as Mutation[])('refuses the isolated %s mutation', (mutation) => {
    expect(refusal(checkDirectoryPrivacy, mutate, mutation)).toBe(reasons[mutation])
  })
})

describe('proximity in the pinned contract', () => {
  it('names proximity, keeps crisis-cell as its permanent alias and reserves the check-in handle', () => {
    checkProximity(pinned)
  })

  const reasons = {
    'alias-removed': 'crisis-cell stays accepted',
    'canonical-removed': 'proximity is a template identifier',
    'accented-identifier': 'template identifiers as decided',
    'alias-undocumented': 'alias documented',
    'alias-temporary': 'alias permanent',
    'template-inlined': 'instant claim takes a WorkspaceTemplateId',
    'handle-unbounded': 'handle length bounded',
    'handle-any-characters': 'handle charset bounded',
    'pseudonym-carries-a-name': 'pseudonym holds no name or contact',
    'operation-invented': 'check-in seam adds no operation',
  } as const
  type Mutation = keyof typeof reasons

  function mutate(document: Json, mutation: Mutation) {
    const template = schema(document, 'WorkspaceTemplateId')
    const identifiers = list(template['enum'], 'template identifiers')
    if (mutation === 'alias-removed') identifiers.splice(identifiers.indexOf('crisis-cell'), 1)
    else if (mutation === 'canonical-removed')
      identifiers.splice(identifiers.indexOf('proximity'), 1)
    else if (mutation === 'accented-identifier') identifiers.push('proximité')
    else if (mutation === 'alias-undocumented')
      rewrite(template, 'description', 'is a deprecated alias of', 'is unrelated to')
    else if (mutation === 'alias-temporary')
      rewrite(template, 'description', 'it is permanent', 'it is removed in the next minor')
    else if (mutation === 'template-inlined')
      delete instantClaimMember(document, 'templateId')['$ref']
    else if (mutation === 'handle-unbounded')
      schema(document, 'ProximityCheckInHandle')['maxLength'] = 200
    else if (mutation === 'handle-any-characters')
      schema(document, 'ProximityCheckInHandle')['pattern'] = '^.+$'
    else if (mutation === 'pseudonym-carries-a-name')
      object(schema(document, 'ProximityCheckInPseudonym')['properties'])['display_name'] = {
        type: 'string',
      }
    else
      object(document['paths'])['/proximity/check-ins'] = {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProximityCheckInPseudonym' },
              },
            },
          },
        },
      }
  }

  it.each(Object.keys(reasons) as Mutation[])('refuses the isolated %s mutation', (mutation) => {
    expect(refusal(checkProximity, mutate, mutation)).toBe(reasons[mutation])
  })
})

describe('the theme vocabulary in the pinned contract', () => {
  it('is exactly light, dark, black, ciel and ciel-nuit, with the three legacy aliases still accepted', () => {
    checkThemes(pinned)
  })

  const reasons = {
    'legacy-kept-canonical': 'exactly the five theme identifiers',
    'theme-missing': 'exactly the five theme identifiers',
    'alias-dropped': 'exactly the three legacy aliases',
    'alias-not-deprecated': 'aliases deprecated',
    'alias-remapped': 'alias mapping | `givre` | `light` |',
    'request-narrowed': 'instant claim accepts every theme and alias',
    'request-unnamed': 'instant claim names both vocabularies',
  } as const
  type Mutation = keyof typeof reasons

  function mutate(document: Json, mutation: Mutation) {
    const theme = schema(document, 'ThemeId')
    const alias = schema(document, 'ThemeIdAlias')
    const member = instantClaimMember(document, 'themeId')
    if (mutation === 'legacy-kept-canonical') list(theme['enum'], 'themes').push('givre')
    else if (mutation === 'theme-missing') list(theme['enum'], 'themes').pop()
    else if (mutation === 'alias-dropped') list(alias['enum'], 'aliases').pop()
    else if (mutation === 'alias-not-deprecated') delete alias['deprecated']
    else if (mutation === 'alias-remapped')
      rewrite(alias, 'description', '| `givre` | `light` |', '| `givre` | `dark` |')
    else if (mutation === 'request-narrowed')
      member['enum'] = list(member['enum'], 'accepted themes').filter((id) => id !== 'real-black')
    else delete member['anyOf']
  }

  it.each(Object.keys(reasons) as Mutation[])('refuses the isolated %s mutation', (mutation) => {
    expect(refusal(checkThemes, mutate, mutation)).toBe(reasons[mutation])
  })
})

describe('the three workspace copies of each contract', () => {
  it('are byte-identical to the canonical file', () => {
    checkParity(fromDisk)
  })

  it.each(COPIES.flatMap((copy) => CONTRACTS.map((name) => `${copy}/${name}`)))(
    'refuse a one-byte drift of %s',
    (drifted) => {
      const read = (path: string) =>
        path === drifted ? Buffer.concat([fromDisk(path), Buffer.from('\n')]) : fromDisk(path)
      expect(() => checkParity(read)).toThrow(`${drifted} byte parity`)
    }
  )

  it('refuse a canonical file edited without its copies', () => {
    const read = (path: string) =>
      path === `${CANONICAL}/core-api.openapi.yaml`
        ? Buffer.concat([fromDisk(path), Buffer.from(' ')])
        : fromDisk(path)
    expect(() => checkParity(read)).toThrow(
      'apps/server/contracts/core-api.openapi.yaml byte parity'
    )
  })
})
