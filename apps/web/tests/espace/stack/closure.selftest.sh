#!/usr/bin/env bash
# Proves closure.mjs can fail, and says why (docs/dev/ESPACE_STACK.md). Against the running stack
# with the audio profile: closure passes; a copy whose second channel set keeps bob (the agent
# re-applies the original members) exits non-zero AND prints the kick check's FAIL line; a copy
# whose channel set after dave's reactivation leaves him out prints the rejoin check's; and the
# real script, with the agent run from a Core checkout without the fix that joins room-access to a
# new audio room (CORE_MAIN, by default a core-main checkout beside this one), exits 1 AND
# prints that check's FAIL line. Room-access itself stays the container's. A self-test that only
# read the exit status would pass on a script that failed for any other reason.
set -euo pipefail
cd "$(dirname "$0")"

mutant=$(mktemp -d)
trap 'rm -r "$mutant"' EXIT

# A Core checkout whose tenant agent only invites room-access to a new audio room.
core_main=${CORE_MAIN:-$(cd ../../../../ && pwd)/core-main}
test -f "$core_main/tenant_agent/handlers.py" || {
  printf 'self-test FAILED [setup]: no Core checkout at %s (set CORE_MAIN)\n' "$core_main" >&2
  exit 1
}
if grep -qF 'if not synapse.join(room_id, access):' "$core_main/tenant_agent/channels.py"; then
  printf 'self-test FAILED [setup]: %s already carries the fix\n' "$core_main" >&2
  exit 1
fi

expect() {
  local label=$1 script=$2 status=$3 says=$4 core=${5:-${CORE_SRC:-}} out code=0
  out=$(ESPACE_STACK_DIR=$PWD CORE_SRC=$core node "$script" 2>&1) || code=$?
  if [ "$code" -ne "$status" ]; then
    printf 'self-test FAILED [%s]: exit %s, expected %s\n%s\n' "$label" "$code" "$status" "$out" >&2
    exit 1
  fi
  if ! grep -qF -- "$says" <<<"$out"; then
    printf 'self-test FAILED [%s]: did not say %q\n%s\n' "$label" "$says" "$out" >&2
    exit 1
  fi
  printf '  ok  %-64s exit %s\n' "$label" "$status"
}

removal='const remaining = everyone.filter((subject) => subject !== bob.subject)'
grep -qF -- "$removal" closure.mjs
sed "s/^const remaining = everyone\.filter((subject) => subject !== bob\.subject)$/const remaining = everyone/" \
  closure.mjs > "$mutant/closure.mjs"
if cmp -s closure.mjs "$mutant/closure.mjs"; then
  echo 'self-test FAILED [mutant]: the mutation did not apply' >&2
  exit 1
fi
rejoin='const rejoining = await agent('"'"'apply'"'"', channelSet(3, [alice.subject, dave.subject]))'
test "$(grep -cF -- "$rejoin" closure.mjs)" -eq 1 || {
  echo 'self-test FAILED [mutant]: the rejoin line is not in closure.mjs exactly once' >&2
  exit 1
}
mkdir "$mutant/rejoin"
REJOIN=$rejoin node -e '
  const fs = require("node:fs")
  const to = process.env.REJOIN.replace("[alice.subject, dave.subject]", "[alice.subject]")
  fs.writeFileSync(process.argv[1], fs.readFileSync("closure.mjs", "utf8").replace(process.env.REJOIN, to))
' "$mutant/rejoin/closure.mjs"
if cmp -s closure.mjs "$mutant/rejoin/closure.mjs"; then
  echo 'self-test FAILED [mutant]: the rejoin mutation did not apply' >&2
  exit 1
fi

expect 'the real script passes' closure.mjs 0 'PASS  channel removal: bob is kicked from both rooms'
expect 'keeping bob in the channels fails the kick check' "$mutant/closure.mjs" 1 \
  'FAIL  channel removal: bob is kicked from both rooms: text never, audio never'
expect 'leaving dave out after his reactivation fails the rejoin check' "$mutant/rejoin/closure.mjs" 1 \
  'FAIL  reactivation: 5 s on, dave is joined to both rooms: text leave, audio leave'
expect "the agent without Core's fix fails the room-access join check" closure.mjs 1 \
  'FAIL  room-access is joined to the new audio room when the agent returns: membership invite' \
  "$core_main"
echo 'self-test passed: 4 of 4 cases, each asserting its exit status and its message'
