#!/usr/bin/env bash
# Proves the migrations-check self-test is bound to the check, one clause at a time.
#
# `check-migrations-complete.selftest.sh` proves the check can fail. It does
# not prove every clause of the check is still doing work: a clause no case
# depends on alone can be deleted while the suite stays green. So every
# mutation below weakens exactly one clause and asserts two things: the suite
# refuses, and it refuses AT THE CASE THAT OWNS THE CLAUSE. A mutation caught
# by an unrelated case proves only that the suite is noisy.
#
# The unmutated suite runs first. Without that baseline, every refusal below
# could be the tree rather than the mutation.
#
# Run it through `uv run`, with the database the job provides, as the self-test.

# The replacement strings are fragments of Python quoted exactly as the check
# writes them. Nothing in them is meant to expand.
# shellcheck disable=SC2016

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
check="$here/check-migrations-complete.py"
selftest="$here/check-migrations-complete.selftest.sh"
expected_mutations=16

for f in "$check" "$selftest"; do
  [ -f "$f" ] || { echo "mutation probe FAILED: $f is missing" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/migrations-check-mutations.XXXXXX")"
trap 'rm -rf "$work"' EXIT
caught=0

# suite <dir>: run the self-test copied into <dir>, against this tree.
suite() {
  MIGRATIONS_SELFTEST_TREE="$root" bash "$1/check-migrations-complete.selftest.sh" 2>&1
}

echo "migrations-check mutation probe"
mkdir "$work/baseline"
cp "$check" "$selftest" "$work/baseline/"
if ! out="$(suite "$work/baseline")"; then
  echo "mutation probe FAILED: the unmutated suite does not pass" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
printf '  ok  %-32s the unmutated suite passes\n' baseline

# mutate <label> <case> <old> <new>: <case> must be the one that refuses.
mutate() {
  local label="$1" case="$2" old="$3" new="$4" dir="$work/$1" out got=0
  mkdir "$dir"
  cp "$check" "$selftest" "$dir/"
  python3 - "$dir/check-migrations-complete.py" "$old" "$new" <<'PY'
import sys

path, old, new = sys.argv[1:4]
with open(path, encoding="utf-8") as handle:
    body = handle.read()
count = body.count(old)
if count != 1:
    sys.exit(f"mutation probe is broken: {old!r} appears {count} times in {path}, wanted 1")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(body.replace(old, new, 1))
PY
  # A mutation that only breaks the syntax fails every case at once, `clean`
  # included, which would read as proof for any clause declared to `clean`.
  if ! python3 -m py_compile "$dir/check-migrations-complete.py" 2>/dev/null; then
    echo "mutation probe is broken: '$label' does not compile; it proves nothing" >&2
    exit 1
  fi
  out="$(suite "$dir")" || got=$?
  if [ "$got" -eq 0 ]; then
    echo "mutation probe FAILED: '$label' survived; the suite passed with that clause weakened" >&2
    exit 1
  fi
  if ! grep -qF -- "self-test FAILED: '$case'" <<<"$out"; then
    echo "mutation probe FAILED: '$label' was caught, but not by '$case'" >&2
    printf '%s\n' "$out" | tail -20 >&2
    exit 1
  fi
  caught=$((caught + 1))
  printf '  ok  %-32s caught by %s\n' "$label" "$case"
}

mutate makemigrations-not-run clean \
  '    execute_from_command_line(["manage.py", "makemigrations", "--check", "--dry-run", *labels])' \
  '    pass'

mutate check-flag-dropped orgs-field-without-migration \
  '"makemigrations", "--check", "--dry-run", *labels' \
  '"makemigrations", "--dry-run", *labels'

mutate labels-not-passed installed-app-without-migrations \
  '"--check", "--dry-run", *labels]' \
  '"--check", "--dry-run"]'

mutate guard-disabled settings-drop-orgs \
  '    missing = [name for name in required if name not in installed]' \
  '    missing = []'

mutate refusal-exits-1 settings-drop-orgs \
  'REFUSED = 2' \
  'REFUSED = 1'

mutate apps-py-models-clause-removed app-without-migrations \
  'if has_migrations or (has_models and "apps.py" in files):' \
  'if has_migrations:'

mutate models-package-clause-removed models-package-without-migrations \
  'has_models = "models.py" in files or (here / "models" / "__init__.py").is_file()' \
  'has_models = "models.py" in files'

mutate migrations-clause-removed migrations-outside-apps \
  'if has_migrations or (has_models and "apps.py" in files):' \
  'if has_models and "apps.py" in files:'

mutate walk-stops-at-depth-2 deep-package \
  '        if here == root:' \
  '        if here == root or len(here.relative_to(root).parts) > 2:'

mutate walk-enters-dot-directories walk-skips-dot-directories \
  'return any(part.startswith(".") or part in PRUNED for part in parts)' \
  'return any(part in PRUNED for part in parts)'

mutate walk-enters-node-modules walk-skips-node-modules \
  'PRUNED = {"node_modules", "__pycache__"}' \
  'PRUNED = {"__pycache__"}'

mutate labels-include-outside-tree third-party-outside-tree \
  '        except ValueError:
            continue' \
  '        except ValueError:
            parts = ()'

mutate labels-include-pruned-paths third-party-in-dot-directory \
  '        if not pruned(parts):
            labels.append(config.label)' \
  '        labels.append(config.label)'

mutate empty-walk-accepted nothing-to-look-at \
  '    if not required:' \
  '    if False:'

mutate unvalidated-constraints-ignored unvalidated-constraint \
  '    return sorted((added - validated) | direct)' \
  '    return sorted(direct)'

mutate append-only-direct-check-ignored append-only-check-without-not-valid \
  '    return sorted((added - validated) | direct)' \
  '    return sorted(added - validated)'

if [ "$caught" -ne "$expected_mutations" ]; then
  echo "mutation probe FAILED: $caught of $expected_mutations mutations ran" >&2
  exit 1
fi
echo "mutation probe passed: $caught weakenings, each refused by the case that owns its clause"
