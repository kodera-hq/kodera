#!/usr/bin/env bash
# Proves the authorisation cross-check can fail, and fails for the stated reason.
#
# Every case below mutates a copy of the matrix, the contract or the check
# itself, runs the check, and asserts two things: exit status 1, and that the
# output names what was mutated. An exit code alone proves a check can go red;
# only the message proves it went red for the right reason — a check that
# refuses everything would pass an exit-code-only self-test.
#
# The baseline case is the third proof: the unmutated inputs must PASS, so a
# refusal above is caused by the mutation and not by the tree.

# The sed expressions below carry literal backticks because the matrix cells
# they edit are Markdown code spans; the shell must not expand them.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
script="$here/check-authz-matrix.py"
authz="$root/docs/api/AUTHZ.md"
contract="$root/contracts/core-api.openapi.yaml"

for f in "$script" "$authz" "$contract"; do
  [ -f "$f" ] || { echo "self-test FAILED: $f is missing" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/authz-matrix-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

caught=0

# fresh <label>: copies of the three inputs to mutate.
fresh() {
  mkdir -p "$work/$1"
  cp "$script" "$work/$1/check.py"
  cp "$authz" "$work/$1/AUTHZ.md"
  cp "$contract" "$work/$1/core-api.openapi.yaml"
}

# mutated <file> <before-copy>: the mutation must have changed the file, or the
# case would be asserting on an unmutated input.
mutated() {
  if cmp -s "$1" "$2"; then
    echo "self-test FAILED: mutation did not change $1" >&2
    exit 1
  fi
}

# append_role <contract> <operationId> <role>: add a role to that operation's
# x-kodera-authz, anchored on the operationId rather than on a line number.
append_role() {
  local before="$1.before"
  cp "$1" "$before"
  awk -v op="$2" -v role="$3" '
    $0 ~ ("operationId: " op "$") { armed = 1 }
    armed && /^ *roles: \[/ { sub(/\]/, ", " role "]"); armed = 0 }
    { print }
  ' "$before" > "$1"
  mutated "$1" "$before"
}

# drop_authz <contract> <operationId>: remove that operation's x-kodera-authz
# block (the key line and its roles line).
drop_authz() {
  local before="$1.before"
  cp "$1" "$before"
  awk -v op="$2" '
    $0 ~ ("operationId: " op "$") { armed = 1 }
    armed && /^ *x-kodera-authz:/ { skip = 2; armed = 0 }
    skip > 0 { skip--; next }
    { print }
  ' "$before" > "$1"
  mutated "$1" "$before"
}

# edit <file> <sed-expression>: apply one sed edit, and insist it changed something.
edit() {
  local before="$1.before"
  cp "$1" "$before"
  sed -E "$2" "$before" > "$1"
  mutated "$1" "$before"
}

# expect_pass <label>
expect_pass() {
  local out got=0
  out="$(python3 "$work/$1/check.py" --authz "$work/$1/AUTHZ.md" --contract "$work/$1/core-api.openapi.yaml" 2>&1)" || got=$?
  if [ "$got" -ne 0 ] || ! grep -qF "PASS no operation grants a role" <<<"$out"; then
    echo "self-test FAILED: '$1' expected exit 0 with PASS, got exit $got:" >&2
    echo "$out" >&2
    exit 1
  fi
  printf '  ok  %-34s exit 0, PASS\n' "$1"
}

# expect_refusal <label> <message fragment>...: exit 1, and every fragment present.
expect_refusal() {
  local label="$1" out got=0 fragment
  shift
  out="$(python3 "$work/$label/check.py" --authz "$work/$label/AUTHZ.md" --contract "$work/$label/core-api.openapi.yaml" 2>&1)" || got=$?
  if [ "$got" -ne 1 ]; then
    echo "self-test FAILED: '$label' expected exit 1, got $got:" >&2
    echo "$out" >&2
    exit 1
  fi
  for fragment in "$@"; do
    if ! grep -qF -- "$fragment" <<<"$out"; then
      echo "self-test FAILED: '$label' refused, but not for the stated reason; missing: $fragment" >&2
      echo "$out" >&2
      exit 1
    fi
  done
  caught=$((caught + 1))
  printf '  ok  %-34s exit 1, names: %s\n' "$label" "$1"
}

echo "authz-matrix self-test"

fresh baseline
expect_pass baseline

# 1. An operation wider than its cell: the drift this check exists to catch.
fresh widen-operation
append_role "$work/widen-operation/core-api.openapi.yaml" inviteToOrganisation staff_support
expect_refusal widen-operation "inviteToOrganisation" "grants ['staff_support'] beyond its cell" "row \`invitation\` verb \`create\`"

# 2. The same widening by `staff_operator`, the over-grant the narrowing removed:
#    a check that exempted that one role from the comparison would still pass
#    case 1, so this case names the role on its own.
fresh widen-operation-staff-operator
append_role "$work/widen-operation-staff-operator/core-api.openapi.yaml" inviteToOrganisation staff_operator
expect_refusal widen-operation-staff-operator "inviteToOrganisation" "grants ['staff_operator'] beyond its cell" "row \`invitation\` verb \`create\`"

# 3. The same widening from the tenant family: `org_admin` re-added to
#    generateDpa, whose cell (shared with acceptDpa) holds the owner only.
fresh widen-operation-org-admin
append_role "$work/widen-operation-org-admin/core-api.openapi.yaml" generateDpa org_admin
expect_refusal widen-operation-org-admin "generateDpa" "grants ['org_admin'] beyond its cell" "row \`dpa_acceptance\` verb \`create\`"

# 4. A cell narrowed under an unchanged contract: the same drift from the other side.
fresh narrow-cell
edit "$work/narrow-cell/AUTHZ.md" 's/^(\| `Invitation` \| full own \| )full own/\1read own/'
expect_refusal narrow-cell "inviteToOrganisation" "grants ['org_admin'] beyond its cell" "row \`invitation\` verb \`create\`"

# 5. An operation with no x-kodera-authz: deny-by-default, never default-open.
fresh drop-authz
drop_authz "$work/drop-authz/core-api.openapi.yaml" revokeEnrolmentToken
expect_refusal drop-authz "revokeEnrolmentToken" "no x-kodera-authz.roles"

# 6. A grant phrase the check does not know: refused by name, never silently ignored.
fresh unknown-phrase
edit "$work/unknown-phrase/AUTHZ.md" 's/^(\| `Contact` \| full own \| )full own/\1bless own/'
expect_refusal unknown-phrase "unknown grant phrase 'bless'" "column \`org_admin\`"

# 7. The invitation overrides removed from the check: each operation then
#    reads as a cell, and `invited` is not a column.
fresh drop-override-handling
edit "$work/drop-override-handling/check.py" 's/if oid in OVERRIDES:/if oid in {}:/'
expect_refusal drop-override-handling "acceptInvitation" "previewInvitation" "names \`invited\`"

# 8. The sentence that states the override removed from AUTHZ.md: an override
#    the spec no longer states is not an override.
fresh drop-override-sentence
edit "$work/drop-override-sentence/AUTHZ.md" 's/Both operations also name the four organisation roles, deliberately/Both operations also name the four organisation roles/'
expect_refusal drop-override-sentence "acceptInvitation" "previewInvitation" "its override is not stated in"

# 8b. The preview dropped from the §4 row: its override goes with it, while
#     acceptance's shared sentence still stands.
fresh drop-preview-sentence
edit "$work/drop-preview-sentence/AUTHZ.md" 's/`POST \/invitations\/preview`, the read-only card shown before it from the same token/the read-only card/'
expect_refusal drop-preview-sentence "previewInvitation" "its override is not stated in"

# 9. The matrix parser made to skip a row: the skipped resource is then not a
#    row, and every operation scoped to it is refused rather than uncounted.
fresh parser-skips-row
edit "$work/parser-skips-row/check.py" 's/for number, row in rows\[2:\]:/for number, row in rows[3:]:/'
expect_refusal parser-skips-row "scope resource 'organisation' is not a row"

# 10. A row deleted from the matrix: same refusal, from the input side.
fresh drop-row
edit "$work/drop-row/AUTHZ.md" '/^\| `Invitation` \|/d'
expect_refusal drop-row "inviteToOrganisation" "scope resource 'invitation' is not a row"

# 11. A row with the wrong number of cells: refused with its line, never guessed.
fresh malformed-row
edit "$work/malformed-row/AUTHZ.md" 's/^(\| `Contact` \| full own \| )full own \| /\1/'
expect_refusal malformed-row "cannot read this matrix row" "AUTHZ.md:"

# 12. A role that is not a column of the matrix.
fresh unknown-role
append_role "$work/unknown-role/core-api.openapi.yaml" patchMe staff_ghost
expect_refusal unknown-role "patchMe" "names ['staff_ghost'], not a column"

# 13. `anonymous` on a resource the rule under the matrix does not list.
fresh anonymous-elsewhere
append_role "$work/anonymous-elsewhere/core-api.openapi.yaml" listMemberships anonymous
expect_refusal anonymous-elsewhere "listMemberships" "names \`anonymous\` on \`membership\`"

# 14. `anonymous` on a row the rule reaches through one named operation only:
#     getOrganisation shares the `organisation` row with discoverRealm, and the
#     allowance is keyed by operation id, so the row does not carry it.
fresh anonymous-on-getOrganisation
append_role "$work/anonymous-on-getOrganisation/core-api.openapi.yaml" getOrganisation anonymous
expect_refusal anonymous-on-getOrganisation "getOrganisation" "names \`anonymous\` on \`organisation\`" "getOrganisation is not one of the operations it names"

# 15. `invited` on any operation but acceptInvitation and previewInvitation.
fresh invited-elsewhere
append_role "$work/invited-elsewhere/core-api.openapi.yaml" listMemberships invited
expect_refusal invited-elsewhere "listMemberships" "grants to acceptInvitation and previewInvitation only"

# 15b. The preview widened beyond its override: it is checked against the exact
#      role set, never as a cell it could fit.
fresh preview-widened
append_role "$work/preview-widened/core-api.openapi.yaml" previewInvitation staff_support
expect_refusal preview-widened "previewInvitation" "override in"

# 16. An `operationId:` line the method-key walk does not count as an operation:
#     the independent witness disagrees with the walk, and the check refuses
#     rather than reporting coverage it does not have.
fresh duplicate-operationid
edit "$work/duplicate-operationid/core-api.openapi.yaml" '/^ *operationId: listMemberships$/p'
expect_refusal duplicate-operationid "operationId" "an operation is not where this check looks"

# 17. `bootstrap` on any operation but the two the closed list names.
fresh bootstrap-elsewhere
append_role "$work/bootstrap-elsewhere/core-api.openapi.yaml" listMemberships bootstrap
expect_refusal bootstrap-elsewhere "listMemberships" "names \`bootstrap\`" "only"

# 18. The closed list emptied in the check: the operations that legitimately
#     name `bootstrap` are then refused, which proves the list is load-bearing.
fresh drop-bootstrap-list
edit "$work/drop-bootstrap-list/check.py" 's/^BOOTSTRAP_OPERATIONS = frozenset\(\{.*\}\)$/BOOTSTRAP_OPERATIONS = frozenset()/'
expect_refusal drop-bootstrap-list "getOrganisationBootstrap" "names \`bootstrap\`" "only"

# 19. The sentence that states the closed list removed from AUTHZ.md: a list
#     the spec no longer states authorises nothing.
fresh drop-bootstrap-sentence
edit "$work/drop-bootstrap-sentence/AUTHZ.md" 's/`bootstrap` reaches exactly two operations, `getOrganisationBootstrap` and `consumeOwnerClaim`/`bootstrap` reaches two operations/'
expect_refusal drop-bootstrap-sentence "getOrganisationBootstrap" "no longer states"

# 20. The sentence that states the consumeOwnerClaim override removed: the
#     operation then reads as a cell, and no column holds `act` on the claim.
fresh drop-claim-override-sentence
edit "$work/drop-claim-override-sentence/AUTHZ.md" 's/That operation also names `org_owner`, deliberately/That operation also names `org_owner`/'
expect_refusal drop-claim-override-sentence "consumeOwnerClaim" "its override is not stated in"

echo "self-test passed: $caught mutations caught, each by the message that names it"
