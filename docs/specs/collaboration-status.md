# Collaboration implementation and release status

Status: Implemented through Wave 3; production cutover pending

## Implemented boundaries

- **Wave 2B:** the web client implements private direct conversations, groups with one to eight invitees, attachment checks and upload/complete/download flows, Matrix message search, text-only unfurl cards, notification history, payload-free Web Push, reusable invite links and moderation controls. Runtime code lives in `apps/web/src/features/messaging`, `apps/web/src/features/espace/matrix`, `apps/web/src/features/notifications`, `apps/server/apps/media`, `apps/server/apps/notifications` and `apps/server/apps/workspaces`.
- **Wave 3:** native workspace Pages use the Tiptap/ProseMirror block editor and Yjs, persisted document trees and roles, wikilinks, backlinks, search, comments and templates. `apps/server/apps/docs` owns document authorization and `apps/server/yjs_collab` owns the authenticated binary collaboration protocol and PostgreSQL update journal. `apps/web/src/features/docs` connects the editor to that service.
- **Community:** canonical identity-realm signup materializes default membership. Public local rooms, announcement posting permissions, private staff/partner grants and moderation are enforced by Core and `packages/synapse-policy`. Camera video and screen sharing use LiveKit.

Implemented code does not establish production deployment. Identity-provider registration and MFA settings, active tenant promotion, storage policy, release evidence, encrypted backup/restore verification and the Community cutover remain operator responsibilities.

## Acceptance evidence

The executable acceptance lives beside the implementation: Synapse policy tests and mutation checks, web messaging and collaborative-editor tests, server media/notification/workspace/document tests, and the bootstrap/production HTTP acceptance scripts. Run those checks against the exact release commit; their existence is not a claim that a deployment has passed them. The documentation truth check validates links and refuses stale top-level pre-Wave-3 claims.

## Remaining scope

Status: Planned. Wave 4 covers billing, quota enforcement and GDPR lifecycle controls. Wave 5 covers a running Tauri shell, native mobile transports and E2EE integration. Wave 6 covers extension runtime v2, importers and federation. E2EE and federation remain Deferred; no client radio transport or proximity check-in ships. The repository issues and GitHub Project remain the authoritative backlog.
