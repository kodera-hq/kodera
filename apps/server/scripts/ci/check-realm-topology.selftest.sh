#!/usr/bin/env bash
# Proves the realm topology check can fail, and fails for the stated reason.
#
# The previous attempt at this gate ran `git grep -i "realm name" docs` and was
# green while three files in `docs/` said the opposite of ADR-0006. A check
# nobody has watched go red is a decoration, so every case below feeds this one
# an input it must reject, and the run that follows is only trusted because
# these ran first.
#
# Two families of case, and the second is the one with history. The first
# family is detection: a realm-per-tenant sentence, a realm named from a tenant
# slug, an adjective wedged between the possessive and the noun, and the same
# phrase buried in a SCREAMING_SNAKE environment variable — that last one is
# not hypothetical, `\b` does not match after an underscore and the obvious
# regular expression walked straight past `KEYCLOAK_DEV_TENANT_REALMS`. The
# second family is the allowlist. An allowlist elsewhere in this workspace
# enforced only that an entry carried a `reason` key, so every entry was
# accepted and the register stopped meaning anything; the cases here point
# entries at the wrong file, the wrong line, the wrong text, the wrong rule and
# the wrong reason, and each one has to be refused.
#
# ## Two rules this file keeps, both learned by getting them wrong
#
# **Assert on what was said, not only on the exit code.** An exit code cannot
# tell "the entry was refused" from "the entry was accepted and happened to
# cover nothing" — opposite verdicts, same number. So every case names the
# sentence the check has to print. Delete the binding check and all four
# binding cases still exit 1, because the occurrence they no longer exempt is
# still unexempted; only the message says which of those two things happened.
#
# **A register under test is never a tracked file of the fixture it runs
# against.** The check skips whichever register it was handed, so a register
# committed inside a fixture is invisible while it is in use and becomes a
# scanned file quoting the forbidden phrase the moment a different register is
# passed. The first revision of this file kept seven alternate registers beside
# a tracked `allow.toml` whose fifth line reads `match = "tenant realm"`; those
# seven cases exited 1 because of that line, and would have exited 1 with the
# whole allowlist implementation deleted. The alternates now live in
# `$work/registers/`, outside every fixture repository, and the `bindings`
# fixture tracks no register at all. The control that opens that block — the
# correct register, exit 0, one registered exemption — is what makes the failures
# after it attributable: if anything else in the fixture matched, it would be
# red.

# **The rule name is not the message.** Every case below named the rule in
# parentheses and none quoted the sentence beside it, so `WHY[rule]` could be
# replaced by a constant — or the three explanations swapped between the three
# rules — with all cases still green. The offence line is what a reader acts on;
# three cases now pin one explanation each, one per rule.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-realm-topology.py"

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/realm-topology-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/registers"

# A fixture is a tiny git repository, because the check reads the tree through
# `git ls-files` — scanning the working directory instead would count build
# output and a developer's scratch files as documentation.
repo() {
  local name="$1"
  mkdir -p "$work/$name"
  git -C "$work/$name" init -q -b main
}

track() {
  git -C "$work/$1" add -A
}

# $1 expected exit, $2 label, $3 fixture, $4 register path under $work or `-`,
# then one or more strings the output must contain. The strings are the point:
# without them a case proves only that something went wrong somewhere.
expect() {
  local want="$1" label="$2" name="$3" allow="$4" got=0 out="" text
  shift 4
  local -a args=(--root "$work/$name")
  [ "$allow" != "-" ] && args+=(--allowlist "$work/$allow")
  out="$(python3 "$script" "${args[@]}" 2>&1)" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$label' expected exit $want, got $got" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  [ "$#" -gt 0 ] || { echo "self-test FAILED: '$label' asserts nothing" >&2; exit 1; }
  for text in "$@"; do
    if ! printf '%s\n' "$out" | grep -qF -- "$text"; then
      echo "self-test FAILED: '$label' exited $want, but not for its own reason;" >&2
      echo "  the output had to contain: $text" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
  done
  printf '  ok  %-48s exit %s\n' "$label" "$got"
}

