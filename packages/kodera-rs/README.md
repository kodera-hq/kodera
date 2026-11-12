# `kodera-rs`

Shared native Rust engine (`#![forbid(unsafe_code)]`) shared by the Kodera Desktop developer preview, **Kodera iOS (`SwiftUI`)** and **Kodera Android (`Jetpack Compose`)**.

## Responsibilities

1. **Transport-Independent Identifiers (`UuidV7`):** RFC 9562 monotonic identifiers isolating client navigation and caches from backend Matrix/Synapse room identifiers.
2. **Device Identity & Crypto Provider Seam:** `Ed25519` device signing, and `MlsCiphertextEnvelope` metadata for a future OpenMLS (RFC 9420) provider. No MLS provider, hardware-backed key or LiveKit E2EE ships today.
3. **`#proximity` channel:** Pre-provisioned intra-organisation proximity beacon (`HMAC-SHA256` rotating every 5 minutes) and bounded `<= 256`-byte store-and-forward frame codec (`TTL <= 6` hops) over local Wi-Fi (`mDNS + QUIC`) and `BLE GATT`. It is an everyday presence channel with a voluntary, pseudonymous check-in. It is not an emergency service.

## Proximity naming and the frozen frame v1

The channel was first named `#urgence` and its types `Emergency*`; they are now `#proximity` and `Proximity*`. The v1 wire format is frozen, so the bytes on the wire and in the signature keep their historical value: the magic `KE`, the version, the layout and the signed labels `kodera-emergency-v1:` and `kodera-emergency-org-v1:`. `vectors/emergency-v1-rules.txt` and `docs/emergency-v1-vectors.md` keep their paths because other checks read them.

[`vectors/proximity-frame-v1.txt`](vectors/proximity-frame-v1.txt) holds the frozen constants, five frames with genuine Ed25519 signatures and seventeen refused frames. This crate (`src/proximity_frame_vectors.rs`), the Swift domain package and the Kotlin domain module read it; flipping any single byte of a shared frame fails the check on each of them.

`ProximityHandle` is the pseudonym shown for a sender: `dedicated` (picked by the member) or `generated` (derived by every device of the organisation), 3 to 24 characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`. A frame never carries a name, and a handle never enters the frame.

A handle is a display label. It is never an identity and never an authorisation input: identity stays the Ed25519 signing key, and the roster and the signature decide what is admitted. A generated handle is `<adjective>-<noun>-<9 characters>` taken from `HMAC-SHA256(organisation beacon salt, "kodera-proximity-handle-v1:" || sender key)`: 55 bits of the digest, the most the 24-character bound leaves beside the longest word pair. Keying it with the organisation's beacon salt means the same key shows another handle in another organisation, so handles are not linkable across organisations and one searched for in one organisation is worth nothing in another. Fifty-five bits rule out accidental meetings inside a roster, not a determined search by someone who can have keys provisioned; that is why a handle decides nothing. `disambiguate_proximity_handles` takes a roster's resolved handles and, when distinct keys show the same one, labels each `handle [fingerprint]` with a prefix of `SHA-256("kodera-proximity-fingerprint-v1:" || sender key)`, 8 hex characters lengthened until the group differs.

[`vectors/proximity-handle-v1.txt`](vectors/proximity-handle-v1.txt) is shared with Swift and Kotlin: accepted and refused handles, each sender in two organisations, and four roster cases. No provisioning contract for dedicated handles exists in this crate.

## Session envelope metadata

`SessionEnvelopeHeader` and `SessionEnvelopeTracker` add one-organisation room metadata tracking alongside the existing `MlsCiphertextEnvelope`; existing crypto algorithm names/discriminants and proximity frame wire bytes are unchanged. A trusted `SessionEnvelopeVerifier` must authenticate every header field against the actual envelope/session before acceptance. There is no built-in MLS engine or ciphertext authentication provider here.

Room epochs cannot decrease, and a room's established algorithm cannot change until the trusted session is explicitly cleared. Rejected scope, replay, algorithm, epoch, capacity or verification checks do not modify state. Each room and replay capacity is independently limited to 1–4096 entries. Room state never evicts; new rooms fail at capacity rather than resetting old epoch/algorithm guarantees. The shared FIFO replay history keys IDs by room and retains them across epoch advances, but loses old ID protection on eviction. No cross-process persistence or lifetime replay guarantee is provided.

## Docs link policy and native webhook seam

`validate_docs_host` accepts only canonical lowercase ASCII public FQDN syntax, excluding local names and IP literals. It does not resolve DNS or guarantee that a DNS name resolves to a public address. `validate_docs_pad_url` checks the exact configured host, HTTPS with omitted port or `443`, and a single `/docs/` or `/pads/` slug of 1–128 ASCII letters/digits/`-`/`_`. Controls, whitespace, credentials, query/fragment, encoded delimiters and traversal are refused before URL normalization; inputs are capped at 399 bytes. `DocsPadUrl` is immutable canonical metadata with port `443` omitted, not document access or navigation authority.

`ExtensionWebhookVerifier` implements the native `kodera-ext-v1:` transcript specified here: `"kodera-ext-v1:" || decimal_timestamp || ":" || raw_uuid_bytes || ":" || payload`. It requires a canonical lowercase 64-character HMAC-SHA256 signature, a timestamp within the inclusive 300-second window, a 1–64-character lowercase extension ID, and at most 1 MiB of payload to bound the existing non-streaming HMAC allocations. All 32 signature bytes are compared without an early mismatch return. Authentication completes before the bounded 1–4096-entry FIFO replay history changes. Keys are `(extension_id, delivery_id)` within one organisation. Evicted IDs, explicit resets and process restarts are not replay-protected indefinitely. Secrets are supplied only for the call and are not stored in the verifier.

This is **not** the extension SDK's `timestamp.body` / `v1=` webhook wire format; it has no automatic compatibility fallback. Organisation and extension ID are absent from the raw `verify_and_record` signing transcript: callers can either use `derive_extension_webhook_secret`, `ExtensionWebhookVerifier::verify_and_record_scoped`, and `ScopedWebhookVerifierRegistry` (which bind `(organisation_id, extension_id)` via `HMAC-SHA256(secret, org_id || ":" || ext_id)` and reject raw secret reuse across distinct pairs) or provision a distinct secret per authorised organisation/extension pair. Likewise, for `#proximity`, `ProximityFrame::sign_for_organisation` / `verify_for_organisation` and `ProximityOrganisationKeyGuard` bind `(organisation_id, organisation_beacon)` and reject reusing an `Ed25519` signing key across organisations while keeping the public v1 vector intact. This library provides no secret provisioning, network ingress, DNS resolution, redirect handling or live Docs integration.

