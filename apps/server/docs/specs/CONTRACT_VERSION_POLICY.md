# Contract version policy and breaking-change gate

**Status:** Proposed · **Owner:** API seat

Implements the version policy and the breaking-change gate of Core issue #28, using
[`contracts/README.md`](../../contracts/README.md) as the requirement of record.
It is independent of the pending foundation and allocation decisions.

## Inputs and boundary

`contracts/check-version-policy.sh --base FILE --candidate FILE --change KIND`
reads two local OpenAPI YAML documents for the same API title. KIND is required:
`unchanged`, `patch`, `additive`, or `breaking`. Repeat `--label LABEL` for labels
read from the relevant pull request. The caller supplies the classification; this
checker does not detect breaking changes. In CI the caller is the breaking-change
gate specified below.

Only stable `X.Y.Z` versions are accepted: numeric components, no leading zeros,
prerelease or build suffix. Documents need OpenAPI 3.x, an `info` mapping with a
nonempty title and version, and a `paths` mapping. Reject unreadable documents,
invalid YAML, duplicate keys, and values that cannot be represented as JSON.
Inputs are bounded to 2 MiB each and YAML aliases are rejected before loading,
preventing expansion during document comparison. Mapping keys must be strings.
Errors must not echo source contents. No network, Git mutations, credentials,
runtime services or provider execution are needed.

## Acceptance rules

- `unchanged` passes only for equal versions and equal parsed documents. YAML
  formatting and comments do not affect equality.
- Any other classification requires a strictly greater version. A version-only
  increase is permitted, since releases can advance metadata alone.
- `patch` permits any strictly greater version.
- `additive` requires a greater major, or the same major and a greater minor.
- `breaking` requires the exact `contract:breaking` label. From `0.y.z`, it
  requires a greater minor or promotion to a nonzero major. From `1.0.0` onward,
  it requires a greater major. A return to an earlier major never passes.
- Invalid invocation or input exits 2. Policy violations exit 1. Passing exits 0
  and explicitly states that compatibility and human approval remain unchecked.

A green result from the policy alone proves that the version fits the
classification it was given, and nothing about compatibility.

## Runnable acceptance and mutations

Write the CLI acceptance harness before the checker:

```sh
bash contracts/check-version-policy.selftest.sh
```

It invokes the real CLI on isolated synthetic documents. Positive cases cover
all classifications, pre-launch and frozen breaking bumps, major promotion,
version-only release, numeric ordering, and formatting-only differences.
Mutations remove the breaking label, lower or preserve a required version, use
an insufficient bump, alter an unchanged document, and corrupt input shapes,
versions, labels, document identity and invocation. Every rejected mutation
asserts the exact exit code and a diagnostic category; a missing or crashing
checker cannot be mistaken for policy enforcement.

Run the checker on identical copies of both repository contracts with
`--change unchanged`. Shellcheck the launchers, and lint, format-check and typecheck
the embedded Python independently. CI runs the self-test and the mutations in the
`contract-change` job. Generated clients, runtime conformance and tag publication
remain separate work under #28: contract tags are created by hand, and no job
creates, publishes or checks them.

## Recovery acceptance

Preserve the original CLI and its ten positive cases and 46 refusals. Add these
positive cases to the same self-test, using the real checker process:

- Each committed Core and Agent contract, compared with itself as `unchanged`,
  passes. The Core document must not be replaced by a small synthetic stand-in.
- Reversing the order of an otherwise identical mapping passes as `unchanged`.
- Adding a YAML comment to an otherwise identical document also passes.

`bash contracts/check-version-policy.mutations.sh` runs private copies of the
checker and self-test. Reducing the input cap to 128 KiB must fail specifically
at `repository core-api.openapi.yaml`; disabling canonical key sorting must
fail specifically at `mapping order`. Require the expected exit and diagnostic,
not an arbitrary subprocess error. The original sources remain untouched.

Before merging the runtime foundation, this mutation runner must demonstrate
the existing self-test misses both regressions. After adding the positives,
both weakened copies must be caught. Keep one pinned PyYAML dependency and the
runtime lock; rerun the existing runtime acceptance after composition. No
workflow, infrastructure, runtime authorization or compatibility-classification
behavior changes are part of this recovery.

## CI enforcement: the breaking-change gate

In the `contract-change` job of `.github/workflows/ci.yml`, on every pull request that is
ready for review and every push to `main` whose change touches a path the gate depends on
(`.github/scripts/ci-plan.py` `PATH_GATED`; a change that touches none cannot move a contract,
so no label can matter), and on every tag and every manual run, `contracts/check-contract-change-ci.sh`
chooses the arguments from the event and runs
`contracts/check_contract_change.py --head REV (--target REV | --base REV | --parent) [--label=NAME ...]`.
The job is in `ci-ok`'s `needs:`, which accepts its skip only when the plan named it. On every
pull-request event, a label added or removed included, `.github/workflows/pr-metadata.yml` runs
the same entry point again for a pull request that changes a contract document, with the labels
the pull request has when it runs.