echo "realm-topology self-test"

# --- detection ---------------------------------------------------------------

repo clean
cat > "$work/clean/README.md" <<'EOF'
# Topology

One Keycloak realm per organisation, named from the organisation slug. A
tenant slug is a DNS label and a project name, never a realm name, and a
second tenant of the same organisation reuses that organisation's realm.
EOF
track clean
expect 0 "a tree that states the topology correctly" clean - \
  "no realm-per-tenant statement in 1 tracked files"

repo prose
printf 'Keycloak runs with one realm per tenant plus the staff realm.\n' \
  > "$work/prose/AUTHZ.md"
track prose
expect 1 "one realm per tenant, in prose" prose - \
  "'one realm per tenant' makes the realm a tenant's" \
  "ADR-0006 puts the realm on the organisation, not on the tenant" \
  "(realm-per-tenant)" \
  "1 realm-per-tenant statement(s) in 1 file(s)"

# The `realm-per-tenant` rule is four patterns, and the sentence above is caught
# by the longest of them — `one realm per …` — which swallows the other three in
# the containment pass. So each of the remaining three gets a sentence only it
# can see. Without these, three quarters of this rule could be deleted and the
# suite would not notice: the case above would go on passing on the one pattern
# that is left.
repo bare-per-tenant
printf 'The diagram still shows a realm per tenant.\n' > "$work/bare-per-tenant/DIAGRAM.md"
track bare-per-tenant
expect 1 "a realm per tenant, without the word one" bare-per-tenant - \
  "'realm per tenant' makes the realm a tenant's" \
  "(realm-per-tenant)"

repo hyphenated-adjective
printf 'The per-tenant realm is created by the worker.\n' > "$work/hyphenated-adjective/JOBS.md"
track hyphenated-adjective
expect 1 "the phrase used as an adjective, reversed" hyphenated-adjective - \
  "'per-tenant realm' makes the realm a tenant's" \
  "(realm-per-tenant)" \
  "1 realm-per-tenant statement(s) in 1 file(s)"

repo sentence-turned-round
printf 'Every tenant owns a realm in the shared Keycloak.\n' > "$work/sentence-turned-round/NOTES.md"
track sentence-turned-round
expect 1 "the claim made with a verb instead of a preposition" sentence-turned-round - \
  "'Every tenant owns a realm' makes the realm a tenant's" \
  "(realm-per-tenant)"

repo possessive
printf "The provider is applied to the tenant's realm by a job.\\n" \
  > "$work/possessive/MODEL.md"
track possessive
expect 1 "the realm described as the tenant's" possessive - \
  "'tenant's realm' makes the realm a tenant's" \
  "the realm is an organisation property; a tenant owns clients inside it" \
  "(tenant-owned-realm)"

# One separator character between the possessive and the noun is all the
# obvious pattern allows, so an adjective walks straight past it. Two lines of
# a consumer-visible contract said "the tenant's own realm" and "the tenant's
# own Keycloak realm", and the first sweep of this repository counted them as
# absent.
repo own-realm
printf "Federation is brokered by the tenant's own Keycloak realm.\\n" \
  > "$work/own-realm/API.md"
track own-realm
expect 1 "an adjective between possessive and noun" own-realm - \
  "'tenant's own Keycloak realm' makes the realm a tenant's" \
  "(tenant-owned-realm)"

repo fixture-realm
printf '{\n  "realm": "tenant-acme"\n}\n' > "$work/fixture-realm/acme.json"
track fixture-realm
expect 1 "a realm fixture named from a tenant slug" fixture-realm - \
  "acme.json,line=2" \
  "a realm is named from the organisation slug, never from a tenant slug" \
  "(realm-named-from-tenant)"

