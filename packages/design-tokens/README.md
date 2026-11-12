# kodera-design-tokens

`@kodera/design-tokens` — the design tokens of Kodera, published as one package.

Established by **ADR-0004** in the console repository: the tokens are a shared package, not a file copied into two repositories. Copies drift silently, and nothing errors when they disagree.

```
tokens.json                    W3C DTCG source of truth, delivered by the design workstream
dist/tokens.css                generated CSS custom properties
dist/tailwind.preset.js        generated Tailwind preset (ESM)
dist/tokens.d.ts               generated types
dist/themes.js, themes.d.ts    the theme registry, as a consumer reads it
dist/native/KoderaTokens.swift generated SwiftUI bindings
dist/native/KoderaTokens.kt    generated Compose bindings (io.kodera.tokens)
dist/native/manifest.json      native format, source SHA-256, mapping and provenance
contrast-pairs.json            the accessibility contract, as data
contrast-known-failures.json   the explicit allowlist, one written reason per entry
token-grammar-exceptions.json  naming-grammar deviations, one written reason per entry
scripts/build.mjs              tokens.json → dist/
scripts/check-grammar.mjs      DTCG validity and the naming grammar
scripts/check-contrast.mjs     WCAG 2.1 ratios over contrast-pairs.json
scripts/lib/themes.mjs         the theme registry: the one list every generator reads
scripts/lib/material.mjs       the material tier, read by the grammar, the build and the contrast gate
scripts/lib/gradient.mjs       no gradient in a flat family, a controlled one in a glass family
scripts/lib/spring.mjs         spring physics, solved once into a CSS easing and native parameters
scripts/lib/backdrop.mjs       the worst-case contrast bound for a translucent background
test/token-test.mjs            the reusable token-resolution guard for consumers
```

Everything runs on plain Node 22 with **no dependencies and no install step**. That is not minimalism for its own sake: a consumer installs this package from a git tag, and npm does not run an install or a build for a git dependency. A `dist/` that needed `npm install` to exist would install as an empty package, with no error at all — which is exactly the class of failure this repository is built to make loud.

## Commands

```sh
npm run build           # regenerate dist/ from tokens.json
npm test                # the four gates, all of them, even after one fails
npm run check:grammar   # DTCG validity + naming grammar + tier counts
npm run check:contrast  # the contrast table and the gate
npm run check:drift     # dist/ equals a fresh build
```

## Themes, materials and motion

Five themes in two families, listed once in `scripts/lib/themes.mjs` and read by every generator: `light`, `dark` and `black` are the flat **givre** family; `ciel` and `ciel-nuit` are the light and dark themes of the **ciel** family, "Ethereal Sky Glass". `ciel` is the default (owner decision B2, behind a worst-case contrast gate and a frame-rate gate) and Givre is unchanged and selectable. The ciel family's values are initial. `docs/specs/ethereal-sky-glass.md` is the specification; this is the map.

```js
import { themes, themeIds, defaultTheme, themeFamilies, themeFor } from '@kodera/design-tokens/themes';
```

| What | Tokens | In CSS | In the preset |
|---|---|---|---|
| Theme roles | `semantic.theme.<theme>.<role>` | `--c-<role>` in each `[data-theme="<theme>"]` block | `c-<role>` colours |
| Materials | `semantic.material.<theme>.<level>`, levels `bar`, `panel`, `popover`, `dialog` | `--material-<level>-{tint,fallback,blur,saturate,border,shadow,bg,backdrop}` and the classes `.material-<level>` | `material-<level>`, `material-<level>-border` colours; `material-<level>` shadow |
| Springs | `motion.spring.{snappy,gentle,bouncy}` | `--spring-<name>` and `--spring-<name>-duration` | `ease-spring-<name>`, `duration-spring-<name>` |
| Sky | `color.theme-<theme>.{sky-zenith,sky-horizon}`, stops of `page-grad` | `--c-page-grad` | `bg-c-page-gradient` |

Two defaults are worth knowing before using any of it:

- **A material is opaque unless the client opts in.** `--material-<level>-bg` is the opaque fallback and `-backdrop` is `none`. The glass is switched on under `@supports (backdrop-filter)` for the ciel family, and off again under `prefers-reduced-transparency: reduce`, `prefers-contrast: more` and `forced-colors: active`. Givre declares the same four levels, opaque.
- **A spring is the plain ease-out unless the client opts in.** `--spring-<name>` becomes the sampled `linear()` curve where that function exists, and goes back under `prefers-reduced-motion: reduce`. Use the pair on `transform` and `opacity`.

A translucent surface is measured by the contrast gate over a **backdrop set**: a named list, in `contrast-pairs.json`, of the opaque extremes one theme paints behind its surfaces. A row on a translucent ground names its theme's set and is held to the worst ground in it, to the bounds of every blend a blur can make of them, and to the opaque fallback. A translucent ground with no set fails, as it always did. `docs/adr/0003` is the argument and its limits.

