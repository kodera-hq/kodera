# `@kodera/extension-sdk`

Zero-dependency TypeScript/ESM SDK for building signed Kodera webhooks, outbound bots, incident bridges, and slash commands (`Apache-2.0`).

## Capabilities

- **Constant-Time Webhook Authentication & Replay Guard**: `signWebhookPayload`, `verifyWebhookRequest`, `verifyWebhookSignature`, and `createWebhookHandler` enforce `x-kodera-signature-256` (`HMAC-SHA256`), a bounded `x-kodera-timestamp` replay window (`0..300s`, default `300s`), and authenticated-signature plus delivery-ID deduplication. Raw bodies are at most `1 MiB`; clocks/timestamps must be non-negative safe integers and received JSON must be valid UTF-8.
- **Strict SSRF & Endpoint Validation (`validateEndpointUrl`)**: Rejects non-HTTPS protocols (unless `allowLocalhostHttp: true` is explicitly passed for local test harnesses), embedded credentials (`user:pass@`), loopback (`localhost`, `127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), unique-local IPv6 (`fc00::/7`), site-local IPv6 (`fec0::/10`), 6to4 (`2002::/16`), and every IPv4-mapped (`::ffff:0:0/96`) or IPv4-translated (`::ffff:0:0:0/96`) IPv6 target.
- **Manifest Validation (`validateManifest`)**: Validates `kodera-extension.json` manifests (`kodera.extension.v1`), least-privilege scopes (`EXTENSION_SCOPES`), subscribed `EXTENSION_EVENTS`, and `webhookUrl` SSRF safety.
- **Typed Outbound Extension Client (`createExtensionClient`)**: Provides `postChannelMessage`, `postThreadReply`, and `postIncidentCard` with payload length bounds (`<= 4000` chars), severity/status validation, `Authorization: Bearer <token>`, `Idempotency-Key` headers, `AbortSignal.timeout`, and redirect refusal.
- **Slash Command & Interaction Helpers (`defineSlashCommand`, `parseCommandInvocation`)**: Parses `/command subcommand --flag=value arg1` into structured `{ command, subcommand, args, flags }` with strict input bounds (`<= 2048` chars, `<= 64` tokens) and prototype-pollution protection (`Object.create(null)` flags).
- **Deterministic In-Memory Test Harness (`createExtensionTestHarness`)**: End-to-end testing of webhook handlers with signed deliveries, replay simulation, clock injection (`advanceTime`, `setTime`), and recorded outbound client calls in zero network milliseconds.

## Quickstart

```js
import {
  createExtensionClient,
  createWebhookHandler,
  defineSlashCommand,
  parseCommandInvocation,
} from '@kodera/extension-sdk';

export const releaseCommand = defineSlashCommand({
  name: '/release',
  description: 'Inspect latest release status',
  scopes: ['messages:write'],
  handler: ({ args, actorId }) => {
    const parsed = parseCommandInvocation(`/release ${args}`);
    return {
      text: `Release query (${parsed.subcommand ?? 'latest'}) requested by <@${actorId}>`,
      ephemeral: true,
    };
  },
});

export const webhookHandler = createWebhookHandler({
  secret: process.env.KODERA_WEBHOOK_SECRET,
  handlers: {
    'release.published': async (payload, { client }) => {
      await client?.postChannelMessage({
        channelId: String(payload.channelId),
        text: `Released ${payload.repo}@${payload.tag}`,
        idempotencyKey: `release:${payload.repo}:${payload.tag}`,
      });
    },
  },
});
```

## Reference implementations

[`extensions/`](../../extensions/README.md) holds worked examples built on this SDK, each labelled
*Reference implementation*. They are exercised with the test harness and synthetic fixtures;
Kodera's server does not yet register a manifest, install an extension or deliver a webhook
(Status: Planned), so the SDK is what you can build and test against today. The catalogue of
those examples, [`extensions/catalog.json`](../../extensions/catalog.json), is generated from
their manifests and checked by this package's test suite (`test/catalog.test.mjs`).

## Replay and transport boundaries

The v1 signing transcript remains `timestamp.rawBody`; delivery and event headers are not signed. A handler records both the authenticated signature and any delivery ID before awaiting side effects. Changing or removing an ID, changing event headers on a replay, or adding timestamp padding cannot redispatch the same authenticated transcript. The default replay capacity is `4096` entries and `maxReplayEntries` may lower it to any positive integer. At capacity, new deliveries refuse without evicting still-valid records. Expired records can be pruned; process restarts do not preserve replay history. A handler records the highest authenticated, metadata-valid clock before pruning, including refused replay/capacity attempts; it rejects clock rollback rather than reopening expired history. Side effects still need their own durable idempotency keys.

Event routing requires a signed body `type` or `event` marker (1–128 ASCII event characters). If both markers are present they must agree; an optional event header must also match. Header-only producers must migrate to signed body metadata before delivery. Invalid routing metadata refuses before replay admission, so a tampered first attempt cannot consume a legitimate delivery. The test harness adds a body marker when absent; raw-body overrides remain exact. Reusing a secret across unrelated organisations/extensions does not establish scope authority.

URL validation is lexical. Redirects are disabled by the outbound client, but the SDK does not resolve and pin DNS addresses, so a public-looking hostname is not proof of a public resolved destination. A production egress adapter must enforce resolved-address and network policy too. Injected transports must honor the passed redirect/error and timeout options. Tests use synthetic public names mapped to loopback transports; no provider or public DNS access is required.

## License

Apache-2.0 ([`LICENSE`](./LICENSE)).

## Additive v2 rotation verification

`verifyRotatingWebhookRequest` and `createRotatingWebhookVerifier` preserve the existing v1
HMAC transcript and primary header. A v2 Core producer signs organisation, installation,
delivery id, event type and key generation inside the raw JSON body. During a bounded rotation,
`X-Kodera-Previous-Signature-256` carries a second independent `v1=` signature; the primary header
never combines signatures. Configure the expected organisation/installation, current generation
and secret, and the previous generation/secret with its trusted absolute `expiresAt` epoch.
The previous key is refused at expiry equality; incoming data cannot extend trusted grace.

Pass the raw body plus signature/timestamp/event/delivery headers to the helper. Scope/header
mismatch, malformed signatures, invalid UTF-8, oversized bodies and expired grace refuse. The
factory additionally bounds and rejects in-process delivery-id replay. For durable side effects,
commit the scoped delivery id with the effect in receiver storage; an in-memory cache cannot
provide that guarantee across process restarts or later producer retries. Provision receiver
keys and generation configuration before changing the producer. A receiver still using only
the legacy helper needs the current key; adopting the new helper is an explicit rollout step.
