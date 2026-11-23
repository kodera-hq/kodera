# Messages and workspace administration review

Status: Verified locally; ready for review.

The change adds compact Pro/Messages navigation, a desktop conversation master/detail layout,
mobile list/back navigation, filterable conversation rows and bubble message presentation.
The existing attachment, voice-note, poll, reaction and read-only controls remain in use.
Confidential and unclassified rooms retain their preview and search boundaries.

Arrivals ordering is independent of sibling positions, translated labels and category order.
The server, web and native clients recognize the system designation and supported aliases.
Native renderers draw the promoted list before category lists, including the Community card.

OpenAPI 0.57.0 adds optional workspace profile and bootstrap identity/preferences fields.
Migration 0021 follows 0020 and reuses the workspace table. Raster logos are bounded to 2 MiB,
validated by MIME and magic bytes, and held on the tenant workspace row. The browser converts
these bytes into local blob URLs under the existing image CSP. Display names, landing channels,
mode defaults and member capabilities retain conditional writes and administrator authorization.
Invitation policy reaches the tenant worker; link previews check workspace policy before fetch
and before publishing prepared results. Member channel creation is opt-in and rechecked under
the workspace lock, excluding protected rooms and inaccessible category selection.

Socket initialization preserves active listener inodes, private modes and ownership. The worker
retains exclusive responsibility for stale-socket recovery. Canonical and scaffolder Compose
copies remain aligned. The roadmap distinguishes H2.3 server capabilities from remaining client
integration, and records H1.4b's separate native VoIP lane as pending integration into this stack.

Validation uses npm workspace commands because the repository declares npm as its package manager.
All checks below passed on the final implementation; affected checks were repeated after the final fixes. Live deployment, provider and
signed-device qualification are separate from these local checks.

## Validation

| Check | Result |
| --- | --- |
| Web unit suite | 550 files, 7,343 tests passed; affected final retest: 114 tests passed |
| Web typecheck and lint | Passed; one existing React Hook Form warning, no errors |
| Browser acceptance | Four desktop/mobile tests in light/dark, including sending, outgoing bubbles, filtering, keyboard mode switching, mobile Back and accessibility |
| Black theme | Accessibility scan passed with zero violations |
| Server non-DB contract/domain suite | 461 tests passed |
| PostgreSQL runtime suite | 136 tests passed; three final tenant-isolation/profile tests passed separately |
| Migration | Fresh PostgreSQL migration chain passed; model state reports no missing workspace migrations |
| OpenAPI | No breaking changes from 0.56.0; four mirror comparisons, 26 workspace operation/example checks, Wave 4 checks and 220-operation authorization matrix passed |
| Served operations and consumer | Served-operation inventory unchanged and verified; generated web types/mocks and consumer alignment passed |
| Native | 25 Swift tests, 23 Kotlin tests, Android app compilation, Swift source parsing and both resource gates passed |
| Production bundle | Entry gzip 153,716 bytes; largest deferred chunk 158,544 bytes |
| Staging bundle | Entry gzip 155,472 bytes; largest deferred chunk 158,566 bytes |
| Telemetry bundle | Entry gzip 154,068 bytes; largest deferred chunk 158,566 bytes |
| Bundle safety | All three profiles passed size, catalogue, dependency and chunk-cycle gates; production/staging simulation-exclusion checks passed |
| Community deployment | Compose security/mutation checks, mirrored assets and live/stale socket runtime checks passed |
| Repository policy | Attribution gate, all 11 required clauses, Python compilation and whitespace checks passed |

The required-clause manifest on this branch is `.github/scripts/required-clauses.txt`; the
requested JSON path does not exist. Every declared clause was preserved.

## Files changed (complete inventory)