## Native consumers

The build also emits SwiftUI and Compose source files, exported as `@kodera/design-tokens/native/swift` and `/native/compose`, plus `/native/manifest`. Native projects consume these generated files from a pinned package revision. The Swift file imports `SwiftUI`; the Kotlin file declares `package io.kodera.tokens` and imports Compose `Color`, `dp`, `sp` and font weight. Native compilation is a consumer check; this package checks generation and source equality with plain Node.

Both platforms expose one palette per registered theme — `KoderaTokens.light`, `.dark`, `.black`, `.ciel` and `.cielNuit` — with camelCase colour roles: `surface`, `ink`, `actionHover`, `borderInput`, `cursor1Soft`, and the rest. Each palette has the same 78 colour properties; the page gradient is excluded explicitly. The numeric groups are `KoderaTokens.Space.s4`, `Radius.md`, `FontSize.lg`, and `FontWeight.semibold`. Hyphenated keys become camelCase; numeric keys receive an `s` prefix, including `FontSize.s2xl`. Invalid or colliding native identifiers fail the build.

Spacing, radius and font-size tokens preserve the numeric magnitude of source `px` values: Swift points for all three, Compose `dp` for spacing/radius and `sp` for font size. Consumers apply native font scaling and responsive layout. Font weights map to SwiftUI `Font.Weight` and Compose font weights without changing the source weight. `KoderaTokens.FontFamily.sans` and `.mono` expose `primary` and `fallbacks` metadata only: they neither install fonts nor choose a platform font automatically.

Colours use sRGB channels and preserve alpha without compositing. `dist/native/manifest.json` declares format `kodera-native-tokens/1`, the SHA-256 of the exact `tokens.json` bytes, every exported source path and alias chain, native API names, values and units. Package version, environment, time and commit identity are not generator inputs. All other token paths are listed with an exclusion reason; gradients and elevation have no approximation in this format. Web CSS, preset and type outputs keep their existing behavior.

Three groups are additive members of format `kodera-native-tokens/1`; nothing a consumer already uses moves. `KoderaTokens.Theme` is the registry as an enum whose raw value is the theme id (`cielNuit` is `"ciel-nuit"`), with `family`, `mode`, `isDark`, `palette` and `materials`. `KoderaTokens.MaterialSet.<theme>.<level>` is a `Material`: an opaque `tint`, its `alpha`, the `blur` in points or dp, the `saturation`, the `border` and the opaque `fallback` to draw when the platform asks for reduced transparency or increased contrast; the shadow has no native approximation. `KoderaTokens.Motion.snappy`, `.gentle` and `.bouncy` are `Spring` values: `stiffness`, `damping` and `mass` as declared, with the `dampingRatio`, the `response` in seconds and the settling time that follow from them. A native system material is not the CSS filter chain the contrast gate models (`docs/adr/0003`).

The native self-test checks exact source mappings, reproducibility, source identity, theme parity, package exports and unchanged web outputs. Mutations prove refusal of missing roles/groups, dangling aliases, cycles, wrong types, invalid values and identifier collisions; isolated build mutations prove missing/edited native artifacts fail the existing drift gate.

## The three sync tests

ADR-0004 names three tests, each guarding one failure that is otherwise completely silent.

| Test | Runs here | Fails when |
|---|---|---|
| **Token resolution** | exported from here, **runs in a consumer that uses the Tailwind preset** | A Tailwind class names one of our colour families and the token does not exist. Tailwind emits no CSS and no error; for `border-*` the element falls back to preflight's `border: 0 solid #e5e7eb`. |
| **Contrast** | here, on every PR | A declared pair falls below its WCAG minimum and is not in the allowlist with a reason — or the allowlist entry no longer describes the pair: each entry is bound to the pair's `fg`, `bg`, `min` and the ratio it was written at, so a re-pointed pair, a loosened minimum or a colour that moved fails instead of inheriting the old excuse. Translucent colours are composited before measuring; an unresolvable pair is a hard failure, never a skipped row. |
| **Version drift** | each consumer's CI | The consumer's pinned version is more than one minor behind the tag published here. Without it a repository sits on an old palette indefinitely and nothing complains. |

A fourth gate is local to this repository: **drift**, which asserts `dist/` is byte-identical to a fresh build. `dist/` is committed so consumers can install from git, and a committed build output is a copy — the same failure mode ADR-0004 rejects — unless something proves it is still generated.

## How CI is wired

