# Invitations

**Status:** Proposed · **Owner:** API seat

How an organisation's owners and admins bring a person in by email. This covers `listInvitations`,
`inviteToOrganisation`, `resendInvitation`, `revokeInvitation`, `previewInvitation` and
`acceptInvitation` of `contracts/core-api.openapi.yaml` (K11a/K11b). `previewInvitation` was added
in contract 0.37.0, for the Console's invitation card (§3, Preview); the five others are served as
the Console already calls them.

## 1. The flow

1. An owner or admin posts a batch of 1 to 500 rows. Each new address gets a pending invitation,
   valid for 14 days, and one *realm account delivery*.
2. The realm worker (`run_realm_deliveries`) finds the account holding that address in the
   organisation's realm. If there is none, it creates it, with the required actions
   `VERIFY_EMAIL`, `UPDATE_PASSWORD` and `CONFIGURE_TOTP`. While any action is pending, it has the
   realm mail the person a set-up link. It records the account's id.
3. The invitation mail run (`send_invitations`) enqueues the `invitation` template through the
   outbox. Its expiry reads in Paris time and the mail's language (« 7 novembre 2026 à 15 h 32 »),
   as the owner claim mail's does. Its link is the Console's acceptance page with the
   organisation's locator, like the owner claim link:
   `<KODERA_INVITATION_LINK>/<organisation id>/<slug>#<token>`. The Console discovers the realm
   from the slug before sign-in. Just above the link, it tells the person to open the realm's
   set-up mail (« Configurer votre compte Kodera ») first, with their phone ready for the one-time
   code; the owner claim mail says the same. `run_deliveries` sends it.
4. The person completes the set-up mail (verify, password, one-time code), opens the invitation
   link, and signs in to the realm. The Console posts the token to `previewInvitation` to show the
   card (who invited them, to which organisation, with which role, until when), then, when the
   person accepts, to `acceptInvitation`.
5. Core creates the person and their identity, then the `active` membership with the invited role.
   It marks the invitation `accepted`. `/me` lists the organisation from the next request.

So the invitee gets two mails: the realm's set-up mail and Core's invitation mail. Core never sees
a password or a second factor. The realm enforces both on every sign-in because they are required
actions.

## 2. The token

- The token has the form `inv1_<invitation id>_<43 URL-safe characters>`, 85 characters in all.
  The secret holds 32 random bytes.
- Core stores the SHA-256 of the secret, and the secret sealed under `KODERA_CONTACT_SEAL_KEY`
  with the invitation's id as context. The seal exists so that a resend can mail the same link.
  The API image seals; only the operator profile opens the seal.
- Comparison is constant time. A token that does not parse, names no invitation, belongs to
  another realm or does not match answers `404 not-found`, and never says which of these it was.
- **Single use:** acceptance moves the row to `accepted` in the same transaction that creates the
  membership. Any later use of the token is `404` or `409` (§3).
- **Expiry:** `expires_at = issued_at + 14 days`, both taken from the database clock. A database
  check bounds the lifetime. Every comparison reads the database clock. A pending row past its
  expiry reads `expired`. The next batch for the organisation writes the `expired` state and
  `invitation.expired`.

## 3. Operations

All six set `Cache-Control: no-store` and `X-Request-Id`. On the four management operations a
staff token gets `403`, recorded as `authz.denied`; on the preview and on acceptance it gets `404`
(below). A staff read or a staff revocation is declared by the contract but not served yet. The
batch, the resend and acceptance run once per `Idempotency-Key` through the replay store
([IDEMPOTENCY_REPLAY.md](IDEMPOTENCY_REPLAY.md)). The preview is a `POST` only so that the token
travels in a body rather than a URL: it writes nothing, takes no `Idempotency-Key`, stores no
response and ignores a key sent anyway.

