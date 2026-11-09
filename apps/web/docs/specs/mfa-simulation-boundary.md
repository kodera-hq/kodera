# Restrict MFA simulation to the explicit mock build

Status: Ready for independent review

## Scope

Continue renewal `06c02f9` with audit A04's isolated safety correction. Existing
MFA enrollment is a simulation: its fixed seed, permissive verifier, generated
recovery strings and local success flag do not establish a real second factor.
Keep that demonstration only when both `VITE_AUTH_MODE=mock` and
`VITE_ENABLE_MSW=1` are explicitly selected. No new authentication endpoint,
provider required-action flow or production enrollment is implemented here.

In normal OIDC and both mixed configurations, a forged local flag must not
satisfy enrollment. The real flow may trust only the existing Core identity's
`mfa_enrolled` response. An unenrolled identity remains on a truthful, accessible
unavailable screen with a local sign-out action. The synthetic screen is loaded
only by a compile-time-gated lazy import.

## Acceptance written before implementation

- Run new `mfaState` configuration tests before edits: the production and mixed
  configurations must reject a forged local enrolled flag. The proper mock
  configuration must retain the demonstration's local completion behavior.
- Build the current production bundle with the existing guard and verify the
  fixed synthetic seed is still emitted despite that guard reporting success.
- Add production-bundle markers for the MFA feature and an isolated mutation:
  inject each MFA marker into an otherwise clean built bundle, without any
  existing identity-provider/MSW marker, and require the guard to reject it.
- Build all four auth/MSW combinations. Only mock plus MSW may emit the MFA
  simulation. Preserve the existing mock enrollment/browser journey.
- Test the unavailable screen's accessible name, focused heading, guidance and
  local sign-out action; it must offer no fake QR, code or completion action.
- Run the full unit suite, static checks, generated catalogue checks, production
  bundle gate/self-test and relevant mock browser journeys. Do not change
  workflows, repository instructions, tokens or deployment configuration.

## Implementation and failure evidence

Before production edits, the local-state acceptance failed in three configurations
(OIDC/no MSW, OIDC/MSW, mock/no MSW) and passed in explicit mock/MSW. The original
production bundle guard reported success while the emitted JavaScript retained
the fixed seed, local enrollment key, recovery-download name and simulated
completion event. The updated guard rejects that same unmodified artifact by
those four feature-specific markers.

The original demonstration now lives under `features/security/mock/`, behind a
literal compile-time condition and React lazy import. Its formatter/verifier and
recovery generation move with it. Both local flag reads and writes independently
require the same two flags. Core-reported MFA enrollment remains unchanged.
The normal route renders an unavailable screen with focused heading, live
status guidance and local sign-out; it cannot call the completion callback.

The existing CI-invoked bundle script now checks five MFA markers in addition to
its earlier infrastructure markers. Its self-test adds each marker separately to
a clean production bundle, verifies a rejection naming that marker, removes it
and verifies the clean control again. Both mixed builds are independently scanned
for MFA; explicit mock/MSW remains the positive control. No CI workflow changed.

## Copy preview

Normal heading: **Double authentification requise**

Normal guidance: “Votre compte doit être protégé par une deuxième vérification.
Son activation n’est pas encore disponible dans cette console. Contactez
l’administrateur de votre organisation avant de réessayer.”

Action: **Se déconnecter**

Mock warning: “Démonstration uniquement : cette simulation ne sécurise pas votre
compte. N’utilisez pas les codes affichés pour un compte réel.”

Both source catalogues were updated and runtime JSON regenerated together.
No enrollment endpoint, provider credential or required-action integration was
invented. This removes false local assurance; it does not establish real MFA
enrollment or prove backend MFA authorization policy. Draft partitioning and
iframe session restoration remain separate from this boundary.

## Validation

- All 856 tests in 87 files passed with two workers. The focused 29-test set
  covers the configuration truth table, existing demonstration helpers,
  production guidance/accessibility/sign-out, catalogues and design guards.
- Type checking, ESLint, Prettier, catalogue regeneration/key-use checks and
  `git diff --check` passed.
- Normal production build and bundle exclusion passed. The bundle self-test
  passed all four configurations, five isolated MFA mutations and the existing
  mock-provider/MSW controls.
- The mock production build and four Chromium journeys passed: forced mock MFA,
  keyboard-only mock completion, typed form recovery and explicit local logout.
  These browser journeys exercise the demonstration, not real factor enrollment.
