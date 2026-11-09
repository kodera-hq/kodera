# Outbox mail sender

**Status:** Proposed · **Owner:** Worker seat

How Core sends its own mail: an outbox delivery of category `message` is committed with the change it belongs to, and a run of `manage.py run_deliveries --once` sends it over SMTP after the commit. It is the sender the owner claim (`FIRST_OWNER_BOOTSTRAP.md` §6.4: a claim link valid 72 hours, sent by Core mail) and the invitation flows need. ADR-0004 keeps messages out of the job model (`../domain/JOB_CATALOGUE.md`, **Outbox deliveries are not jobs**), and `IDEMPOTENCY_REPLAY.md` §3 requires every external effect of a request to go through the outbox, so no request handler ever opens an SMTP connection.

The terms MUST, MUST NOT, SHOULD and MAY are normative.

## 1. Scope

In this increment:

- two records in `apps.outbox`: `OutboxMessage`, the payload of one `message` delivery, and `OutboxDeliveryAttempt`, one row per send attempt (§2);
- `enqueue_message`, the service a caller runs inside its own transaction (§3);
- the template catalogue, with the two templates `owner_claim` and `invitation`, in the copy the product owner approved, and the drafts `order_confirmation`, `order_cancellation` and `credit_note_issued` (§4);
- the sealed secret and recipient, and what never reaches a log or an audit row (§5);
- the SMTP transport and its settings (§6);
- `run_deliveries`, which sweeps, claims, sends and records, and the management command that runs it once (§7);
- four audit actions (§8);
- the acceptance checks and their mutants (§9).

Not in this increment, each owned elsewhere:

- any caller: no route or job enqueues a message yet. The owner-claim issue (K8a) and the invitation (K11a) call `enqueue_message`;
- deliveries of category `commercial` or `identity_user_operation`, and every realm-changing delivery with the organisation lock it takes (`JOB_CATALOGUE.md` §1): a run claims only `message` deliveries that do not change a realm;
- a worker process or a schedule: the operator, or a cron entry, runs the command (§7.5);
- HTML bodies: a message is `text/plain` only;
- the audit row of an operator's delivery reconciliation decision, which the decision function in `apps.jobs` writes (§10).

## 2. Records

### 2.1 `OutboxMessage` (`outbox_message`)

One row per `message` delivery, inserted in the transaction that inserts the delivery.

| Column | Type | Rule |
|---|---|---|
| `delivery_id` | UUID, primary key | Foreign key to `outbox_outboxdelivery`, restrict (`outbox_message_delivery_fk`) |
| `template_id` | text | A template of the catalogue (§4), checked by `enqueue_message`; the column is checked for its shape only (`outbox_message_template_id_valid`, `^[a-z][a-z0-9_]{0,63}$`), so the catalogue can grow without a migration |
| `locale` | text | `fr` or `en` (`outbox_message_locale_valid`) |
| `params` | jsonb | An object of string values (a list of them for a `lines` parameter, §4), secret-free and free of personal data: the template's declared parameters and nothing else (`outbox_message_params_object`) |
| `link` | text NULL | The URL the message links to, without its fragment (`outbox_message_link_valid`: 1 to 2048 characters, no `#`). Null for a template that carries no link (§4) |
| `sealed` | bytea NULL | The recipient address and the link secret, sealed (§5.1); an empty secret for a template without a link. Null once erased |
| `expires_at` | timestamptz | After this instant the message is never sent (§7.1) |
| `not_before` | timestamptz | `DEFAULT clock_timestamp()`. A deferral moves it later (§7.3) |

### 2.2 `OutboxDeliveryAttempt` (`outbox_deliveryattempt`)

One row per attempt to send. An attempt is opened, and committed, **before** the first byte goes to the SMTP server, and closed once with its outcome. It is what makes a send happen at most once per record.