# `realm-named-from-tenant` is three patterns, and a JSON fixture exercises one
# of them. The other two are the shapes this actually arrives in outside a
# fixture file: a configuration key, and a discovery URL.
repo config-realm
printf 'keycloak:\n  realm: tenant-acme\n' > "$work/config-realm/values.yaml"
track config-realm
expect 1 "a realm named from a tenant in configuration" config-realm - \
  "values.yaml,line=2" \
  "(realm-named-from-tenant)"

repo discovery-url
printf 'Issuer: https://id.kodera.io/realms/tenant-acme\n' > "$work/discovery-url/RUNBOOK.md"
track discovery-url
expect 1 "a realm named from a tenant in a discovery URL" discovery-url - \
  "RUNBOOK.md,line=1" \
  "(realm-named-from-tenant)"

# The hole a `\b`-anchored pattern leaves open: an underscore is a word
# character, so `\btenant` never matches inside a SCREAMING_SNAKE name and the
# one executable statement of the topology went unread.
repo env-var
printf 'KEYCLOAK_DEV_TENANT_REALMS=tenant-acme,tenant-bravo\n' > "$work/env-var/.env.example"
track env-var
expect 1 "the phrase inside a SCREAMING_SNAKE name" env-var - \
  "'TENANT_REALMS' makes the realm a tenant's" \
  "(tenant-owned-realm)"

# The boundary has to hold in the other direction too, or the next reader
# silences the check instead of the statement.
repo multitenant
printf 'The multitenant realm model is described in ADR-0006.\n' \
  > "$work/multitenant/NOTES.md"
track multitenant
expect 0 "a word that merely ends in tenant" multitenant - \
  "no realm-per-tenant statement in 1 tracked files"

# The boundary is two lookarounds, and the case above only exercises the one in
# front. This is the one behind: the sentence ends in an identifier that merely
# begins with `realm`, and a camelCase name is documented as out of this
# scanner's reach — so reading one as a claim about topology would be the check
# widening into text it cannot judge. Every tenant really does get these jobs.
repo realm-identifier
printf 'Every tenant gets a realmUpdate job when a role changes.\n' \
  > "$work/realm-identifier/JOBS.md"
track realm-identifier
expect 0 "an identifier that merely begins with realm" realm-identifier - \
  "no realm-per-tenant statement in 1 tracked files"

# Only tracked files are read. A rendered artefact or a developer's notes
# must not be able to fail this, and must not be able to hide anything either.
repo untracked
printf '# nothing to see\n' > "$work/untracked/README.md"
track untracked
printf 'one realm per tenant\n' > "$work/untracked/scratch.md"
expect 0 "an untracked file is not read" untracked - \
  "no realm-per-tenant statement in 1 tracked files"

# This check, its self-test and its mutation probe all have to spell the
# forbidden phrases out in order to look for them, so they are skipped by name.
repo own-files
mkdir -p "$work/own-files/scripts/ci"
printf 'one realm per tenant\n' \
  > "$work/own-files/scripts/ci/prove-realm-topology-selftest-binds.sh"
track own-files
expect 0 "the check's own files are skipped by name" own-files - \
  "no realm-per-tenant statement in 0 tracked files"

# ...by NAME, and not by directory. A glob over `scripts/ci/` would let the
# next file dropped in there hide a real statement, and that claim is only worth
# the line it is written on if something fails when it stops being true.
repo neighbour-file
mkdir -p "$work/neighbour-file/scripts/ci"
printf 'one realm per tenant\n' \
  > "$work/neighbour-file/scripts/ci/check-something-else.py"
track neighbour-file
expect 1 "a neighbour in the same directory is still read" neighbour-file - \
  "scripts/ci/check-something-else.py,line=1" \
  "(realm-per-tenant)"

# --- the allowlist -----------------------------------------------------------