| Operation | Caller | Answer |
|---|---|---|
| `GET /organisations/{id}/invitations` | `org_owner`, `org_admin` | `200` cursor page, newest first. `state` filters. The cursor is signed and bound to the organisation, the caller and the filter |
| `POST /organisations/{id}/invitations` | `org_owner`, `org_admin`, active organisation | `201` with one outcome per row, in order: `created`, `already_member`, `already_invited`, `invalid_email` |
| `POST /invitations/{id}/actions/resend` | same | `200 Invitation` with `sent_count + 1` |
| `DELETE /invitations/{id}` | same | `204`. Revoking a revoked invitation again also answers `204` |
| `POST /invitations/preview` | any signed-in realm user | `200 InvitationPreview`: the card, nothing written |
| `POST /invitations/accept` | any signed-in realm user | `200 Membership` with `source: invitation` |

**Batch rules**

- `org_owner` is never a value.
- An owner may grant `org_admin`, `org_billing` or `org_member`. An admin may grant `org_admin` or
  `org_member`. A row outside the caller's grant refuses the whole call with `403` before anything
  is written.
- Addresses are lower-cased. An address that is already an `invited`, `active` or `suspended`
  member is `already_member`. A pending one, including a repeat inside the same batch, is
  `already_invited`.
- An address of a person removed from this organisation is `failed`, with the detail `Removed
  from this organisation.`. No invitation is written. Their realm account stays disabled, and an
  invitation never turns an account on (§4): the realm's drift check would turn it off again
  anyway (MEMBERSHIP_LIFECYCLE.md §6.1). Bringing a removed person back is not served yet (§9).
- `send_email: false` writes the invitation with `sent_count` 0, so no mail is owed.
- `locale` (`fr` or `en`, default `fr`) picks the mail's language.
- A per-organisation advisory lock serialises batches.

**Resend and revoke** are held to the batch's grant: an admin cannot resend or revoke an
invitation to a role only an owner may grant (`org_billing`). That is `403`, recorded as
`authz.denied`, before the invitation's state is read.

**Resend:** only a pending, unexpired invitation can be resent. A revoked or expired one is
`410 invitation-revoked` or `410 invitation-expired`, and an accepted one is `409`. A resend
within 60 s of the last send is `429` with `Retry-After`. A resend owes one more invitation mail
with the same token, plus one more realm account delivery, which mails a fresh set-up link while
the account's actions are pending.

**Revoke:** only a pending, unexpired invitation can be revoked. An accepted or expired one is
`409`.

**Accept, in order:**

1. A non-customer lane, or a token that does not resolve → `404`.
2. The caller already holds an `active` or `suspended` membership there → `409`. This is a second
   click on the same link.
3. The invitation is revoked or expired → `410 invitation-revoked` or `410 invitation-expired`.
4. Any other non-pending state → `404`.
5. The caller's subject is not the account the realm worker recorded for this invitation, or the
   token's `email_verified` is not `true` → `404`. A link forwarded to someone else is therefore
   useless.
6. The organisation is not active → `409`.

A person Core already holds keeps their identity. A `removed` row is never revived through an
invitation: acceptance answers `409` and writes nothing. The batch refuses that address in the
first place, so this guards only against an invitation written by some other path.

Last in the transaction comes the member set hook (`member_joined`, ADR-0016). The tenant agent
learns of the newcomer on its next pull.

**Preview.** `previewInvitation` takes `{token}`, the same token, bounded like acceptance's (32 to
256 characters, no other member). It answers what acceptance would answer, in the same order and
from the same code, except that where acceptance would write, it reads:

- Steps 1 to 6 above, unchanged: a token that does not resolve, a staff token, an account other
  than the one the realm worker recorded, or an unverified address is `404`; a member is `409`;
  a revoked or expired invitation is the typed `410`; an organisation that is not active is `409`.
- Then acceptance's two later refusals: a person Core holds whose identity or person is no longer
  usable is `404`, and a person whose membership there is `removed` is `409`.