| Column | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | |
| `delivery_id` | UUID | Foreign key to `outbox_outboxdelivery`, restrict (`outbox_deliveryattempt_delivery_fk`) |
| `seq` | integer | 1, 2, … per delivery; unique with `delivery_id` (`outbox_deliveryattempt_seq_unique`) |
| `message_id` | text | The `Message-ID` header this attempt sends, `<{attempt id}@{sending domain}>` |
| `started_at` | timestamptz | `DEFAULT clock_timestamp()` |
| `finished_at` | timestamptz NULL | Set with `outcome` and only with it (`outbox_deliveryattempt_finished_with_outcome`) |
| `outcome` | text NULL | Null while open; then `accepted`, `temporary`, `transport`, `permanent`, `ambiguous` or `abandoned` (`outbox_deliveryattempt_outcome_valid`) |
| `smtp_code` | integer NULL | The SMTP reply code that decided the outcome, when there was one |
| `provider_message_id` | text NULL | The provider's queue identifier, read from the final `2xx` reply (§7.4) |

Database guards, each a refusal under the name in brackets:

- a partial unique index, `outbox_deliveryattempt_one_open`, on `delivery_id` where `outcome IS NULL`: a delivery has at most one open attempt, so two runners cannot both be sending it;
- a row trigger, `outbox_deliveryattempt_guard`, refuses changing an attempt whose `outcome` is set (`outbox_deliveryattempt_outcome_once`) and deleting any attempt (`outbox_deliveryattempt_retained`), SQLSTATE `23514`. A closed attempt is never reopened, so it is never sent again.

