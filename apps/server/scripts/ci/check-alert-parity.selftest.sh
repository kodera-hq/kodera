#!/usr/bin/env bash
# Proves the alert-parity check can fail, and fails for the reason it names.
#
# The case this check exists for is `grain-disagrees`: two documents that agree
# on every severity while one counts tenants and the other counts organisations.
# That is not a hypothetical shape — it is what an earlier round of these two
# documents had done, and a severity comparison was green over it.
#
# ## What this file is written against
#
# **A case has to assert what was said, not only the exit code.** Every rule
# below shares one exit status, so "exit 1" distinguishes nothing: a case that
# reddens because a *different* rule fired is a case that would stay green after
# its own rule was deleted. Each `expect` therefore names the sentence.
#
# **A rule that matches nothing reports agreement it never looked for.** The
# counting-grain rule binds one alert today. `no-fleet-count` is the case that
# makes that visible: with the only `count(...)` sketch reworded away, the check
# must fail rather than report parity over the thirty-five rows it still read.
#
# **Both documents need fixtures.** Cases that only ever mutate one of the two
# leave half the parsing untested — the shape that left `docs/INDEX.md` unread
# in the ADR check for a whole generation.
#
# ## The baseline these fixtures are built on
#
# `OBSERVABILITY_STACK.md` §2.2 declares exactly one entity label, `tenant_slug`,
# and both documents count `IdPOutageFleetWide` in tenants. A disagreement
# between two *entity* nouns therefore cannot be written by editing one word:
# there is no second noun to write. The four cases that need one declare
# `organisation_slug` in §2.2 first, through `second_entity`, and only then make
# the sketch and the prose name different things. That is the honest fixture —
# the check derives its vocabulary from the label table, so a case about two
# entities has to put two entities in the table — and it buys a pair of cases a
# single-entity tree cannot otherwise state: `entity-declared` and
# `entity-undeclared`, which hold the check's claim that a new dimension is
# usable the moment §2.2 declares it and never before.

# Every fixture argument below is a line of Markdown quoted exactly as the two
# documents write it, and those documents put alert names, labels and PromQL in
# code ticks. Nothing in a single-quoted string here is meant to expand; the
# strings have to survive into the file byte for byte or the fixture is not the
# document. Variables are used double-quoted throughout, so this silences a
# warning about backticks and not about anything that could be a mistake.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-alert-parity.py"
repo="$(cd "$here/../.." && pwd)"

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/alert-parity-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

stack="docs/specs/OBSERVABILITY_STACK.md"
slo="docs/specs/SLO.md"
adr="docs/adr/0006-kodera-identity-topology.md"

# A fixture is the repository's own two documents. Mutating the real thing is
# the point: a hand-written miniature would prove the check parses a miniature,
# and every shape below is one these files can actually take.
fixture() {
  local dir="$work/$1"
  mkdir -p "$dir"
  # The whole documentation tree, not the two files the tables come from: rule 5
  # sweeps `docs/`, and a fixture holding only those two would prove the sweep
  # works on the files it was already reading.
  cp -R "$repo/docs" "$dir/docs"
}

# edit <fixture> <file> <old> <new>   — one replacement, and it must land.
edit() {
  python3 - "$work/$1/$2" "$3" "$4" <<'PY'
import sys

path, old, new = sys.argv[1:4]
with open(path, encoding="utf-8") as handle:
    body = handle.read()
if old not in body:
    sys.exit(f"self-test is broken: {old!r} not in {path}")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(body.replace(old, new, 1))
PY
}

# second_entity <fixture>  — declare `organisation_slug` in §2.2.
#
# §2.2 carries one `_slug` label, so on this tree an entity disagreement has to
# be *introduced* before it can be stated. This is the legitimate way to do it:
# the row is the one a real second dimension would add, and the check picks the
# noun up from the table rather than from a list kept in step with it by hand.
second_entity() {
  edit "$1" "$stack" \
    '| `tenant_slug` | the tenant'"'"'s stable slug, e.g. `lab` | one per tenant; the primary dimension everywhere |' \
    '| `tenant_slug` | the tenant'"'"'s stable slug, e.g. `lab` | one per tenant; the primary dimension everywhere |
| `organisation_slug` | the slug of the organisation that owns the tenant | one per organisation |'
}

