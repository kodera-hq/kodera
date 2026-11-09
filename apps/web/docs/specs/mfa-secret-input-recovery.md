# Authentication input is excluded from recovery

Status: Implemented; review pending

The mock MFA screen currently saves an unsubmitted OTP in the generic session
stash and restores it after reauthentication. Authentication codes must never
enter form recovery, even in the explicit demonstration build. Remove only this
consumer; preserve the enrollment demonstration and the production bundle guard.

## Acceptance

The shell browser journey enters a distinct six-digit code, expires the session,
and starts sign-in again. At the identity handoff, both application storage
namespaces must contain neither that code nor the MFA stash key. After the
callback the same MFA destination opens, selecting the application method shows
an empty code field, and the ordinary keyboard enrollment journey still passes.
Check at handoff because consuming a secret after return would hide persistence.

Run the focused browser test before the component change and record the failure.
Run the focused journey, keyboard enrollment, forced MFA and logout journeys
afterward, followed by existing unit, static and production bundle checks.

## Scope and limits

Only the mock MFA component, its browser acceptance and this spec change. The
generic stash ownership problem, existing order persistence, OIDC iframe callback
dispatch and reload bootstrap remain separate work. No real enrollment flow or
new provider call is introduced. Authentication seeds, OTPs, passwords, tokens and
recovery codes are excluded from future recovery consumers as well.

## Recorded initial failure

The browser acceptance failed before the component change at the handoff storage
assertion: the session stash contained `mfa-totp-code` and the entered synthetic
OTP. This proves the check detects the actual persistence, before consumption on
return can conceal it. The initial sandbox run could not bind its server; the
subsequent isolated loopback run supplied this behavioral failure.

## Validation evidence

The corrected browser journey passes alongside forced enrollment, keyboard-only
enrollment and logout (four Chromium journeys). Type checking, lint, formatting
and the production bundle exclusion guard pass. The initial full unit run had
855 passing tests and one existing API-generator self-test timeout under parallel
validation load; its isolated rerun passes all eight tests. The full-suite rerun passes all 856 tests across 87 files without changing
any timeout or test configuration.
