# Support tickets

**Status:** Proposed · **Owner:** API seat

`createSupportTicket` (`POST /support/tickets`) stores a customer's ticket and has it mailed to
Kodera's support mailbox. The API stores; the operator profile mails, as it does for invitations
(INVITATIONS.md §4). Core holds no helpdesk, no staff read of tickets and no response target per
support tier yet, so the answer's `external_ref` is null and its `sla` is absent.

## 1. Who

- Every tenant role (`org_owner`, `org_admin`, `org_billing`, `org_member`), about the caller's own
  organisation: the path names none. A suspended organisation may open a ticket too.
- A known person with no current membership gets `403`, recorded. Core not knowing the token's
  identity gets the identity-unknown answer (AUTHZ.md §2 step 6).
- A staff token gets `403`, recorded, until the staff lane of the customer operations exists
  (kodera-hq/kodera#344).
- A body naming another organisation (`organisation_id`) gets `403`, recorded: a ticket is never
  filed under an organisation the caller does not belong to.

## 2. The request

- `Idempotency-Key` is required. The same key and body replay the first answer; the same key with
  another body is `409 idempotency-key-reuse` (IDEMPOTENCY_REPLAY.md).
- The body is `SupportTicketCreateRequest`, `application/json`, at most 128 KiB, with no other
  member. `subject` is one line: no control character. `body` keeps its line breaks: CRLF and CR
  become LF, and a tab is kept; any other control character is refused. Lengths are counted in
  characters after that normalisation. `severity` defaults to `question` and `locale` to `fr`.
- `tenant_id`, when given, must be a tenant of the caller's organisation that is not deleted;
  otherwise `400` with the pointer `/tenant_id`.
- `contact_email` is an address the customer types, of at most 200 characters: a mail parameter's
  bound, so every ticket accepted can be mailed. It is shown to support as unverified and is never
  a header of any mail.
- Each malformed field answers `400 malformed-request` with its pointer, escaped as RFC 6901 says;
  a body the parser cannot read, nested too deep included, is `400` with no pointer.

## 3. The tenant context

Computed when the ticket is opened, never from the body: the named tenant, or the organisation's
newest tenant that is not deleted, or none. Its slug, status, pack and capacity tier are copied
onto the ticket. `agent_stale`, `open_incident_component_keys` and `last_job_id` are not composed
yet (`null`, `[]`, `null`).

## 4. Limits

Counted in the database, in the replay store's transaction, under a transaction lock of the
organisation's tickets (an advisory lock keyed by the organisation, not its row lock):

- 5 tickets per identity per rolling hour;
- 20 tickets per organisation per rolling hour.

Past either, `429 rate-limited` with `Retry-After`: the seconds until the oldest counted ticket
leaves the hour. Nothing is stored, so the same key works once the limit allows it.

## 5. The support mailbox

`KODERA_SUPPORT_MAILBOX` names it, in the API's environment and in the operator's. It is one
address, never a constant. Its value is `support@kodera.io`, the one support address, which the
whole team reads. Unset or malformed in the API, the operation answers
`503 service-unavailable` with `Retry-After` after authorising the caller, and stores nothing.

The API's value is only a gate: whether a mailbox is configured at all. The recipient is the
operator's value, read when the mail is enqueued, so the two environments must name the same
address. The gate cannot see two other states in which a ticket is answered `201` and reaches no
one yet: copy still unapproved on a remote transport (§6, logged and counted as held), and a host
whose operator does not run `send_support_tickets` (on staging, until the Fleet change below
lands, tickets are stored and not mailed).

## 6. The mail

`manage.py send_support_tickets --once` (operator profile) enqueues one `support_ticket` message
per ticket not yet mailed, in one transaction per ticket, and marks it mailed. `run_deliveries`
sends it (OUTBOX_MAIL_SENDER.md).

- **To:** the support mailbox.
- **Reply-To:** the requester's address as Core stores it (`identity_user.email`), read when the
  ticket was opened, never an address the request carried. The sender seals it with the recipient
  (OUTBOX_MAIL_SENDER.md §5.1).
- **Subject:** the template's, from Core's own values only: the ticket reference, the category, the
  severity and the organisation's slug. Never the customer's text.
- **Body:** plain text, one part. The customer's subject and message appear in the body only, the
  message verbatim through the catalogue's `text` parameter (OUTBOX_MAIL_SENDER.md §4).
- The template's copy is approved (`approved = true`). It goes only to Kodera's own support
  mailbox and is never shown to a customer, so the lead approved it rather than the product owner.
  If a later edit sets `approved = false`, a remote transport holds it again: each run then logs a
  WARNING naming how many tickets are held, and prints the count as `held_for_approval`, counting
  every held ticket, not one batch.

Without the mailbox, the outbox seal key or the sender's settings, the run refuses to enqueue,
after it has settled and erased as below. It prints counts, never an address or a ticket's text.

**How long Core keeps the text.** Core stores the customer's subject, message and both addresses
because no helpdesk exists yet (MODEL.md, "Departure while no helpdesk exists"), and keeps them only
as long as the mail needs them, at most `RETENTION`, 14 days from the ticket's opening. Each run, in
this order and whatever the mail settings:

1. **Settle.** For each ticket whose message will never be built again (its delivery ended, or it
   expired, even while awaiting reconciliation), the message's copies of the four values are
   replaced with `—` (`redact_ended_params`, OUTBOX_MAIL_SENDER.md §5.1). Delivered (`succeeded`):
   the ticket's subject and body are emptied, both addresses nulled, `content_erased_at` and
   `mail_delivered_at` set. Failed or expired: the ticket is owed again, once (`mail_retried_at`),
   and mailed in the same run, while at least an hour of its 14 days is left; otherwise, or after a
   second failure, its text is erased and its id logged as an ERROR. A permanently refused mail is
   therefore sent twice at most, never at every pass.
2. **Expire.** Every ticket older than 14 days has its text erased, delivered or not, logged as an
   ERROR with the count. A message still waiting keeps its own copy until it ends or expires, and
   the next run's settling redacts it.
3. **Enqueue**, as above. A message expires six days after it is enqueued, or at the end of its
   ticket's 14 days if that comes first, so no copy outlives the ticket's; a ticket with less than
   an hour left is not mailed.

14 days is two outbox windows and a margin: the first message and one retry after a failed delivery
both end inside it, and a ticket no mail reached in two weeks is better opened again than kept. What
stays is what the API answered with, less the subject: id, organisation, tenant and its context,
category, severity, state, locale and timestamps. The `201` the replay store keeps carries the subject
for its 24 hours (IDEMPOTENCY_REPLAY.md). A database check refuses an erased mark on a ticket that
still holds text, and the owed index leaves erased tickets out. The bound holds where
`send_support_tickets` is scheduled and its pass runs: the operator schedule runs it every pass,
and on the Fleet mail unit a failed pass, which the unit's alert reads, also skips it (the mail unit, above).

Every value it passes stays within a mail parameter's bound. A character a parameter refuses (a
control, format or private-use character, or a line or paragraph separator), which an organisation's
name may carry since intake refuses only NUL, becomes a space; a long name is cut with `…`; and an
address too long for a parameter is shown as `—` (the requester's still reaches support as the
Reply-To). A ticket whose message the outbox refuses anyway is marked (`mail_refused_at`), logged by
its id, and reported once as `skipped`, which makes that run exit non-zero. It is not retried, so it
holds back no newer ticket, and an operator who fixed the cause clears the mark to have it mailed.

