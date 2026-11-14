# API reference & webhooks

> Read the pinned contracts before sending a request.

## Two separate API boundaries

Core API 0.44.2 is the customer-console contract. Agent API 0.6.0 is the tenant-agent contract; its authentication and operations are a separate boundary. Both use OpenAPI 3.1.

The console uses its authenticated Core transport. It does not call identity providers, infrastructure providers or tenant control endpoints directly.

> Configure KODERA_CORE_API_BASE to the real Core base ending in /api/v1. Supply an authorized token through your own terminal session. The example is copied, never executed here.

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $KODERA_ACCESS_TOKEN" \
  --header "Accept: application/json" \
  "$KODERA_CORE_API_BASE/me"
```

## Status, problem details and idempotency

Use each pinned operation response schema, including application/problem+json where declared. HTTP 401/403 are not offline success; 409 requires inspecting the actual operation response.

Do not blindly retry mutations. Preserve the same idempotency key when checking an uncertain claim. The implemented instant-claim endpoint and generated contract still require reconciliation.

SDK verification errors include SIGNATURE_MISMATCH and TIMESTAMP_OUT_OF_RANGE. Treat these as refusals, not instructions to weaken verification.

> An unavailable service or a 503 can produce a local preview, never a fabricated Cloud allocation.

## Keep transport bytes and event authority separate

Verify raw bytes before parsing or normalizing JSON. A body change, even whitespace, changes its signature. Bind the secret, organisation and target channel using trusted server configuration.

Delivery and event headers are not signed by the SDK v1 transcript. Signed body routing metadata and handler replay protection must remain in place.

> The simulator below performs no network request, provisions no webhook, and persists no secret or replay cache.

## Sources

- [packages/api-contract/core-api.openapi.yaml](https://github.com/kodera-hq/kodera/blob/main/packages/api-contract/core-api.openapi.yaml)

- [packages/api-contract/agent-api.openapi.yaml](https://github.com/kodera-hq/kodera/blob/main/packages/api-contract/agent-api.openapi.yaml)

- [packages/extension-sdk/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md)
