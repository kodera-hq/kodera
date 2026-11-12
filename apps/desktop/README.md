# Kodera Desktop (`@kodera/desktop`)

Status: Developer preview; native shell and transport activation are not complete.

The desktop backend links the shared `kodera-rs` frame codec and bounded proximity mesh coordinator. Tauri configuration, capabilities and icons are checked locally. The current binary remains a shell placeholder: no running WebView or JavaScript IPC registration is claimed.

## Local backend capabilities

- `DesktopProximityNode` holds one provisioned organisation salt/roster, validates beacon windows and signatures, suppresses duplicate and older check-ins, tracks member status timestamps, and schedules a bounded priority outbox. Its constructor limits roster and outbox sizes.
- `emit_proximity_checkin`, `ingest_ble_frame`, and `get_proximity_roster_status` are Rust-callable command seams. The future trusted native adapter must own signing/verifying providers, bind the commands to the correct organisation session and apply platform transport permissions. Callers must not supply arbitrary crypto providers through IPC.
- `preflight_self_host_spec` validates provider, region, public domain, email and token shape locally. Token `Debug` and `Display` are redacted. It performs no provider request or deployment, and redaction is not memory zeroisation.
- `SelfHostDeploymentPlan::from_spec` revalidates mutable public spec fields and derives the root, `matrix`, `visio`, `docs` and `auth` DNS requirements and HTTPS origins. Targets remain unresolved public addresses until a future provider adapter allocates the server. Its public configuration preview contains only the existing `KODERA_DOMAIN` and `KODERA_ACME_EMAIL` keys from `deploy/community`; it neither reads nor copies the provider token. The planned service origins are not routes configured by today's single-origin community Caddy profile. No DNS writes, cloud API call, secret generation, container execution or instance installation occurs.
- `DesktopWorkspaceSession` privately owns one proximity node under a canonical non-nil organisation UUID. Every operation checks the expected organisation. `clear_session()` clears roster, replay and outbox, overwrites the held beacon salt, then drops the node. `switch_organisation()` clears first and requires fresh salt/roster provisioning; a failed replacement stays unprovisioned. This is logical state teardown, not a guarantee of physical zeroisation of Rust allocations, allocator copies or caller-owned inputs.
- The same workspace session starts with Docs unprovisioned. A trusted native adapter can configure a canonical Docs host; every configuration/link check verifies the current organisation first. Invalid host replacements preserve the current policy, and explicit removal unprovisions Docs. Validated immutable links contain only canonical HTTPS host/path metadata; they perform no fetch, WebView navigation or access grant. Clearing, switching or dropping the session discards the host policy, so replacement sessions require fresh configuration.
- A session-owned `ExtensionWebhookVerifier` performs the native `kodera-ext-v1:` HMAC/timestamp/replay checks and is discarded on clear/switch/drop. It holds no secret; a trusted adapter must select a separate secret per organisation/extension pair, never from untrusted request input. The transcript does not sign organisation or extension ID and is incompatible with the existing extension SDK's timestamp-dot-body / `v1=` format. There is no network ingress, provider credential store, SDK compatibility fallback or IPC registration. Replay state is capped at 4096 entries, FIFO-evicted and not persisted; payloads are capped at 1 MiB. A previously returned URL or caller-owned secret is outside this object's logical teardown.

The shared `SessionEnvelopeTracker` is a separate authenticated-metadata coordinator: a trusted native crypto adapter must bind every header field to the actual authenticated ciphertext/session. This code does not supply that provider or implement MLS. Within one organisation it pins each room's algorithm, refuses lower epochs and deduplicates retained message IDs across epoch advances. Room records never evict at capacity, so flooding cannot reset an established room's epoch. Replay IDs are FIFO-bounded and eventually evict; replay protection is not permanent. Both room and replay entry limits are at most 4096. Reset is reserved for ending the trusted session; persistence and process-restart rollback protection remain the adapter's responsibility.

Proximity v1 frames are signed plaintext. They do not contain a signed organisation binding, and a public rotating beacon is discovery metadata rather than authorisation. Production activation, especially with a device key shared across organisations, requires the security review described in [the shared protocol boundary and test vector](../../packages/kodera-rs/docs/emergency-v1-vectors.md). Drop the node on organisation/session change or roster replacement. Historical check-ins are not a guarantee that a person is currently safe.

`#proximity` is an everyday presence channel with a voluntary, pseudonymous check-in. It is not an emergency service: it does not reach emergency services, and delivery is never guaranteed. It was first named `#urgence`. The 129-byte public frame and every other v1 wire byte are frozen under their historical values (magic `KE`, signed label `kodera-emergency-v1:`); only names in code, routes and copy changed.

No live BLE/Wi-Fi exchange, hardware-backed crypto, provider provisioning or deploy flow is claimed by these local tests.

## Bounded JSON command seam