`run_operator_schedule` runs it in each pass, after `send_invitations` and before `run_deliveries`
(OPERATOR_SCHEDULE.md §1). On a host that runs the mail unit instead, it runs after
`run_deliveries` in that unit, so its refusal never stops the invitations from being delivered
(OPERATOR_SCHEDULE.md §2). Either needs `KODERA_SUPPORT_MAILBOX` in the operator's environment
as well as the API's.

**Not running yet on staging.** Its mail unit (`kodera-mail-deliveries.service`, Fleet role
`operator_egress`) runs `send_invitations` and `run_deliveries` only. Until the Fleet change that adds
this run lands, staging stores tickets and mails none of them.


## 7. Acceptance

- `tests/test_support_tickets_http.py`: the answer for each role, the replay, every refusal, the
  tenant context, the limits, the `503`; mutation proofs for the route and the limits.
- `tests/test_support_ticket_mail.py`: the run enqueues one message per ticket with the mailbox,
  the requester's Reply-To and the verbatim body; never twice; nothing without the mailbox; the
  built mail is one plain-text part whose subject carries no customer text. Retention: a delivered
  ticket keeps only its metadata and its message loses the text; a failed one is retried with the
  text kept and the failed copy redacted, once, or erased when too late for a retry; text past 14 days is
  erased while its message waits and where the mail is refused; a message still to be sent is never
  redacted; the database refuses an erased mark on a ticket that keeps its text.
- `tests/test_retention_evidence_reachability_contract.py`: the stored-ticket exemption lapses with
  MODEL.md's departure, covers one model of one app at runtime, and one `CreateModel` of one
  migration.
- `tests/test_outbox_mail_text_params.py`: the catalogue's `text` parameter and the sender's
  per-message Reply-To.
- `tests/test_support_ticket_request.py`: the request's and the mail's bounds agree, deep nesting is
  malformed, pointers are escaped.
- `tests/test_support_writer_role.py`: the API writer role opens, replays and limits tickets with
  `dev/api_writer_role.py`'s grants, and cannot change or delete one.
- `tests/test_operator_schedule.py`: the pass runs `send_support_tickets`, and its refusal holds back
  no other run.
- `tests/test_identity_unknown_http.py`: `createSupportTicket` answers `403 identity-unknown` and
  keeps its `401` challenge.

## 8. Follow-ups

- The response target per tier, the article catalogue and incidents (kodera-hq/kodera#343).
- The staff lane (kodera-hq/kodera#344), then `listSupportTickets` and `getSupportTicket`.
- A helpdesk mirror, which would fill `external_ref`.
- The `RESTRICT` foreign keys the subject purge will need changed (MODEL.md, `SupportTicketLink`).
- The Fleet change that runs `send_support_tickets` on staging (the mail unit, both env
  allowlists, the env files, the unit's self-test and README).
