#!/bin/sh
# Render the config from the environment, create the signing key once, run.
set -eu
python3 - <<'PY'
import os, re
text = open("/config/homeserver.yaml.tmpl").read()
open("/data/homeserver.yaml", "w").write(re.sub(r"\$\{([A-Z_]+)\}", lambda m: os.environ[m.group(1)], text))
PY
python3 -m synapse.app.homeserver -c /data/homeserver.yaml --generate-keys
exec python3 -m synapse.app.homeserver -c /data/homeserver.yaml
