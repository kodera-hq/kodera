#!/usr/bin/env node
// Writes the v1 smoke's input file (tests/smoke/README.md) from the journey.json that Core's
// live end-to-end stack renders (kodera-core dev/e2e, `make_trust render`). TEST ONLY: every
// value in journey.json is derived from a public label. The output is written 0600 and never
// printed, so no password reaches a terminal or a log.
//
//   node scripts/smoke-input-from-journey.mjs <journey.json> <smoke-input.json> [--claim-by-mail]
//
// Without --claim-by-mail the organisation is taken as already claimed (`python -m
// dev.e2e.journey` consumes the claim through the API), and E1 proves the owner's sign-in only.
// When `invitee.json` sits beside journey.json (`python -m dev.e2e.invitations --until set-up`),
// its invitee is the input's member, whose pending invitation E2 accepts.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const claimByMail = args.includes('--claim-by-mail')
const [from, to, ...rest] = args.filter((arg) => arg !== '--claim-by-mail')
if (!from || !to || rest.length > 0) {
  console.error('usage: smoke-input-from-journey.mjs <journey.json> <out.json> [--claim-by-mail]')
  process.exit(2)
}

const journey = JSON.parse(readFileSync(from, 'utf8'))
const fail = (message) => {
  console.error(`${from}: ${message}`)
  process.exit(1)
}

const owner = journey.accounts?.owner
if (!owner) fail('no accounts.owner')
// Template owner mode leaves the account credential-free until the journey's binding step,
// then presets these.
const credentials = owner.password ? owner : owner.after_binding
if (!credentials?.password || !credentials?.totp_base32) fail('the owner has no credentials')
const organisation = journey.organisation?.slug
if (!organisation) fail('no organisation.slug')
if (claimByMail && !journey.mailpit_origin) fail('a claim by mail needs mailpit_origin')

const inviteePath = join(dirname(from), 'invitee.json')
// `render` rewrites journey.json and leaves an earlier bring-up's invitee.json in place: an
// invitee older than the journey belongs to a stack that is gone, and its sign-in to no realm.
// journey.json names no organisation id to bind it to (Core assigns one at intake), so its age is
// the check, and a stale one stops here rather than reach E2 as someone else's account.
if (existsSync(inviteePath) && statSync(inviteePath).mtimeMs < statSync(from).mtimeMs)
  fail(
    'invitee.json predates journey.json: run `dev.e2e.invitations --until set-up` on this bring-up, or remove it'
  )
const invitee = existsSync(inviteePath) ? JSON.parse(readFileSync(inviteePath, 'utf8')) : undefined
if (invitee && (!invitee.email || !invitee.password || !invitee.totp_base32))
  fail('invitee.json has no complete sign-in')
if (invitee && invitee.realm !== organisation) fail('invitee.json names another realm')

const input = {
  organisation,
  owner: {
    username: owner.username,
    email: owner.email,
    password: credentials.password,
    totpBase32: credentials.totp_base32,
  },
  ...(invitee
    ? {
        member: {
          // The realm worker names the invitee's account by its address.
          username: invitee.email,
          email: invitee.email,
          password: invitee.password,
          totpBase32: invitee.totp_base32,
        },
      }
    : {}),
  ...(journey.mailpit_origin ? { mailpit: journey.mailpit_origin } : {}),
  ...(claimByMail ? { claim: 'mail' } : {}),
}
writeFileSync(to, JSON.stringify(input, null, 2) + '\n', { mode: 0o600 })
// `mode` applies only when the file is created: an existing file is narrowed here too.
chmodSync(to, 0o600)
console.log(
  `${to}: ${organisation}, owner ${owner.username}${invitee ? ', member' : ''}${claimByMail ? ', claim by mail' : ''}`
)
if (journey.console_origin) console.log(`SMOKE_BASE_URL=${journey.console_origin}`)
