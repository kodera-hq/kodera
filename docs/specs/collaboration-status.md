# Collaboration implementation and release status

Status: Implemented through Wave 9 core tracks; Wave 10 in progress; hosted Community cutover promoted

## Implemented boundaries

- **Wave 2B:** the web client implements private direct conversations, groups with one to eight invitees, attachment checks and upload/complete/download flows, Matrix message search, text-only unfurl cards, notification history, payload-free Web Push, reusable invite links and moderation controls. Runtime code lives in `apps/web/src/features/messaging`, `apps/web/src/features/espace/matrix`, `apps/web/src/features/notifications`, `apps/server/apps/media`, `apps/server/apps/notifications` and `apps/server/apps/workspaces`.
- **Wave 3:** native workspace Pages use the Tiptap/ProseMirror block editor and Yjs, persisted document trees and roles, wikilinks, backlinks, search, comments and templates. `apps/server/apps/docs` owns document authorization and `apps/server/yjs_collab` owns the authenticated binary collaboration protocol at `wss://<api-host>/documents/collab` and PostgreSQL update journal. `apps/web/src/features/docs` connects the editor to that service.
- **Community:** canonical identity-realm signup materializes default membership. Public local rooms, announcement posting permissions, private staff/partner grants and moderation are enforced by Core and `packages/synapse-policy`. Camera video and screen sharing use LiveKit, and CI verifies fresh-volume cold-start runtime and footprint bounds on `deploy/community`.
- **Wave 4:** typed document Collections (`Table`, `Kanban` and `List` views over validated JSONB schemas), transactional workspace quotas, immutable Factur-X `380`/`381` PDF/A-3 + XML billing documents, VIES VAT evidence, supervised dunning, verified Stripe webhook settlement, and GDPR Art. 17/20 signed exports and erasure (`PrivateVolume` `O_NOFOLLOW` isolation and statutory invoice retention). Self-hosted Community runs with `KODERA_BILLING_ENABLED=false`.
- **Wave 5:** `packages/kodera-rs` implements scoped OpenMLS (RFC 9420), Vodozemac Megolm, durable device/session state, LiveKit media-key export seams, universal ES256 passkey binding without AAGUID lock-in, and `#proximity` v1/v2 frame codecs. `apps/desktop` implements the origin-fenced Tauri v2 shell, deep-links, tray/PTT controls, zeroized process credential vault and self-host stack deployment wizard; `apps/ios` and `apps/android` implement `ciel` workspace navigation, Matrix room/invitation models and URI coordinators, CallKit/`ConnectionService` call seams, payload-free push seams and universal passkey assertion verification, gated by reproducible candidate and reviewed SPDX SBOM checks.
- **Wave 6 & Wave 7:** `apps/server` implements the outbound extension runtime v2 (scoped workspace installation, key rotation, reconciliation and dual-key HMAC signed webhook and slash-command dispatch with pinned-IP SSRF protection) alongside 23 reference implementations in `extensions/`, bounded `Slack`, `Discord` and `Notion` importers, explicit partner-room and opt-in open federation controls (`KODERA_FEDERATION_MODE`), developer documentation with `llms.txt`, and cross-surface security hardening.
- **Wave 8 & Wave 9 (merged core tracks):** `.well-known` discovery, zero-trust `/staff/v1/*` operations, `Kodera Passport` signed PKCE cross-workspace magic-link sign-in and workspace switcher, clean-room Enterprise Edition `ee/` (`SAML 2.0`, `SCIM 2.0`, `Ed25519` compliance audit exports and `ee/billing/` commercial schedules, warm-pool governance and purchase orders), modern `openmls_*` crypto-provider generation, `kodera-rs` `wasm32` browser WASM device-proof bindings, default-off `/api/v1/organisations/{organisation_id}/confidential/*` opaque envelope and HPKE KeyPackage relay (`0.47.0`), atomic browser confidential vault storage (`apps/web/src/features/confidential/`), voluntary `#proximity` check-in over RAM-only Unix socket `/run/proximity/broker.sock` with 15-minute HKDF epoch leases and foreground native BLE/mDNS adapter layers, and the multi-OS GitHub Releases binary distribution workflow (`.github/workflows/release-binaries.yml`).

The hosted Community tenant is live: active tenant promotion, release evidence and identity-provider registration at `auth.kodera.io` are complete. Remaining operator responsibilities are encrypted backup/restore rehearsal, live payment activation, managed-fleet provisioning and signed desktop/mobile store distribution. These completed cutover gates do not establish deployment of every later source change. Mobile association endpoints fail closed with `503 well_known_unconfigured` until `KODERA_IOS_APP_IDS` / `KODERA_ANDROID_ASSETLINKS_SHA256` are configured and public edge routing is qualified.

## Wave 10 client capabilities

Status: In progress; client primitives and operator-gated server discovery/publication implemented.

Merged work in #169, #177, #180, #182 and #183 implements refusal of plaintext fallback and
room quarantine, worker-isolated attachment encryption, confidential Pages updates/snapshots,
LiveKit media transforms, local worker SAS device comparison, and user-held `KVKB1` encrypted
local key archives. These are cryptographic capabilities, not a claim that ordinary rooms,
uploads, documents or calls are encrypted end to end in production. Standard channels and
ordinary Yjs documents remain server-readable. The existing ordinary collaboration relay does
not admit confidential `KDE1` envelopes. The operator-gated server directory now publishes
current participating-device room discovery, consecutive accepted MLS epoch evidence and
proof-bound public cross-signing/device-verification bundles (`apps/server/apps/confidential`).
Key-package claims reject stale epochs. Server backup publication, native group/key integration
and interoperable browser/codec qualification remain open. The
[partner/guest channel slice](H2_3_BRIDGES_GUESTS_MLS.md) adds revisioned bilateral
agreements, single-channel guest grants and live Matrix/media revocation checks; its required
edge request-scope gate and default-off operator activation are explicit deployment boundaries.

## Acceptance evidence

The executable acceptance lives beside the implementation: Synapse policy tests and mutation checks, fresh-volume Community cold-start checks, web messaging, collaborative-editor, collections, Passport, confidential-storage and billing/GDPR tests, server media/notification/workspace/document/billing/extension/importer/staff/e2ee/proximity/EE tests, Rust/WASM/desktop/mobile gates, and the bootstrap/production HTTP acceptance scripts. Run those checks against the exact release commit; their existence is not a claim that a deployment has passed them. The documentation truth check validates links and refuses stale top-level pre-Wave-3 claims.

## Remaining scope

Status: Client transport/group integration, physical radio qualification, remaining operator activation and universal encryption roadmap. Live native Matrix messaging, real native media adapters, compiled mobile Rust client bindings, native push runtime acceptance, durable browser/native group integration, operator activation of server discovery/epoch and cross-signing publication, server backup publication, interoperable LiveKit media qualification, persistent desktop OS keychain wiring, background iOS PushKit provisioning, two-device physical `mDNS + QUIC` / `BLE GATT` radio qualification, OS-notarised desktop installers, App Store / Google Play publication, backup/restore rehearsal, live payment activation and managed-fleet provisioning remain open; universal zero-knowledge end-to-end encryption by default across all rooms, documents, attachments and calls is planned in Track 7 of [`ROADMAP.md`](../../ROADMAP.md). The repository issues and GitHub Project remain the authoritative backlog.
