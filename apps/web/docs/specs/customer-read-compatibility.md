# Customer read compatibility

Status: Proposed compatibility increment for the separately reviewed Core customer contract.

> **Amended.** The Core contract is at **0.11.0**, not the 0.6.0 candidate the
> qualification below consumed. The rule this document specifies is no longer a proposal against a
> moving target: contract 0.11.0 gives the organisation slug as
> `^[a-z0-9][a-z0-9-]{3,18}[a-z0-9](?![\s\S])`, and the validator the console ships is that
> rule, held to the pinned contract by `src/api/organisationSlug.test.ts` — five to twenty
> characters, lowercase alphanumerics with internal hyphens and alphanumeric ends. Contract 0.10.0
> carried two to twenty; the owner raised the minimum to five (decision SLUG-MIN-ANSWER). The
> two-to-twenty wording below is the qualification as it was run. That settles decision
> **B-slug** on the console side; the console previously validated 2–40 and accepted edge hyphens.

The organisation-identifier field normalizes pasted hosts and casing as before, then admits the actual persisted organisation domain: two to twenty lowercase ASCII letters, digits and internal hyphens, with alphanumeric ends. Keep tenant-order validation at its independent three-to-thirty-two-character rule. Explain the organisation rule in the existing error catalogue entry. Update the login specification's former two-to-forty range.

Acceptance precedes the validator edit: actual pure discovery validation covers two/twenty-character positives, twenty-one-character refusal, edge hyphens and final newline. The existing order schema suite remains a regression control. A separate disposable generator experiment consumes the exact Core 0.6.0 candidate and runs typecheck plus current discovery, session and switcher tests. Its copied contract/temporary lock are explicit experiment inputs; do not claim a published contract tag or change the production pin until that tag exists. Current response mocks remain the existing Core-generated examples; this shape change adds no new API response.

Source/consumer tests qualify validation and generated compatibility only. They do not establish a live connection to Core or customer identity, bootstrap, collaboration, release or deployment readiness.

## Hosted qualification correction

Status: Exact catalogue mismatch and pointer/validation layout failure reproduced before correction.

The committed JSON copy must regenerate byte-exactly from the canonical French and English markdown catalogue rows. The existing regeneration suite is the acceptance; fix the source rows and regenerate rather than weakening that gate.

The existing real-browser unknown-domain journey must restore the previously entered email when the person clicks the fallback's email action, including while the empty organisation field loses focus and shows validation. Preserve the same actionable validation and email retention. Reproduce the failed original browser journey before selecting a narrow correction; a mock HTTP response remains synthetic acceptance only.

The fallback email action keeps the field focused during a primary pointer press so on-blur validation cannot move the action between press and release. The normal click still changes views; no early pointer activation is introduced. Keyboard users may leave the field, see its validation and activate the email action normally. Browser acceptance covers the original journey, a held upper-quarter pointer press through validation paint, and keyboard return with email value/focus preserved. The cross-platform pointer control explicitly performs the default focus action only when the event has not been cancelled; it does not mock React state or API authority.

Qualification: the two original regeneration failures were reproduced, canonical rows corrected and regeneration left the intended JSON unchanged. All 65 focused discovery/i18n cases pass. All 11 login Chromium journeys pass, including the unchanged original unknown-domain journey and both new pointer/keyboard controls. The final pointer control fails on a private exact archive of the original published source, proving that the fix—not an assertion change—restores the action. The local original center click passed before correction; the measured validation repaint moved the action about 21px, and the upper-quarter click exposes the same loss without relying on pixel rounding. The focus observer runs after React's event cancellation; an earlier target-listener observer was corrected before final red/green qualification.

Typechecking/build, lint and changed-file formatting pass. Lint reports two pre-existing warnings outside this change. The production exclusion check passes. Hosted green status remains pending a separately reviewed publication of this correction; no full mock or real identity claim follows from these synthetic checks.