- [ROADMAP.md](../../ROADMAP.md)
- [apps/android/CHANGELOG.md](../../apps/android/CHANGELOG.md)
- [apps/android/app/src/main/kotlin/io/kodera/android/session/CommunityWorkspaceCard.kt](../../apps/android/app/src/main/kotlin/io/kodera/android/session/CommunityWorkspaceCard.kt)
- [apps/android/app/src/main/kotlin/io/kodera/android/session/SignedInScreen.kt](../../apps/android/app/src/main/kotlin/io/kodera/android/session/SignedInScreen.kt)
- [apps/android/client/src/main/kotlin/io/kodera/android/client/CoreWorkspaceClient.kt](../../apps/android/client/src/main/kotlin/io/kodera/android/client/CoreWorkspaceClient.kt)
- [apps/android/client/src/test/kotlin/io/kodera/android/client/CoreWorkspaceClientTests.kt](../../apps/android/client/src/test/kotlin/io/kodera/android/client/CoreWorkspaceClientTests.kt)
- [apps/ios/App/CommunityWorkspaceCard.swift](../../apps/ios/App/CommunityWorkspaceCard.swift)
- [apps/ios/App/SignedInView.swift](../../apps/ios/App/SignedInView.swift)
- [apps/ios/CHANGELOG.md](../../apps/ios/CHANGELOG.md)
- [apps/ios/packages/KoderaClient/Sources/KoderaClient/CoreWorkspaceClient.swift](../../apps/ios/packages/KoderaClient/Sources/KoderaClient/CoreWorkspaceClient.swift)
- [apps/ios/packages/KoderaClient/Tests/KoderaClientTests/CoreWorkspaceClientTests.swift](../../apps/ios/packages/KoderaClient/Tests/KoderaClientTests/CoreWorkspaceClientTests.swift)
- [apps/server/apps/engine_intents/channel_sets.py](../../apps/server/apps/engine_intents/channel_sets.py)
- [apps/server/apps/media/services.py](../../apps/server/apps/media/services.py)
- [apps/server/apps/workspaces/administration.py](../../apps/server/apps/workspaces/administration.py)
- [apps/server/apps/workspaces/api/administration.py](../../apps/server/apps/workspaces/api/administration.py)
- [apps/server/apps/workspaces/api/iam.py](../../apps/server/apps/workspaces/api/iam.py)
- [apps/server/apps/workspaces/api/moderation.py](../../apps/server/apps/workspaces/api/moderation.py)
- [apps/server/apps/workspaces/api/serializers.py](../../apps/server/apps/workspaces/api/serializers.py)
- [apps/server/apps/workspaces/channel_order.py](../../apps/server/apps/workspaces/channel_order.py)
- [apps/server/apps/workspaces/channel_sets.py](../../apps/server/apps/workspaces/channel_sets.py)
- [apps/server/apps/workspaces/governance.py](../../apps/server/apps/workspaces/governance.py)
- [apps/server/apps/workspaces/initialise.py](../../apps/server/apps/workspaces/initialise.py)
- [apps/server/apps/workspaces/logo.py](../../apps/server/apps/workspaces/logo.py)
- [apps/server/apps/workspaces/migrations/0021_workspace_logo_and_ux_preferences.py](../../apps/server/apps/workspaces/migrations/0021_workspace_logo_and_ux_preferences.py)
- [apps/server/apps/workspaces/models.py](../../apps/server/apps/workspaces/models.py)
- [apps/server/apps/workspaces/structure.py](../../apps/server/apps/workspaces/structure.py)
- [apps/server/config/settings/base.py](../../apps/server/config/settings/base.py)
- [apps/server/contracts/agent-api.openapi.yaml](../../apps/server/contracts/agent-api.openapi.yaml)
- [apps/server/contracts/check_wave4_surfaces.py](../../apps/server/contracts/check_wave4_surfaces.py)
- [apps/server/contracts/check_wave_surfaces.py](../../apps/server/contracts/check_wave_surfaces.py)
- [apps/server/contracts/core-api.openapi.yaml](../../apps/server/contracts/core-api.openapi.yaml)
- [apps/server/docs/api/AUTHZ.md](../../apps/server/docs/api/AUTHZ.md)
- [apps/server/tenant_agent/channels.py](../../apps/server/tenant_agent/channels.py)
- [apps/server/tests/test_customer_read_contract.py](../../apps/server/tests/test_customer_read_contract.py)
- [apps/server/tests/test_e2ee_contract.py](../../apps/server/tests/test_e2ee_contract.py)
- [apps/server/tests/test_proximity_contract.py](../../apps/server/tests/test_proximity_contract.py)
- [apps/server/tests/test_realm_discovery_contract.py](../../apps/server/tests/test_realm_discovery_contract.py)
- [apps/server/tests/test_tenant_agent_channels.py](../../apps/server/tests/test_tenant_agent_channels.py)
- [apps/server/tests/test_workspace_onboarding.py](../../apps/server/tests/test_workspace_onboarding.py)
- [apps/server/tests/test_workspace_onboarding_contract.py](../../apps/server/tests/test_workspace_onboarding_contract.py)
- [apps/server/tests/test_workspace_ux.py](../../apps/server/tests/test_workspace_ux.py)
- [apps/server/tests/workspace_safety/iam_schema_inventory.py](../../apps/server/tests/workspace_safety/iam_schema_inventory.py)
- [apps/server/tests/workspace_safety/test_workspace_ux.py](../../apps/server/tests/workspace_safety/test_workspace_ux.py)
- [apps/web/contracts/agent-api.openapi.yaml](../../apps/web/contracts/agent-api.openapi.yaml)
- [apps/web/contracts/contract.lock.json](../../apps/web/contracts/contract.lock.json)
- [apps/web/contracts/core-api.openapi.yaml](../../apps/web/contracts/core-api.openapi.yaml)
- [apps/web/public/developer-docs/en/api.md](../../apps/web/public/developer-docs/en/api.md)
- [apps/web/public/developer-docs/fr/api.md](../../apps/web/public/developer-docs/fr/api.md)
- [apps/web/public/llms.txt](../../apps/web/public/llms.txt)
- [apps/web/src/api/schema.d.ts](../../apps/web/src/api/schema.d.ts)
- [apps/web/src/app/ModuleRail.tsx](../../apps/web/src/app/ModuleRail.tsx)
- [apps/web/src/features/command-palette/WorkspacePaletteRegistration.tsx](../../apps/web/src/features/command-palette/WorkspacePaletteRegistration.tsx)
- [apps/web/src/features/command-palette/messages.ts](../../apps/web/src/features/command-palette/messages.ts)
- [apps/web/src/features/docs/developerDocsContent.json](../../apps/web/src/features/docs/developerDocsContent.json)
- [apps/web/src/features/espace/ChannelSidebar.tsx](../../apps/web/src/features/espace/ChannelSidebar.tsx)
- [apps/web/src/features/espace/EspaceChannelHeader.tsx](../../apps/web/src/features/espace/EspaceChannelHeader.tsx)
- [apps/web/src/features/espace/EspaceLiveView.tsx](../../apps/web/src/features/espace/EspaceLiveView.tsx)
- [apps/web/src/features/espace/MessageRow.tsx](../../apps/web/src/features/espace/MessageRow.tsx)
- [apps/web/src/features/espace/MessagesPinnedBanner.tsx](../../apps/web/src/features/espace/MessagesPinnedBanner.tsx)
- [apps/web/src/features/espace/SimpleMessagingSidebar.test.tsx](../../apps/web/src/features/espace/SimpleMessagingSidebar.test.tsx)
- [apps/web/src/features/espace/SimpleMessagingSidebar.tsx](../../apps/web/src/features/espace/SimpleMessagingSidebar.tsx)
- [apps/web/src/features/espace/WorkspaceUiModeToggle.tsx](../../apps/web/src/features/espace/WorkspaceUiModeToggle.tsx)
- [apps/web/src/features/espace/uiModePreference.test.ts](../../apps/web/src/features/espace/uiModePreference.test.ts)
- [apps/web/src/features/espace/uiModePreference.ts](../../apps/web/src/features/espace/uiModePreference.ts)
- [apps/web/src/features/messaging/unfurl/UnfurlCard.tsx](../../apps/web/src/features/messaging/unfurl/UnfurlCard.tsx)
- [apps/web/src/features/workspace/OrganisationHeader.tsx](../../apps/web/src/features/workspace/OrganisationHeader.tsx)
- [apps/web/src/features/workspace/admin/WorkspaceProfilePanel.test.tsx](../../apps/web/src/features/workspace/admin/WorkspaceProfilePanel.test.tsx)
- [apps/web/src/features/workspace/admin/WorkspaceProfilePanel.tsx](../../apps/web/src/features/workspace/admin/WorkspaceProfilePanel.tsx)
- [apps/web/src/features/workspace/admin/adminMessages.ts](../../apps/web/src/features/workspace/admin/adminMessages.ts)
- [apps/web/src/features/workspace/admin/shared.tsx](../../apps/web/src/features/workspace/admin/shared.tsx)
- [apps/web/src/features/workspace/iamApi.test.ts](../../apps/web/src/features/workspace/iamApi.test.ts)
- [apps/web/src/features/workspace/iamApi.ts](../../apps/web/src/features/workspace/iamApi.ts)
- [apps/web/src/features/workspace/useWorkspaceLogo.ts](../../apps/web/src/features/workspace/useWorkspaceLogo.ts)
- [apps/web/src/features/workspace/workspace.test.ts](../../apps/web/src/features/workspace/workspace.test.ts)
- [apps/web/src/features/workspace/workspace.ts](../../apps/web/src/features/workspace/workspace.ts)
- [apps/web/src/features/workspace/workspaceCache.ts](../../apps/web/src/features/workspace/workspaceCache.ts)
- [apps/web/src/index.css](../../apps/web/src/index.css)
- [apps/web/src/mocks/demo/community.test.ts](../../apps/web/src/mocks/demo/community.test.ts)
- [apps/web/src/mocks/demo/workspaceGovernance.ts](../../apps/web/src/mocks/demo/workspaceGovernance.ts)
- [apps/web/src/ui/TimelineMessage/TimelineMessage.tsx](../../apps/web/src/ui/TimelineMessage/TimelineMessage.tsx)
- [apps/web/tests/e2e/collective-studio.spec.ts](../../apps/web/tests/e2e/collective-studio.spec.ts)
- [apps/web/tests/e2e/community-workspace.spec.ts](../../apps/web/tests/e2e/community-workspace.spec.ts)
- [apps/web/tests/e2e/core-workspace-journey.spec.ts](../../apps/web/tests/e2e/core-workspace-journey.spec.ts)
- [apps/web/tests/e2e/files-command-shortcuts.spec.ts](../../apps/web/tests/e2e/files-command-shortcuts.spec.ts)
- [apps/web/tests/e2e/messages-mode.spec.ts](../../apps/web/tests/e2e/messages-mode.spec.ts)
- [apps/web/tests/e2e/settings-profile.spec.ts](../../apps/web/tests/e2e/settings-profile.spec.ts)
- [apps/web/tests/e2e/workspace-founder-regressions.spec.ts](../../apps/web/tests/e2e/workspace-founder-regressions.spec.ts)
- [apps/web/tests/unit/api/contract-consumer-alignment.test.ts](../../apps/web/tests/unit/api/contract-consumer-alignment.test.ts)
- [apps/web/tests/unit/api/generated.test.ts](../../apps/web/tests/unit/api/generated.test.ts)
- [apps/web/tests/unit/api/regen-clean.test.ts](../../apps/web/tests/unit/api/regen-clean.test.ts)
- [apps/web/vite.config.ts](../../apps/web/vite.config.ts)
- [deploy/community/docker-compose.yml](../../deploy/community/docker-compose.yml)
- [deploy/community/test_media_worker_startup.py](../../deploy/community/test_media_worker_startup.py)
- [docs/reviews/H2_6_MESSAGES_WORKSPACE_ADMIN.md](../../docs/reviews/H2_6_MESSAGES_WORKSPACE_ADMIN.md)
- [docs/specs/H2_6_MESSAGES_WORKSPACE_ADMIN.md](../../docs/specs/H2_6_MESSAGES_WORKSPACE_ADMIN.md)
- [docs/specs/collaboration-status.md](../../docs/specs/collaboration-status.md)
- [packages/api-contract/README.md](../../packages/api-contract/README.md)
- [packages/api-contract/agent-api.openapi.yaml](../../packages/api-contract/agent-api.openapi.yaml)
- [packages/api-contract/core-api.openapi.yaml](../../packages/api-contract/core-api.openapi.yaml)
- [packages/api-contract/package.json](../../packages/api-contract/package.json)
- [packages/create-kodera/assets/docker-compose.yml](../../packages/create-kodera/assets/docker-compose.yml)
- [scripts/ci/check-community-deploy.py](../../scripts/ci/check-community-deploy.py)