### Revisions

| Event | Head | Base |
|---|---|---|
| `pull_request` | the pull request's head commit | the merge-base of the head and `origin/<target branch>` |
| `push` to `refs/heads/main` | the pushed commit | the event's `before` commit; the first parent when `before` is all zeros |
| any other, `workflow_dispatch` included | the commit the run is for | the merge-base of that commit and `origin/main` |

A change that reached the target after a branch was cut is not read as the
branch's change. Comparing a push with the commit before it covers a push of
several commits. A manual run is never judged against its own first parent:
judged that way, a head whose breaking change sits one commit lower passes. The
job checks out full history. A revision that does not resolve, a pair with no
merge-base, and a head with no parent all exit 2.

When the base is the head itself, as on a manual run on `main`'s tip, the gate
compares nothing: it says `no contract comparison performed: base equals head`
and exits 0. That is not a merge path. Every change reaches `main` through a
pull request and a push, and both are compared.

Only pull-request runs cancel one another. Every other run gets a concurrency
group of its own, so the run for a push to `main` is neither cancelled nor
replaced while it waits.

### Files

Every `contracts/*.openapi.yaml` at either commit is checked:

| At the base | At the head | Result |
|---|---|---|
| present | the same blob | unchanged; passes without running the policy |
| present | different bytes, equal parsed document | unchanged; the policy runs with `unchanged` |
| present | a different parsed document | classified below; the policy runs with that classification |
| absent | present | added; passes once the policy accepts the file compared with itself |
| present | absent | deleted; fails, because every client breaks and no bump can say so |

A document that does not parse, or no contract at either commit, exits 2.

### Classification

Findings come from two places:

- `oasdiff changelog BASE HEAD --format json --severity-levels LEVELS --allow-external-refs=false`,
  with LEVELS the severity overrides below.
- The gate's own rules, for what oasdiff does not read:
  - `security-scheme-changed` (ERR), `security-scheme-removed` (ERR),
    `security-scheme-added` (INFO): a scheme in `components.securitySchemes`
    differs in anything but a `description`, is gone, or is new.
  - `servers-changed` (ERR): `servers` differs on the document, on a path both commits
    have, or on an operation both have. A client's base URL may stop reaching the API.
  - `x-kodera-authz-changed`, `x-kodera-scope-changed` (ERR): the extension differs
    on an operation both commits have. A role or scope a client relied on may be refused.
    Operations are matched with path parameter names ignored, so renaming `{id}` to
    `{organisation_id}` hides no change to who may call.
    Every list inside either extension is compared as a set: reordering entries, or
    repeating one, is not a change, so a pure reorder classifies as a patch and still
    needs the version increase any document change needs. Adding or removing an entry
    is breaking.

The most severe finding decides:

- ERR or WARN: `breaking`. WARN is oasdiff saying it cannot tell, and the
  README counts anything a client can break on as breaking.
- INFO only: `additive`.
- No finding, but the parsed document changed: `patch`.

External references are refused rather than fetched, so the gate reads nothing
but the two commits; a contract that needs one exits 2. oasdiff exiting
non-zero, or printing anything but a JSON list of findings at a known level,
exits 2.

### Severity overrides

oasdiff's defaults judge what a client can survive. The README is stricter in
places, and `contracts/oasdiff-severity-levels.txt` raises exactly those checks
to ERR.

The gate reads the file **as it is at the base commit**, so an edit a pull
request makes to the overrides does not apply to that pull request: a change to
the file takes effect for the pull requests after it merges. The gate's code is
not read from the base; see Not covered. When the base
commit has no such file, the copy beside the gate is used, and the gate says so.
oasdiff exits non-zero on an id it does not know, so the file cannot go stale
silently on a version bump.

| README rule | Checks raised to ERR |
|---|---|
| An enum member is added in a minor only where the contract says the enum is open, and neither contract says so | `request-parameter-enum-value-added`, `request-parameter-property-enum-value-added`, `request-property-enum-value-added`; an added response member is already ERR |
| A removed enum member | `response-property-enum-value-removed`, `response-mediatype-enum-value-removed` |
| A removed or renamed field | `response-optional-property-removed`; and a field removed in two steps, `response-optional-property-became-write-only` then `response-optional-write-only-property-removed`, or for a required field the built-in ERR `response-required-property-became-write-only` then the override `response-required-write-only-property-removed` |
| A changed status code | `response-non-success-status-removed` |
| A changed default | `-default-value-changed` and `-default-value-removed` for request parameters, request and response bodies, and request and response properties |
| Anything a client can break on: an endpoint, path or parameter removed after its deprecation | `api-path-removed-with-deprecation`, `api-removed-with-deprecation`, `request-parameter-removed-with-deprecation` |
| Anything a client can break on: security required where the operation had none | Built-in ERR `api-security-anonymous-access-removed` in oasdiff 1.37.0; no override required |

