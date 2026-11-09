# Offline pagination contract check

**Status:** Proposed · **Owner:** API seat

Specified before checker correction; the local checker is implemented and wire
correction remains pending.

The checker validates the existing 26 required paginated operations against an
explicit method/path/operation-ID inventory. Deleting page declarations must
not shrink the checked population. An additional discovered page requires an
inventory decision. This does not discover every possible new unpaginated
collection from its name or prove a complete API implementation.

Preserve the launcher interface:
`bash contracts/check-cursor-pagination.sh [--self-test] [contract]`.
Success exits 0, contract refusal 1, unreadable/ambiguous/unsupported input 2.
Keep fixed diagnostics without parser/source contents. Input is bounded to
2 MiB before parsing; duplicate keys and YAML aliases refuse. Local JSON
Pointer traversal is bounded and never reads another file or fetches a URL.

Only actual successful response content and the outer schema's reference/allOf
composition establish a CursorPage envelope. Extensions, examples and nested
unrelated properties do not. Equivalent local response references pass; missing,
cyclic, nonlocal or incompatible references refuse. Conflicting or unsupported
schema/reference siblings refuse instead of being discarded.

Validate effective path and operation parameters by name and location, honoring
operation overrides. Ordinary inline equivalents of the current optional query
parameters pass: cursor is a string with maximum length 512; limit is an integer
with minimum 1, maximum 200 and default 50. Boolean numeric values, duplicate
declarations, conflicting or unsupported schema constraints and weakened
overrides refuse. No new values or ordering rules are selected here.

Keep the existing actual 400 MalformedRequest and 422 ValidationError requirement
for listLegalDocuments, listEntitlements and listTenantAvailability. Broader
error-response policy remains a wire-contract decision. The current optional
next_cursor and collection-specific ordering gaps remain unresolved by this
checker-only correction; success never claims runtime pagination correctness.

## Acceptance and composition

Run `bash contracts/check-cursor-pagination.acceptance.sh [contract]` on the
original launcher before implementation. The audit's population removal,
response alias with missing parameters, extension-only error and boolean Limit
must initially reproduce false success. Preserve their exact named refusals
after correction, alongside positive actual-contract/alias/inline/path-level
cases and the original 17 refusal scenarios. Deliberate private checker
weakenings must fail the corresponding assertion, not merely crash.

Recover from existing PR head f04e6bdfcacc8a4d8a6a90f96aeccf68189aa682 by
normally merging the actual parent 02f272fd97b5936f0de108e1ee4b9eafcdef95a1.
Verify that ancestry before adding implementation. Preserve its newer proposal
statuses, Agent version and disclosed authority gaps. Then normally compose
reviewed runtime 8da12bef792c3db6b5d4991de20977df1cc29f7f: adding standalone
Python activates existing CI types and requires its real Django configuration.
Preserve runtime metadata/lock/settings/workflows byte-for-byte; resolve only
the documentation overlap while retaining the local health-probe exception and
newer parent contract qualifications. No workflow workaround is admitted.

After composition, run the checker acceptance, named weakening mutations,
affected lint/types and all 53 existing disposable-runtime acceptance tests.
No new wire, IAM, Docker, settings or workflow edit is part of this correction.
The original PR already carries its Core version and three-operation pagination
changes; those remain inherited, alongside the newer parent corrections.

## Measured recovery

The initial CLI acceptance reproduced six defects before the checker changed.
Expanded counterexamples then caught an empty shared page definition, a page
hidden by an unsupported union, and a contradictory shared page constraint.
The resulting 51 cases retain all 17 original refusal scenarios. The shared
page's existing semantic shape is checked conservatively, including its optional
`next_cursor`; unsupported constraints require a separate contract decision.
Escaped JSON Pointer names pass, while cycles and excessive reference depth
refuse. Individual `--probe` selection on the acceptance helper reports partial
acceptance and is used only by weakening tests; the launcher self-test runs all.

Run `bash contracts/check-cursor-pagination.mutations.sh` to prove seven specific
regressions fail their matching assertion: erased inventory envelope, lost
response alias, counterfeit error response, weakened parameter schema, ignored
operation override, an undersized input cap, and an empty page definition.
An unrelated exception or scanner crash is not accepted as mutation detection.

Composition produced four actual conflicts: `.env.example`, `README.md`,
`dev/README.md` and `docs/api/CONVENTIONS.md`. Runtime environment and metadata
remain exact; documentation preserves the health exception and newer proposed
contract/authority disclosures. The canonical runtime dependency definition
removes the automatically merged duplicate parser dependency. The three renamed
organisation realm fixtures and the compose import mount resolve to actual local
files. This path check is not a Keycloak startup qualification. The separate
runtime acceptance tests health/database behavior and development isolation only.

## Narrow schema-equivalence correction

Status: Implemented after measured red acceptance; final independent review pending.

The independent review of `2bd0bd9` found three false-refusal classes. For the
checked Cursor/Limit schemas, permit string `description` and `title` annotations
without treating them as constraints. Permit the existing numeric length/bounds
and default written as mathematically equal integer-valued JSON numbers, such as
`200.0`; never equate a boolean or numeric string with a number. Require all other
schema keys and constraints exactly as before. Exercise both shared definitions
and effective inline declarations, plus annotated contradictory constraints.

The shared continuation type may be `[string, null]` or `[null, string]`.
Missing, duplicated or additional type members still refuse. This correction
does not change the current handling of `required`: making `next_cursor`
required remains accepted by this local checker, while the actual source wire
keeps it optional. No wire freeze, new pagination behavior, dependency, workflow
or runtime change is admitted here.

Add the equivalent positive cases and corresponding refusal controls to the
existing CLI acceptance before editing the checker. Preserve all 51 existing
cases and seven assertion-bound mutation checks. Add focused excessive-refusal
mutations for annotations, numeric spelling and nullable type order; each must
fail its named positive assertion rather than crash.

Initial execution on the unchanged checker reproduced seven false refusals with
60 controls passing. The corrected checker passes all 67 cases. All seven prior
mutation checks remain intact; four additional mutations prove annotation and
numeric/type-order compatibility plus refusal of boolean-to-number coercion.
All eleven fail their exact selected assertion. Ruff, shell checks and the
existing mypy command pass. Only the checker, acceptance/mutation helpers and
this specification change; no runtime suite or external service was rerun for
this local declaration-equivalence correction.

## Changelog

- Specifies and qualifies a bounded static inventory check without changing wire semantics.
- Preserves the current contract parent and independently reviewed runtime through normal merges.
- Admits narrow schema spelling equivalents while retaining constraint and boolean refusals.