The jobs are in `.github/workflows/ci.yml`. **Tracked dot-entries** refuses a committed dot-entry nobody vouched for, **Grammar, contrast, drift, units** runs `npm test`, **Secret scan** runs gitleaks over the whole history, **Workflow lint** runs actionlint over these workflows, **Vendor attribution** checks every tracked file for assistant attribution, **Vendor attribution (the surfaces that are not files)** checks the branch name, the commit messages on the branch, the tags on the commit and, on a pull request, its title and its body unless a bot opened it, and **Required clauses** checks that every clause in `.github/scripts/required-clauses.txt` is still present. The gitleaks and actionlint archives are verified by SHA-256 before extraction, against the `GITLEAKS_SHA256` / `ACTIONLINT_SHA256` env values recorded next to each pinned version in the workflow. **`ci-ok`** does no work of its own — it needs every other job, and every one of them must have concluded `success`. A job that concluded `skipped` fails it too, unless that job is named in the `SKIP_OK` environment variable on the step; **this repository declares none**, because no job here is conditional, so nothing may skip. That is the whole point of the rule: a skipped required check is reported to branch protection as satisfied, so adding an `if:` or a path filter to a gate would otherwise turn the merge button green precisely because the gate never ran.

`ci-ok` is the single check branch protection points at. Requiring the working jobs by name instead would keep the gate list in repository settings, where it drifts out of step with the workflow: a renamed job leaves the old context required forever, blocking every PR on a check nothing will ever report, while the job that replaced it is required by nothing. Adding, renaming or splitting a gate is therefore a change to `ci.yml` alone.

Before it decides anything, `ci-ok` proves both of its scripts can still fail — `aggregate-result.selftest.sh` and `check-aggregate-covers-jobs.selftest.sh` — and then runs both: `check-aggregate-covers-jobs.py`, which fails if a job exists in `ci.yml` but is missing from `ci-ok`'s `needs:` (such a gate could go red while the required check stayed green), and `aggregate-result.py`, which reads the verdicts. A required check nobody has ever seen fail is a decoration, and this one is the last thing standing between a red gate and a green merge button.

## Releasing

A tag is the release: there is no registry and the package is `private: true`. The procedure — gates green on `main`, `dist/` drift-clean, the contrast register read, the decider of every value change named, an annotated `vX.Y.Z` tag, then one repin pull request per consumer — is in [`RELEASE.md`](RELEASE.md). What each tag carries is in [`CHANGELOG.md`](CHANGELOG.md).

## How a consumer takes it

Until GitHub Packages is set up for the organisation, a consuming repository takes a **git dependency pinned to a tag**. A branch or a bare repository URL is not pinned: it re-resolves on every fresh install, and the palette changes underneath the consumer between two CI runs of the same commit.

```jsonc
// package.json in a consuming repository
{
  "dependencies": {
    "@kodera/design-tokens": "*"
  }
}
```

Tailwind:

```js
// tailwind.config.ts
import koderaPreset from '@kodera/design-tokens/tailwind-preset';

export default {
  presets: [koderaPreset],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Declare nothing else. Re-declaring a colour here is how
  // front-ends start to disagree.
};
```

Anything outside Tailwind — the Visio theme, a raw stylesheet, an email template — reads the CSS instead:

```js
import '@kodera/design-tokens/tokens.css';
```

And a consumer that uses the Tailwind preset runs the resolution guard as one of its own unit tests:

```js
import preset from '@kodera/design-tokens/tailwind-preset';
import { assertClassesResolve, sourceFiles } from '@kodera/design-tokens/token-test';

it('every colour class resolves to a real token', () => {
  assertClassesResolve({ files: sourceFiles('src'), preset, minFiles: 5 });
});
```

The guard throws when a class names one of our families and resolves to nothing. It also throws when it scanned no files or matched no classes, because a guard that silently judges nothing is worse than no guard.

### The version-drift rule for consumers

A consumer pinned more than **one minor** behind the newest tag here fails its own CI. One minor of slack is the review window for a token change; two is a repository nobody is updating. The rule lives in each consumer because that is where the stale pin is, and it is a CI check rather than a convention because a convention about a version number is a convention nobody enforces.

Versioning follows ADR-0004 and DESIGN_HANDOFF F5: renaming or removing a token is a **major**; a deprecation keeps the old name resolving for one minor.

## The source of truth is the design workstream's values

`tokens.json` is the design workstream's delivery. This repository generates from it and measures it; it does not **decide** it. A change to a token value is a design decision and arrives as a PR here carrying three things — the decision, the ratio it now measures in the token's `$description`, and the contrast gate green — or an allowlist entry naming the decision it is still waiting on. It is never a build fix. Three primitives have moved that way, in one signed pass: `color.slate.600`, `color.slate.700` and `semantic.border.input` (ADR-0002).

