// What one run of the v1 smoke is pointed at (tests/smoke/README.md). Read from the JSON file
// `SMOKE_INPUT` names, never from the command line, so no password reaches a shell history.
import { readFileSync } from 'node:fs'

export interface SmokeAccount {
  username: string
  email: string
  password: string
  /** Base32, what an authenticator app is given. */
  totpBase32: string
}

export interface SmokeInput {
  /** The organisation's slug, which is also its realm. */
  organisation: string
  owner: SmokeAccount
  /** A person invited into the organisation and set up, whose invitation is still pending: E2
   * accepts it through the Console. Absent: E2 is skipped, and says why. */
  member?: SmokeAccount
  /** A Mailpit API origin that receives the organisation's mail, where one exists. */
  mailpit?: string
  /** `mail`: the owner's claim is part of this run, its link read from Mailpit. Absent: the
   * organisation is already claimed, and E1 proves the owner's sign-in and role only. */
  claim?: 'mail'
}

/** The steps this spec knows: SMOKE_REQUIRE names only these, so a typo cannot require nothing. */
const STEPS = ['E1', 'E1b', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const

/** `SMOKE_REQUIRE=E2,E3`: the steps this run must prove. A required step whose input is missing
 * fails instead of being skipped, so a run meant to prove it cannot pass on « 1 skipped ». */
export function readRequired(): ReadonlySet<string> {
  const listed = (process.env['SMOKE_REQUIRE'] ?? '')
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step !== '')
  for (const step of listed)
    if (!(STEPS as readonly string[]).includes(step))
      throw new Error(`SMOKE_REQUIRE: ${step} is not a step (${STEPS.join(', ')})`)
  return new Set(listed)
}

function account(value: unknown, name: string): SmokeAccount {
  const record = value as Record<string, unknown> | null
  for (const field of ['username', 'email', 'password', 'totpBase32'])
    if (typeof record?.[field] !== 'string' || record[field] === '')
      throw new Error(`SMOKE_INPUT: ${name}.${field} is missing`)
  return record as unknown as SmokeAccount
}

export function readInput(): SmokeInput {
  const path = process.env['SMOKE_INPUT']
  if (!path) throw new Error('SMOKE_INPUT names no input file (tests/smoke/README.md)')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (typeof raw['organisation'] !== 'string')
    throw new Error('SMOKE_INPUT: organisation is missing')
  if (raw['claim'] !== undefined && raw['claim'] !== 'mail')
    throw new Error('SMOKE_INPUT: claim is "mail" or absent')
  if (raw['claim'] === 'mail' && typeof raw['mailpit'] !== 'string')
    throw new Error('SMOKE_INPUT: a claim read from mail needs mailpit')
  return {
    organisation: raw['organisation'],
    owner: account(raw['owner'], 'owner'),
    ...(raw['member'] === undefined ? {} : { member: account(raw['member'], 'member') }),
    ...(typeof raw['mailpit'] === 'string' ? { mailpit: raw['mailpit'] } : {}),
    ...(raw['claim'] === 'mail' ? { claim: 'mail' as const } : {}),
  }
}
