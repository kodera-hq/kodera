# Architecture decision records

One file per decision, numbered, never edited after acceptance except to change **Status** (Proposed → Accepted → Superseded by ADR-nnnn). Template: [`0000-template.md`](0000-template.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-console-is-a-separate-app.md) | The console is a separate application, not part of the hub | Accepted; superseded in part by ADR-0009 (deployment address only) |
| [0002](0002-tenant-realm-login.md) | Tenant admins log in against their own tenant realm | Accepted |
| [0003](0003-console-talks-only-to-core-api.md) | The console talks only to the Core API | Accepted; superseded in part by ADR-0011 (Espace's homeserver only) |
| [0004](0004-shared-design-tokens.md) | The design tokens are a shared package, not a file copied into two repositories | Accepted |
| [0005](0005-routing-and-server-state.md) | Routing and server state: a typed router with a code-based route tree, and a query cache | Accepted; superseded in part by ADR-0010 (gated owner-claim consume dispatch only) |
| [0006](0006-forms-and-validation.md) | Forms are react-hook-form with zod schemas, wrapped once | Accepted |
| [0007](0007-browser-oidc-client.md) | The browser OIDC client is oidc-client-ts, behind an AuthAdapter | Accepted |
| [0008](0008-tailwind-4-through-the-preset.md) | Tailwind 4, with the tokens preset loaded unchanged through `@config` | Accepted |
| [0009](0009-console-deployment-origins.md) | The Console has agreed Kodera deployment origins | Accepted |
| [0010](0010-owner-claim-native-dispatch.md) | Owner-claim consume has one enforced native dispatch boundary | Accepted; effective only with configured enforcement and source-bound acceptance |
| [0011](0011-workspace-homeserver-is-a-second-backend.md) | The workspace's homeserver is the Console's second backend | Accepted; superseded in part by ADR-0012 (the form of `connect-src`, and one homeserver per deployment) |
| [0012](0012-audio-rooms-join-the-second-backend.md) | Audio rooms join the second backend, and every organisation's homeserver is found under one matrix domain | Accepted |

The cross-repository identity decision is `kodera-core` ADR-0006. The active
execution sequence is the project roadmap.
