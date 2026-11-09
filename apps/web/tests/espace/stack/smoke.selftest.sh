#!/usr/bin/env bash
# Proves smoke.mjs can fail, and says why (docs/dev/ESPACE_STACK.md). Against the running stack:
# - smoke passes;
# - a copy of smoke that does not deactivate the account fails the organisation check, and so do
#   a copy that refreshes with another member's live refresh token and one that signs in as
#   another active member: each of those clauses fails the check on its own;
# - Synapse restarted from a copy of its config with `forget_rooms_on_leave` off makes smoke fail
#   the leave and removal checks at their deadline, while the "nothing posted after" checks still
#   pass on answers of 200 that held the earlier history, so they are proven against a real
#   departed member's history, not passed vacuously;
# - against that Synapse, three copies of smoke, each turning one of those checks' clauses
#   (the history, the event and context reads, the earlier-message control) onto the earlier
#   message, fail them;
# - Synapse restarted from the real config passes again.
# A self-test that only read the exit status would pass on a smoke script that failed for any
# other reason.
set -euo pipefail
cd "$(dirname "$0")"

# expect LABEL STATUS LINE...: each LINE is an extended regular expression that must match a
# whole line of smoke's output. SMOKE names the copy of smoke to run.
expect() {
  local label=$1 status=$2 out code=0 says
  shift 2
  out=$(node "${SMOKE:-smoke.mjs}" 2>&1) || code=$?
  if [ "$code" -ne "$status" ]; then
    printf 'self-test FAILED [%s]: exit %s, expected %s\n%s\n' "$label" "$code" "$status" "$out" >&2
    exit 1
  fi
  for says in "$@"; do
    if ! grep -qxE -- "$says" <<<"$out"; then
      printf 'self-test FAILED [%s]: did not say %q\n%s\n' "$label" "$says" "$out" >&2
      exit 1
    fi
  done
  printf '  ok  %-62s exit %s\n' "$label" "$status"
}

# mutate NAME FROM TO: a copy of smoke with FROM, which must occur exactly once, replaced by TO.
# It sits next to smoke.mjs, which reads the stack's .runtime/config from its own folder.
mutate() {
  local name=$1 from=$2 to=$3
  if [ "$(grep -cF -- "$from" smoke.mjs)" -ne 1 ]; then
    printf 'self-test FAILED [%s]: smoke.mjs does not hold %q exactly once\n' "$name" "$from" >&2
    exit 1
  fi
  FROM=$from TO=$to node -e '
    const fs = require("node:fs")
    fs.writeFileSync(process.argv[1], fs.readFileSync("smoke.mjs", "utf8").replace(process.env.FROM, process.env.TO))
  ' "smoke.$name-mutant.mjs"
  copies+=("smoke.$name-mutant.mjs")
}

organisation='a member who leaves the organisation loses their tokens at once and cannot sign in'
passes=("PASS  $organisation: .*")
fails=() history=() reads=() control=()
for d in left 'was removed' 'was banned'; do
  passes+=("PASS  a member who $d cannot read the history: 403 after [0-9]+ ms, [0-9]+ reads")
  passes+=("PASS  nothing posted after a member $d reaches them: [0-9]+ answers of 200 held only what came before")
done
# Only leaving and removal depend on the setting: Synapse refuses a banned member's history
# whatever it says, so the mutant still passes the ban case, at once.
for d in left 'was removed'; do
  fails+=("FAIL  a member who $d cannot read the history: status 200 at the [0-9]+ ms deadline")
  fails+=("PASS  nothing posted after a member $d reaches them: [1-9][0-9]* answers of 200 held only what came before")
  history+=("FAIL  nothing posted after a member $d reaches them: seen through the history")
  reads+=("FAIL  nothing posted after a member $d reaches them: seen through /event and /context")
  control+=("FAIL  nothing posted after a member $d reaches them: seen through a history without the earlier message")
done
fails+=("PASS  a member who was banned cannot read the history: 403 after [0-9]+ ms, 1 reads")

synapse_from() {
  local log
  if ! log=$(SYNAPSE_CONFIG_DIR=$1 bash bin/compose.sh up -d --wait --force-recreate synapse 2>&1); then
    printf 'self-test FAILED [restart]: Synapse did not come up from %s\n%s\n' "$1" "$log" >&2
    exit 1
  fi
}

mutant=$(mktemp -d)
copies=()
restored=false
# Whatever happens, Synapse ends on its real config and every mutant is removed.
cleanup() {
  if [ "$restored" = false ]; then
    SYNAPSE_CONFIG_DIR=./synapse bash bin/compose.sh up -d --wait --force-recreate synapse >/dev/null 2>&1 || true
  fi
  rm -f "${copies[@]}" || true
  rm -r "$mutant" || true
}
trap cleanup EXIT
cp synapse/* "$mutant/"
grep -q '^forget_rooms_on_leave: true$' "$mutant/homeserver.yaml.tmpl"
sed 's/^forget_rooms_on_leave: true$/forget_rooms_on_leave: false/' synapse/homeserver.yaml.tmpl > "$mutant/homeserver.yaml.tmpl"
chmod -R a+rX "$mutant"

mutate kept 'body: { deactivated: true }' 'body: { deactivated: false }'
# One clause each: a refresh token that is still live (another member's, fresh) and a sign-in as
# another active member must each fail the organisation check on their own.
mutate refresh 'body: { refresh_token: carolLogin.refresh_token }' \
  'body: { refresh_token: (await login(alice)).json.refresh_token }'
mutate signin 'const carolAgain = await login(carol)' 'const carolAgain = await login(alice)'
mutate history 'if (bodies.includes(`after ${tag}`))' 'if (bodies.includes(`before ${tag}`))'
mutate reads '[`event/${afterId}`, `context/${afterId}?limit=0`]' \
  '[`event/${before.json.event_id}`, `context/${before.json.event_id}?limit=0`]'
mutate control '!bodies.includes(`before ${tag}`)' '!bodies.includes(`after ${tag}`)'

expect 'the real stack passes' 0 "${passes[@]}"
SMOKE=smoke.kept-mutant.mjs expect 'an account left active fails the organisation check' 1 "FAIL  $organisation: .*"
SMOKE=smoke.refresh-mutant.mjs expect "a live refresh token fails the organisation check" 1 \
  "FAIL  $organisation: joined 200, deactivate 200, history 401 M_UNKNOWN_TOKEN, refresh 200 undefined, sign-in 403 M_FORBIDDEN"
SMOKE=smoke.signin-mutant.mjs expect 'an active sign-in fails the organisation check' 1 \
  "FAIL  $organisation: joined 200, deactivate 200, history 401 M_UNKNOWN_TOKEN, refresh 401 [A-Z_]+, sign-in 200 undefined"
synapse_from "$mutant"
expect 'forget_rooms_on_leave off fails the leave and removal checks' 1 "${fails[@]}"
SMOKE=smoke.history-mutant.mjs expect 'a leak through the history is caught' 1 "${history[@]}"
SMOKE=smoke.reads-mutant.mjs expect 'a leak through /event or /context is caught' 1 "${reads[@]}"
SMOKE=smoke.control-mutant.mjs expect 'a history without the earlier message is caught' 1 "${control[@]}"
synapse_from ./synapse
restored=true
expect 'the real config restored passes again' 0 "${passes[@]}"
echo 'self-test passed: 9 of 9 cases, each asserting its exit status and its messages'