# expect <exit> <fixture> <text...>
expect() {
  local want="$1" fixture="$2" got=0 out="" text
  shift 2
  out="$(python3 "$script" "$work/$fixture" 2>&1)" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$fixture' expected exit $want, got $got" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  [ "$#" -gt 0 ] || { echo "self-test FAILED: '$fixture' asserts nothing" >&2; exit 1; }
  for text in "$@"; do
    if ! printf '%s\n' "$out" | grep -qF -- "$text"; then
      echo "self-test FAILED: '$fixture' exited $want, but not for its own reason;" >&2
      echo "  the output had to contain: $text" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
  done
  printf '  ok  %-26s exit %s\n' "$fixture" "$got"
}

echo "alert-parity self-test"

fixture clean
# Independently count the fixture corpus with find, not the checker's Python
# enumeration or its output. The documented scope excludes the ADR directory.
# A narrowed sweep must still fail; a legitimate new document must not.
document_count="$(find "$work/clean/docs" -path "$work/clean/docs/adr" -prune \
  -o -type f -name '*.md' -print | wc -l | tr -d '[:space:]')"
[ "$document_count" -gt 2 ] || { echo "self-test FAILED: corpus is not the full documentation tree" >&2; exit 1; }
expect 0 clean \
  "35 catalogued alerts, 1 out of scope" \
  "2 prose restatement(s) of that threshold across $document_count document(s) under docs/, all agreeing"

fixture added-document
mkdir -p "$work/added-document/docs/integration"
printf '%s\n' '# Additional prose coverage' 'Status: Synthetic test document.' \
  > "$work/added-document/docs/integration/extra-prose-coverage.md"
expect 0 added-document \
  "35 catalogued alerts, 1 out of scope" \
  "2 prose restatement(s) of that threshold across $((document_count + 1)) document(s) under docs/, all agreeing"

# ---------------------------------------------------------------- the grain

# The disagreement this check was written for: the sketch counts one thing and
# §5.1 counts another, while both documents still say Sev-1. Stating it needs a
# second entity dimension, so §2.2 gains one first.
fixture grain-disagrees
second_entity grain-disagrees
edit grain-disagrees "$stack" 'count by (tenant_slug)' 'count by (organisation_slug)'
expect 1 grain-disagrees \
  "IdPOutageFleetWide groups by 'organisation_slug'" \
  "counts 'tenants', which is 'tenant_slug'"

# The same disagreement written from the other side.
fixture grain-disagrees-prose
second_entity grain-disagrees-prose
edit grain-disagrees-prose "$slo" '≥ 3 tenants at once' '≥ 3 organisations at once'
expect 1 grain-disagrees-prose \
  "IdPOutageFleetWide groups by 'tenant_slug'" \
  "counts 'organisations', which is 'organisation_slug'"

# A dimension is usable the moment §2.2 declares it. All three statements move
# to organisations, and §2.2 carries the label they moved to, so this is silent.
fixture entity-declared
second_entity entity-declared
edit entity-declared "$stack" 'count by (tenant_slug)' 'count by (organisation_slug)'
edit entity-declared "$slo" '≥ 3 tenants at once' '≥ 3 organisations at once'
edit entity-declared "$slo" 'When three or more tenants fail login at once' \
  'When three or more organisations fail login at once'
expect 0 entity-declared \
  "all agreeing"

# ...and never before it. The same three edits with §2.2 untouched: the
# documents agree with each other about a dimension the pipeline does not carry,
# which is the half of the defect that makes a corrected wording unwritable.
fixture entity-undeclared
edit entity-undeclared "$stack" 'count by (tenant_slug)' 'count by (organisation_slug)'
edit entity-undeclared "$slo" '≥ 3 tenants at once' '≥ 3 organisations at once'
edit entity-undeclared "$slo" 'When three or more tenants fail login at once' \
  'When three or more organisations fail login at once'