# The register in use is not scanned, and this case is what pins that: the
# register is a tracked file of its fixture and quotes the forbidden phrase on
# its own line 5. Remove the skip and this goes red.
repo allowed
mkdir -p "$work/allowed/contracts"
printf 'the account lives in the tenant realm and signs in there\n' \
  > "$work/allowed/contracts/api.yaml"
cat > "$work/allowed/allow.toml" <<'EOF'
[[allow]]
path = "contracts/api.yaml"
line = 1
rule = "tenant-owned-realm"
match = "tenant realm"
reason = "deferred-contract"
owner = "the contract branch"
note = "Corrected by the contract polish, which needs a second human reviewer."
EOF
track allowed
expect 0 "a tracked register is not scanned" allowed allowed/allow.toml \
  "1 registered exemption(s)" \
  "contracts/api.yaml:1  tenant-owned-realm  'tenant realm'  [deferred-contract]"

# Every case from here to the end of the binding block runs against `bindings`,
# which tracks no register. `contracts/api.yaml` line 1 carries the one
# occurrence and line 2 carries none; `contracts/other.yaml` is a real tracked
# file with nothing on it, so an entry retargeted onto it fails the binding
# rather than the cheaper "is that a tracked file" test.
repo bindings
mkdir -p "$work/bindings/contracts"
cat > "$work/bindings/contracts/api.yaml" <<'EOF'
the account lives in the tenant realm and signs in there
sessions are minted by the organisation's realm
EOF
printf "roles are groups in the organisation's realm\\n" \
  > "$work/bindings/contracts/other.yaml"
track bindings

cat > "$work/registers/allow.toml" <<'EOF'
[[allow]]
path = "contracts/api.yaml"
line = 1
rule = "tenant-owned-realm"
match = "tenant realm"
reason = "deferred-contract"
owner = "the contract branch"
note = "Corrected by the contract polish, which needs a second human reviewer."
EOF

# The control. Each case below is this register with one field changed, so a
# red run after this one is attributable to that field and to nothing else.
expect 0 "a bound entry, every field true" bindings registers/allow.toml \
  "1 registered exemption(s)" \
  "contracts/api.yaml:1  tenant-owned-realm  'tenant realm'  [deferred-contract]"

# Wrong file, and the file it names is real and tracked.
sed 's|contracts/api.yaml|contracts/other.yaml|' "$work/registers/allow.toml" \
  > "$work/registers/wrong-file.toml"
expect 1 "the same entry, wrong file" bindings registers/wrong-file.toml \
  "entry 1 (contracts/other.yaml:1): stale" \
  "no 'tenant-owned-realm' match of 'tenant realm' on that line" \
  "this check found nothing there"

# Wrong line, and the line it names exists.
sed 's|^line = 1$|line = 2|' "$work/registers/allow.toml" \
  > "$work/registers/wrong-line.toml"
expect 1 "the same entry, wrong line" bindings registers/wrong-line.toml \
  "entry 1 (contracts/api.yaml:2): stale" \
  "this check found nothing there"

# Wrong text: the line is exempt for a phrase that is not the one found there.
sed 's|^match = .*|match = "tenant realms"|' "$work/registers/allow.toml" \
  > "$work/registers/wrong-match.toml"
expect 1 "the same entry, wrong text" bindings registers/wrong-match.toml \
  "no 'tenant-owned-realm' match of 'tenant realms' on that line" \
  "this check found 'tenant realm' (tenant-owned-realm) there"

# Wrong rule, right text. A rule rename must invalidate the entries citing it.
sed 's|^rule = .*|rule = "realm-per-tenant"|' "$work/registers/allow.toml" \
  > "$work/registers/wrong-rule.toml"
expect 1 "the same entry, wrong rule" bindings registers/wrong-rule.toml \
  "no 'realm-per-tenant' match of 'tenant realm' on that line" \
  "this check found 'tenant realm' (tenant-owned-realm) there"

