# Git Tracker

Status: Implemented

`@kodera/extension-git-tracker` accepts native GitHub and GitLab deliveries and
queues English or French metadata cards for a configured private Kodera channel.
It reuses the extension SDK manifest validator, URL validation and authenticated
outbound client. Existing `github-repo-tracker` and `github-release-notifier`
consume Kodera's signed envelope; they remain unchanged. This adapter fills the
native provider ingress boundary without wrapping native signatures in a
pretend Kodera envelope.

The runtime manifest ID is `git-tracker` (SDK slug syntax), with canonical ID
`io.kodera.ext.git-tracker`. Only `messages:write` and `webhooks:incoming` are
requested. No provider API token, slash command or elevated room capability is
needed. The channel's actual private membership policy remains server-owned.
Community bootstrap creates `kodera-git-tracker` under Core Kodera (server PR #56).
An operator supplies its real channel ID; no fixture feed is presented as live.

## Events and noise

| Provider | Native events |
| --- | --- |
| GitHub | push; pull_request opened, ready_for_review, merged, closed; pull_request_review submitted; issues opened/closed; release published; workflow_run/check_suite completed |
| GitLab | Push Hook; Merge Request Hook open, draft-to-ready update, merge, close; Issue Hook open/close; Release Hook create; Pipeline Hook failure/recovery |

Draft PRs, non-default-branch pushes, and known-bot commits touching only lockfiles
are suppressed unless `includeDrafts`, `includeOtherBranches`, or
`includeBotLockfiles` is enabled. Unknown file lists are not guessed to be noise.
`botNames` can replace the default exact bot usernames. CI considers only the
configured default branch. A first success is quiet; a failure transition emits
once, followed by one recovery. Out-of-order run numbers/attempts cannot reverse
newer state. Check suites are ordered per app; workflow runs per workflow; GitLab
pipelines per repository. Other-branch CI remains suppressed.

Cards deliberately omit all arbitrary titles, release tags, commit messages,
names, email addresses, descriptions and provider-supplied URLs. Regex redaction
cannot guarantee absence of personal data or secrets from those fields. Output
contains only an operator-approved repository slug, fixed localized labels,
numeric item IDs and links derived from the configured HTTPS provider origin.
Raw delivery bodies and credentials never enter the outbox or application logs.
Repository slugs themselves are trusted configuration and must be approved for
the target audience. French text exists only in `src/locales/fr.json`.

## Authentication and replay limits

GitHub `X-Hub-Signature-256` is HMAC-SHA256 over the exact raw bytes, compared in
constant time. GitLab `X-Gitlab-Token` is a bearer secret, **not a payload HMAC**;
fixed-length SHA256 digests are compared in constant time. Use a unique random
secret of at least 32 characters per hook, a TLS-only ingress, and a fixed
provider/repository allowlist. GitLab token disclosure permits payload forgery;
this implementation makes no stronger claim.

Native providers do not supply the signed timestamp used by the Kodera envelope.
GitHub also does not authenticate its delivery ID or event headers. The adapter
cross-checks event headers against signed body structure and deduplicates both
the delivery ID and SHA256 of the authenticated raw body, within a hook/channel
scope. Changing an unsigned delivery ID does not replay a captured body. There
is no invented freshness window. Identical native bodies intentionally collapse.
Receipts must survive process restarts and be retained for the hook's entire
secret epoch. Rotate the secret and stop accepting the previous secret before
retiring an epoch and its receipts. An attacker with a leaked token/secret can
forge new bodies; a replay store cannot fix credential compromise.

References: [GitHub signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[GitHub webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
[GitLab webhook authentication](https://docs.gitlab.com/user/project/integrations/webhooks/),
[GitLab event payloads](https://docs.gitlab.com/user/project/integrations/webhook_events/).

## Runtime integration

The caller must inject a durable transactional store and the SDK outbound client.
There is no implicit memory fallback. `createMemoryDeliveryStore` is a bounded
reference for tests and local experiments only; it is not restart-durable.

```js
import { createServer } from 'node:http';
import { createExtensionClient } from '@kodera/extension-sdk';
import { createGitTracker } from '@kodera/extension-git-tracker';
import { createNodeHandler } from './src/http.mjs';

// Resolve these from the host's admitted secret/configuration provider.
const tracker = createGitTracker({
  provider: 'github',
  secret: hookSecret,
  hookId: 'community-github-v1',
  channelId: privateTrackerChannelId,
  providerOrigin: 'https://github.com',
  repositories: [
    { slug: 'kodera-hq/kodera', defaultBranch: 'main' },
    { slug: 'kodera-hq/kodera-ops', defaultBranch: 'main' },
  ],
  locale: 'en',
  deliveryStore: transactionalOutbox,
  client: createExtensionClient({ baseUrl: coreApiOrigin, token: extensionToken }),
});
createServer(createNodeHandler(tracker)).listen(8080, '127.0.0.1');
// Run from the host's retrying job worker; a failure leaves items pending.
await tracker.deliverPending(50);
```

Mount one fixed provider-specific route behind TLS, strip no body bytes, and
reject compressed bodies. The Node adapter accepts only POST application/json,
reads at most 1 MiB, and returns 202 only after durable enqueue, 200 for duplicate
receipts, 401 for failed authentication, 400 for invalid input, or 503 for storage
failures. Never log bodies or headers. Authentication happens before any replay
reservation; failed authentication cannot poison a delivery ID.

### Durable outbox contract

Implement all three asynchronous methods below using one persistent store:

- `enqueue({id, keys, item, transition})`: in **one transaction**, atomically reject
  any existing receipt key; serialize on the transition key when present; compare
  sequence tuples lexicographically; suppress older/equal states and repeated CI
  status; update newer CI state; persist both receipt keys and the safe card when
  emitted. Return `{status: 'queued'|'ignored'|'duplicate'}`. `item` can be null for
  valid filtered events. The transition's `state` is success/failure. Initial
  success is silent, initial failure emits; subsequent state changes emit. Unique
  constraints must arbitrate concurrent deliveries across receiver processes.
- `pending(limit, scope)`: return only pending cards in that exact scope, each with
  its persisted `id`, `scope`, `channelId`, `text`, and `blocks`. Use a stable order.
- `complete(id)`: remove/mark only the sent outbox item; retain receipt keys and CI
  state. Never delete receipts just because a card was sent.

Do not reserve receipts separately from persisting the outbox item: a crash in
between would lose an event. A transaction failure must roll back receipt keys
and state. A worker failure leaves the item pending. Repeated workers use the
same SDK `Idempotency-Key` (the persisted digest); the receiving Core endpoint
must durably honor that key, including crash-after-send retries. No receipt is
released after an uncertain downstream outcome. Capacity exhaustion fails
closed with 503 rather than evicting replay protection. These requirements are
an operator integration gate: repository tests exercise the contract reference,
not an unconfigured production database or external provider.

## Local verification and signed request example

This monorepo uses npm workspaces:

```sh
npm --workspace @kodera/extension-git-tracker test
npm run test:sdk
npm --workspace @kodera/extension-sdk run typecheck
```

For a **local synthetic receiver only**, prepare a payload and sign its exact
bytes (the displayed secret is intentionally non-production):

```sh
printf '%s' '{"repository":{"full_name":"example/project"},"action":"opened","issue":{"number":42}}' > /tmp/tracker-payload.json
signature=$(openssl dgst -sha256 -hmac 'synthetic-local-hook-secret-32-bytes' /tmp/tracker-payload.json | awk '{print $NF}')
curl --fail-with-body http://127.0.0.1:8080/ \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: issues' \
  -H 'X-GitHub-Delivery: local-synthetic-1' \
  -H "X-Hub-Signature-256: sha256=$signature" \
  --data-binary @/tmp/tracker-payload.json
```

A changed byte must
return 401; the repeated authenticated body must return duplicate even with a
changed delivery ID. No command here configures or sends a real provider event.