Two things the build emits are still not tokens: the frost page gradient behind `--bg-page`, and the focus ring. (The themed page gradients are tokens — `semantic.theme.*.page-grad` — and are generated from the source like any other value.) They live in `scripts/lib/spec.mjs` rather than inside the build script, because the contrast gate reads them there too — `contrast-pairs.json` measures the ring by role, so changing its geometry moves what the gate measures instead of leaving the rows describing a ring that is no longer there. The ring's colour is not one value: its core is a theme role, so `--focus-ring` and `--focus-ring-on-inverse` are declared inside each `[data-theme]` block and the light pair carries `:root` with it for a page that sets no attribute.

`dist/` is generated. Editing it by hand is undone by the next build and caught by the drift gate.

## What v0.1 is not

- **The ciel family is a foundation, not a palette.** `ciel` and `ciel-nuit` carry every role, material and row, with initial values chosen so that every gate is green; nothing about their values is decided, and `test/fixtures/themes.json` does not pin them. `ciel` is the unthemed default.
- **Three themes, and an older semantic tier that is still single-valued.** The dark mode ADR-0004 and DESIGN_HANDOFF A4 call for is here: `semantic.theme.light`, `.dark` and `.black` carry the same 79 roles — the product reference's 49 plus `elevated`, `scrim`, `border-input`, `placeholder`, `disabled` and `on-disabled`, the twelve collaborator cursor roles (`cursor-1`..`cursor-6` and `cursor-1-soft`..`cursor-6-soft`), and the twelve non-status categorical tag roles (`tag-1-bg`/`tag-1-fg`..`tag-6-bg`/`tag-6-fg`) — emitted as `--c-*` custom properties and `c-*` preset colours that follow `[data-theme]`, with `ciel` as the unthemed default. The older semantic tokens — `semantic.surface.*`, `semantic.text.*` and the rest — still hold one value each and do not follow the attribute, so migrating a component to `c-*` means auditing its surfaces, text and statuses together. Focus indication is no longer part of that audit: the ring follows the attribute on its own, and the only choice a component still makes is which of the two variants it draws (`--focus-ring` on a normal ground, `--focus-ring-on-inverse` on an inverse panel). `docs/specs/shell-themes.md`.
- **No component tier for colour.** The `component` group is no longer empty — it carries the shell geometry aliases under `component.shell.*` — but nothing in it is a colour. The first component colour token (`button.primary.fill.hover`) arrives with the console's `src/ui/` primitives.
- **No z-index ladder.** DESIGN_HANDOFF A12 is owed, so the preset does not override it and Tailwind's defaults apply. Breakpoints (A13) and themed elevation (A10) are here. `breakpoint.sm` … `breakpoint.2xl` are Tailwind 4's own five steps in rem (640, 768, 1024, 1280 and 1536 px at a 16 px root), mobile-first, for devices from 360 px, with every screen still reflowing at 320 CSS px. They reach the preset as `screens` and the CSS as `--breakpoint-*`, which a media query cannot read. `semantic.elevation.<theme>.raised`, `.overlay`, `.drawer` and `.dialog` reach the CSS as `--elevation-*` inside every `[data-theme]` block and the preset as `shadow-raised`, `shadow-overlay`, `shadow-drawer` and `shadow-dialog`, each a `var()` that follows the theme; a `shadow-c-*` colour or an opacity modifier has no effect on them. Level 0 is `shadow-none`. `shadow-card` and `shadow-pop` are unchanged and stay single-valued.
- **Two contrast pairs are exempt, and none fails.** The tertiary ink, the input border, the focus ring and the placeholder were fixed in the values rather than written down: `color.slate.600` and `color.slate.700` are darker — one step of the ramp does not move alone, so this darkens `text.tertiary` **and** `text.secondary` together — `border.input` is slate.500, the ring is two-tone, an opaque core inside a 35 % halo, both following `[data-theme]`, and `text.placeholder` is slate.600 (5.87:1 on white). What remains in `contrast-known-failures.json` is two rulings — the retired white-on-slate.300 disabled label, and the decorative card edge — each with the trigger that would reopen it. Both read "Decided, not pending": nothing there is awaiting a decision.

## Adding a token

1. Edit `tokens.json`.
2. Add a row to `contrast-pairs.json` for every surface the token can sit on or behind. A colour with no row is unguarded, and DESIGN_SYSTEM.md forbids one. A translucent surface is measured over its theme's named backdrop set; a colour a glass theme can paint behind a surface, a gradient stop included, goes into that set.
3. `npm run build` and commit `dist/`.
4. `npm test`. If a pair fails, the fix is the value — not an allowlist entry, unless the design workstream decided otherwise and the reason says so.
5. If an allowlist entry is what the decision calls for, it carries the pair's `fg`, `bg` and `min`, the ratio measured today, a reason and a decision. `test/check-contrast.selftest.mjs` is where a new way the gate must fail gets its mutation.

## Licence

The code and the token values are [Apache-2.0](LICENSE), copyright Samouraï Coop. The Kodera name and logo are not licensed: see [`TRADEMARKS.md`](TRADEMARKS.md).