# A rule that does not exist at all is refused before the binding is consulted,
# so a typo reads as a typo rather than as a stale entry.
sed 's|^rule = .*|rule = "realm-belongs-to-tenant"|' "$work/registers/allow.toml" \
  > "$work/registers/invented-rule.toml"
expect 1 "a rule outside the vocabulary" bindings registers/invented-rule.toml \
  "\`rule\` is 'realm-belongs-to-tenant', not one of"

# A path nothing tracks.
sed 's|contracts/api.yaml|contracts/absent.yaml|' "$work/registers/allow.toml" \
  > "$work/registers/absent-file.toml"
expect 1 "an entry pointed at no tracked file" bindings registers/absent-file.toml \
  "'contracts/absent.yaml' is not a tracked text file"

# A line number past the end of a file that is otherwise the right one.
sed 's|^line = 1$|line = 99|' "$work/registers/allow.toml" \
  > "$work/registers/past-end.toml"
expect 1 "an entry past the end of its file" bindings registers/past-end.toml \
  "'contracts/api.yaml' has 2 lines; line 99 is not one"

# A reason outside the vocabulary. This is the failure being guarded against:
# a plausible-sounding string must not buy an exemption.
sed 's|^reason = .*|reason = "agreed with the team"|' "$work/registers/allow.toml" \
  > "$work/registers/invented-reason.toml"
expect 1 "a reason outside the vocabulary" bindings registers/invented-reason.toml \
  "\`reason\` is 'agreed with the team', not one of"

# `deferred-contract` names an owner, or nobody is carrying the deferral.
grep -v '^owner = ' "$work/registers/allow.toml" > "$work/registers/no-owner.toml"
expect 1 "a deferral nobody owns" bindings registers/no-owner.toml \
  "reason 'deferred-contract' requires a non-empty \`owner\`"

# A line number is a number, and a string that looks like one is not.
sed 's|^line = 1$|line = "1"|' "$work/registers/allow.toml" \
  > "$work/registers/line-string.toml"
expect 1 "a line number written as a string" bindings registers/line-string.toml \
  "\`line\` must be an integer"

# Nothing rests on what a note says, but an entry with no note is one nobody
# has explained.
sed 's|^note = .*|note = "   "|' "$work/registers/allow.toml" \
  > "$work/registers/empty-note.toml"
expect 1 "an entry whose note is whitespace" bindings registers/empty-note.toml \
  "\`note\` is empty"

# The same exemption written twice hides how many occurrences are really held.
cat > "$work/registers/duplicate.toml" <<'EOF'
[[allow]]
path = "contracts/api.yaml"
line = 1
rule = "tenant-owned-realm"
match = "tenant realm"
reason = "deferred-contract"
owner = "the contract branch"
note = "First."

[[allow]]
path = "contracts/api.yaml"
line = 1
rule = "tenant-owned-realm"
match = "tenant realm"
reason = "deferred-contract"
owner = "the contract branch"
note = "Second, addressing the same occurrence."
EOF
expect 1 "the same occurrence exempted twice" bindings registers/duplicate.toml \
  "entry 2 repeats entry 1: contracts/api.yaml:1 'tenant realm'"

# An entry that is a reason and nothing else. This is the exact shape the
# tokens repository shipped, and it must not be enough.
cat > "$work/registers/bare-reason.toml" <<'EOF'
[[allow]]
reason = "deferred-contract"
EOF
expect 1 "an entry that is a reason and nothing else" bindings registers/bare-reason.toml \
  "entry 1: missing \`path\`"

# An unreadable register is not an empty one.
printf 'allow = [ this is not toml\n' > "$work/registers/broken.toml"
expect 1 "a register that is not valid TOML" bindings registers/broken.toml \
  "::error file=broken.toml::" \
  "1 allowlist entr(y/ies) did not hold up."

