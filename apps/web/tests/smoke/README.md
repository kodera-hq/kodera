# v1 smoke

Status: E1 is green against Core's `dev/e2e` stack, both ways: the owner signs in after the journey consumed the claim, and, with `--claim-by-mail` on a stack stopped at the claim mail (`journey --until claim-mail`), the owner claims through the Console's `/claim` page first. The claim by mail needs kodera-core#307. E2 is green against the same stack (`SMOKE_REQUIRE=E2`): a member invited by Core's `dev.e2e.invitations` accepts on the Console's `/invitations/accept` page (kodera-console#293) and signs in as an active `org_member`. E1b and E3–E7 follow as their Core routes land.

The v1 exit criteria, walked in real browsers against a Console that is already served and a real
Core, Keycloak and Synapse. No mocks, no web server, no retries: a red step is a finding. The same
spec runs locally and on staging; only two inputs change.

| Step | What it proves                                                         |
| ---- | ---------------------------------------------------------------------- |
| E1   | The owner claims the organisation and signs in as its sole owner       |
| E1b  | The owner places the order (CGV and DPA accepted), staff settle it     |
| E2   | An invited member accepts through the Console and signs in             |
| E3   | Espace: the two exchange a text message                                |
| E4   | Espace: an audio room, two browsers, each hears the other              |
| E5   | Visio: the launch tile opens the organisation's instance               |
| E6   | The owner revokes the member, whose next request is refused            |
| E7   | Isolation: the member of another organisation sees none of this one    |

Each step starts from the state the previous one left. E1b is what opens the rest: Core opens an
organisation's workspace only once it has an order whose DPA the owner accepted, and the tenant the
order creates is what the Visio tile reads. The order is a normal one, placed by the owner on
`/{org}/order`; billing is deferred for the dogfood, so staff then settle it as complimentary with
Core's operator command, which credits its invoice in full. E1b is written once that
command exists.

## Inputs

- `SMOKE_BASE_URL`: the Console's origin, for example `http://localhost:5173`.
- `SMOKE_INPUT`: the path of a JSON file, never values on the command line, so no password
  reaches a shell history:

  ```json
  {
    "organisation": "e2e-pilot",
    "owner": { "username": "…", "email": "…", "password": "…", "totpBase32": "…" },
    "member": { "username": "…", "email": "…", "password": "…", "totpBase32": "…" },
    "mailpit": "http://localhost:8125",
    "claim": "mail"
  }
  ```

  `claim: "mail"` makes the claim part of the run, its link read from `mailpit`. Without it, the
  organisation is already claimed and E1 proves the owner's sign-in and role only. `member` is a
  person already invited and set up whose invitation is still pending; E2 reads its link from
  `mailpit` and accepts it, and is skipped, saying why, without both. Keep the file outside the
  repository, mode 0600.

- `SMOKE_REQUIRE` (optional): the steps this run must prove, for example `E2`. A required step whose
  input is missing fails instead of being skipped, so an evidence run cannot pass on « 1 skipped ».
  Only the step names in the table above are accepted.

## Local run, against Core's live end-to-end stack

Bring up kodera-core's `dev/e2e` stack and run its journey (its `README.md`). Then build the
Console against it, on the origin the stack's realm redirects to (`http://localhost:4173` by
default), and serve it. Core is reached on the Console's own origin, as on staging: it answers no
CORS preflight, so the preview forwards `/api` to it (`PREVIEW_CORE_ORIGIN`, `vite.config.ts`):

```bash
VITE_CORE_API_URL=http://localhost:4173/api/v1 VITE_KEYCLOAK_URL=http://localhost:8180 VITE_AUTH_MODE=oidc VITE_OIDC_CLIENT_ID=console VITE_ENABLE_MSW=0 VITE_MATRIX_DOMAIN=kodera-e2e.test VITE_FIRST_OWNER_JOURNEY=1 npx vite build --outDir dist-smoke --emptyOutDir
```

```bash
PREVIEW_CORE_ORIGIN=http://localhost:8100 npx vite preview --outDir dist-smoke --port 4173 --strictPort
```

Write the input file from the stack's `journey.json`. The script prints the `SMOKE_BASE_URL` the
stack expects:

```bash
node scripts/smoke-input-from-journey.mjs ../kodera-server/dev/e2e/rendered/journey.json "$TMPDIR/smoke-input.json"
```

```bash
SMOKE_BASE_URL=http://localhost:4173 SMOKE_INPUT="$TMPDIR/smoke-input.json" npm run test:smoke
```

The journey consumes the claim through the API. For the claim by mail, stop it at the mail instead
(`uv run python -m dev.e2e.journey --until claim-mail` in Core) and add `--claim-by-mail`, which
writes `claim: "mail"`: E1 then reads the link from Mailpit and claims on the Console's `/claim`
page. Its sign-in returns to `/auth/claim-callback`, which the e2e realms register since
kodera-core#307.

For E2, invite the member after the journey (`uv run python -m dev.e2e.invitations --until set-up`
in Core). It writes `rendered/invitee.json` beside `journey.json`, and the script above then adds
the `member`. `render` leaves the previous bring-up's `invitee.json` in place, so the script refuses
one older than `journey.json`. The invitation itself is made by that Core command, not by the owner
in the Console: E2 proves the acceptance. An invitation is single use, so a second E2 on the same bring-up meets `409`: bring
the stack up again. Two runs inside one 30-second window also reuse a one-time code, which Keycloak
refuses; wait for the next window.

## Staging run

Over the VPN, against the staging Console, with an input file for a staging organisation the
operator has created:

```bash
SMOKE_BASE_URL=https://app.staging.kodera.io SMOKE_INPUT="$HOME/.kodera/smoke-staging.json" npm run test:smoke
```

Traces are kept for a failed step only on a loopback Console: a trace records every field typed and
every URL, which here means the password, the codes and the claim link. Against staging a failure
leaves no trace on disk.

Each code is used once: a step that signs in waits for a fresh TOTP window rather than reuse one
Keycloak has already accepted.
