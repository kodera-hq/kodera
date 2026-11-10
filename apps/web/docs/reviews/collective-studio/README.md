# Collective studio review evidence

Status: Locally verified web slice; visual acceptance and live-service qualification pending

## Capture method

Baseline is d83e7a1, exported read-only outside the working tree. After captures use the bundled production web build with the repository's mock authentication, Core API handlers and local community preview. Both use the same room, an explicitly joined office-hours audio preview, and the same draft content. No real media is captured or transmitted. Fixtures are existing product preview data, not copied landing identities or portraits.

Viewports are 1440 × 1000 and 390 × 1000, Chromium, reduced motion, Europe/Paris time zone. Light captures use French; dark captures use English. Baseline English was selected through its development i18n instance because authentication originally reset the choice. After captures select EN on the actual login screen. Full-page mobile images place the existing fixed app tab bar at its initial viewport position; scroll interaction is tested separately. Desktop document content scrolls inside the canvas, leaving the dock visible; captures begin at the breadcrumb, and the source editor continues below the fold.

The primary visual reference is the user-supplied workspace-reference-1048 close-up. Corrected workspace/document landing captures and the read-only studio contract are secondary. Landing PR kodera-hq/kodera-ops#12 remained open at 77762eda819df91792876b8d07c169393ce76ba9 when inspected. These artifacts do not imply its acceptance, merge or deployment.

## Before / after

| Surface                      | Before                                         | After                                            |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Workspace, desktop, light FR | [Baseline](before-workspace-1440-light-fr.png) | [Implemented](after-workspace-1440-light-fr.png) |
| Document, desktop, light FR  | [Baseline](before-document-1440-light-fr.png)  | [Implemented](after-document-1440-light-fr.png)  |
| Workspace, desktop, dark EN  | [Baseline](before-workspace-1440-dark-en.png)  | [Implemented](after-workspace-1440-dark-en.png)  |
| Document, desktop, dark EN   | [Baseline](before-document-1440-dark-en.png)   | [Implemented](after-document-1440-dark-en.png)   |
| Workspace, narrow, light FR  | [Baseline](before-workspace-390-light-fr.png)  | [Implemented](after-workspace-390-light-fr.png)  |
| Document, narrow, light FR   | [Baseline](before-document-390-light-fr.png)   | [Implemented](after-document-390-light-fr.png)   |
| Workspace, narrow, dark EN   | [Baseline](before-workspace-390-dark-en.png)   | [Implemented](after-workspace-390-dark-en.png)   |
| Document, narrow, dark EN    | [Baseline](before-document-390-dark-en.png)    | [Implemented](after-document-390-dark-en.png)    |

## Visual findings and remaining deviations

- Identity, room search, Notifications, Messages and all four tool destinations now share the same sidebar in both canvases. The sage selection uses existing semantic colors, with the current-room leading indicator retained. The room list scrolls independently so navigation stays available. Icons share outline geometry.
- The product retains its resizable 256px default workspace sidebar and 76px module rail. The reference's 170px embedded sidebar does not accommodate real categories, room names, unread counts and audio occupants. This is an explicit adaptation, not a pixel-fidelity claim. Existing conversation onboarding and membership controls also occupy more space than the concept.
- Titles use the newly generated 800-weight token and locally licensed font face. Names use the available 700-weight face rather than the reference's 750. Reading text, compact chrome, borders, spacing and control geometry use existing shared tokens. No exact font is inferred from the concept, and semantic colors are not claimed to match its pixels.
- The full editing row, breadcrumb, contextual export, large title, semantic headings, task toggles and highlighted passage are visible. Narrow layouts wrap all tools instead of dropping them. The editor remains a selection-aware Markdown source plus escaped preview, not collaborative WYSIWYG. Existing document management and developer documentation destinations remain available above it. The source editor requires canvas scrolling at desktop height.
- Favorite, mention and live-draft Share are explicitly unavailable without their required contracts. The preview store's existing Publish action remains functional and identifies its local lifetime. Authorship, anchored comments, count badge and structured document attachments are missing backend scope; the comments column explains that absence and follows the source on narrow screens. No fictional author or comment bubble fills the gap.
- The dark dock spans the workspace navigation and content and retains its controller across view changes. Real participant names/initials and speaking state replace fabricated video. The browser fixture has one actual preview participant; a component test exercises four named audio participants. Camera is visibly unavailable. Four videos, their crops, and camera permission flows require the existing controller to gain a video adapter. Narrow screens stack participants and retain every control in normal scroll flow; this is not a viewport-fixed mobile video strip.
- FR/EN and light/dark are exercised. The English choice now persists through login reload. Native desktop/iOS/Android remain the bounded capability assessment in the [audit](../../specs/collective-studio-product.md), not rewritten clients.