`DesktopWorkspaceSession::dispatch_command(&str)` accepts at most 16,384 UTF-8 bytes and returns a typed `DesktopCommandResponse`. It is a local Rust backend seam, not registered Tauri JavaScript IPC, a WebView, caller authentication or an executed provider operation. A trusted future bridge must establish the current caller/session authority separately. The implementation remains dependency-free: strict field rejection is implemented by the command decoder, not a Serde annotation.

Each request is one flat JSON object with exactly one `command` discriminator and one `organisation_id` string. All commands, including planning and clearing, require the currently active canonical non-nil organisation UUID. Wrong-org, malformed and unprovisioned requests fail without effects. A repeated clear returns unavailable because the session is already ended; it never reactivates it. An old organisation's clear cannot end a replacement organisation's session. Organisation equality alone is not a generation token or proof of membership.

| `command` | Additional required fields |
| --- | --- |
| `plan_self_host` | `provider` (`scaleway`, `hetzner`, `hostinger`, `ovhcloud`), `region`, `fqdn`, `acme_email`, `raw_token`: strings |
| `validate_docs_pad_url` | `raw_url`: string; trusted Docs host must already be configured |
| `proximity_current_beacon` (legacy name `emergency_current_beacon`) | `now_unix_secs`: unsigned decimal integer |
| `proximity_member_statuses` (legacy name `emergency_member_statuses`) | None |
| `proximity_next_relay_batch` (legacy name `emergency_next_relay_batch`) | `max_frames`: unsigned integer representable as `usize`, capped at 128 before drain |
| `set_sound_pack` | `sound_pack`: exact native pack ID string |
| `get_sound_pack` | None |
| `clear_workspace_session` | None |
| `create_channel_poll` | `channel_id`, `poll_id`, `question`: strings; `options`: 2–10 strings; `allow_multiple`: boolean |
| `vote_channel_poll` | `channel_id`, `poll_id`, `voter_id`: strings; `selections`: 0–10 unsigned option indices |
| `get_channel_poll`, `close_channel_poll` | `channel_id`, `poll_id`: strings |
| `redact_iban` | `raw_iban`: structurally canonical IBAN string, at most 128 raw bytes |
| `validate_connector_post_url` | `raw_url`: conservative canonical public HTTPS post URL |

The three proximity routes answer under two names, permanently: the `proximity_*` name and the `emergency_*` name they carried when the channel was called `#urgence`. `LEGACY_ROUTE_ALIASES` resolves a legacy name to its proximity route before the decoder runs, so both share one schema, one set of effects and one response. The alias applies to the `command` discriminator only and no other spelling is accepted. Each member status carries `sender_handle`, the pseudonym derived from the sender key under the organisation's beacon salt (`ProximityHandle::generated`), and `sender_fingerprint`, present only when another member of the roster shows the same handle. Both are display labels: never a name, never an identity and never an authorisation input. Identity stays the signing key.

Unknown and duplicate fields are denied, including escaped duplicate key spellings. At most seven fields are admitted. Only poll schemas admit booleans and one-level scalar arrays of at most ten elements; array element types are checked against the exact field schema. Existing command schemas still refuse those types. Nested arrays/objects, null, numeric strings, negative/fractional/exponent numbers, leading-zero numbers, overflow and trailing data are refused before dispatch. Ordinary JSON string escapes and valid Unicode surrogate pairs are decoded; unpaired surrogates and raw control characters are refused. This is a bounded command-only JSON subset, not a general-purpose JSON library. Parsing/schema errors are closed codes with no input excerpts. No operation executes until the entire request has parsed and matched its exact field schema.

Request `Debug`/`Display` redact the whole request. Plans contain no token field; if a caller copies the validated trimmed token into public plan metadata, the dispatcher refuses the response rather than emitting a corrupted redacted plan. Actual returned strings and plan diagnostics are checked case-insensitively so domain case-folding cannot expose a normalized token. Errors never interpolate request values. Caller-owned input and temporary Rust allocations are not guaranteed physically zeroised. Roster responses are sorted, relay batches contain only the existing verified bounded wire frames, and beacon responses include matching bytes/lowercase hex.

The native pack IDs are `givre`, `cristal`, `atelier`, `8bit`, `404`, and `silent`, following the current native contract. Older Web slugs are not accepted as aliases and no Web migration is claimed. Each provisioned organisation starts with `givre`; clear removes the preference and replacement provisioning resets it. Preference changes do not synthesize or play audio. Unit tests cover every typed/raw command, token aliases/redaction, wrong-org effects, sound resets, parser bounds/escapes/duplicates/deep input and transactional clear/drain refusal.

## Local polls and connector metadata

`ChannelPoll` holds a validated question (1–280 UTF-8 bytes) and 2–10 unique trimmed option labels (1–120 bytes each). Canonical non-nil UUIDs correlate at most 512 voter ballots. They are bookkeeping keys, not authenticated identities. A voter replaces one complete selection atomically; duplicate or out-of-range indices are refused, and a single-choice ballot contains at most one index. An empty selection removes that voter's ballot, including when the registry is full. New voters fail at capacity while existing voters can replace/remove. Closed polls refuse all voting and repeated closing; trusted lifecycle teardown can still clear them.

