#!/usr/bin/env bash
# Prepare the single genesis commit a repository is published with.
#
# Non-destructive: it builds ONE parentless commit holding exactly the tree of
# the source ref, points a new branch at it, and proves it. The source branch,
# the index and the working tree are never touched, and no remote is read or
# written. Pushing the genesis branch, and making it the default branch, is a
# separate human step.
#
#   scripts/cutover/prepare-genesis-commit.sh [--source REF] [--branch NAME] [--message TEXT] [--dry-run]
#   scripts/cutover/prepare-genesis-commit.sh --selftest
#
# Refuses, by name: a dirty working tree, an existing target branch, an OpenAPI
# copy that differs from packages/api-contract (where that package exists), a
# tracked .env file, a vendor-attribution finding in the tree or in the commit
# message, a required-clauses finding (where the repository carries a manifest),
# and any result other than one commit whose tree equals the source's.
#
# --dry-run runs every check and builds the commit object, but creates no branch.
set -euo pipefail

SOURCE="main"
BRANCH="genesis"
MESSAGE="Initial public release of Kodera"
DRY_RUN=0
SELFTEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "prepare-genesis-commit: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

blocked() { echo "BLOCKED: $*" >&2; exit 1; }

genesis() {
  local root
  root="$(git rev-parse --show-toplevel)" || blocked "not inside a git repository"
  cd "$root"

  git rev-parse --verify --quiet "${SOURCE}^{commit}" >/dev/null || blocked "source ref '$SOURCE' does not exist"
  [ -z "$(git status --porcelain)" ] || blocked "working tree has uncommitted or untracked changes"
  if [ "$DRY_RUN" -eq 0 ] && git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    blocked "branch '$BRANCH' already exists; delete it or pass --branch"
  fi

  local tree
  tree="$(git rev-parse "${SOURCE}^{tree}")"

  # Every check reads the source tree itself, exported to a scratch directory,
  # so the working tree's checkout cannot stand in for what is committed.
  # `add -f`: a tracked file that a .gitignore also matches is in the genesis
  # tree, so it must be in the scanned copy too.
  local scratch
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' RETURN
  git archive --format=tar "$tree" | tar -x -C "$scratch"
  (cd "$scratch" && git init -q && git add -A -f && git -c user.name=genesis -c user.email=genesis@invalid commit -q -m scan)

  local env_files
  env_files="$(git ls-tree -r --name-only "$tree" | grep -E '(\.env|(^|/)\.env\.[^/]+)$' | grep -vE '\.env\.example$' || true)"
  [ -z "$env_files" ] || blocked "a .env file is tracked: $(head -3 <<<"$env_files" | tr '\n' ' ')"

  if [ -d "$scratch/packages/api-contract" ]; then
    local spec copy
    for spec in "$scratch"/packages/api-contract/*.openapi.yaml; do
      for copy in apps/server/contracts apps/web/contracts; do
        [ -e "$scratch/$copy/$(basename "$spec")" ] || continue
        cmp -s "$spec" "$scratch/$copy/$(basename "$spec")" || blocked "OpenAPI drift: $copy/$(basename "$spec") differs from packages/api-contract"
      done
    done
  fi

  python3 "$scratch/.github/scripts/check-vendor-attribution.py" "$scratch" >/dev/null || blocked "vendor attribution found in the tree"
  printf '%s\n' "$MESSAGE" | python3 "$scratch/.github/scripts/check-vendor-attribution.py" --text commit-message >/dev/null \
    || blocked "vendor attribution found in the commit message"
  printf '%s\n' "$BRANCH" | python3 "$scratch/.github/scripts/check-vendor-attribution.py" --text branch-name >/dev/null \
    || blocked "vendor attribution found in the branch name"
  if [ -f "$scratch/.github/scripts/check-required-clauses.py" ]; then
    python3 "$scratch/.github/scripts/check-required-clauses.py" "$scratch" >/dev/null || blocked "a required clause is missing"
    echo "clauses: checked"
  else
    echo "clauses: this repository carries no clause manifest; not checked"
  fi

  local commit
  commit="$(printf '%s\n' "$MESSAGE" | git commit-tree "$tree")"
  [ "$(git rev-list --count "$commit")" -eq 1 ] || blocked "the genesis commit has history"
  [ -z "$(git rev-list --parents -n 1 "$commit" | cut -s -d' ' -f2)" ] || blocked "the genesis commit has a parent"
  [ "$(git rev-parse "${commit}^{tree}")" = "$tree" ] || blocked "the genesis tree differs from $SOURCE"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "GENESIS DRY RUN OK: commit $commit (not on any branch), tree $tree = $SOURCE, 1 commit"
    return 0
  fi
  git branch "$BRANCH" "$commit"
  [ "$(git rev-list --count "refs/heads/$BRANCH")" -eq 1 ] || blocked "branch '$BRANCH' does not hold exactly one commit"
  echo "GENESIS READY: branch $BRANCH = $commit, tree $tree = $SOURCE, 1 commit; $SOURCE untouched"
}

selftest() {
  local self here work
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  here="$(git -C "$(dirname "$self")" rev-parse --show-toplevel)"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  fixture() {
    rm -rf "$work/repo" && mkdir -p "$work/repo/.github/scripts" "$work/repo/packages/api-contract" "$work/repo/apps/web/contracts"
    cp "$here/.github/scripts/check-vendor-attribution.py" "$work/repo/.github/scripts/"
    [ -f "$here/.github/scripts/vendor-attribution-allowlist.txt" ] && cp "$here/.github/scripts/vendor-attribution-allowlist.txt" "$work/repo/.github/scripts/"
    printf 'openapi: 3.1.0\n' > "$work/repo/packages/api-contract/core-api.openapi.yaml"
    cp "$work/repo/packages/api-contract/core-api.openapi.yaml" "$work/repo/apps/web/contracts/"
    printf 'hello\n' > "$work/repo/README.md"
    (cd "$work/repo" && git init -q -b main && git add -A \
      && git -c user.name=t -c user.email=t@invalid commit -q -m one \
      && printf 'two\n' >> README.md && git -c user.name=t -c user.email=t@invalid commit -qam two)
  }
  run() { (cd "$work/repo" && bash "$self" "$@" 2>&1); }
  expect_block() {
    local label="$1" needle="$2" out status; shift 2
    set +e; out="$(run "$@")"; status=$?; set -e
    if [ "$status" -ne 1 ] || ! grep -qF "$needle" <<<"$out"; then
      echo "selftest FAIL [$label]: expected exit 1 with '$needle', got $status: $out" >&2; exit 1
    fi
    echo "  ok  $label"
  }

  fixture
  local main_before out
  main_before="$(git -C "$work/repo" rev-parse main)"
  out="$(run --dry-run)" || { echo "selftest FAIL [clean dry run]: $out" >&2; exit 1; }
  grep -qF "GENESIS DRY RUN OK" <<<"$out" || { echo "selftest FAIL [clean dry run]: $out" >&2; exit 1; }
  git -C "$work/repo" rev-parse --verify --quiet refs/heads/genesis >/dev/null && { echo "selftest FAIL: dry run created a branch" >&2; exit 1; }
  echo "  ok  clean dry run creates no branch"
  out="$(run)" || { echo "selftest FAIL [clean run]: $out" >&2; exit 1; }
  [ "$(git -C "$work/repo" rev-list --count genesis)" -eq 1 ] || { echo "selftest FAIL: genesis has history" >&2; exit 1; }
  [ "$(git -C "$work/repo" rev-parse genesis^{tree})" = "$(git -C "$work/repo" rev-parse main^{tree})" ] || { echo "selftest FAIL: tree differs" >&2; exit 1; }
  [ "$(git -C "$work/repo" rev-parse main)" = "$main_before" ] || { echo "selftest FAIL: main moved" >&2; exit 1; }
  [ "$(git -C "$work/repo" rev-list --count main)" -eq 2 ] || { echo "selftest FAIL: main lost history" >&2; exit 1; }
  echo "  ok  clean run: one commit, same tree, main untouched"
  expect_block "existing branch" "branch 'genesis' already exists"

  fixture; printf 'dirty\n' >> "$work/repo/README.md"
  expect_block "dirty tree" "working tree has uncommitted"

  fixture; printf 'x\n' > "$work/repo/scratch.txt"
  expect_block "untracked file" "working tree has uncommitted"

  fixture; (cd "$work/repo" && printf 'openapi: 3.0.0\n' > apps/web/contracts/core-api.openapi.yaml && git -c user.name=t -c user.email=t@invalid commit -qam drift)
  expect_block "OpenAPI drift" "OpenAPI drift: apps/web/contracts/core-api.openapi.yaml"

  fixture; (cd "$work/repo" && printf 'K=v\n' > .env.staging && git add -f .env.staging && git -c user.name=t -c user.email=t@invalid commit -qm env)
  expect_block "tracked env file" "a .env file is tracked"

  local vendor
  vendor="$(printf '%s%s' 'Clau' 'de')"
  fixture; (cd "$work/repo" && printf 'Written with %s\n' "$vendor" >> README.md && git -c user.name=t -c user.email=t@invalid commit -qam vendor)
  expect_block "attribution in tree" "vendor attribution found in the tree"

  fixture; (cd "$work/repo" && printf '*.log\n' > .gitignore && printf 'Written with %s\n' "$vendor" > run.log \
    && git add .gitignore && git add -f run.log && git -c user.name=t -c user.email=t@invalid commit -qm ignored)
  expect_block "attribution in a tracked file a .gitignore matches" "vendor attribution found in the tree"

  fixture
  expect_block "attribution in message" "vendor attribution found in the commit message" --message "Co-Authored-By: $vendor <noreply@example.com>"

  fixture; (cd "$work/repo" && mkdir -p tools/tenants && printf 'K=v\n' > tools/tenants/acme.env && git add -f tools/tenants/acme.env && git -c user.name=t -c user.email=t@invalid commit -qm tenant)
  expect_block "tracked name.env file" "a .env file is tracked: tools/tenants/acme.env"

  fixture; (cd "$work/repo" && printf 'K=\n' > .env.example && git add -f .env.example && git -c user.name=t -c user.email=t@invalid commit -qm example)
  out="$(run --dry-run)" || { echo "selftest FAIL [.env.example is allowed]: $out" >&2; exit 1; }
  echo "  ok  .env.example is allowed"

  fixture
  expect_block "missing source" "source ref 'nope' does not exist" --source nope

  echo "prepare-genesis-commit selftest: 13 cases OK"
}

if [ "$SELFTEST" -eq 1 ]; then selftest; else genesis; fi