### Labels

A pull request's labels come from its event. The workflow also runs on
`labeled` and `unlabeled`, so adding or removing a label starts a run that sees
it, without a push. A push to `main` in which a contract file differs takes the
labels of the pull request whose merge commit is the pushed commit, read from the
API; a push in which no contract file differs reads none, since none can matter.
When no such pull request can be read, the script asks up to four times, waiting
5, 10 and 20 seconds, then fails closed with exit 2 and says to re-run the job
once GitHub lists the pull request for the commit. A manual run has no labels.
CI checks that `contract:breaking` is present, not who applied it.

### Exit status and messages

0 when every contract passes; 1 when any contract violates the policy or was
deleted; 2 when the gate could not look. A refusal names the file, the
classification, the checks at WARN or ERR, and the policy's own verdict.

### Pinned tool

oasdiff is a release binary. The job downloads it and checks it against
`OASDIFF_SHA256` before unpacking it; `OASDIFF_VERSION` names it. The gate
refuses any oasdiff whose `oasdiff --version` is not exactly
`oasdiff version <OASDIFF_VERSION>`, because the classification is defined only
for that version; locally, use that release's binary, since a build from source
reports another version string. Dependabot does not track the tool: a bump is a
pull request changing both values, with the digest taken from that release's
`checksums.txt`.

### Proofs

Before the gate runs, the job runs `contracts/check-contract-change.mutations.sh`.
It first runs both self-tests below unmutated, printing every case, and stops
unless each passes in full; then it runs the mutations.

- `contracts/check-contract-change.selftest.sh`. Each case builds commits in a
  throwaway repository seeded with the committed contracts and the severity file
  beside the gate under test, runs the gate with oasdiff and the policy, and
  asserts the exit status and a message. The cases cover every row of the file
  table; each classification with its required bump passing and an insufficient
  bump refused; a breaking change without its label; WARN as breaking; each of
  the gate's own rules (servers on the document, a path and an operation; a role
  narrowed or widened; a scope; a security scheme's URL or type changed, a scheme
  removed or added, and only its description changed; an authz change behind a
  renamed path parameter, and the rename alone); roles and scope entries
  reordered or repeated, each a patch; the base being the head; a
  realistic case for security added and for each step of a two-step field
  removal; a severity file weakened at the head having no effect; a base without
  the severity file; one case per severity override, `override-<check id>`, a
  minimal contract pair that oasdiff reports at INFO by default and the override
  must raise; the agent contract; a target that moved after the branch was cut; a
  breaking change one commit below the tip; the three ways of choosing a base;
  and these could-not-look paths: oasdiff missing, failing `--version`, reporting
  another version, or printing non-JSON; an unreadable contract; an external
  `$ref`; an added contract the policy cannot read; the policy exiting without a
  verdict; an unknown revision; no merge-base; a root commit; no contract at
  either commit. A case that finds the committed contracts no longer shaped as it
  needs exits 2.
- `contracts/check-contract-change-ci.selftest.sh`. The event script runs its
  real code path against a throwaway repository, with a stand-in `gh` and a
  stand-in gate that records the arguments it receives, for a pull request into
  `main` and into another branch, unreadable labels, the gate's exit status
  passed through, a manual run on `main`, a push to another branch, a push to
  `main` with and without a commit before it, a push that changes no contract, a
  pull request that appears only on a retry, no pull request, an API failure, a
  pull request merged as another commit, and no event. Each case asserts the exit
  status, the gate's recorded arguments, a message, and every call to `gh`.
- `contracts/check-contract-change.mutations.sh`. It weakens one rule at a time
  in a private copy of the gate, the event script, the severity file or the
  workflow, and requires the case that owns the rule to refuse the weakening with
  its diagnostic. Every severity override line is removed in turn and must be
  refused by its `override-<check id>` case. One mutation removes the job from
  `ci-ok`'s `needs:` and requires the coverage check to refuse it. Both unmutated
  self-tests must pass every case first, every mutation site must occur exactly
  once, and every listed mutation must run, so the harness cannot pass by
  aborting.

### Not covered

- Renaming a contract file reads as a deletion and an addition, and the deletion
  is refused.
- Renaming a component schema with every reference updated produces only
  `api-schema-removed` at INFO, so it classifies as additive.
- A change to any `x-kodera-*` extension other than an operation's
  `x-kodera-authz` or `x-kodera-scope` produces no finding and classifies as
  a patch.
- An enum meant to be open has no machine-readable marker, so growing it
  classifies as breaking.
- An OAuth2 scope's description is a value in a `scopes` map, not a
  `description` key, so changing it counts as a security scheme change, breaking.
- A change to an `operationId` or a tag, or a global `security` requirement
  added (`api-global-security-added`), is INFO, so additive.
- On a pull request, the gate, the event script, the version policy and the
  workflow run as they are at the head; only the severity file is read from the
  base.
