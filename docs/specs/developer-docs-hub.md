# Developer documentation hub and community preview

Status: Implementation specification

## Scope and design

Keep channel-scoped team pads as the default Docs view and preserve their drafts when
switching to a developer reference. Use existing Plus Jakarta Sans and IBM Plex Mono
roles, semantic surface/ink/accent/border tokens, and the existing spacing scale.
The palette inherits black, white, slate 100/300/600/900 (token values #000000,
#FFFFFF, #EEF2F6, #C9D3DE, #5A6672, #2F3A45); the selected application theme remains
in control. No new palette, font, animation dependency or service is introduced.

A quiet three-column reference has left-aligned searchable topic navigation, a
readable article, and a page outline with source/copy/help actions. On narrow
containers the same content stacks; code scrolls rather than shrinking the page.
Avoid decorative dashboard cards: the engineering callout and signed transcript are
the distinguishing content. Keyboard focus, truthful clipboard feedback and reduced
motion are acceptance conditions.

## Product behavior

- Add a shared team/developer view selector to DocsWorkspacePanel; retain the channel-scoped
  team editor through a slot and the authenticated workspace's current pads.
- Provide four bilingual, source-linked pages: Community quickstart, extension SDK,
  API/webhooks and architecture/security. Copy exports the complete displayed page.
- Use local Web Crypto HMAC-SHA256 for an explicit synthetic-payload simulator.
  Kodera signs timestamp.rawBody with v1=; native GitHub signs rawBody with sha256=.
  Do not claim native provider headers are interchangeable. Bound all inputs, retire
  stale calculations, clear results after edits and expose actual verification errors.
  This tool is not a network ingress, replay store or tenant authorization decision.
- Generate public llms.txt and bilingual Markdown pages from the same curated content.
  Enforce deterministic freshness and source/catalog/version parity with tests.
- Provide the routed Community workspace with its three channel categories, team
  pads, developer Docs and hosting information. Local demonstration rooms remain
  isolated from customer workspaces. community.kodera.io is a target address;
  availability and deployment are unverified.
- Exactly ten official connector implementations exist. Linear, Stripe and Sentry
  are potential SDK integrations, not extra shipped official connectors.
- Audio synthesis at 48 kHz belongs to the Web implementation. Rust provides bounded
  native metadata/codecs; no native audio hardware or live BLE provider is asserted.

## Acceptance and verification

Tests cover pad retention, both entry points, search including empty results,
page outlines/source paths, Markdown and llms clipboard success/failure, translated
copy, synthetic valid/tampered/expired signatures, scheme separation and bounds,
community channel selection and help navigation. Existing team-pad and workspace
journeys must remain green. Verify narrow/desktop layouts and keyboard behavior
in a local browser. No live service or personal environment file is required.

Run the shared heavy-job wrapper for builds/tests. Required gates: full Web tests,
Web production build, attribution, required clauses and non-destructive Genesis
rehearsal on a clean feature branch. No remote, push, merge or deployment.