# `allow` is an array of tables, not whatever else happens to parse.
printf 'allow = "everything"\n' > "$work/registers/allow-not-a-list.toml"
expect 1 "a register whose allow is not a list" bindings registers/allow-not-a-list.toml \
  "\`allow\` must be an array of tables"

# The reason's own condition. `deferred-contract` claims the correction belongs
# to a contract review, so it is refused for a file that is not a contract.
repo not-a-contract
mkdir -p "$work/not-a-contract/docs"
printf 'the account lives in the tenant realm and signs in there\n' \
  > "$work/not-a-contract/docs/api.md"
track not-a-contract
cat > "$work/registers/not-a-contract.toml" <<'EOF'
[[allow]]
path = "docs/api.md"
line = 1
rule = "tenant-owned-realm"
match = "tenant realm"
reason = "deferred-contract"
owner = "the contract branch"
note = "Not a contract, so this reason does not apply."
EOF
expect 1 "deferred-contract outside contracts/" not-a-contract registers/not-a-contract.toml \
  "reason 'deferred-contract' requires that the file is under contracts/"

# `historical-quotation` has a condition too: the line must actually sit in a
# section that records history.
repo history
cat > "$work/history/SPEC.md" <<'EOF'
# Spec

The realm is an organisation property.

## Changelog

- Revision 1 said one realm per tenant; ADR-0006 replaced that reading.
EOF
track history
cat > "$work/registers/history.toml" <<'EOF'
[[allow]]
path = "SPEC.md"
line = 7
rule = "realm-per-tenant"
match = "one realm per tenant"
reason = "historical-quotation"
note = "The changelog records what an earlier revision said."
EOF
expect 0 "a quotation inside a changelog" history registers/history.toml \
  "1 registered exemption(s)" \
  "SPEC.md:7  realm-per-tenant  'one realm per tenant'  [historical-quotation]"

# The same quotation, the same reason, moved out of the changelog: now it is a
# live statement wearing a historical label.
repo history-elsewhere
cat > "$work/history-elsewhere/SPEC.md" <<'EOF'
# Spec

## Topology

Keycloak is configured with one realm per tenant.
EOF
track history-elsewhere
cat > "$work/registers/history-elsewhere.toml" <<'EOF'
[[allow]]
path = "SPEC.md"
line = 5
rule = "realm-per-tenant"
match = "one realm per tenant"
reason = "historical-quotation"
note = "Claims to be history while sitting under a topology heading."
EOF
expect 1 "the same quotation outside one" history-elsewhere registers/history-elsewhere.toml \
  "reason 'historical-quotation' requires that the line sits under a changelog"

# A stale entry: the line was fixed, the exemption outlived it. Same register
# as the control, against a fixture where the sentence has been corrected.
repo stale
mkdir -p "$work/stale/contracts"
printf "the account lives in the organisation's realm\\n" > "$work/stale/contracts/api.yaml"
track stale
expect 1 "an entry the fix left behind" stale registers/allow.toml \
  "entry 1 (contracts/api.yaml:1): stale" \
  "this check found nothing there" \
  "1 allowlist entr(y/ies) did not hold up."

echo "self-test passed: each of the four phrasings of the topology claim — with"
echo "and without the word one, reversed into an adjective, and turned round onto"
echo "a verb — a realm named from a tenant in a fixture, in configuration and in a"
echo "discovery URL, the realm called the tenant's with and without an adjective"
echo "in the way, and the phrase buried in an environment variable are all caught;"
echo "a word that merely ends in tenant, an identifier that merely begins with"
echo "realm, an untracked file and this check's own files are not; a neighbour in"
echo "the same directory still is, because the skip list is names and not a glob;"
echo "and an allowlist entry pointed at the wrong file, line, text, rule or reason"
echo "— or duplicated, or left behind by the fix it excused, or carrying a reason"
echo "and nothing else — is refused. Every case asserts the sentence it is caught"
echo "with, and prove-realm-topology-selftest-binds.sh proves each case is the one"
echo "that owns its clause."