## Native sound preference identifiers

`SoundPackId` admits exactly `givre`, `cristal`, `atelier`, `8bit`, `404`, and `silent`, with round-tripping slugs and `is_silent()`. These current native identifiers are not aliases for the older Web pack contract. Unknown/case/whitespace/legacy spellings fail closed. This type is a preference identifier only: it supplies no DSP samples, playback engine or audio-hardware integration.

## Channel polls and connector metadata

The dependency-free `ChannelPoll` validates org/channel context, 1–280-byte trimmed questions, 2–10 unique 1–120-byte labels and a voter capacity of 1–512. Replacing a canonical non-nil UUID voter's entire ballot is atomic, and empty ballots remove that voter even at capacity. Duplicate/invalid indices, multiple choices in a single-choice poll, wrong scope and closed/reclosed mutations fail without state changes. Aggregate snapshots omit voter identities. `total_votes` counts distinct nonempty ballots; rounded half-up option percentages use that denominator, so multiple-choice totals may exceed 100 percent. This is local bookkeeping, not membership verification, a distributed voting protocol or persisted state.

Poll text rejects control characters and an explicit Unicode 15.1 format-control set (including zero-width, bidi and BOM controls), without normalizing or case-folding ordinary labels. Future Unicode format-set additions need a coordinated policy update; exact admitted UTF-8 labels remain distinct.

`redact_iban` performs structural uppercase ASCII validation and masks every character except the initial country/check four and the final four, grouping the result every four characters. It checks a 128-byte raw-input bound before removing ASCII spaces, then canonical length 15–34. It does not verify checksums, country-specific lengths, account existence or provider authority. `validate_connector_post_url` performs conservative syntax-only admission of bounded public-DNS HTTPS post paths, including `@` handle segments. It permits only an omitted/exact 443 port and refuses queries, fragments, encoding, credentials, local/IP hosts and ambiguous paths. Arbitrary public host syntax is not evidence that a host is Mastodon or that a resolved address is public; no DNS resolution, fetch, redirects or banking/notification action is implemented.

## Independent public packet check

The dependency-free `scripts/audit-proximity-vector.mjs` verifies the shared public v1 packet using the installed runtime’s built-in Ed25519 and HMAC implementations. It checks exact agreement with the Rust fixture, every signed packet/signature byte mutation, six permitted TTL variations, the signature of every frame in `vectors/proximity-frame-v1.txt` and the rotating beacon. No private key or external crate is needed. TTL remains unsigned by design, and neither the beacon nor the signature establishes organisation membership or measured proximity. This oracle complements the injected Rust verifier tests; it does not activate a hardware or radio provider.

## Running Tests

```bash
cargo test -p kodera-rs
```

Licensed under `Apache-2.0`.

## Workspace preferences and local Docs

`workspace_prefs` re-exports a strict dependency-free five-RGB `kodera-theme:v1:` codec, four curated presets, pure-black monogram constants, validated profile metadata, rank-based preview IAM and transactional local Docs documents. Share codes are capped at2048 UTF-8 bytes with standard canonical base64 and exact JSON schemas. Profiles and IAM are correlation/preview data, never authenticated membership or permission grants. Docs bodies are capped at64KiB; quoted frontmatter exports remain literal Markdown. The desktop [local seam contract](../../apps/desktop/src-tauri/WORKSPACE-PREFERENCES.md) records byte limits, format-control policy, IPC differences and unprovisioned behavior.