expect 1 entity-undeclared \
  "groups by 'organisation_slug', which the required-label table at §2.2 does not declare"

# A flat count: the shape the catalogue carried before the grouping was stated.
# It names no dimension, so it means "series", which means "tenants" — silently.
fixture grain-unstated
edit grain-unstated "$stack" \
  'count(count by (tenant_slug) (gatus_result_success{check="login"} == 0))' \
  'count(gatus_result_success{check="login"} == 0)'
expect 1 grain-unstated \
  "nothing says one series of what"

# A dimension the pipeline does not carry, under an otherwise untouched tree.
fixture grain-undeclared-label
edit grain-undeclared-label "$stack" 'count by (tenant_slug)' 'count by (customer_slug)'
expect 1 grain-undeclared-label \
  "groups by 'customer_slug', which the required-label table at §2.2 does not declare"

# Removing the label from §2.2 must fail for the same reason, from the other
# end: the sketch is unchanged and the dimension is gone.
fixture grain-label-dropped
edit grain-label-dropped "$stack" \
  '| `tenant_slug` | the tenant'"'"'s stable slug, e.g. `lab` |' \
  '| `tenant_slugg` | the tenant'"'"'s stable slug, e.g. `lab` |'
expect 1 grain-label-dropped \
  "groups by 'tenant_slug', which the required-label table at §2.2 does not declare"

# Same unit, different number.
fixture grain-threshold
edit grain-threshold "$stack" \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 3' \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 5'
expect 1 grain-threshold \
  "IdPOutageFleetWide fires at 3 here and at 5 in"

# The count is integer-valued: strictness changes the first firing count.
fixture grain-strict-boundary
edit grain-strict-boundary "$stack" \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 3' \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) > 3'
expect 1 grain-strict-boundary \
  "IdPOutageFleetWide fires at 3 here and at 4 in"

# An equivalent strict expression is valid, not an unsupported comparator.
fixture grain-strict-equivalent
edit grain-strict-equivalent "$stack" \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 3' \
  'count by (tenant_slug) (gatus_result_success{check="login"} == 0)) > 2'
expect 0 grain-strict-equivalent \
  "all agreeing"

# A §5.1 row that no longer states a countable threshold at all.
fixture grain-prose-vague
edit grain-prose-vague "$slo" \
  '`login_availability` bad on ≥ 3 tenants at once' \
  '`login_availability` bad widely at once'
expect 1 grain-prose-vague \
  "does not state a threshold as '≥ N nouns'"

# A noun that is not one of §2.2's entity dimensions.
fixture grain-prose-noun
edit grain-prose-noun "$slo" '≥ 3 tenants at once' '≥ 3 regions at once'
expect 1 grain-prose-noun \
  "counts 'regions', which is not an entity in the required-label table"

# The sketch keeps its fleet-wide count and §5.1 keeps its table, but the row
# that says what the count is of is gone. The unit is then stated nowhere, which
# is not the same as the two documents agreeing about it.
fixture hard-down-row-lost
edit hard-down-row-lost "$slo" \
  '| `IdPOutageFleetWide` | `login_availability` bad on ≥ 3 tenants at once | Sev-1 | phone, any hour |' \
  ''
expect 1 hard-down-row-lost \
  "IdPOutageFleetWide fires on a fleet-wide count in" \
  "has no §5.1 row saying what that count is of"

# The rule binding nothing. With the only fleet-wide count reworded, the run
# must fail rather than report parity over the severities it still compared.
fixture no-fleet-count
edit no-fleet-count "$stack" \
  'count(count by (tenant_slug) (gatus_result_success{check="login"} == 0)) >= 3' \
  'three or more tenants failing the login check'
expect 1 no-fleet-count \
  "no catalogue expression counts across the fleet"

# ------------------------------------------------- the same threshold in prose

# The shape that produced this rule: a threshold stated in three places and
# corrected in two. Here §6's sketch and §5.1 both move to organisations and
# §7.2's bullet — prose, not a table cell — is left behind saying tenants.
# Rules 1 to 4 are green over it; rule 5 is the one that sees it.
fixture restated-noun
second_entity restated-noun
edit restated-noun "$stack" 'count by (tenant_slug)' 'count by (organisation_slug)'
edit restated-noun "$slo" '≥ 3 tenants at once' '≥ 3 organisations at once'
expect 1 restated-noun \
  "SLO.md,line=282" \
  "this sentence counts IdPOutageFleetWide in 'tenants' (tenant_slug)"

