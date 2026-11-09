# Operator schedule

**Status:** Proposed · **Owner:** API seat

These operator runs are one-shot commands: invitation mails, message deliveries, and the realm
deliveries (revocation included). Nothing in Core or Fleet ran them on a schedule, so a removed
member stayed enabled in the realm until someone ran `run_realm_deliveries --once` by hand.
`manage.py run_operator_schedule` is the one supported process that runs them periodically. It
replaces hand-made timer units that call each `--once` command.

## 1. What a pass runs

Each pass runs these commands in order, each with `--once`:

| # | Run | Spec |
|---|---|---|
| 1 | `run_realm_deliveries`: access off and on (revocation), then the invitees' accounts | MEMBERSHIP_LIFECYCLE.md §6.1, INVITATIONS.md §4 |
| 2 | `send_invitations` | INVITATIONS.md §4 |
| 3 | `send_support_tickets` | SUPPORT_TICKETS.md §6 |
| 4 | `run_deliveries --budget-s 20` | OUTBOX_MAIL_SENDER.md §7.5 |

- The order is deliberate. Revocation has a minute (MEMBERSHIP_LIFECYCLE.md §6.1.8), so the realm
  goes first, and within it the access deliveries come before the invitees' accounts; the access
  pass is bounded by `RUN_BOUND_S` (§6.1.9). A mail that run 2 or 3 enqueues is sent by run 4 in
  the same pass.
- The mail run claims nothing new after 20 s, so it lasts at most 20 s plus one send's timeout
  (30 s). A slow but reachable relay (up to 50 sends of 30 s each) can therefore not hold back the
  next pass's revocation by more than that. What it leaves is claimed first by the next pass.
- A run that refuses or fails is logged with its name. For a refusal, the log also carries the
  command's own message. For a crash, it carries the exception class only, never the message.
  The pass then continues with the next run, so a mail relay outage never holds back a
  revocation.
- Each run prints its line of counts, prefixed by its name. The pass then prints
  `pass N ok=… failed=… at=<UTC time>`, for example `at=current baselineT10:15:00Z`.
- Each run is safe to overlap with another copy of itself (skip-locked claims; the realm run takes
  its own run lock), so a second process, or a hand-run `--once`, does no harm.

## 2. Running it

```bash
python manage.py run_operator_schedule --interval 60 --settings=config.settings.deploy_operator
```

- **Environment.** The operator profile's environment, with every run's own settings:
  - SMTP and the outbox seal key;
  - the contact seal key and `KODERA_INVITATION_LINK`;
  - `KODERA_SUPPORT_MAILBOX`;
  - `KODERA_REALM_WORKER_SECRET_DIR` and the two Keycloak origins.

  A run whose settings are missing refuses on every pass and is logged. The other runs still go.
- **Interval.** `--interval` sets the seconds between pass starts, from 10 to 3600. Use 60, the
  minute that MEMBERSHIP_LIFECYCLE.md §6.1.8 asks for revocation. A pass that takes longer than
  the interval is followed at once by the next.
- **Stopping.** The process stops after the run in progress on SIGTERM or SIGINT. `--passes N`
  stops it after N passes (tests, a manual catch-up).
- **Release playbook.** Run one long-lived service per Core environment, under the operator
  image and profile, with `Restart=always` (or a container `restart: unless-stopped`). Do not
  add one timer per command. Alert on `failed=` greater than 0 for several passes in a row, and
  on no `pass` line for more than a few intervals: the `at=` time is what a staleness or
  `absent()` alert reads, and it also catches a stuck pass.
- **Two units instead (staging).** A host may keep the realm worker's secrets and the SMTP
  route in different containers: the realm worker's secret can take over any account of its
  realm, and the SMTP route can mail anyone. It then runs two units, each every minute:
  - the realm unit runs `run_realm_deliveries --once` on the realm network, with no SMTP. With
    `KODERA_REALM_SETUP_REDIRECT` set, it also needs `KODERA_MAIL_LINK_ORIGINS`, which the
    setting is checked against when the settings load;
  - the mail unit runs `send_invitations --once`, then `run_deliveries --once --budget-s 20`, on
    the mail network, with no realm secret. Once Fleet adds it (SUPPORT_TICKETS.md §6, not yet on
    staging), `send_support_tickets --once` runs last in that unit, so that its refusal (no
    mailbox set) never stops the invitations from being delivered; a ticket mail it enqueues
    leaves on the next minute's run.

  What §1's order is for still holds: mail never delays a revocation, because the units are
  independent and the mail run stops claiming after 20 s. The order itself does not. The
  invitation mail can leave before the realm unit has created the account and had Keycloak send
  the set-up mail, so the invitation's copy must not assume the set-up mail came first.

  A bare `--once` command prints no `pass` line, so the alerts above do not apply there. Alert
  instead on each unit's own result (failed for several runs in a row) and on its timer's last
  trigger (staleness).

## 3. Out of scope

- Billing mails (`send_order_confirmations`), the idempotency purge (`purge_idempotency`) and the
  discovery quota clean-up are not in the pass. They keep their own cadence (IDEMPOTENCY_REPLAY.md
  §2.7).
- This is not the worker (`python -m worker`). Jobs are leased and run there. Outbox deliveries
  are not jobs (ADR-0004).

## 4. Acceptance

`tests/test_operator_schedule.py` checks:

- a pass runs the three runs once, in order: the realm first, the mail run with its budget;
- the connection is closed after each run;
- a refused run does not hold back the next;
- a crash is logged by its class only;
- each run's lines are printed under its name;
- a stop request ends the pass before the next run;
- the bounds of `--interval` and `--passes` are refused;
- `--passes` bounds the loop, and each pass line carries its time.

`tests/test_outbox_mail_sender.py` checks that a run whose budget is spent claims nothing new
(`spent_budget_stops_run`, owned by the `run-ignores-its-budget` mutant).
