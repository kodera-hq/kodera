#!/bin/sh
# Arguments are native-owned paths. Rename on one volume, restore the prior app on failure.
set -eu
pid=$1
installed=$2
candidate=$3
stage=$4
backup="$stage/previous.app"
# Bound the handoff so a host that fails to quit cannot leave an immortal helper.
attempt=0
while kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then rm -rf -- "$stage"; exit 1; fi
  sleep 1
done
if ! mv -- "$installed" "$backup"; then /usr/bin/open "$installed" || true; rm -rf -- "$stage"; exit 1; fi
if ! mv -- "$candidate" "$installed"; then
  mv -- "$backup" "$installed"
  /usr/bin/open "$installed" || true
  rm -rf -- "$stage"
  exit 1
fi
if ! /usr/bin/open "$installed"; then
  rm -rf -- "$installed"
  mv -- "$backup" "$installed"
  /usr/bin/open "$installed" || true
fi
rm -rf -- "$stage"