fixture restated-number
edit restated-number "$slo" 'When three or more tenants fail login at once' \
  'When five or more tenants fail login at once'
expect 1 restated-number \
  "SLO.md,line=282" \
  "this sentence fires IdPOutageFleetWide at 5"

# A fourth document, which is the case the sweep exists for: the file that held
# the statement left behind was one nobody had thought to list.
fixture restated-elsewhere
mkdir -p "$work/restated-elsewhere/docs/ops"
printf '%s\n' '# On call' '' \
  'When `IdPOutageFleetWide` fires — five or more tenants failing login — wake the rota.' \
  > "$work/restated-elsewhere/docs/ops/ROTA.md"
expect 1 restated-elsewhere \
  "ops/ROTA.md,line=3" \
  "this sentence fires IdPOutageFleetWide at 5"

# A noun that is no dimension at all, in prose.
fixture restated-noun-unknown
edit restated-noun-unknown "$slo" 'When three or more tenants fail login at once' \
  'When three or more regions fail login at once'
expect 1 restated-noun-unknown \
  "counts IdPOutageFleetWide in 'regions', which is not an entity"

# A changelog entry describing the behaviour before a correction is a record of
# a decision, not a restatement of the rule. The sentence planted here states a
# threshold this check would otherwise refuse — five where §6 fires at three —
# so it is the exemption that makes the case pass, not the sentence being
# harmless. Remove the exemption and this reddens.
fixture restated-history-exempt
edit restated-history-exempt "$slo" '## Changelog' '## Changelog

Once upon a time `IdPOutageFleetWide` fired on five or more tenants.'
expect 0 restated-history-exempt \
  "all agreeing"

# ...and the exemption stops at the next heading, so the identical sentence
# after a changelog section is read again.
fixture restated-after-history
mkdir -p "$work/restated-after-history/docs/ops"
printf '%s\n' '# Rota' '' '## Changelog' '' \
  'Once `IdPOutageFleetWide` fired on five or more tenants.' '' \
  '## Today' '' \
  '`IdPOutageFleetWide` still fires on five or more tenants.' \
  > "$work/restated-after-history/docs/ops/ROTA.md"
expect 1 restated-after-history \
  "ops/ROTA.md,line=9" \
  "this sentence fires IdPOutageFleetWide at 5"

# An accepted ADR is never edited, only superseded, so `docs/adr/` is exempt
# wholesale — the same carve-out the realm-topology check makes. The planted
# sentence would fail rule 5 anywhere else, which is what makes this a test.
fixture restated-adr-exempt
printf '%s\n' '' 'Historically `IdPOutageFleetWide` fired on five or more tenants.' \
  >> "$work/restated-adr-exempt/$adr"
expect 0 restated-adr-exempt \
  "all agreeing"

# An ordinary sentence about tenants near an alert name is not a threshold, and
# this one carries both traps: a bare count that disagrees with §6 (`5 tenants`
# where §6 fires at three) and an "or more" with no noun after it. Widen the
# pattern in either direction and this case reddens. If it ever does, the
# pattern has grown into prose it cannot judge.
fixture restated-not-a-threshold
edit restated-not-a-threshold "$stack" \
  '`IdPOutageFleetWide` inhibits per-tenant `TenantLoginFailing`.' \
  '`IdPOutageFleetWide` inhibits per-tenant `TenantLoginFailing`. It has fired across 5 tenants once, and we do not expect three or more.'
expect 0 restated-not-a-threshold \
  "all agreeing"

# ------------------------------------------------------------- the severities

fixture severity-disagrees
edit severity-disagrees "$stack" \
  '| `TenantLoginFailing` | `gatus_result_success{check="login"} == 0` | 3 checks | 2 |' \
  '| `TenantLoginFailing` | `gatus_result_success{check="login"} == 0` | 3 checks | 1 |'
