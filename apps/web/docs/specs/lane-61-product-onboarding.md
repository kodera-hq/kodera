# Product onboarding and workspace convergence

Status: Implemented locally; verification in progress

The local onboarding walkthrough has three steps: identity and hosting preference, organisation template preview, then theme and sound selection. The audiovisual template adds four text channels, two voice channels, production role previews and a starter document. These are local preview state. A hosting preference does not provision a cloud tenant. An invitation is copyable only when the caller supplies a real invitation URL; the component never invents one.

The authenticated Workspace wires Discussion and Docs to the existing Espace canvas. Local document panels remain mounted per channel so navigation preserves their drafts. Collaborative editing still depends on the external Docs service, as the panel explains.

Frame.io is an official connector with fixed production-channel routing, bounded text, a strict HTTPS host allowlist and the shared HMAC/replay boundary. Provider events are recorded separately from the SDK manifest's canonical event vocabulary because the shared SDK is outside this lane's ownership.

The deployment CLI prepares configuration and prints a quoted Compose command. It does not start a deployment. An operator must supply the external issuer's public trust registry; no signing trust is generated or fetched. Existing configuration is never overwritten. Generated secrets are mode 0600 and are never printed.

## Runnable acceptance

- `bash deploy/community/kodera-deploy.sh --selftest`
- `python3 scripts/ci/check-community-deploy.py --selftest`
- `node --test extensions/frameio-review-bridge/test/*.test.ts`
- `npm test --prefix apps/web`
