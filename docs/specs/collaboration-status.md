# Collaboration implementation and release status

Status: Implemented through Wave 7; production cutover in progress

## Implemented boundaries

- **Wave 2B:** the web client implements private direct conversations, groups with one to eight invitees, attachment checks and upload/complete/download flows, Matrix message search, text-only unfurl cards, notification history, payload-free Web Push, reusable invite links and moderation controls. Runtime code lives in `apps/web/src/features/messaging`, `apps/web/src/features/espace/matrix`, `apps/web/src/features/notifications`, `apps/server/apps/media`, `apps/server/apps/notifications` and `apps/server/apps/workspaces`.
- **Wave 3:** native workspace Pages use the Tiptap/ProseMirror block editor and Yjs, persisted document trees and roles, wikilinks, backlinks, search, comments and templates. `apps/server/apps/docs` owns document authorization and `apps/server/yjs_collab` owns the authenticated binary collaboration protocol and PostgreSQL update journal. `apps/web/src/features/docs` connects the editor to that service.
- **Community:** canonical identity-realm signup materializes default membership. Public local rooms, announcement posting permissions, private staff/partner grants and moderation are enforced by Core and `packages/synapse-policy`. Camera video and screen sharing use LiveKit.
- **Wave 4:** typed document Collections (`Table`, `Kanban` and `List` views over validated JSONB schemas), transactional workspace quotas, immutable Factur-X `380`/`381` PDF/A-3 + XML billing documents, VIES VAT evidence, supervised dunning, and GDPR Art. 17/20 signed exports and erasure (`PrivateVolume` `O_NOFOLLOW` isolation and statutory invoice retention). Self-hosted Community runs with `KODERA_BILLING_ENABLED=false`.
- **Wave 5:** `packages/kodera-rs` implements scoped OpenMLS (RFC 9420), Vodozemac Megolm, universal ES256 passkey binding without AAGUID lock-in, and `#proximity` v1/v2 frame codecs. `apps/desktop` implements the origin-fenced Tauri v2 bridge, deep-links, tray/PTT controls and OS keychain storage; `apps/ios` and `apps/android` implement `ciel` workspace navigation, Matrix invitation flows, CallKit/`ConnectionService` call seams, payload-free push handling and universal passkey flows, gated by reproducible candidate and SPDX SBOM checks.
- **Wave 6 & Wave 7:** `apps/server` implements the outbound extension runtime v2 (manifest registration, workspace installation, dual-key HMAC signed webhook and slash-command dispatch with pinned-IP SSRF protection) alongside 22 reference implementations in `extensions/`, bounded `Slack`, `Discord` and `Notion` importers, explicit partner-room federation controls in `packages/synapse-policy` (`v0.1.5`), bilingual developer documentation with `llms.txt`, and cross-surface security hardening.

Implemented code does not establish production deployment. Identity-provider registration and MFA settings, active tenant promotion, storage policy, release evidence, encrypted backup/restore verification, payment provider activation, and signed desktop/mobile store distribution remain operator responsibilities.

## Acceptance evidence

The executable acceptance lives beside the implementation: Synapse policy tests and mutation checks, web messaging, collaborative-editor, collections and billing/GDPR tests, server media/notification/workspace/document/billing/extension/importer tests, Rust/desktop/mobile gates, and the bootstrap/production HTTP acceptance scripts. Run those checks against the exact release commit; their existence is not a claim that a deployment has passed them. The documentation truth check validates links and refuses stale top-level pre-Wave-3 claims.

## Remaining scope

Status: Operator cutover and deferred tracks. Cross-client end-to-end encrypted confidential rooms, encrypted LiveKit media frames, open Matrix federation, physical `mDNS + QUIC` / `BLE GATT` radio hardware adapters for `#proximity`, clean-host cold-start footprint measurements, notarised desktop installers, App Store / Google Play publication, and `ee/` SAML 2.0 / SCIM 2.0 enterprise modules remain planned. The repository issues and GitHub Project remain the authoritative backlog.