`OutboxDelivery` (`JOB_QUEUE.md` §7) is unchanged. The run writes its `status`, `operation_ref` (the current attempt's `Message-ID`), `started_at`, `finished_at` and `updated_at`, and never its identity columns; its guards apply to every write here as they do to any writer.

## 3. Enqueuing a message

```python
enqueue_message(
    *, organisation_id: UUID, template_id: str, locale: str, recipient: str,
    params: Mapping[str, object], expires_at: datetime,
    link: str | None = None, link_secret: str | None = None,
    reply_to: str | None = None,
) -> UUID  # the delivery's id
```

It MUST be called inside the caller's transaction, which writes the change the message belongs to and its audit row; outside one it raises and writes nothing. It inserts an `OutboxDelivery` (`category = message`, `changes_realm = false`, `status = pending`) and its `OutboxMessage`, and raises `MessageRefusedError`, writing nothing, when:

- the template is not in the catalogue, or has no copy for `locale`;
- `params` does not hold exactly the template's declared parameters, or a value is empty, longer than 200 characters or holds a control character, or a `text` parameter's value (§4) is empty, longer than 20,000 characters or holds a control character other than a line feed or a tab, or a line or paragraph separator;
- `reply_to` is given and is not one such conservative address either (below);
- `recipient` is not one conservative address of at most 254 characters: dot-separated atoms of letters, digits and `_ % + -` before the `@` (at most 64 characters, no quoting and no other atext), a host name of letter-digit-hyphen labels after it;
- the template carries a link and `link` is missing or not an absolute `https` URL — `http` only for `localhost`, a loopback address or a `.localhost` name — or has a user, a password or a fragment, or its origin is not one of `KODERA_MAIL_LINK_ORIGINS`, the console's origins (§6): a caller cannot make Core mail a token to a host it does not serve;
- the template carries a link and `link_secret` is not 16 to 512 characters of `A–Z a–z 0–9 _ -`, or it carries none and either is given;
- `expires_at` is not later than the database clock, or is more than seven days after it: a claim link lives 72 hours, and nothing Core mails waits longer than a week.

Without a seal key (`KODERA_OUTBOX_SEAL_KEY`, §6) it raises `SenderUnavailableError` instead, writing nothing: a missing key is the deployment's fault, not the message's.

The link secret is the claim or invitation token. The sent body carries `link#link_secret`, so the token travels in the URL fragment and never reaches a server log. It is stored only sealed (§5.1).

## 4. Templates and copy

The catalogue is `apps/outbox/mail/catalogue.toml`, read once per process. Each template declares its parameters, an `approved` flag and, per locale, a `subject` and a `body`. Placeholders are `${name}`: the declared parameters and `link`, which the sender fills with `link#link_secret`. A template carries a secret link (the default), and then its body MUST contain `${link}` and its subject must not; or it says `link = false`, carries no link and no secret, and no placeholder `${link}`: its message stores no link, and its sealed value holds the recipient and an empty secret. A parameter a template declares under `lines` takes one to ten values, each held to the rule of a single value, rendered one per line, and never in a subject. A parameter a template declares under `text` carries a person's own message verbatim: one value of up to 20,000 characters, line feeds and tabs kept, every other control character refused, rendered as given, never in a subject, and never also under `lines`. A message is one `text/plain` part, so nothing in such a value is read as markup or as a header.

**`support_ticket`** carries a customer's support ticket to the support mailbox (SUPPORT_TICKETS.md §6): `link = false`, the ticket's reference and context as single values, the customer's subject as a single value in the body only, and the customer's message as its one `text` parameter. Its subject is built from the template and the ticket's own values (severity, category, organisation slug, reference), never from the customer's text. It is enqueued by `send_support_tickets` in the operator profile, with the requester's address as the message's own Reply-To (§5.1). Its copy is approved (`copy = "approved"`, `approved = true`): it goes only to Kodera's own support mailbox and is never shown to a customer, so the lead approved it rather than the product owner.

**`order_confirmation`** is the message that forms the contract (CGV 5.3): `link = false`, parameters `organisation_name`, `order_reference` and `documents`, the last a `lines` parameter naming each document accepted with the order, its version and the permanent URL of its text. It is enqueued by `send_order_confirmations` in the operator profile (`apps/billing/confirmations.py`), to the signatory, for each order with an accepted DPA, not cancelled, whose confirmation was never enqueued or whose delivery ended `failed` (expired, rejected, out of attempts): a confirmation that does not arrive is enqueued again, since the contract is not formed without it. Each enqueue writes `order.confirmation_enqueued`. An order whose texts cannot all be named is not enqueued, is reported, and makes the command exit non-zero without holding back the others. The run refuses as a whole, enqueuing nothing, without `KODERA_LEGAL_TEXT_ORIGIN`, without a transport, or on a remote transport while the copy is not approved: there it would only be held until it expired. Its copy is a draft (`copy = "draft"`, `approved = false`) until the product owner approves it.

**`credit_note_issued`** delivers a credit note to the customer: `link = false`, parameters `organisation_name`, `credit_note_number`, `invoice_number`, `issued_on`, `total_incl_vat` and `credit_note_url`, the credit note's permanent reference (`getCreditNote` on Core's public API host, which the organisation's owner, admins and billing role read with their token; a person opens it in Kodera, not from the mail). The same `send_order_confirmations` run enqueues it once per credit note, to the order's billing contact, or the signatory when there is none or the outbox would refuse its address; it writes `credit_note.notice_enqueued`, and enqueues it again if its delivery ends `failed`. Its copy is a draft. The run refuses on a remote transport while any of the three drafts (`order_confirmation`, `order_cancellation`, `credit_note_issued`) is unapproved, so the three are approved together.

**`order_cancellation`** is the notice that a confirmed order was cancelled: `link = false`, parameters `organisation_name` and `order_reference`. A confirmation is sent once and forms the contract, so a cancellation meets it in one of two ways. Still pending, it is withdrawn at its claim (§7.2) and never sent. Already `succeeded`, the contract was formed: the same `send_order_confirmations` run writes `order.terminated` and enqueues this notice to the confirmation's recipient, once, and again if the notice's delivery ends `failed`. A confirmation in `needs_reconciliation` waits for a person. Its copy is a draft too (see `credit_note_issued` for the run's refusal while a draft is unapproved).

French is user-facing product copy and needs the product owner's approval (`AGENTS.md`). The two templates the slice needs, **`owner_claim` and `invitation`, carry the copy the product owner approved**, French and English, verbatim but for the placeholder syntax (`{name}` written `${name}`); French is the approved source and English a faithful translation. Each entry says `copy = "approved"` and `approved = true`. Changing the wording is a pull request the owner approves, with `approved = false` until then.

**Unapproved copy never leaves on a remote transport.** A run on a transport that is not local (§6) does not claim a delivery whose template has `approved = false`: the delivery stays `pending`, and the run reports it as held. A local transport (Mailpit, a test server) sends it, so the end-to-end flow can be exercised before the copy is approved. An entry is approved by the pull request that carries the owner's wording and sets `approved = true`.

## 5. Secrets and personal data

### 5.1 The sealed column

`FIRST_OWNER_BOOTSTRAP.md` §6.4 requires a delivery payload carrying a token's plaintext to be encrypted, narrowly readable, and deleted at the delivery's expiry or completion; `MODEL.md` says the same of the owner claim's token. So:

- `params` and `link` are secret-free: the token is never in either;
- `sealed` holds the JSON object `{"recipient": …, "secret": …}`, and `"reply_to": …` when the message names its own Reply-To (§3); a message that names none seals exactly the two members it always did, encrypted with AES-256-GCM under the seal key (§6), a fresh 96-bit nonce per seal, and the associated data `kodera-outbox-message:` followed by the delivery's 16 id bytes. A sealed value moved to another delivery does not open. The stored value is a version byte, the nonce and the ciphertext;
- A caller that put customer text in a message's parameters erases that copy with `redact_ended_params`: it replaces the named parameters with `—`, only once the delivery is `succeeded` or `failed`, and leaves a message still to be sent whole. `send_support_tickets` redacts its four (SUPPORT_TICKETS.md §6).
- `sealed` is set to null — **erased** — in the transaction that makes the delivery `succeeded` or `failed`, and by the sweep (§7.1) for every delivery that reached either state another way, through an operator's decision, and for every message past `expires_at`.

The recipient is sealed with the secret because it is personal data the run needs only to send; the readable payload holds neither. A message's own Reply-To is sealed with them so that it is bound to its delivery and cannot be swapped; a template may still show the same address in its body, as `support_ticket` does. The run checks it again when it builds the message, and a message that names one is sent with it in place of the transport's `KODERA_MAIL_REPLY_TO`.

### 5.2 Logs and audit carry identifiers only

The rendered message exists in the runner's memory between the claim and the end of the SMTP conversation, and nowhere else. No log line, no exception text that is logged, no audit row, no attempt row and no command output carries the body, the subject, the link, the secret or the recipient. What they carry: the delivery and attempt ids, the template id, the outcome, the SMTP reply code, the `Message-ID` and the provider's queue identifier.

In particular:

- the SMTP library's debug output stays off: it prints the whole conversation, recipient and body included;
- an SMTP error is logged by its class name, never by its text: a server's refusal commonly echoes the recipient address;
- the provider's queue identifier is read from the final reply and kept only when it is one token of `A–Z a–z 0–9 . _ -` of at most 128 characters; anything else is dropped.

## 6. The transport

Settings, read once at start by `config.settings.job_queue` (the profile that installs `apps.outbox`) and refused at start when malformed:

| Variable | Meaning |
|---|---|
| `KODERA_MAIL_SMTP_URL` | `smtp://[user@]host[:port]` — STARTTLS required, port 587 by default — or `smtp+insecure://host[:port]`, plaintext, accepted only for the literal `localhost` or a loopback address. The test profile (`config.settings.test`) adds one name, the compose service `mailpit`, as `KODERA_MAIL_INSECURE_HOSTS`, passed to the parser as `insecure_hosts`; no other profile exempts a name. Unset: no transport, and the command refuses to run. A password in the URL is refused |
| `KODERA_MAIL_SMTP_PASSWORD` | The SMTP password, injected from the secret store. Required when the URL names a user, refused otherwise. No default |
| `KODERA_MAIL_FROM` | The sender address, `name <local@domain>` or `local@domain`. On a remote transport its domain MUST be `notify.kodera.io` or `notify.staging.kodera.io` (ADR-0015, Core platform mail); a local transport accepts any domain |
| `KODERA_MAIL_REPLY_TO` | The `Reply-To` address, unless a message names its own (§5.1). Default `support@kodera.io`, an alias of `hello@kodera.io` |
| `KODERA_MAIL_LINK_ORIGINS` | The origins a message may link to, comma-separated `scheme://host[:port]`: the console's origin in each environment. Unset: no link is accepted, so no message that carries a link can be enqueued |
| `KODERA_OUTBOX_SEAL_KEY` | The seal key, 32 bytes in URL-safe base64. Unset: `enqueue_message` raises `SenderUnavailableError` and the command refuses to run. No default |

A transport is **local** exactly when its URL is `smtp+insecure`. Outside tests and the local stack every transport is `smtp://`, so every remote conversation upgrades with STARTTLS, verifying the server's certificate chain against the system trust store and its name against the configured host, TLS 1.2 at least, before it authenticates or sends an address: a server that does not offer STARTTLS, or whose certificate does not verify, gets nothing. The SMTP client is built with the host, so the name the TLS layer verifies is that host. In production the transport is Scaleway Transactional Email over SMTP; locally it is Mailpit (`compose.yaml`, `smtp+insecure://localhost:1025`).

Each conversation has a 30-second timeout per socket operation.

## 7. A run

`run_deliveries(transport=…, limit=50)` refuses to run inside a caller's transaction. It sweeps once, then claims, sends and records one delivery at a time until `limit` deliveries were attempted, nothing is due, or the transport failed (§7.3). A run attempts each delivery at most once, so a deferral whose jittered delay is near zero waits for the next run. `send` never raises: whatever goes wrong is classified by the phase it happened in (§7.3), and a raise that escaped it anyway is recorded `ambiguous`, so no exception leaves an attempt open or ends the run.

### 7.1 The sweep

In its own transaction, rows locked `FOR NO KEY UPDATE SKIP LOCKED`:

1. **Abandoned attempts.** A `message` delivery `in_flight` whose open attempt started more than 15 minutes ago by the database clock is moved to `needs_reconciliation`, and the attempt closed `abandoned`: a runner that died, or lost its database session, after opening the attempt may or may not have sent the message, and an unknown outcome is reconciled, never retried automatically (ADR-0004). `outbox_delivery.reconciliation_required` is written. Fifteen minutes is well past the longest conversation the timeouts allow;
2. **Expired messages.** A `pending` message whose `expires_at` has passed, or whose `sealed` was erased, becomes `failed`, with `outbox_delivery.failed` and reason `expired`;
3. **Erasure.** `sealed` is erased for every message whose delivery is `succeeded` or `failed`, or whose `expires_at` has passed. A message `needs_reconciliation` past its expiry is erased too: if an operator's decision later returns it to `pending`, step 2 fails it.

### 7.2 The claim

In its own transaction: the oldest due delivery — `status = pending`, `category = message`, `changes_realm = false`, `not_before` and `expires_at` on either side of the database clock, `sealed` present, template not held (§4) — locked `FOR NO KEY UPDATE SKIP LOCKED`. The claim unseals and renders it; a value that does not unseal stops the run with an error naming the delivery and changes nothing (a wrong key would otherwise fail every message); a message that does not render or build — a template that no longer renders, a header the mail library refuses — fails the delivery (`outbox_delivery.failed`, reason `unrenderable`), so it never rolls its claim back and comes first again at every run. Otherwise the claim opens the next attempt, sets the delivery `in_flight` with `started_at` and `operation_ref` set to the attempt's `Message-ID`, and commits. Only then does the run connect.

A delivery of `order_confirmation` whose order is `cancelled` is withdrawn at the claim instead: it ends `failed` with reason `withdrawn`, unopened. The order's row is locked in share mode by its key and its state read once the lock is held, so a cancellation still open is waited for and then seen; one committed after the claim meets a confirmation already on its way (§4, `order_cancellation`).

### 7.3 Outcomes

The conversation is driven step by step, so the run knows whether the message content had started to leave when it ended:

| Where the conversation ended | Attempt | Delivery |
|---|---|---|
| A `2xx` reply to the end of the message content | `accepted` | `succeeded`, `finished_at` set, `sealed` erased; `outbox_delivery.sent` |
| A `4xx` reply to `MAIL`, `RCPT`, `DATA` or the end of the content | `temporary` | `pending`, `not_before` moved by the backoff; `outbox_delivery.deferred` |
| A `5xx` reply to `MAIL`, `RCPT`, `DATA` or the end of the content | `permanent` | `failed`, `finished_at` set, `sealed` erased; `outbox_delivery.failed`, reason `rejected` |
| Before `MAIL` was sent: no connection, a bad greeting, no STARTTLS, a TLS or authentication failure, any reply, exception or timeout there; or a `421` to `MAIL`, `RCPT` or `DATA`, which closes the channel | `transport` | `pending`, `not_before` unchanged, nothing of the budget spent; `outbox_delivery.deferred`, reason `transport`. **The run stops**: the next delivery would meet the same transport |
| A `1xx` or `3xx` reply, or an exception, before the content | `temporary` | as `temporary` |
| Lost connection, timeout, exception, unreadable reply, or a `1xx` or `3xx` reply after the `354` to `DATA`, once the content started to leave | `ambiguous` | `needs_reconciliation`; `outbox_delivery.reconciliation_required`, reason `outcome_unknown`. Never resent automatically |

A lost connection before the `354` is `temporary`: the server holds no message. A run never sends a second message on one attempt, and the attempt's outcome is written once.

**Backoff** is retry class `A` of `JOB_CATALOGUE.md`: the n-th deferral of a delivery waits a uniformly random delay between 0 and `min(10 min, 30 s × 2^(n−1))` (full jitter). The fifth `temporary` attempt fails the delivery instead, with reason `attempts_exhausted`. Only `temporary` attempts count: a `transport` attempt says nothing about the message, and an `ambiguous` or `abandoned` attempt an operator resolves does not count either, as no exit from `needs_reconciliation` counts against a job's budget (`JOB_QUEUE.md` §5.4).

If an outcome arrives after the sweep abandoned its attempt, `attempt_is_open` — the delivery still `in_flight` and the attempt still open, read under the delivery's row lock — is false, nothing is written, and the run logs the ids and the outcome; the delivery stays with its operator.

### 7.4 What is recorded

On the attempt: `outcome`, `finished_at`, `smtp_code`, and on acceptance `provider_message_id` — the last token of the final reply that passes §5.2's filter, after stripping `<` and `>` (Mailpit answers `250 2.0.0 Ok: queued as <id>`). On the delivery: `status`, `finished_at` when terminal, `updated_at`. Each outcome writes its audit row in the same transaction.

### 7.5 The command

`python manage.py run_deliveries --once [--limit N] [--budget-s S] --settings=config.settings.job_queue`. `--once` is required: there is no long-running mode until a worker exists. With `--budget-s`, the run claims nothing new once S seconds have passed and adds `stopped=budget` to its line; a send in progress still ends within its own timeout, so a run lasts at most S plus one send. It refuses to start when no transport or no seal key is configured, prints one line of counts — sent, deferred, failed, held for reconciliation, held for copy approval — and exits `0`; it exits non-zero when a sealed value does not open. Two concurrent runs are safe: claims skip locked rows, and the one-open-attempt index refuses a second open attempt.

`python manage.py send_order_confirmations --settings=config.settings.job_queue` enqueues the order confirmations due (§4) and prints how many were enqueued and skipped; it exits non-zero when one was skipped or when the run refused. `run_operator_schedule` (OPERATOR_SCHEDULE.md) runs `run_deliveries --once --budget-s 20` every minute. `send_order_confirmations` is not in its pass yet: the operator runs it after an order is placed.

`config.settings.job_queue` builds on the local database profile today, which refuses any database but a local one, so the command runs against the local stack and tests only until a deployed worker profile exists. That is consistent with ADR-0015, whose precondition is that nothing runs on a live Core database before its cutover.

The message: `From`, `To`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `Auto-Submitted: auto-generated`, `Content-Language`, `text/plain; charset=utf-8`, quoted-printable.

## 8. Audit

Four actions, `system` actor, target `urn:kodera:outbox_delivery:<id>`, retention `standard`, written in the transaction of the change they record (`../domain/AUDIT_TAXONOMY.md` §3). `metadata` carries `attempt` (the sequence number), `template_id`, `smtp_code` (or null) and `reason` from a closed set; `outbox_delivery.sent` adds `message_id` and `provider_message_id`.

| Action | Reasons |
|---|---|
| `outbox_delivery.sent` | — |
| `outbox_delivery.deferred` | `temporary`, `transport` |
| `outbox_delivery.failed` | `rejected`, `attempts_exhausted`, `expired`, `unrenderable`, `withdrawn` |
| `outbox_delivery.reconciliation_required` | `outcome_unknown`, `attempt_abandoned` |

## 9. Acceptance

`tests/test_outbox_mail_sender.py`, in the normal suite, against the test database and an in-process SMTP server (`tests/smtp_stub.py`: the standard library, and `cryptography`, already locked, to generate a test CA and a server certificate for `localhost` at test time). It follows `IDEMPOTENCY_REPLAY.md` §4: every check raises an `AssertionError` with a fixed first line, runs once unmutated, and each mutant patches one part of the sender, or rewrites one guard inside a rolled-back transaction, and requires its owning check to fail with exactly that line. A check without a mutant fails the inventory test.

| Check | What it proves | Mutants it catches |
|---|---|---|
| `accepted_is_succeeded` | A `250` to the content makes the delivery `succeeded` with the provider's identifier recorded, the `Message-ID` as `operation_ref`, `sealed` erased, one `sent` audit row; the message the server received has the link with its fragment, `Reply-To`, `Auto-Submitted` and the attempt's `Message-ID` | `2xx` classified temporary; identifier not recorded; erasure skipped; `Reply-To` dropped |
| `temporary_is_deferred_with_backoff` | A `451` to `RCPT` defers the delivery: `pending`, `not_before` later, one closed `temporary` attempt, nothing received | backoff zero; `4xx` classified permanent |
| `deferrals_are_bounded` | One attempt per run; the fifth `temporary` attempt fails the delivery `attempts_exhausted`, not the fourth | budget unbounded; budget one short; a run reclaiming its deliveries |
| `permanent_is_failed` | A `550` to `RCPT` fails the delivery and erases `sealed`; a second run sends nothing | `5xx` classified temporary |
| `ambiguous_is_never_resent` | The server drops the connection after the content: `needs_reconciliation`, attempt `ambiguous`, a second run sends nothing; a `354` after the content is `ambiguous` too | the failure classified temporary; every reply class read as deciding |
| `abandoned_attempt_is_reconciled` | An `in_flight` delivery whose open attempt is 16 minutes old is moved to `needs_reconciliation`, not resent; one a second old is left alone | threshold widened; threshold zero |
| `late_outcome_is_dropped` | An outcome recorded after the sweep abandoned its attempt writes nothing | the late-outcome guard removed |
| `attempt_guards_refuse` | A second open attempt, a rewrite of a closed attempt's outcome and a delete are each refused by their guard | each guard dropped |
| `nothing_secret_is_logged` | Over a run with one accepted and one refused message — the server's replies echoing the address — no log record, no output, no attempt row and no audit row carries the secret, the link, the recipient or the body; the logs do carry the ids | SMTP debug output on; the whole reply stored as the provider id |
| `secret_is_sealed_and_bound` | No column of the message, attempt, delivery or audit tables holds the secret or the recipient in clear; two seals never share a nonce; a sealed value moved to another delivery does not open, and a run stops on it without changing anything | sealing replaced by plaintext; nonce reused; associated data dropped |
| `expired_is_not_sent` | A message past its expiry is not claimed, is failed `expired`, and its `sealed` erased | the claim's expiry clause dropped; the sweep's expiry pass skipped |
| `unapproved_copy_is_held_remotely` | With a template's approval withdrawn, a remote transport does not claim it and it stays `pending`; a local one sends it | the hold removed |
| `starttls_is_required` | A STARTTLS transport facing a server that does not offer it sends no `MAIL`, records a `transport` attempt and stops the run | STARTTLS skipped |
| `starttls_verifies_the_server` | Real TLS against the stub: with the test CA trusted and the host `localhost`, the handshake succeeds and the message is delivered; with the CA untrusted, or the host `127.0.0.1` that the certificate does not name, nothing is sent | certificate not verified (`CERT_NONE`); host name not checked |
| `transport_failure_stops_run` | With nothing listening, the second due delivery is not attempted, and six runs leave the first `pending` with six `transport` attempts | the run continues; transport failures counted |
| `unbuildable_message_is_failed` | A message whose build raises is failed `unrenderable`, with no attempt, and the next delivery of the run is sent | the build failure not caught |
| `transport_settings_are_validated` | Plaintext to a remote host or to `mailpit` outside the test override, a password in the URL, a user without a password, an unknown scheme, a remote `From` outside the notify domains and a malformed seal key are refused; the local, the compose and the remote examples parse | the loopback test widened; the sender-domain rule removed |
| `enqueue_is_checked` | Without a seal key it raises `SenderUnavailableError`; a link outside the allowed origins, an expiry more than seven days away, an address outside the conservative set, an unknown template, a missing or extra parameter, a bad locale, a link with a fragment, a short secret and a past expiry are refused and write nothing; outside a transaction it raises; a valid call writes a `pending` `message` delivery | the parameter check removed; the caller-transaction check removed; the origin check removed; the lifetime cap removed; any atext accepted |
| `link_less_message_is_checked_and_sent` | A template without a link refuses a link or a secret, a `lines` parameter out of bounds is refused, and a valid `order_confirmation` is sent through a local transport with every line in its body | the link refusal removed; the `lines` bounds removed |
| `catalogue_carries_the_approved_copy` | Both shipped templates exist in French and English, approved, with the approved subjects and no placeholder marker, and each renders with its link; every other template says it is a draft | an entry read as unapproved |
| `command_runs_once` | `run_deliveries --once` sends the due message; without `--once`, without a transport or without a seal key it refuses | `--once` not required |

Not proven here: a real provider's reply format and certificate chain, and concurrency between two runs beyond the one-open-attempt guard.

## 10. Recorded tensions and owed items

- **`Reply-To`. Resolved.** It is `support@kodera.io`, which the product owner made an alias of `hello@kodera.io`, the address ADR-0015 names for replies.
- **"Delivered".** The queue's closed set has `succeeded`, not `delivered`. An accepted message is `succeeded`: the provider accepted it; whether it reached an inbox is not observed.
- **The decision's audit row. Resolved.** This increment executes `message` deliveries and did not change the decision function in `apps.jobs`. A later change to `JOB_QUEUE.md` §7 and its tests added the action, `outbox_delivery.reconciliation_decided`, and its writer, which names the `staff_operator` grant the decision relied on.
- **ADR-0015 is Proposed.** The `notify.*` sending domains and their keys do not exist yet (its step 3), so the remote rule of §6 refuses anything else until they do.
- **The copy. Resolved.** The product owner approved the wording of both templates (§4).

## Changelog

- First version: `OutboxMessage` and `OutboxDeliveryAttempt`, `enqueue_message`, the sealed recipient and secret, the template catalogue with placeholder copy for `owner_claim` and `invitation`, the SMTP transport, `run_deliveries --once`, four audit actions, and the acceptance checks with their mutants.
- Security review: STARTTLS verifies the server against the configured host (the client is built with it), with real TLS checks; `send` never raises; a conservative recipient set; a message that does not build is failed `unrenderable`; transport failures spend no budget; link origins are allow-listed; a `1xx` or `3xx` reply after the content is ambiguous; a message waits at most seven days; plaintext only to loopback or `localhost`, plus the test profile's `mailpit`. The approved copy replaces the placeholders.
- §10: the decision's audit row, `outbox_delivery.reconciliation_decided`, is written by the decision function (JOB_QUEUE.md §7); no longer owed.
- §§3, 6, 9: a missing seal key raises `SenderUnavailableError`, as `apps/outbox/sender.py` does, not `MessageRefusedError`; `enqueue_is_checked` now proves it, with the mutant `seal-key-not-required`.
- A template may carry no link (`link = false`) and declare `lines` parameters, for the order confirmation, the third template, whose draft copy is held on a remote transport until the product owner approves it. `outbox_message.link` is null for such a message, and `enqueue_message` takes `link` and `link_secret` only for a template that carries a link.
- §§4, 7.2: a cancelled order's confirmation is withdrawn at its claim (reason `withdrawn`), and one already sent is followed by the draft `order_cancellation` notice and `order.terminated`.
- §4: the draft `credit_note_issued` notice delivers each credit note with its permanent URL.
- §§3, 4, 5.1, 6: a template may declare a `text` parameter for a person's own message, and a message may name its own Reply-To, sealed with its recipient, for the `support_ticket` mail (SUPPORT_TICKETS.md), whose internal copy the lead approved.