- Otherwise `200`:

  | Member | Value |
  |---|---|
  | `organisation_name` | the organisation's display name |
  | `inviter_display_name` | the inviter's display name; `null` when they set none or their person is deleted |
  | `role` | the role acceptance will grant |
  | `expires_at` | the invitation's expiry |

  Nothing else: no identifier, no address (neither the invitee's nor the inviter's), no state, no
  realm. The person reading it is the invited account itself, signed in and verified (step 5), so
  a forwarded link shows no card, exactly as it accepts nothing. Steps 2 and 3 come before step 5,
  on the preview as on acceptance, so another account of the realm holding the link learns that
  the token is genuine and either that it is itself a member (`409`) or that the invitation is
  revoked or expired (`410`), never the card.

The preview runs in one `REPEATABLE READ READ ONLY` transaction and takes no lock. It neither
consumes nor extends the token: the invitation's row, its counters, the replay store and the audit
log are unchanged by it. Like acceptance it is the `invited` principal's
([AUTHZ.md](../api/AUTHZ.md) §4), so a person Core does not hold yet is answered rather than
refused `identity-unknown`.

`429` is declared, as on acceptance, and not served by either (§9). The token carries 256 random
bits, compared in constant time, and only the invited account can read a preview at all, so
guessing gains nothing a limit would stop.

## 4. The two runs

Both runs belong to the operator profile and never to the API image (ADR-0003).

- **`run_realm_deliveries --once`** handles the realm access deliveries first, as before, then the
  realm account deliveries (`outbox_realmaccount`). For each delivery it reads the invitation and
  its organisation from Core's own rows.
  - The organisation's issuer must sit on the pinned origin; otherwise the delivery fails
    `payload_mismatch`.
  - An invitation that is no longer pending, or an organisation that is not active, ends the
    delivery as `withdrawn` without a call.
  - Every step is idempotent: a lookup comes before a create, and a create that collides reads
    again.
  - A created account carries the invitation's locale (`attributes.locale`), so the realm's
    set-up mail and sign-in pages speak the invitee's language.
  - A disabled or ambiguous account fails the delivery, and an operator looks at it. An invitation
    never enables an account.
  - Transport and credential errors keep the delivery pending without spending an attempt. So
    does a 400 to a set-up mail that names the return address (`redirect_refused`): the realm's
    `console` client does not list it, which is the realm's configuration and not the
    invitation's, so the delivery waits for the realm to be fixed instead of failing it and every
    later one. Other temporary errors back off, up to 5 attempts. An attempt left open for 15
    minutes runs again.
  - The run exits non-zero when anything needs an operator.
  - Right before it asks the realm to mail a set-up link, the run logs the person out
    (`POST users/{id}/logout`), with nothing between the two calls. The logout moves the
    account's `notBefore` to that second, and the realm (identity realm tooling) refuses any set-up link
    issued before it, so only the newest link works and a resend revokes the older ones. The
    logout also ends every session the person holds: harmless while they are onboarding, and
    intended when a member with pending actions (a reset) is sent a new link. A failed logout
    sends nothing and is handled like a failed send. An account with nothing pending is neither
    logged out nor mailed.
  - The set-up link lives 72 hours, and both onboarding mails say so just after their link: past
    it, an invitee asks an admin to resend the invitation (which mails a fresh set-up link), and
    a first owner writes to support. With
    `KODERA_REALM_SETUP_REDIRECT` set, the set-up mail also names the realm's `console` client
    and that URL, so Keycloak ends on a link back to the Console instead of its own "account
    updated" page. The URL must be exactly the root, `<origin>/`, of one of
    `KODERA_MAIL_LINK_ORIGINS`: the realm template's `console` client lists that redirect alone,
    and Keycloak refuses the whole set-up mail for any other. Any other value stops the process.
    Unset, the mail names no client, as before.
- **`send_invitations --once`** handles each invitation with `sent_count > mail_enqueued_count`
  whose latest realm account delivery has succeeded: only that outcome says whether the realm
  mailed a set-up link. When it did, the mail is `invitation`, which announces the set-up mail;
  when the account was already set up, `invitation_account_ready`, which announces none. An
  invitation whose account delivery is pending or failed waits, and is not counted. In one
  transaction it opens the token's seal, enqueues the message, and raises
  `mail_enqueued_count`. It refuses to run without `KODERA_INVITATION_LINK` on
  `KODERA_MAIL_LINK_ORIGINS`, the contact seal key, or the outbox seal key. It prints counts
  only.

