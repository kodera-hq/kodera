# Quickstart & self-hosting

> Prepare your workspace. Keep identity and deployment under your control.

## Start with a configuration plan

From a checkout of kodera-hq/kodera, run the dependency-free Node CLI. This dry run validates public domain, external HTTPS issuer and template without creating files or services.

The five templates are audiovisual-production, tech-studio, b2b-advisory, public-sector and proximity; crisis-cell is a permanent alias of proximity. The audiovisual template includes a Frame.io connector intent.

> The CLI is a local pre-release. Registry publication is not confirmed; use the checked-out executable now.

```bash
node packages/create-kodera/bin/create-kodera.mjs --self-host \
  --domain chat.example.org --oidc-issuer https://id.example.org/realms/studio \
  --oidc-client-id console --template audiovisual-production --dry-run
```

## After the official package is published

The package provides create-kodera and kodera-deploy executable names. The npx form below becomes usable after registry publication.

Real generation additionally requires operator-owned public issuer trust and a source checkout. It creates a new directory, mode-0600 configuration and a template intent; it refuses overwrites.

> A generated manifest does not prove that channels, credentials or connector subscriptions exist.

```bash
npx create-kodera --self-host --domain chat.example.org \
  --oidc-issuer https://id.example.org/realms/studio \
  --oidc-client-id console --template audiovisual-production --dry-run
```

## Generate, inspect, then start Compose

Prepare public-trust.json from your external issuer public keys. Run the shell generator from the repository root; it prints the Compose command for the operator.

Community includes Caddy, Web, API/migrator, room-access, PostgreSQL, Valkey, Synapse and LiveKit. Docker Compose v2, public DNS, HTTPS and media ports must be configured. The stack supplies no identity provider.

> No installation time, memory footprint or remote deployment is promised by this documentation.

```bash
bash deploy/community/kodera-deploy.sh --domain chat.example.org \
  --oidc-issuer https://id.example.org/realms/studio \
  --oidc-origin https://id.example.org --oidc-client-id console \
  --support-mailbox support@example.org --trust-file public-trust.json \
  --template audiovisual-production --env-file kodera-generated.conf --generate-only
```

## Sources

- [deploy/community/README.md](https://github.com/kodera-hq/kodera/blob/main/deploy/community/README.md)

- [packages/create-kodera/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/create-kodera/README.md)

- [README.md](https://github.com/kodera-hq/kodera/blob/main/README.md)
