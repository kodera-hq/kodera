# Staging walk

Real browsers against the deployed staging Console, `https://app.example.test`, over the
target network. No web server, no mocks, no retries: a red step is a finding. The walk
reads only. It never accepts an invitation, never sends one, and never places an order.

It is not the v1 smoke (`tests/smoke/`). The smoke drives E1 and E2 end to end against Core's
local stack, where Mailpit holds the mail. This walk checks what can be checked on staging itself,
step by step as the exit criteria's preconditions land there. The checklist it follows is kept
with the run notes, not in this repository.

| Spec               | Needs                                   | What it proves                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.spec.ts`   | the VPN only                            | A failure is written only to the temporary directory removed after the run; the Console is served with its security headers; Core answers 401 to `/me` with no token; sign-in by the organisation's identifier reaches its Keycloak with PKCE S256; a protected page with no session goes to sign-in; the invitation page tells a good link from a bad one |
| `signed-in.spec.ts`| an account or a saved session (below)   | `/me` names an active membership and home renders; then, for an owner or an administrator only (skipped otherwise, saying why), People's invite drawer opens and closes with nothing sent                                                                                                                            |

## Run

```bash
npx playwright test -c e2e/staging/playwright.config.ts
```

Without credentials the signed-in spec is skipped, and says why.

## Environment

No value lives in this repository. Keep them in a file outside it, mode 0600, and load it into
the shell that runs the walk (`set -a; . ~/.kodera/staging-walk.env; set +a`), so no password
reaches the shell history.

| Variable                           | Default                         | Meaning                                                                                                                         |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `KODERA_STAGING_URL`               | `https://app.example.test` | The Console's origin                                                                                                            |
| `KODERA_STAGING_ORG`               | `acme-team`                   | The organisation's slug, which is also its realm                                                                                |
| `KODERA_STAGING_USERNAME`          | none                            | A test account of that organisation: its Keycloak username                                                                      |
| `KODERA_STAGING_PASSWORD`          | none                            | Its password                                                                                                                    |
| `KODERA_STAGING_TOTP_BASE32`       | none                            | Its authenticator key, Base32, as Keycloak shows it under « Impossible de scanner ? »                                           |
| `KODERA_STAGING_STORAGE_STATE`     | none                            | Instead of the three above: a saved browser session (see below)                                                                 |
| `KODERA_STAGING_REQUIRE_SIGNED_IN` | none                            | `1` makes a missing account or session a failure instead of a skip, so a run meant to prove the signed-in pass cannot pass on a skip |

The three account variables go together: setting only some of them is an error. Use a test
account made for this, never a person's own.

### A saved session instead of an account

A person who signs in with their own authenticator can lend the walk their Keycloak session
without handing over any secret:

```bash
npx playwright open --save-storage="$HOME/.kodera/staging-session.json" https://app.example.test/login
```

Sign in in the window that opens, then close it. Then run the walk with
`KODERA_STAGING_STORAGE_STATE="$HOME/.kodera/staging-session.json"`. The file holds a live
session: keep it at mode 0600 and delete it after the run. It lasts as long as the realm's idle
session timeout; when it has expired, the walk says so.

## On failure

Traces, screenshots and videos are off: on staging they would record a password, a one-time code
or an invitation link. Playwright still writes `error-context.md` for each failed test: the error,
its call log (which can name the URLs visited) and an ARIA snapshot of the page, which on
Keycloak's pages holds the username and the code field. `PLAYWRIGHT_NO_COPY_PROMPT=1` stops the
snapshot of a test that fails outside an assertion, such as a sign-in step; a failed assertion
attaches its own snapshot, and nothing turns that off.

So every output goes to a temporary directory under the system's temporary folder, never into the
repository, and `teardown.ts` removes it when the run ends, failed or not. The runner's
`.last-run.json` goes to the null device, so `--last-failed` is not available. A run cut short
(Ctrl-C, a crash) can leave the directory behind: look for `kodera-e2e-walk-*` in `$TMPDIR` and
delete it. Read a failure in the console output, which the list reporter prints and nothing keeps,
then reproduce by hand.