Logs and audit rows carry identifiers and reasons only: never an address, a token or a user
representation.

## 5. Identity

Every sign-in to an organisation realm passes the one-time code, whatever the account's required
actions: the realm's browser flow has the code form `REQUIRED`, with only the session cookie as an
alternative path. So an invitee whose account existed already, with no action pending, still signs
in with their code. `dev/e2e/make_trust.py check_realm` refuses a realm that weakens this
(an optional code, a conditional step, a password-only path); the production realm template lives
in identity realm tooling.

`apps/identity/invited.py` creates the person (`identity_user`) and their realm identity, bound to
the organisation's issuer and realm, with the invitation's address as the contact. The orgs app
reaches it through this module, which keeps the application boundary rule.

## 6. Audit

| Action | Actor | When |
|---|---|---|
| `invitation.sent` | the inviter | each `created` row, with `role` and `send_email` |
| `invitation.resent` | the caller | each resend, with `sent_count` |
| `invitation.revoked` | the caller | the first revocation |
| `invitation.expired` | `system` | a lapsed row moved to `expired` |
| `invitation.accepted`, `membership.created` | the new identity | acceptance; `membership.created` carries `source: invitation` |
| none | | a preview, whatever its answer: it is a read |
| `outbox_delivery.*` | `system` | each realm account delivery outcome, `operation: account_ensure` |

## 7. Grants

`dev/api_writer_role.py` gives the API role the following:

- `SELECT` and `INSERT` on `orgs_invitation` and `outbox_realmaccount`.
- `INSERT` on `identity_user`, `identity_identity` and `orgs_membership`.
- `UPDATE` on the invitation's state columns (`state`, `sent_count`, `last_sent_at`,
  `accepted_at`, `membership_id`, `revoked_at`, `updated_at`), and on `orgs_membership.accepted_at`
  for a revival.

The preview needs no grant beyond these: it reads `orgs_invitation`, `orgs_organisation`,
`orgs_membership`, `identity_user`, `identity_identity` and `outbox_realmaccount`, which the API
role already selects.

The API role gets nothing on the realm, and no outbox seal key.

## 8. Acceptance

- `tests/test_invitations.py` sends real signed requests through the routed views and checks every
  response against the contract. It covers:
  - batch outcomes, grants, denials, replay, validation and paging;
  - the resend rate limit, revocation, acceptance and its refusals, and single use;
  - the preview: its card, each of its refusals, and that it changes nothing (the invitation row,
    the audit log, the replay store and the memberships are the same after it, and acceptance
    still succeeds with the token it read);
  - the realm account run against a fake admin, including the invitation's locale on a created
    account and a realm that refuses the set-up return address, whose deliveries wait instead of
    failing;
  - the mail run against the real outbox, including the wait for the account delivery and the
    `invitation_account_ready` mail for an account already set up.
- The real-stack run: Core, Keycloak, Mailpit and the operator runs in `dev/e2e/`.
  1. The owner invites.
  2. Both mails arrive.
  3. The invitee completes password and TOTP, then accepts.
  4. `/me` shows the membership.
  5. A removal disables the realm user and ends their sessions.

  The commands and output are in the pull request.

## 9. Open

- A removed person cannot be invited back. Serving it needs a decision: re-enabling their realm
  account before they accept conflicts with the drift check, which keeps every removed member's
  account off.
- Seats are not checked against the capacity tier yet. The contract's `quota-exceeded` is never
  answered.
- With `send_email: false`, no link can be retrieved yet. Retrieval needs a contract change.
- Staff reads and staff revocation are declared but not served.
- No limiter serves the `429` that `acceptInvitation` and `previewInvitation` declare. Both are
  bound to a 256-bit token and to the invited account (§3), so the limit is defence in depth, owed
  to both at once rather than to one (issue #357).
- The Console's acceptance page should tell the invitee to complete the set-up mail first, as
  the mail now does.
