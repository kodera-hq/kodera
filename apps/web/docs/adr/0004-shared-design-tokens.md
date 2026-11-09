# ADR-0004: The design tokens are a shared package, not a file copied into two repositories

**Status:** Accepted
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context

Two front-ends render the same brand: `kodera-web` (static, prerendered, dark only) and this console (stateful, authenticated, light and dark). ADR-0001 states they share the design tokens and nothing else.

What exists today is not a design system. The hub's `tailwind.config.js` holds 21 colours and two font stacks — dark mode only, no spacing, type scale, radius, elevation, motion, z-index, breakpoints, semantic layer, or focus style. The light ramp the console needs is settled elsewhere, in `kodera-visio/theme/custom.css`, because the brand coral `#FD6262` measures 2.96:1 on white and fails both the AA text minimum (4.5:1) and the non-text minimum (3:1); Visio ships `#B83636` for primary, `#8F2E2E` for tertiary text and `#5C6FBF` for the focus ring instead. So the values a console needs already live in two repositories, in two formats, with one hard-won accessibility correction present in only one of them.

The failure mode this decision exists to prevent is quiet. A Tailwind colour class naming a token that does not exist produces **no CSS rule and no error**: the build succeeds, the class stays in the markup, and the element falls back to preflight — for `border-*`, to `border: 0 solid #e5e7eb`, a light grey line on a dark page. The hub shipped exactly that on two membership cards. Its `src/tailwind-tokens.test.ts` is the asset worth keeping from the current setup, and the one thing that makes the failure loud.

A copied token file adds a second such failure mode, slower and worse: the two copies drift, nothing errors, and the difference surfaces when someone puts two screenshots side by side.

## Decision

**One small repository publishing one package, `@kodera/design-tokens`, consumed by the hub and by the console.**

It publishes three artefacts, all generated from one source:

1. **`tokens.json`**, W3C DTCG format, three tiers — primitive (raw values) → semantic (`surface.raised`, `text.muted`, `border.state.danger`) → component (`button.primary.bg`) — with a light and a dark value for every semantic token. It carries the type scale (8 steps, `clamp()`), spacing on a 4 px base, radius reconciled from today's 9/12/13/14/16/20 px into four steps, elevation, motion with a `prefers-reduced-motion` rule, z-index, breakpoints, and the focus ring.
2. **`tokens.css`**, generated: custom properties under `:root` and the dark selector. This is what Visio-style consumers and anything outside Tailwind read.
3. **A Tailwind preset**, generated: `presets: [koderaPreset]` in each consumer's `tailwind.config.ts`. Consumers re-declare nothing. Consumers must not duplicate token values in their local Tailwind configuration.

**Three sync tests keep the consumers honest**, each guarding one silent failure:

| Test | Lives in | Fails when |
|---|---|---|
| Token resolution | each consumer | A class names one of our colour families and the token does not exist — the case that emits no CSS at all. Ported and generalised from `kodera-web/src/tailwind-tokens.test.ts`, widened to `.tsx` and to spacing, radius and type, not colour alone. |
| Contrast pairs | the tokens repository | Any declared pair falls below its WCAG minimum. Same shape as `kodera-visio/scripts/check-contrast.py`: an explicit table of (foreground, background, label, minimum), covering text on every surface, status pills, button fills, disabled states, the focus ring against **both** adjacent surfaces, and state-carrying borders. A pair whose token is missing is reported as SKIP and counted, so a renamed token cannot quietly empty the suite. |
| Version drift | each consumer's CI | The consumer's pinned `@kodera/design-tokens` is more than one minor behind the published version. Without it a repo sits on an old palette indefinitely and nothing complains. |

**Components: Radix Primitives with shadcn-style local copies in `src/ui/`.** Behaviour — focus trapping, roving tabindex, `aria-*` wiring, dismiss semantics — comes from Radix, which is unstyled. Appearance comes from our tokens. The copies are ours, in this repository, reviewed by CODEOWNERS, so a fix to a focus ring is a normal PR and never a fork of a dependency.

**Storybook with the accessibility addon, in the console only.** The console has the component inventory (roughly 28 primitives, each with default, hover, active, focus-visible, disabled, loading, error, empty and skeleton states); the hub has a landing page. Storybook there would be scaffolding nobody opens.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: a published `@kodera/design-tokens` package** | One source of truth, versioned, with a drift check. Costs a release step and a second PR per consumer to adopt a change. |
| Copy `tokens.json` into both repositories | Zero setup, and it is what exists today. Rejected: two copies drift silently, and the accessibility correction that lives in only one of them is the proof. Nothing fails when they disagree. |
| Monorepo for hub + console + tokens | Solves sharing outright. Rejected: it merges two deployments, two release cadences and two CI shapes to share one file, and would fold a static prerendered site into an authenticated application's pipeline against ADR-0001. |
| A styled component library (MUI, Chakra) | Rejected: its theme becomes the source of truth and our tokens become a translation layer over someone else's design language. The bar is Qonto or Revolut, which means our own visual identity, and the bundle and override cost are paid on every screen. Radix gives the behaviour without the appearance. |
| Radix Themes rather than Primitives | Rejected for the same reason, one step lighter: it ships opinions about colour and radius we would spend the project overriding. |

## Consequences

- A token change is a release of the tokens package plus a bump PR in each consumer. Slower than editing a file; the drift check is what makes the slowness visible rather than optional.
- The console cannot style anything until the package exists. This is deliberate — the palette here is empty on purpose, and no colour class may be written before the token-resolution test can judge it.
- The contrast table becomes the accessibility contract. Any new semantic pair has to be added to it, or it is unguarded.
- `src/ui/` is owned by CODEOWNERS and needs a second reviewer: every screen inherits its focus and keyboard behaviour.
- Revisit if the tokens package release cycle becomes the bottleneck for design iteration; the fallback is a `workspace:` link during heavy design work, never a copied file.