expect 1 severity-disagrees \
  "TenantLoginFailing is Sev-1 in the catalogue and Sev-2 in"

fixture severity-disagrees-slo
edit severity-disagrees-slo "$slo" \
  '`TenantRelayJoinFailing`, `TenantLoginFailing`, `SLOBurnHigh`' \
  '`TenantRelayJoinFailing`, `SLOBurnHigh`'
expect 1 severity-disagrees-slo \
  "TenantLoginFailing is catalogued in §6 but has no row in docs/specs/SLO.md §7.1"

fixture paging-row-phantom
edit paging-row-phantom "$slo" '`SLOBurnMedium`, `SLOBurnSlow`' '`SLOBurnMedium`, `SLOBurnVerySlow`, `SLOBurnSlow`'
expect 1 paging-row-phantom \
  "§7.1 gives SLOBurnVerySlow Sev-3, but no row in docs/specs/OBSERVABILITY_STACK.md §6 catalogues it"

# The one documented exception may not gain a severity, and no second alert may
# quietly become severity-less alongside it.
fixture watchdog-listed
edit watchdog-listed "$slo" '`DeadMansSwitchTriggered`, `ForbiddenLabelObserved`' \
  '`DeadMansSwitchTriggered`, `Watchdog`, `ForbiddenLabelObserved`'
expect 1 watchdog-listed \
  "Watchdog is the documented severity-less exception, so it must have no §7.1 row"

fixture second-severityless
edit second-severityless "$stack" \
  '| `ProbePeerDown` | either Gatus loses the other'"'"'s heartbeat | 5 m | 2 |' \
  '| `ProbePeerDown` | either Gatus loses the other'"'"'s heartbeat | 5 m | — |'
expect 1 second-severityless \
  "ProbePeerDown's Sev cell reads '—'"

# The exception is carved out of the severity rule in both directions. The case
# above is a second alert dropping out of scope; this is the one alert in it
# climbing back in, which is the same decision and needs the same argument.
fixture watchdog-has-severity
edit watchdog-has-severity "$stack" '| — | — | **none' '| — | 1 | **none'
expect 1 watchdog-has-severity \
  "Watchdog is the severity-less exception but its Sev cell reads '1'"

# ------------------------------------------------------------- the escalation

fixture escalation-unlisted
edit escalation-unlisted "$slo" \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-2 |' \
  '| `PreflightStale` | Sev-3 | Sev-2 |'
expect 1 escalation-unlisted \
  "PreflightNightlyFailed's Sev cell escalates to 2, and the Escalations table"

fixture escalation-mismatched
edit escalation-mismatched "$slo" \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-2 |' \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-1 |'
expect 1 escalation-mismatched \
  "PreflightNightlyFailed escalates Sev-3 → Sev-1 here and 3 → 2 in"

# The table is the list, so it may not carry an alert that does not escalate.
fixture escalation-spurious
edit escalation-spurious "$slo" \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-2 |' \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-2 | red twice |
| `PreflightStale` | Sev-3 | Sev-2 |'
expect 1 escalation-spurious \
  "PreflightStale has an Escalations row but a bare Sev cell"

# A severity cell in that table the check cannot read is a refusal, not a row it
# quietly drops — dropped, this is `escalation-unlisted` arriving as a pass.
fixture escalation-cell-malformed
edit escalation-cell-malformed "$slo" \
  '| `PreflightNightlyFailed` | Sev-3 | Sev-2 |' \
  '| `PreflightNightlyFailed` | 3 | Sev-2 |'
expect 1 escalation-cell-malformed \
  "escalation row for PreflightNightlyFailed does not read 'Sev-n' in both severity cells"

# --------------------------------------------------------- unreadable, not fine