## Functional and regression evidence

| Check                                   | Actual local result                            | Scope and limits                                                                                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web unit/component suite                | 1,071 passed, 65 files                         | Docs, workspace, Matrix messaging and permissions, audio lifecycle, login locale, dock, channel rows, timeline, token/spacing guards; adapters are mocked                                                                                                   |
| New production-browser suite            | 4 passed                                       | 1440/390 × light FR/dark EN; all destinations present, unavailable explanation, keyboard focus, explicit join, mute, retained dock DOM, middle selection formatting, undo, task change, link cancel/insertion, local publication, draft retention and leave |
| Existing production-browser regressions | 20 passed                                      | community-workspace.spec.ts and fonts.spec.ts in light/dark; send/reaction/thread, invite, docs publication, workspace switch, menus, mobile audio and local fonts                                                                                          |
| Accessibility                           | Zero axe violations in four document scenarios | WCAG 2 A/AA, 2.1 AA and 2.2 AA tags; no horizontal overflow; reduced motion and keyboard focus tested; not a screen-reader or physical-device certification                                                                                                 |
| Token package                           | All four gates passed; 111 unit tests          | Grammar, contrast, generated drift and units; selected-room contrast pairs added for light/dark/black                                                                                                                                                       |
| TypeScript                              | Passed                                         | Web application and node configuration                                                                                                                                                                                                                      |
| ESLint                                  | Zero errors, one existing warning              | ContactsStep.tsx React Hook Form watch incompatibility warning is outside this slice                                                                                                                                                                        |
| Production bundling                     | Passed                                         | Existing native config-loader and large-chunk advisories; no new dependency or deployment                                                                                                                                                                   |

Empty, offline, loading, error, failed publication and permission boundaries are covered by the existing component suites, not by the happy-path screenshots. Real provider grants, live media, production authentication and external pad provisioning were not exercised. The draft notice deliberately says it is not saved to the server; only the existing local store's publication callback has saving/failure evidence.

## Reproduction

From the repository root:

```sh
npm --workspace @kodera/web test -- src/features/docs src/features/espace src/features/workspace src/features/login/LoginScreen.test.tsx src/i18n/languagePreference.test.ts src/ui/AudioDock src/ui/ChannelRow src/ui/TimelineMessage tests/unit/ui/tokens.test.ts tests/unit/ui/spacing-guard.test.ts
npm --workspace @kodera/web run typecheck
npm --workspace @kodera/web run lint
npm --workspace @kodera/design-tokens test
npm --workspace @kodera/web run test:e2e -- tests/e2e/collective-studio.spec.ts tests/e2e/community-workspace.spec.ts tests/e2e/fonts.spec.ts
python3 .github/scripts/check-vendor-attribution.py .
```

The standard browser configuration builds the mock profile and runs both Chromium projects. In this session a temporary equivalent configuration served a production build on localhost:4177 with an empty Vite envDir; no environment files were read. The baseline used an isolated export on localhost:4178. Browser screenshots are emitted by collective-studio.spec.ts; the committed files preserve this reviewed run. The new scenario uses computed viewport titles, so it is executed by Playwright rather than counted by the static numbered-spec-name scanner.

See the [capability inventory, component/token map and bounded follow-ups](../../specs/collective-studio-product.md). This evidence supports review of this web slice; it does not mark the remaining product capabilities complete.
