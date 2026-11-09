# White-light foundation

Status: Owner-directed source candidate. Main integration, version/tag selection, release, consumer repins and broad visual-reference acceptance remain separate gates.

zôÖma's recorded direction is a white-dominant light interface with ordinary ink text and cobalt reserved for controls, selection and restrained emphasis. This bounded source change corrects the large light backgrounds; text usage and consumer layouts are separate work.

## Values and preserved contract

| Source role | Previous | Candidate |
|---|---|---|
| `color.theme-light.page` | `#EEF3F8` | `#FFFFFF` |
| `color.theme-light.sunken` | `#F7FAFD` | `#FFFFFF` |
| `color.theme-light.page-grad` | Frost/white stops | White at all three existing stops |
| `semantic.surface.page` | `{color.frost.100}` | `{color.white}` |
| `SPEC.pageGradient` | Frost/white references | `color.white` at all three existing stops |

The gradient remains a gradient with angle 115deg and positions 0%, 45%, 100%. CSS variables, Tailwind keys, public types and native role names retain their APIs. Default light, explicit/nested light and the legacy flat/gradient fallback agree. The fixture carries only these light value corrections; its archived reference hash is preserved in the shell specification.

All other source values and metadata remain unchanged apart from the legacy page description. Preserve dark/black, surface/elevated white, every ink/focus/inverse/status/disabled role, muted hover/detail fills, categorical/cursor palettes, typography and geometry. In particular, `accent-ink` remains the cobalt focus core; it is not remapped globally to ordinary ink. Inverse panels require coordinated consumer surface/text/focus changes rather than blanket inverse-token edits.

## Acceptance

The production theme and CSS parity tests reproduce the old page/gradient failure before correction. They enforce default/scoped white backgrounds, legacy parity and refusal of former page/sunken/gradient values, a missing default scope, wrong scoped declarations or stray root overrides. Existing grammar, contrast, drift, unit and native-generation gates remain mandatory. Generate twice and compare every output byte; preserve exported variable/type/preset/native inventories and all dark/black declarations.

The unchanged contrast register keeps every minimum and existing exception. On the corrected white page the light focus core measures 8.07:1 and its outer halo 1.86:1; the halo remains below 3:1 and is never the indicator. The original cobalt 35% example paints `#B5C0F2` at 1.78:1 on white. Historical frost-ground arithmetic remains a distinct regression case. These measurements do not certify a rendered consumer.

## Consumer and release gates

Whitening `sunken` removes tonal separation and may remove hover feedback where consumers reused that role. Before repinning, inspect each use for retained edge, selection, hover, disabled and keyboard-focus cues. Ordinary links/headings/navigation move to ink at their actual use sites; primary-button and destructive/status labels retain their own semantics.

Console qualification must cover real login/recovery, organisation selection, Home/cards, navigation, appearance, Espace transcript/thread/menu/callbar, dialogs/drawers and forms, including loading/error/disabled/danger states. Check 1440/390/320px, all three themes and 200% text zoom. Preserve audience fences, drafts, leave-call and mute behavior. Keycloak, native and Landing require their owners' separate source/runtime and release gates. No consumer, provider, device, deployment or full-programme readiness follows from this package candidate.
