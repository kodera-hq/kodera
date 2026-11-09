# create-kodera

Status: Local pre-release package; not published to a registry

A Node-only configuration generator and explicit Cloud claim client. Requires Node
22.22.2 or newer. Runtime uses only the Node standard library; no install or build
step is needed to run the checked-out executable.

```sh
node packages/create-kodera/bin/create-kodera.mjs --selftest
node packages/create-kodera/bin/create-kodera.mjs --self-host \
  --domain chat.example.org --oidc-issuer https://id.example.org/realms/studio \
  --oidc-client-id console --template audiovisual-production --dry-run
```

For a real generated directory, also supply `--trust-file public-trust.json`,
`--source-dir /path/to/community-checkout` and `--output-dir /new/directory`.
The external issuer trust registry must contain public keys, a generation label
and a future expiry. No identity provider or signing trust is invented. The new
output directory contains a mode-0600 environment file, portable Compose assets
and a template intent manifest. Secrets never appear in stdout. Existing directories
are refused. The source checkout is needed to build the actual Community runtime
images; this generator neither publishes images nor runs Docker. An operator starts
Compose explicitly from the generated directory. The template manifest is a
provisioning intent; it does not assert that remote channels already exist.

`--cloud --org Cinema --template audiovisual-production --dry-run` prints a stable
request plan without allocating a tenant. A real allocation requires an explicit
HTTPS Core `--api-url` ending at its API base, for example `/api/v1`, and optionally
`--token-file` pointing to a standalone access-token file, never an environment file.
The endpoint is `/workspaces/instant-claim`. `--idempotency-key` allows checking the
same intent after an uncertain response. Redirects are refused; requests have a
2500ms timeout, including response-body reads. No automatic Cloud retry is made.

After the official package is published, its two bin names are `create-kodera` and
`kodera-deploy`. Commands shown in the console are previews; they do not download
or execute a registry package. No registry publication occurs in this lane.