# A section the check cannot find is a section it would otherwise report
# agreement with. Every parse failure below is a refusal, never a skip.
# One catalogue subsection renamed out of the pattern. The alerts in it are not
# skipped into agreement: they become §7.1 rows with nothing to compare, and the
# counting rule loses its only alert and says so.
fixture catalogue-section-lost
edit catalogue-section-lost "$stack" '### 6.1 Availability and budget' '### 6a Availability and budget'
expect 1 catalogue-section-lost \
  "§7.1 gives TenantWebDown Sev-1, but no row in docs/specs/OBSERVABILITY_STACK.md §6 catalogues it" \
  "no catalogue expression counts across the fleet"

# Every catalogue subsection renamed: §6.5 still matches nothing but prose, so
# the catalogue is empty. An empty catalogue agrees with any paging table at all,
# which is why it is a refusal and not a pass.
fixture no-catalogue
edit no-catalogue "$stack" '### 6.1 Availability and budget' '### 6a Availability'
edit no-catalogue "$stack" '### 6.2 Saturation and capacity' '### 6b Saturation'
edit no-catalogue "$stack" '### 6.3 Certificates, backups, integrity' '### 6c Certificates'
edit no-catalogue "$stack" '### 6.4 Pipeline integrity' '### 6d Pipeline integrity'
expect 1 no-catalogue \
  "no alert rows found under §6"

fixture no-label-table
edit no-label-table "$stack" '### 2.2 Required labels' '### 2b Required labels'
expect 1 no-label-table \
  "no section matching '^### 2\\\\.2 '"

fixture no-paging-table
edit no-paging-table "$slo" '### 7.1 Which alert pages, and when' '### 7a Which alert pages, and when'
expect 1 no-paging-table \
  "no section matching '^### 7\\\\.1 '"

fixture no-hard-down-table
edit no-hard-down-table "$slo" '### 5.1 Hard-down alerts (symptom first)' '### 5a Hard-down alerts'
expect 1 no-hard-down-table \
  "no section matching '^### 5\\\\.1 '"

fixture duplicate-catalogue-row
edit duplicate-catalogue-row "$stack" \
  '| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.20` | 10 m | 2 | `disk-full.md` |' \
  '| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.20` | 10 m | 2 | `disk-full.md` |
| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.30` | 10 m | 3 | `disk-full.md` |'
expect 1 duplicate-catalogue-row \
  "DiskFillingUp is catalogued twice"

fixture duplicate-paging-row
edit duplicate-paging-row "$slo" '`CertExpiringSoon`, `RestoreDrillStale`' \
  '`CertExpiringSoon`, `CertExpired`, `RestoreDrillStale`'
expect 1 duplicate-paging-row \
  "CertExpired has a second §7.1 row"

# A catalogue row missing its `Sev` column would otherwise be read with the
# runbook cell — or with nothing — as a severity. It is a refusal.
fixture catalogue-row-truncated
edit catalogue-row-truncated "$stack" \
  '| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.20` | 10 m | 2 | `disk-full.md` |' \
  '| `DiskFillingUp` | `node_filesystem_avail_ratio < 0.20` | 10 m |'
expect 1 catalogue-row-truncated \
  'catalogue row for `DiskFillingUp` has 3 cells'

# Pointed at a tree with no documents in it, the check refuses. "Could not look"
# and "looked and found nothing wrong" are the same exit code everywhere else in
# this repository's history, and that is how a gate goes quiet.
mkdir -p "$work/no-documents"
expect 1 no-documents \
  "::error::" \
  "docs/specs/OBSERVABILITY_STACK.md"

echo "self-test passed: a threshold counting the wrong thing from either side, a"
echo "second dimension usable the moment §2.2 declares it and refused before it,"
echo "an unstated grain, a grouping label §2.2 does not declare, a label removed"
echo "from under a sketch, a mismatched threshold, a vague or wrongly-worded"
echo "condition, the rule matching nothing at all, the same threshold restated in"
echo "prose with the wrong unit or the wrong number — in either document or in a"
echo "third one the sweep had never been pointed at — a severity disagreeing"
echo "either way, a phantom paging row, the documented exception given a severity,"
echo "a second alert without one, an escalation missing, mismatched or invented,"
echo "and every table the check reads going missing or gaining a duplicate are all"
echo "caught; a changelog entry, an ADR and an ordinary sentence about tenants are"
echo "not; and every case asserts the sentence it is caught with"