Poll text rejects control characters and an explicit Unicode 15.1 format-control set (including zero-width, bidi and BOM controls), without normalizing or case-folding ordinary labels. Future Unicode format-set additions need a coordinated policy update; exact admitted UTF-8 labels remain distinct.

The denominator is the number of distinct voters with nonempty ballots, not the count of selected options. Percentages are rounded half up using `(optionVotes * 100 + totalVotes / 2) / totalVotes`, or zero without voters. Multiple-choice percentages can sum above 100. Public snapshots and diagnostic formatting expose aggregates, never voter identifiers or individual ballots. A workspace owns at most 32 polls keyed by channel and poll ID; an existing ID cannot be silently replaced, including after closing. Clear, organisation switch, failed replacement and Drop discard the complete poll registry. A future authenticated adapter must establish the current org, channel, voter and close/create permissions; this seam is not live distributed voting, persistence or an authorised poll service.

`redact_iban` only validates the uppercase ASCII country/check/body structure, 15–34 canonical characters after removing ASCII spaces. It rejects more than 128 raw bytes before processing. The result preserves the first four and last four characters, masks every middle character and groups the masked text in blocks of four. No checksum, country-length registry, account existence, provider verification or payment action is supplied. Raw accounts are not retained in session state or formatted by request/errors/responses; transient input memory is not guaranteed physically zeroised.

`validate_connector_post_url` admits bounded lowercase public-DNS HTTPS post metadata with omitted/exact port 443, a nonempty unreserved ASCII path and optional Mastodon-style `@` handle segments. Query strings, fragments, percent escapes, backslashes, path parameters, dot segments, repeated slashes, credentials, local names and IP literals are refused; admitted port 443 is omitted in the returned string. Common platform hosts and any syntactically admitted public FQDN are allowed because Mastodon deployments are not a finite host list. This does not establish platform identity, DNS/public resolved addresses, ownership, redirects, document authority or network SSRF safety. No connector request, notification delivery, treasury access, fetch or navigation occurs.

## Verification

```bash
npm --workspace @kodera/desktop run typecheck
cargo test --offline -p kodera-desktop
cargo test --offline -p kodera-rs
```

Both Rust crates forbid unsafe code. Tests cover multi-hop TTL exhaustion, priority and capacity, replay/own-echo suppression, beacon windows, stale-status rejection, roster isolation, malformed/signature/off-roster input, token redaction, safe deterministic plan derivation, authenticated-header refusal/retry, algorithm/epoch pinning and organisation-session teardown. The exact shared 129-byte frame uses a genuine Ed25519 signature generated from a published RFC test key; Rust crypto-provider tests remain injected trait tests.

Docs policy tests reject URL authority/normalization/traversal ambiguities. Native webhook tests pin an independently calculated binary-payload HMAC fixture, reject tampering of each signature byte and the existing SDK transcript, exercise timestamp extremes, bounded replay/reset and failed-auth retry, and expose the reused-secret context limitation. Desktop tests cover organisation checks and the complete Docs/verifier reset on successful and failed switches.

The desktop typecheck runs `verify-config.mjs --selftest`: 33 in-memory negative mutations verify identifier, the complete approved CSP source policy, CSP asset protection, local-only capability origins/windows/permissions, frontend bundle path, and icon/capability file selection refusals before the real configuration passes. It changes no on-disk configuration or asset. Directive and source ordering are allowed to vary without changing the admitted policy.

The same script holds the desktop preview to its companion role: it sells nothing. `verifyCompanionSurface` reads every Rust source, the Tauri configuration, the capabilities, `Cargo.toml` and `package.json` and refuses pricing, plan-tier, upgrade, checkout, invoice, payment or subscription wording in English or French, a stated price, a billing provider or store purchase API, and any address or path that names a billing destination. The word `plan` alone stays admitted because it names the self-host deployment plan. The selftest reintroduces 14 such cases in memory and requires each to be refused for its own diagnostic.

The dispatch audit covers all 20 current JSON routes, rather than the earlier 16-route brief count, plus the three legacy route names. A populated workspace exercises every successful route, all 92 combinations of the 23 route names with wrong organisation/decoded duplicate key/unknown field/wrong scope type, and all 23 names after teardown. Refusals preserve theme, profile, Docs, poll, member state and the pending proximity outbox. `legacy_emergency_routes_are_permanent_aliases_of_the_proximity_routes` holds each legacy name to the same response and the same resulting state as its proximity route, on success and on refusal; `dropping_any_legacy_alias_is_refused_by_the_dual_name_check` removes one alias at a time and requires that check to fail. These are local end-to-end decoder-to-session checks, not a running WebView or radio test.

## License

Licensed under the Apache License, Version 2.0 ([`LICENSE`](./LICENSE)).
