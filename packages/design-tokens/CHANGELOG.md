# Changelog

One section per tag, newest first, no dates: the tag and the commit it points at are the record, and `RELEASE.md` says how a tag is cut. `Unreleased` collects what is on `main` (or in an open pull request named here) and not yet tagged.

`v0.1.0` is the first tag; nothing before it was tagged. A consumer pinned to a commit SHA moves to the tag as `RELEASE.md`, "After the tag", describes.

## Unreleased

- Relicensed from MIT to Apache-2.0 (`LICENSE`, `package.json`) for open-core monorepo unification.
- **`ciel` is the default theme** (owner decision B2, `feat/w3-ciel-default-theme-and-strict-style-csp`): the two gates `docs/specs/ethereal-sky-glass.md` set before a default both stand. The unthemed root now takes `ciel`; `themes.js` `defaultTheme`, the manifest's `default` flags, Swift `Theme.defaultTheme` and Compose's `isDefault` follow. No token name or value changes. The root claim is `:root:where(:not(<every other theme>))` rather than a bare `:root`, which tied with `[data-theme="<other>"]` and lost to whichever block came later: with the default declared after Givre, a bare `:root` would have painted Ciel on a page that chose Givre. `test/theme-registry.selftest.mjs` holds the claim, with a mutation for the bare form.

"Ethereal Sky Glass", the engine and its foundation tokens (`docs/specs/ethereal-sky-glass.md`). Additive: every token name, CSS variable, preset key and native member a consumer uses today still resolves to the same value, so this is a minor (`RELEASE.md`, step 5). The family, its theme ids, the opaque fallback and the two gates before it can be a default were decided by zôÖma, through the lead session; the values the new themes carry are initial and are not decided.

### Added

- **A theme registry**, `scripts/lib/themes.mjs`: five themes as a family in a mode — `light`, `dark`, `black` (givre) and `ciel`, `ciel-nuit` (ciel). Every generator reads it; `scripts/build.mjs` holds `tokens.json` to it in both directions. Exported to consumers as `@kodera/design-tokens/themes` (`themes`, `themeIds`, `defaultTheme`, `themeFamilies`, `themeFor`, and the types `ThemeId`, `ThemeFamily`, `ThemeMode`, `ThemeInfo`).
- **The `ciel` family**: `[data-theme="ciel"]` and `[data-theme="ciel-nuit"]`, each with the 79 roles, the four elevation levels and primitives of its own (`color.theme-ciel.*`, `color.theme-ciel-nuit.*`, `shadow.theme-ciel*.*`). Foundation values: Givre light and dark with the grounds moved towards a sky.
- **A material tier**: `material.theme-<theme>.<level>` and `semantic.material.<theme>.<level>`, levels `bar`, `panel`, `popover`, `dialog`, in all five themes. CSS variables `--material-<level>-tint`, `-fallback`, `-blur`, `-saturate`, `-border`, `-shadow`, `-bg` and `-backdrop` in every theme block, and the classes `.material-bar`, `.material-panel`, `.material-popover`, `.material-dialog`. Opaque by default; the glass is enabled under `@supports (backdrop-filter)` for the ciel family and disabled under `prefers-reduced-transparency: reduce`, `prefers-contrast: more` and `forced-colors: active`. Preset: colours `material-<level>` and `material-<level>-border`, shadow `material-<level>`. New primitives `color.theme-ciel.glass`, `.glass-edge` and their `ciel-nuit` twins.
- **A controlled sky**: `color.theme-<theme>.sky-zenith` and `.sky-horizon` in the two ciel themes, and a three-stop `page-grad` through them. Givre gradients stay one colour (D-UI3).
- **Spring motion**: `motion.spring.snappy`, `.gentle`, `.bouncy`, as stiffness, damping and mass. CSS variables `--spring-<name>` and `--spring-<name>-duration`; preset keys `ease-spring-<name>` and `duration-spring-<name>`. The plain ease-out by default; the sampled `linear()` curve where it is supported and motion is not reduced.
- **Native**, additive members of format `kodera-native-tokens/1`: palettes `KoderaTokens.ciel` and `.cielNuit`; `KoderaTokens.Theme`, `ThemeFamily`, `ThemeMode`; `KoderaTokens.Material`, `Materials`, `MaterialSet.<theme>.<level>`; `KoderaTokens.Spring`, `Motion.<name>`. The manifest gains `themes` and entries of type `material` and `spring`.

### Gates

- **Contrast**: a translucent background is still a hard failure, unless the row names a backdrop set: a list, declared once under `backdropSets` for one registered theme, of the opaque extremes that theme paints behind a surface. The row is then measured over every extreme, the bounds of every blend of them, any declared `layers`, and a material's opaque fallback, and held to the minimum (`docs/adr/0003`). The ground's own theme selects the set; a list written into a row is refused. A gradient ground is measured over its stops, and every stop a glass theme paints must be one of its backdrop extremes. 936 rows, 0 fail: the 486 that were there are unchanged, and 450 are new (the ciel twins of every Givre row, seven rows per material level in every theme, twelve stacked rows, and text on the sky).
- **Grammar**: `material` is a root group that admits one composite; `spring` and `material` are closed composites, field by field; a gradient is one colour everywhere except a ciel theme's own, which is bounded to four stops, each a named opaque colour of that theme, anchored at 0 and 1.
- **The contrast report no longer exits before its table is written**: `process.exit()` cut a long table on a pipe on platforms where pipe writes are asynchronous.

### Tests

- New: `test/theme-registry.selftest.mjs`, `test/check-grammar.selftest.mjs`, `test/backdrop-contrast.selftest.mjs`, `test/sky-glass.selftest.mjs`, `test/spring-motion.selftest.mjs`. `test/check-contrast.selftest.mjs` gains every refusal of the backdrop rule. `test/givre-nuit.selftest.mjs` scopes its no-gradient clause to the givre family and to every gradient that belongs to no theme, with a mutation for each way a gradient could enter Givre.

## v0.6.0

A wider rail item, so the rail's labels fit in 12 px sentence case, and a content-header height of its own. One value changes and one name is added, so this is a minor (`RELEASE.md`, step 5). The licence entry below was carried over from `Unreleased`.

### Decided by

- **`feat/rail-item-68`**: zôÖma, who accepted the reference screens as drawn, with their listed deviations (design specification #123, `design/reference/README.md`, "Deviations from the product mock, accepted": the row "Rail entry 56 px | 68 px (`shell-rail-width` less one spacing step)", because « Messages » at 12 px is 58 px wide). The lead session lands it for gap G6 of the console gap report.

### Token values changed — design decisions

- **Rail item**: `space.shell-rail-item-width` `56px` → `68px`. `semantic.layout.rail-item-width` and `component.shell.rail-item-width` reference it, so `--shell-rail-item-width`, `--sp-shell-rail-item-width`, `--layout-rail-item-width`, the preset's `shell-rail-item-width` key and the native bindings follow. The rail itself stays 76 px. A consumer that uses the item width as a height grows taller with it. The console does so twice: its square rail items, and its content header (`TopBar`, the shell's `header`), which is `shell-rail-item-width` tall, the approved 56 px. Its repin gives both their own height: the items from padding, as the reference draws them, and the header the new `shell-header-height` below, so the header stays at 56 px.

### Tokens added

- `space.shell-header-height` (`56px`), with `semantic.layout.header-height` and `component.shell.header-height`: the content header's height, the approved console height that the console took from the rail item width until now. CSS variables `--shell-header-height`, `--sp-shell-header-height` and `--layout-header-height`; the preset key `shell-header-height`; native `shellHeaderHeight`. Decided by zôÖma through the console's shell-fidelity spec (`kodera-console` `docs/specs/shell-fidelity.md`, status "approved by the owner": "a 56 px content header"); the token keeps the console's pixels as they are. Open question for zôÖma, not decided here: the reference accepted in design specification #123 draws the content header at 60 px (`design/reference/README.md`, "Content header | `.head` | 60 px"), and its deviations table has no 56 px row; the console's `TopBar` records the same gap.

### Tests

- The shell geometry pins `header-height` at 56 px, and a new test holds a rail item to the rail less one spacing step, as the reference defines it.

### Licence

- The code and the token values are licensed under MIT (`LICENSE`, `package.json` `"license": "MIT"`), copyright Samouraï Coop. The Kodera name and logo are excluded (`TRADEMARKS.md`). Decided by zôÖma.

## v0.5.0

"Givre & Nuit": a deeper dark theme, a near-black rail in every theme, a brighter cobalt in dark and black, flat grounds everywhere and rounder corners. Values only: every token name, CSS variable and preset key a consumer uses today still resolves; two primitives are added. Together with the two entries carried from `Unreleased` below, this is a minor (`RELEASE.md`, step 5). Direction, reference screens and the design contrast table: `docs/specs/givre-nuit.md`.

### Decided by

- **`feat/givre-nuit-v0.5.0`**: zôÖma, through the lead session (decisions D-UI1 to D-UI4): direction approved; Automatique stays the default theme; **no gradient**, plain cobalt only; the black theme is kept.
- The white-light foundation and the native bindings below: as recorded in their own entries.

### Token values changed — design decisions

- **Dark grounds** (`color.theme-dark.*`): `page` `#10151B` → `#0B0E14`, `sunken` `#131A21` → `#0E1219`, `surface` `#171E26` → `#131823`, `elevated` `#1D252E` → `#1B2130`, `muted` `#1F2831` → `#1D2433`, `muted-2` `#242E38` → `#262E3E`, `hairline` `#1B222A` → `#161B25`, `border` `#2C353F` → `#262E3C`, `border-soft` `#242D36` → `#1D2430`, `border-strong` `#3A4551` → `#344056`, `border-input` `#6B7886` → `#6E7D94`, `inverse` `#0C1116` → `#07090D`, `inverse-2` `#1E2831` → `#161B26`, `rail-line` `#39434F` → `#2A3242`.
- **Dark inks**: `ink` `#E8EFF6` → `#EDF1F7`, `ink-2` `#B9C6D4` → `#B8C2D1`, `ink-3` `#98A6B5` → `#97A3B5`, `ink-4` `#7F8D9C` → `#7D8A9D`, `placeholder` `#8592A1` → `#8F9BAE`, `on-inverse-dim` `#9EADBC` → `#A1ADBE`.
- **Cobalt in dark and black**: `action` `#3B57DE` → `#4361EE`; `accent-ink` `#A9BBFF` → `#AEBEFF` (the focus-ring core follows); `accent-soft` (dark) `#1C2540` → `#1A2350`. `action-hover` was `{color.cobalt.500}` (`#2B4BDB`, the light action, darker than the dark action); it is now each theme's own primitive, `#3A59E8`.
- **Flat page**: the dark and black `page-grad` stops are all the page colour (`#0B0E14`, `#000000`), as light's already are. No theme paints a gradient.
- **Light** (on top of the white foundation): `ink` `#2F3A45` → `#1E2933`, `inverse` `#2F3A45` → `#111827` (the rail and inverse panels), `inverse-2` `#3D4956` → `#1D2535`, `rail-line` `#56626E` → `#3A4559`, `on-inverse-dim` `#C9D3DE` → `#B4BFCC`.
- **Radius** (web and native): `md` 8 → 10 px (also the preset's `rounded` default), `lg` 12 → 16 px, `xl` 16 → 20 px.
- Unchanged: status roles, tags, cursors, `t1`–`t6`, typography, spacing, elevation geometry, the legacy non-themed roles (`--surface-inverse`, `--text-*`).

### Tokens added

- `color.theme-dark.action-hover` and `color.theme-black.action-hover` (`#3A59E8`), with their CSS variables `--theme-dark-action-hover` and `--theme-black-action-hover`. `semantic.theme.<theme>.action-hover` references them.

### Contrast register

- Six normative rows, two per theme: `action` against `surface` and against `page` at 3:1 (non-text, 1.4.11). Light 6.70:1 and 6.70:1, dark 3.54:1 and 3.85:1, black 3.90:1 and 4.18:1. In dark the fill measured 2.88:1 against `surface` before (old `action` on old `surface`), so this pair could not be gated until now. The rows are a floor, not a pin: the old dark `action` alone measures 3.05:1 and 3.32:1 on the new grounds and would pass them. What pins the decided values is `test/fixtures/themes.json` and the cursor test's `action-hover` probe.
- 483 rows, 0 fail, 0 allowed, unchanged exemptions. Tightest text row: `on-inverse` on `action`, 4.66:1 in dark and 4.79:1 in black.

### Gates

- `test/givre-nuit.selftest.mjs` joins the `units` gate. It checks that no theme paints a gradient, that no gradient token anywhere in the tree has two colours, that no `linear-gradient` in the built CSS or preset has two distinct stop colours (a sandbox build of a top-level two-stop primitive proves it), that the dark grounds get lighter in order (`inverse` < `page` < `sunken` < `surface` < `elevated`), that every theme's `inverse` is a near-black rail (luminance below 0.02), that every `action-hover` is its theme's own primitive, that the six action rows exist and are normative at 3:1, and that the radius ladder rises with `md` 10, `lg` 16 and `xl` 20 px. Seventeen mutations, fifteen in memory and two on a sandbox build, each assert their own message.
- The pinned references move with the decision: `test/fixtures/themes.json` (36 role values: light 5, dark 27, black 4; dark `disabled` and `on-disabled` move through their references to `muted-2` and `ink-3`), the dark and black focus ring in `test/css-parity.selftest.mjs`, `--r-lg` there, `Radius.md` in the native test, and the cursor mutation that probes `action-hover`, which now sits next to the new dark hover.

### Carried from `Unreleased`

White-light foundation candidate, decided by zôÖma: use white for the light page and sunken backgrounds and all existing page-gradient stops, including the legacy page fallback. Preserve every token name, gradient angle/stop position, dark/black map, ink/focus/status/disabled value and geometry. Canonical web/native outputs carry the same correction; consumers have not been repinned. Production regressions bind default/scoped light and legacy/themed parity. No version, tag, contrast threshold or exception changes. See `docs/specs/white-ink-foundation.md`.

Add deterministic SwiftUI and Compose bindings, source provenance and a native format manifest. Existing web outputs and all token values are unchanged. Native generation and refusal mutations run in the existing test and drift gates. No package version or release tag is changed.

## v0.4.0

**#38** (`feat/cursor-and-tag-palettes`) adds the collaborator cursor palette (DESIGN_HANDOFF A11), the non-status categorical tag palette (A5 / A11), and the nine contrast rows requested by **#37** across all three shell themes (`light`, `dark`, `black`), bringing each theme from 55 to 79 roles. It adds names only and does not rename, remove or change any token a consumer already uses (`t1`–`t6` stay untouched). `RELEASE.md`, step 5, makes the whole a minor.

### Decided by

- **#38** (`feat/cursor-and-tag-palettes`): zôÖma, design-tokens track. All values below are new.

### Tokens added

- **Collaborator cursor palette**, twelve roles per theme (`cursor-1`..`cursor-6` and `cursor-1-soft`..`cursor-6-soft`), named generically rather than under `docs-cursor-*` so the collaborative canvas/board, presence indicators and document editor share one palette instead of falling back to `action` or `ink-4` (`p06-docs.html` drew collaborator 2's cursor in `ink-4` because only one accent existed). Every solid cursor role stays at least `ΔE76 >= 10` away from `action` and `action-hover` (`cursor-1` is cerulean `~207°`, `ΔE76 >= 42.9` from `action`):
  - `cursor-1` / `cursor-1-soft` (cerulean): `#0E60A3` / `#E4F0FB` in light, `#1671BA` / `#112536` in dark, `#1873BC` / `#0B1A28` in black;
  - `cursor-2` / `cursor-2-soft` (iris): `#6336C2` / `#EFE9FC` in light, `#7C52DC` / `#241B3E` in dark, `#8056E0` / `#1B1330` in black;
  - `cursor-3` / `cursor-3-soft` (teal): `#0E6E78` / `#E3F4F6` in light, `#147984` / `#0F262C` in dark, `#157D88` / `#0B1E23` in black;
  - `cursor-4` / `cursor-4-soft` (berry): `#A82468` / `#FAEAF2` in light, `#C1357B` / `#321728` in dark, `#C5387E` / `#26101E` in black;
  - `cursor-5` / `cursor-5-soft` (copper): `#AC4D0C` / `#FDF0E4` in light, `#B15310` / `#2E1E12` in dark, `#B65511` / `#23150B` in black;
  - `cursor-6` / `cursor-6-soft` (jade): `#117556` / `#E4F5EE` in light, `#157B5B` / `#112922` in dark, `#177F5E` / `#0B1F19` in black.
- **Non-status categorical tag palette**, twelve roles per theme (`tag-1-bg`/`tag-1-fg`..`tag-6-bg`/`tag-6-fg`), for room topics, departments, categories and filter chips that carry no status meaning. The existing `t1`–`t6` roles stay untouched for avatar tints and status-aligned chips; because `t1`–`t4` reuse the semantic `accent`, `ok`, `warn` and `bad` softs and inks, every `tag-1`..`tag-6` pair sits outside all four semantic status hue bands (`bad` red `345°–15°`, `warn` amber `15°–50°`, `ok` emerald `120°–165°`, `accent` cobalt `220°–240°`) and reuses zero status or `t1`–`t5` values:
  - `tag-1-bg` / `tag-1-fg` (iris, `~256°`): `#F1EEFC` / `#4D2CA6` (8.25:1) in light, `#231B3C` / `#D5C8FA` (10.41:1) in dark, `#19132C` / `#DFD4FC` (12.78:1) in black;
  - `tag-2-bg` / `tag-2-fg` (teal, `~187°`): `#E5F4F6` / `#0E5E6A` (6.58:1) in light, `#10282E` / `#9FE0EA` (10.49:1) in dark, `#0A1E23` / `#B0E7EF` (12.69:1) in black;
  - `tag-3-bg` / `tag-3-fg` (plum, `~321°`): `#F9EBF4` / `#8A2465` (7.23:1) in light, `#311728` / `#F0B9DC` (9.88:1) in dark, `#25101E` / `#F5C7E4` (12.10:1) in black;
  - `tag-4-bg` / `tag-4-fg` (cerulean, `~204°`): `#E6F1FA` / `#12517A` (7.38:1) in light, `#122638` / `#A8D5F5` (9.93:1) in dark, `#0C1C2B` / `#B8DDF8` (12.11:1) in black;
  - `tag-5-bg` / `tag-5-fg` (orchid, `~283°`): `#F5ECF9` / `#6E2889` (7.84:1) in light, `#2B1836` / `#E4BEF5` (10.09:1) in dark, `#201129` / `#EBCBF8` (12.30:1) in black;
  - `tag-6-bg` / `tag-6-fg` (lichen, `~84°`): `#EEF3E6` / `#3F571B` (7.18:1) in light, `#1E2814` / `#C7DEA0` (10.51:1) in dark, `#151D0D` / `#D3E6B2` (12.96:1) in black.
- Seventy-two primitives (`color.theme-<theme>.cursor-*` and `color.theme-<theme>.tag-*`) and seventy-two semantic aliases (`semantic.theme.<theme>.cursor-*` and `semantic.theme.<theme>.tag-*`), each emitted as `--c-<role>` inside every `[data-theme]` block and as `c-<role>` in the Tailwind preset.

### Contrast register

- **One hundred thirty-five normative rows** join `contrast-pairs.json`, forty-five per theme, with no exemptions, inversions or allowlist entries:
  - For each collaborator cursor slot (`cursor-1`..`cursor-6`): `cursor-N` on `surface` (3:1, worst `dark.cursor-6` at 3.21:1), `cursor-N` on `sunken` (3:1, worst `dark.cursor-6` at 3.35:1), `on-inverse` on `cursor-N` for floating cursor name flags (4.5:1, worst `black.cursor-2` at 4.63:1), `ink` on `cursor-N-soft` for selection highlights (4.5:1, worst `light.cursor-2-soft` at 9.79:1), and `spec:focus-ring.<theme>.indicator` on `cursor-N-soft` (3:1, worst `light.cursor-2-soft` at 6.81:1).
  - For each non-status categorical tag slot (`tag-1`..`tag-6`): `tag-N-fg` on `tag-N-bg` (4.5:1, worst `light.tag-2` at 6.58:1) and `spec:focus-ring.<theme>.indicator` on `tag-N-bg` (3:1, worst `light.tag-3-bg` at 7.00:1).
  - For **#37** (Espace reference screens and primitives): `ok-ink` on `muted` (4.5:1: 5.81:1 light, 7.67:1 dark, 8.92:1 black), `inverse` on `on-inverse` for the pressed call toggle plate (4.5:1: 11.59:1 light, 17.62:1 dark, 20.03:1 black), and `spec:focus-ring-on-inverse.<theme>.indicator` on `bad` for the danger leave/toast controls (3:1: 5.42:1 light, 5.03:1 dark, 5.17:1 black), plus three non-normative `measurements` rows reporting `spec:focus-ring-on-inverse.<theme>.outer` on `bad`.

### Gates

- `test/color-math.selftest.mjs` classifies `cursor-1`..`cursor-6` as non-grounds (solid cursor strokes and flag fills), `cursor-1-soft`..`cursor-6-soft` and `tag-1-bg`..`tag-6-bg` as painted grounds requiring default focus-ring coverage rows, and `bad` alongside `inverse` and `inverse-2` as a ground requiring `on-inverse` focus-ring coverage across all three themes.
- `test/cursor-and-tag-palettes.selftest.mjs` joins the `units` gate:
  - checks that all six collaborator cursor slots per theme alias their theme primitives, carry descriptions, clear 3:1 on `surface` and `sunken`, clear 4.5:1 under `on-inverse` and `ink` on `-soft`, stay `>= 20°` apart in hue, stay `ΔE76 >= 10` away from `action` and `action-hover`, reuse no action/status/`ink-4` hex value, carry all five normative contrast rows per slot (plus the three `#37` rows per theme), and emit scoped CSS and dynamic `var(--c-*)` preset entries;
  - checks that all six non-status categorical tag pairs per theme alias their theme primitives, carry descriptions, clear 4.5:1 (`tag-N-fg` on `tag-N-bg`), stay outside all four semantic status hue bands (`bad` red, `warn` amber, `ok` emerald, `accent` cobalt), reuse no status or `t1`–`t5` hex value, keep `-bg` and `-fg` within `10°` in hue and distinct slots `>= 12°` apart, carry both normative contrast rows (`tag-N-fg` at 4.5:1 and `focus-ring` at 3:1), and emit scoped CSS and dynamic `var(--c-*)` preset entries;
  - twenty-seven self-test mutations prove every clause, `ΔE76` floor, `#37` row requirement, and status-band refusal fails on its own with its expected message.

## v0.3.0

Two pull requests since `v0.2.0`. **#35** (`feat/breakpoint-elevation-tokens`) adds breakpoint tokens (DESIGN_HANDOFF A13) and themed elevation tokens (A10). It adds names and does not rename, remove or change anything a consumer can use today. **`chore/release-v0.3.0`** cuts this version and changes only `package.json`'s `version` and this file. `RELEASE.md`, step 5, makes the whole a minor.

### Decided by

- **#35** (`feat/breakpoint-elevation-tokens`): zôÖma through the lead's delegated authority (owner decisions D0–D6, which delegate design authority to the lead session). The values below are new.

### Tokens added

- **Breakpoints**, a new `breakpoint` root group (primitive tier, `dimension`): `sm` 40rem, `md` 48rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem (640 to 1536 px at a 16 px root), mobile-first min-widths. The smallest device designed for is 360 px, and every screen still reflows without horizontal scroll at 320 CSS px (WCAG 1.4.10). They reach the preset as `screens` and the CSS as `--breakpoint-*`. They are Tailwind 4's own default steps, so a Tailwind 4 consumer that takes the preset sees no change, and its queries keep scaling with the reader's default font size.
- **Elevation**, four levels plus level 0 (`shadow-none`, no token), each with a purpose, one geometry and a value per theme:
  - `raised`, a resting card: the `shadow.card` geometry, `0 8px 24px -16px`, in the theme's `shadow-1`;
  - `overlay`, a menu, popover, select, tooltip or toast: the `shadow.pop` geometry, `0 20px 50px -20px`, in `shadow-2`;
  - `drawer`, a panel fixed to a screen edge: `0 0 64px -8px`, with no offset so it falls on the open edge whichever edge the panel is on, in `shadow-2`;
  - `dialog`: `0 32px 80px -24px`, in `shadow-2`.

  A level is chosen by the kind of surface, not by its z layer (A12): a toast sits above a dialog and still casts level 2.
- Twelve primitives, `shadow.theme-<theme>.<level>`, hold the geometry and reference the theme's existing shadow colour. They are public CSS variables too, `--shadow-theme-light-raised` … `--shadow-theme-black-dialog`, typed in `TokenCssVariable`, so removing one later is a major. `semantic.elevation.<theme>.<level>` references them.
- Each level reaches the CSS as `--elevation-<level>` inside every theme block and the preset as `boxShadow.<level>`, a `var()`, so `shadow-overlay` follows `[data-theme]`. A `shadow-c-*` colour or an opacity modifier has no effect on it.
- No new colour. The levels reuse `color.theme-*.shadow-1` and `shadow-2`, which `contrast-pairs.json` already measures.
- `shadow.card` and `shadow.pop` are unchanged. Today the console draws `shadow-card shadow-c-shadow-1` and `shadow-pop shadow-c-shadow-2`; `shadow-raised` and `shadow-overlay` render those same shadows in each theme.
- Not covered: A10's mapping of `kodera-web`'s three arbitrary shadows. The hub is out of Kodera's scope.

### Gates

- The grammar gate accepts the `breakpoint` root group. It now reads references inside a composite value: one is allowed in a shadow's `color` only, and it must resolve, without a cycle, to a colour token. Each of those fails as `[alias]`, naming the token and the field, instead of reaching the CSS as a literal `{…}` string or a length where a colour belongs.
- The build resolves that colour and names the token when it is not a colour. It refuses an elevation set that is missing in a theme, empty, or different between themes, and a level named after a shadow primitive or after one of Tailwind's own shadow sizes (`sm`, `lg`, `inner` …), which it would silently replace.
- `test/elevation-breakpoints.selftest.mjs`, in the `units` gate, checks four things:
  - four levels, weakest first, each in its own theme's shadow colour and distinct across themes;
  - one geometry per level, with `raised` and `overlay` field for field equal to `shadow.card` and `shadow.pop`, and blur rising up the ladder;
  - every level scoped in every theme block and dynamic in the preset;
  - four or five rem breakpoints, rising from above 360 px, each in the CSS and equal to the preset's `screens`.

  Every clause, and every error above, has a mutation that asserts its own message. Deleting any one of the new build or grammar checks turns the suite red.

## v0.2.0

Four pull requests since `v0.1.1`: three merged, and the one that cuts this version. **`feat/themes-dark-black`** completes the three themes for the screens the product reference does not draw (menus, dialogs, form fields, disabled controls) and fixes the two placeholder rows by value; it adds names and changes one value, and renames or removes nothing. **#32** (`fix/token-resolution-coverage`) changes `test/token-test.mjs`, which consumers import as `./token-test`, and is recorded under "Fixed". **#31** (`chore/bounded-attribution-check`) and **#33** (a Dependabot bump of `actions/setup-node`) changed how this repository is checked. `RELEASE.md`, step 5, makes the whole a minor.

### Decided by

- **`feat/themes-dark-black`**: @zxxma, through the lead session to which @zxxma delegated design and merge authority (owner decisions D0–D6); the lane brief carries @zxxma's wish for a more modern UI and a real dark theme. Every value below is new except `semantic.text.placeholder`.

### Fixed

- **#32**: the token-resolution guard now also scans `divide-*` and the directional borders (`border-t-*` … `border-e-*`, `border-x-*`, `border-y-*`), matched by the longest prefix so `border-l-*` is not read as `border-*`, and never from inside a hyphenated name. A consumer's CI that repins can newly fail on such a class that does not resolve, which is the point of the guard.

### Token values changed — design decisions

- `semantic.text.placeholder`: `{color.slate.500}` → `{color.slate.600}`. The hint now clears 4.5:1 like running text — 5.87:1 on white (was 3.62:1) and 5.22:1 on the muted field (was 3.21:1) — so `text.placeholder/surface.default` and `text.placeholder/surface.muted` lose their exemption and leave `contrast-known-failures.json`. Every field still carries a visible label. `slate.500` itself does not move: it stays the picto and `border.input` step, and `forbidden:slate.500/surface.default` still fails the gate if it ever becomes usable as text. Three consumer names move with it, from `#7C8894` to `#5A6672`: the CSS variable `--text-placeholder` and the preset keys `text-placeholder` and `ink-placeholder`. A consumer that uses `slate-500` directly sees nothing change.

### Tokens added

- Six roles in every theme, after the 49 reference roles (`docs/specs/shell-themes.md`, "Roles added beyond the reference"): `elevated` (menus, popovers, dialogs; `#FFFFFF` / `#1D252E` / `#141619`), `scrim` (dialog overlay), `border-input` (the edge of a control the user has to find, 3:1), `placeholder` (4.5:1), `disabled` and `on-disabled` (a neutral fill and a 4.5:1 label). Each reaches consumers as `--c-<role>` inside every theme block and as a `c-<role>` preset colour. Eight theme primitives carry the values no existing primitive held (`color.theme-dark.elevated`, `.border-input`, `.placeholder`, `.scrim`; `color.theme-black.elevated`, `.border-input`, `.scrim`; `color.theme-light.scrim`); the other roles reference the primitive that already carries their value.

### Contrast register

- Sixty-six normative rows join `contrast-pairs.json`, twenty-two per theme: the focus ring on `elevated` (3:1; `elevated` is a shell container, so the coverage check in `test/color-math.selftest.mjs` requires it), the four inks and the three status `-ink` roles on `elevated` (4.5:1), `ink-4` icons on `elevated` (3:1), `border-input` on `surface`, `sunken`, `muted` and `elevated` (3:1), `placeholder` on the same four (4.5:1), `on-disabled` on `disabled` (4.5:1), and four pairs the reference screens draw that no row covered: `ink` and `ink-3` on `accent-soft`, `ink` on `warn-soft`, `ok-ink` on `surface` (all 4.5:1, worst 4.70:1, light `ink-3` on `accent-soft`). None is exempt, inverted or allowlisted; the worst is `light.border-input` on `muted` at 3.21:1. Three decorative `measurements` rows report the scrim on the page, and nine `capability` rows report the `ok`, `warn` and `bad` fills as icons on `elevated`: the decided usage there is the `-ink` role, and dark `bad` would measure 2.86:1.
- `contrast-known-failures.json` goes from four rulings to two: the retired white-on-slate.300 disabled label and the decorative card edge, both unchanged.

### Gates

- `test/check-contrast.selftest.mjs` took its subjects from the allowlist, whose first entry was the placeholder; it is now the disabled label. Three mutations had been written against the placeholder's ink. "An entry whose pair has started passing" wrote black onto the subject's token, which the disabled label shares with the primary button's two label rows, so those rows went red too and the case's exit status proved nothing: with the gate's "delete the entry" branch disabled it still passed. It now moves only the subject row's foreground and asserts that the gate counts exactly one problem; with that branch disabled it goes red again. Of the other two, re-pointing a pair at `surface.inverse` assumed a dark foreground (white on inverse passes, so the gate reported "delete the entry" instead of the reason under test), and the "worse colour" case used a literal tuned to slate.500. The first now picks a surface on which the re-pointed pair still fails, and asserts one exists; the second derives the worse ink from the subject by laying 60 % of its background over it. Each still asserts the message the gate prints.

## v0.1.1

Four merged pull requests since `v0.1.0` (`b91e07e`, #26). **#30** (`fix/dark-action-hover-and-source-walk`) changes `test/token-test.mjs` and is recorded under "Fixed". The other three changed how this repository is checked and maintained: **#27** (`docs/rename-wave-1-prose`) touched `package.json`, but only its `description` and `repository.url`, alongside README, `RELEASE.md`, `.github/dependabot.yml` and ADR prose; **#28** (`chore/relevel-shared-checkers`) re-levelled the shared checkers under `.github/scripts/`; **#29** (`chore/s06-workflow-range-rules`) changed `.github/workflows/ci.yml` and `.github/scripts/required-clauses.txt`. None of the four changes `tokens.json`, `scripts/lib/spec.mjs` or `dist/`, so nothing a consumer renders moves, `RELEASE.md`, step 4, has no decider to name, and step 5 names two bumps, a major for a renamed or removed name and a minor for a value change, neither of which applies, so the version moves by a patch.

### Fixed

- `sourceFiles` in `test/token-test.mjs`, the walk consumers pass to `assertClassesResolve`, tested its default `/node_modules|dist|\.git/` against the **whole absolute path**: `src/features/distribution/`, a file named `dist.ts`, anything under `.github`, and every file of a checkout that sits under a `dist` directory went unscanned, with no error. By default it now skips `node_modules`, `dist` and `.git` only as whole path segments below the root it is given — the behaviour of `guardedSourceFiles` in open console PR #125 (not merged), so that copy need not land, or can be dropped after it does. Console `main` (`d1ec716`) calls `sourceFiles(SRC)` with the default walk in three guards (tokens, spacing, theme roles); on its `src/` the old and the new walk list the same 495 files, so this fix changes nothing there today. A caller-supplied `ignore` still replaces the default and is still tested against the whole path. Four tests in `test/token-test.selftest.mjs`: two fail on the old walk, one fails if the default skips nothing, and one fails if a caller-supplied `ignore` stops replacing the default.

### Deviation from the mock, kept

- `semantic.theme.dark.action-hover` and `semantic.theme.black.action-hover` stay `{color.cobalt.500}` (`#2B4BDB`), not the high-fidelity mock's `--c-action-hover` `#4C6BF0`. Decided by @zxxma, superseding a same-day ruling that would have taken the mock's value: under `#4C6BF0` the primary button's `on-inverse` label on hover measures 4.18:1 (dark) and 4.29:1 (black), below the 4.5:1 running text asks; on `#2B4BDB` it measures 6.23:1 and 6.40:1. This is the deviation #18 recorded under `v0.1.0`, reaffirmed; `docs/specs/shell-themes.md`, "Decided observed combinations", carries it. No value moves.

## v0.1.0

The first tag carries everything on `main` at the commit it points at. **#1** (`chore/bootstrap`) created the package from the design drop, and the sections below describe what changed since. Five merged pull requests after it changed `dist/`, `tokens.json`, `test/token-test.mjs` or `package.json`: **#17** (`feat/control-selection-ring-token`); **#9** (`fix/tertiary-text-contrast`), which carried the contrast decisions first opened as #6 (`feat/contrast-decisions`) — #6 was closed unmerged, so #9 is the single commit that landed them; **#14** (`chore/package-private-and-release-procedure`), which wrote this file and `RELEASE.md` and is recorded under "Added" at the end; **#18** (`feat/complete-shell-theme-tokens`), the three shell themes; and **#20** (`feat/theme-the-focus-ring`), the themed focus ring, whose entries the sections below mark. **#15** (`docs/contrast-register-hardening`) changed the contrast register and its gate. The other eleven — #4, #7, #8, #13, #16, #19, #21, #22, #23, #24 and #25 — changed how this repository is checked and maintained; none of the twelve touched any of those four paths.

### Decided by

`RELEASE.md`, step 4: every pull request in `git log -- tokens.json scripts/lib/spec.mjs` up to this tag, and the person who decided what it changed.

- **#1** (`chore/bootstrap`): @zxxma (design of record v0.1)
- **#9** (`fix/tertiary-text-contrast`): @zxxma (owner decision B3)
- **#17** (`feat/control-selection-ring-token`): @zxxma (owner decision B0b)
- **#18** (`feat/complete-shell-theme-tokens`): @zxxma (owner decision B3)
- **#20** (`feat/theme-the-focus-ring`): @zxxma (owner decision B-themed-ring, also stated in its description)

### Token values changed — design decisions

These are the first value changes since the design drop. Each one was decided before it landed, and ADR-0002 is where that is on record (see "Governance" below); none of them is a build fix.

Three of the four edit `tokens.json`: the two slate steps and `semantic.border.input`. The fourth does not. The focus ring has no token in v0.1 — its geometry is a constant in `scripts/lib/spec.mjs` (`SPEC.focusRing`), which `scripts/build.mjs` imports and emits as both `--focus-ring` and the Tailwind `ring*` defaults; only the ring's colour comes from `tokens.json`, through `semantic.action.primary` as the ring stood then, and that token is not changed. The distinction matters for "Governance" below: ADR-0001's "never edits a value" clause was about `tokens.json`, so it bound the first three directly and did not reach the ring. ADR-0002 closes that gap from both ends — it replaces the clause for token values, and it makes `scripts/lib/spec.mjs` a declared build input whose every composed colour carries a contrast row — so the ring is decided on the same footing as the three token moves without being recorded as a token edit.

- `color.slate.600`: `#66737F` → `#5A6672`. This is `semantic.text.tertiary`, the smallest body colour. It now clears 4.5:1 on every surface it sits on, including `frost.200`, the dark end of the page gradient (was 3.84:1 there).
- `color.slate.700`: `#56626E` → `#4C5763`. This is `semantic.text.secondary`, moved down with tertiary so the two do not converge into one colour.
- `semantic.border.input`: `{color.slate.300}` → `{color.slate.500}`. The boundary of a control the user must find now clears 3:1 on white (3.62:1; slate.300 measured 1.52:1, SC 1.4.11).
- Focus ring: two-tone. An opaque 2 px core in `semantic.action.primary` (6.70:1 on white, 6.01:1 on the page) with the delivered 35 % halo kept at 3 px outside it. `--focus-ring` becomes `0 0 0 2px #2B4BDB, 0 0 0 5px rgba(43, 75, 219, 0.35)`; the Tailwind `ring` defaults become the opaque core (`2px`, `#2B4BDB`). The single-tone halo measured 1.78:1. **#20** themes that core; the entry below has the new values.

**#20 changes one thing a consumer already renders: the light theme's focus ring.** Like the ring entry above, it is a change to a spec constant rather than to `tokens.json`, and no token value moves with it.

- Focus ring: themed. The opaque core follows `[data-theme]` instead of carrying one value under every attribute. `--focus-ring` takes `semantic.theme.<t>.accent-ink` and a new `--focus-ring-on-inverse` takes `semantic.theme.<t>.on-inverse`, for a control on an inverse panel; the widths, the 35 % halo and the layer order are unchanged. **In the light theme the core moves `#2B4BDB` → `#2340C4`** — on white the ring goes from 6.70:1 to 8.07:1 — so the default theme's ring is visibly, if slightly, a different blue. Dark and black draw `#A9BBFF`. The preset's `ringColor.DEFAULT` becomes `var(--focus-ring-color)` rather than a frozen hex, and `ringColor["on-inverse"]` is added; `ringWidth.DEFAULT` stays `2px`.

Both slate moves are **primitive** moves: a consumer that uses `slate-600` or `slate-700` directly, not only through `text-tertiary` / `text-secondary`, shifts with them.

**#18 changes no existing token value.** It adds 313 tokens and changes and removes none, so nothing a consumer already renders moves with it. One of the values it adds departs from the product reference, and that departure is a design decision on the same footing as the four above:

- `semantic.theme.dark.action-hover` and `semantic.theme.black.action-hover`: `#4C6BF0` → `{color.cobalt.500}` (`#2B4BDB`). The dark and black button hover fill is the shared cobalt. The reference value put the hover label at 4.18:1 (dark) and 4.29:1 (black) under `on-inverse`, below the 4.5:1 running text asks; the decided fill measures **6.23:1** and **6.40:1**, with no waiver. The two rejected theme primitives (`color.theme-dark.action-hover`, `color.theme-black.action-hover`) are removed from the source rather than left as unused variables — they are values #18 never shipped, not tokens it took away. Light is unchanged; hover now darkens from `action` instead of lightening.

### Tokens added

- `space.control-selection-ring-width` (`5px`) and `semantic.control.selection-ring-width`, which references it (#17). This names the 5 px ring the selected radio already renders; the rendering itself does not change. The build emits `--control-selection-ring-width`, `--sp-control-selection-ring-width` and the Tailwind `ringWidth["control-selection"]: "5px"` — consumer-visible names the first tag carries. It is the **selected-control** ring, not the keyboard focus indicator: the focus ring's geometry stays in `scripts/lib/spec.mjs` and `ringWidth.DEFAULT` stays `2px` (`docs/specs/control-selection-ring.md`). No colour, contrast pair, threshold or exception moves with it.
- The three shell themes (#18): complete light, dark and black semantic maps under `semantic.theme.*`, each carrying the same 49 roles, emitted as `--c-*` custom properties that follow `[data-theme]` (the unthemed default is light) and as matching `c-*` Tailwind colours, plus `bg-c-page-gradient` for the themed page gradient. Existing token paths, CSS declarations and static preset keys are preserved; the new API is opt-in. Spec: `docs/specs/shell-themes.md`.
- Shell geometry (#18): `--shell-*` custom properties and `w-shell-*` preset widths — rail 76px, rail item 56px, sidebar 264px, document column 780px maximum and 360px minimum, dock 340px with a 24px edge offset — as named spacing tokens with semantic and `component.shell.*` aliases. This is the first content the grammar's reserved `component` group has ever carried, and none of it is a colour. A width token is not a breakpoint.
- Theme gradients (#18) as DTCG stop lists with a namespaced `io.kodera.css-gradient` angle extension; generation reproduces the reference CSS exactly, and a gradient is never a Tailwind colour.

### Contrast register

- `contrast-known-failures.json` goes from nine allowed and two exempt rows, all "awaiting the design decision", to four exempt rulings, each with the trigger that reopens it: the two placeholder rows (a placeholder is never real text; every field carries a visible label), `action.onPrimary/slate.300` (the white-on-slate.300 disabled label is retired; the decided rule is `text.tertiary` on the slate.300 fill, a component rule that has no token until the component tier carries colour — #18 puts the shell geometry aliases in that group, and nothing else), and `border.default/surface.default` (decorative; the card's extent is carried by `shadow.card`).
- Three forbidden rows added to `contrast-pairs.json`, each failing the gate if the pair ever starts passing: `slate.500`, `green.500` and `amber.500` as running text on white.
- The focus ring is measured against the unthemed `semantic.surface.*` values by **four** rows, each addressing a tone by role rather than naming a token that resembles it. `focus-ring/surface.default` and `focus-ring/surface.page` read the opaque core at 8.07:1 and 7.23:1 against a 3:1 minimum. `focus-ring-halo/surface.default` and `focus-ring-halo/surface.page` read the 35 % halo alone, at 1.86:1 and 1.82:1; both are `expect: "fail"`, so the halo cannot be quietly promoted back to carrying the ring on its own. All four name the light role (`spec:focus-ring.light.*`) since **#20** made the ring themed; the ratios above are that pull request's, and were 6.70:1, 6.01:1, 1.78:1 and 1.74:1 before it. No row overrides the alpha, and none can: `contrast-pairs.json`'s `$comment` records that "the alpha travels with the colour and no row can opt out", so what the gate measures is what `scripts/lib/spec.mjs` composes.
- Each of the four allowlist entries is now **bound to the pair it excuses** (#15). It carries the pair's `fg`, `bg` and `min` alongside the `ratio` measured when it was written, and `bindingProblem()` in `scripts/check-contrast.mjs` fails the gate the moment any of them stops matching: a pair re-pointed at other tokens or at another `spec:` role, a minimum loosened, or a measured ratio that has moved by more than 0.05 in either direction. A missing `reason` or a missing `decision` fails there too. Before #15 the gate read one field — `reason` — so `ratio`, `min` and `decision` were carried but inert and `fg`/`bg` were not carried at all: an entry was attached to its pair by nothing but the `id`. The rule splits at the minimum and only one half ever fires on a row. A pair that has come to clear its minimum is refused before a single field is read, because such an entry is to be deleted rather than re-measured — and a minimum loosened far enough for the pair to clear lands there too, reported as an entry to delete rather than as a loosened bound; the field bindings apply only while the pair is still failing, which is the case where the colour moved under a ruling that still has something to excuse. No entry carries an `fgAlpha` either, for the reason the row above gives: compositing is unconditional and the alpha travels with the colour (ADR-0002), so there is nothing there to bind to. `test/check-contrast.selftest.mjs` joins the `units` gate with fifteen cases — two baselines and thirteen that break exactly one thing and assert the note the gate prints for that reason. One baseline asserts an untouched copy of the gate and its inputs is green; the other builds the subject the role-addressed mutations need — the ring row held to a minimum it does not clear, with a scratch ruling to excuse it — and asserts that copy is green too, measuring the ratio the ruling records, so building it is setup rather than one of the breaks. **One** of the thirteen also asserts a note the gate must **not** print: a minimum loosened far enough for the pair to clear could be reported either as an entry to delete or as a loosened bound, and that case pins the first by requiring the second to be absent. Nothing a consumer renders moves with it: #15 edits neither of the build's two inputs, `tokens.json` and `scripts/lib/spec.mjs`, and no file in `dist/`.
- Two light-theme usages are decided rather than re-coloured (#18): the selected room row's icon uses `ink-3` on `accent-soft` (**4.70:1**; `ink-4` measured 2.99:1 against 3:1), and the connected-room indicator uses `ok-on-dark` on `inverse` (**8.10:1**; `ok` measured 2.73:1 against 3:1). No token value moved. The two rows measure the decided usages: `theme.light/icon-ink-3/accent-soft` and `theme.light/indicator-ok-on-dark/inverse`. Every theme role is covered by a normative pair or by an explicitly non-normative measurement (decorative or capability, each with a purpose); no theme row is exempt, inverted or listed in `contrast-known-failures.json`, so the four allowlist entries above are still the whole allowlist and still the only exempt rows.
- **The themed ring is gated, on every ground it is claimed to clear (#20).** Fifty-four normative rows join `contrast-pairs.json`, eighteen per theme at `min: 3.0`: `theme.<t>/focus-ring/<ground>` for the six shell containers and the ten painted backgrounds, `theme.<t>/focus-ring-on-inverse/<ground>` for the two inverse panels. None is exempt, inverted or allowlisted. The worst measurement across all fifty-four is 6.39:1, the light core on `light.muted-2`; the on-inverse core's worst is 9.19:1 on `light.inverse-2`. Each row addresses the ring by a role that names its theme — `spec:focus-ring.<theme>.indicator`, `spec:focus-ring-on-inverse.<theme>.indicator` — so a role without a theme in it, which would measure whichever ring the spec handed back, fails the check in `test/color-math.selftest.mjs`.
- **The four non-normative `measurements` rows for the unthemed ring are retired (#20).** They recorded `dark.surface` 2.51:1, `dark.sunken` 2.62:1, `dark.page` 2.74:1 and `black.surface` 2.92:1 under #18, gated by nothing, because the ring did not follow `[data-theme]` and there was no themed alternative to point at. There is one now, so the reason they existed is gone; the same grounds are covered by enforcing rows instead. The shortfall they recorded was also incomplete: the unthemed core failed on all eight dark grounds and five of the black theme's eight, and on two of the **light** theme's own — `light.inverse` 1.73:1 and `light.inverse-2` 1.37:1 — which no document in this repository recorded until #20 closed it.
- **Six `measurements` rows are added in their place (#20),** `focus-ring-on-inverse-halo/theme.<t>.inverse` and `…/theme.<t>.inverse-2` — both panels, in every theme, so each figure quoted for that tone is derived by a row rather than copied into prose. The default ring's halo stays below 3:1 on all fifty-four theme-and-ground combinations measured (1.01:1 to 2.27:1) and four inverted rows pin it there, two of them new on `dark.surface` (2.27:1) and `black.surface` (2.20:1). The on-inverse ring's halo does not: it reaches 3.04:1 on `dark.inverse` and 3.15:1 on `black.inverse-2`. It therefore gets no inverted row — one would assert something false — and is reported non-normatively instead, with the purpose saying why. What carries the guarantee on those two grounds, where the gate reports a translucent-only ring as a PASS on its own row, is an invariant rather than a row: `test/color-math.selftest.mjs` asserts that the tone against the control is opaque across every theme and every variant, and a mutation that drops the opaque core proves it fails by name.

### Gates

- `test/theme-contract.selftest.mjs` joins the `units` gate (#18): exact fixture values, identical role sets, complete scoped CSS, dynamic preset bindings, geometry, determinism, and fail-closed behaviour for an incomplete map, each proven by a mutation. It also reports the non-normative measurements. With it and `test/check-contrast.selftest.mjs` (#15) the `units` gate now runs six files; the four gates — grammar, contrast, drift, units — are unchanged in name and number.
- The ring's claim became a check (#20). `test/color-math.selftest.mjs` asserts that every ground the ring is claimed to clear carries a normative row, and eleven mutations prove it can fail: a dropped ground on each variant, a role with the theme stripped out of it, a loosened minimum, a halo row with its `expect: "fail"` removed, the themed halo rows deleted, every halo row deleted, a halo row demoted from a pin to a report, a missing `.inverse-2` measurement, a seventh painted ground added to the themes with no ring row, and a role the classification rules cannot place. Each asserts the message the check prints. The claim is derived rather than written beside the rows: the variants come from `SPEC.focusRing.variants` and the grounds from the theme roles themselves, so a variant added to the spec composes tones no row measures and fails the suite by name, and a ground added to the themes has to be measured before it ships — a role the classification rules cannot place stops the suite rather than falling outside the claim. Two more mutations there hold the spec itself: a ring asked for by an unknown theme or an unknown variant is refused by name rather than silently defaulted to light, which is the shape the old defect had. `test/css-parity.selftest.mjs` now pins both rings in all three theme blocks by literal value, and counts the `--focus-ring` declarations so a copy outside them cannot reappear. The preset side is pinned too (#20): `test/theme-contract.selftest.mjs` holds `ringColor` to one key per variant and no others, each a `var()` reference to the property that variant declares, with that property declared in the generated CSS. Without it, replacing the reference with a hex painted one theme's ring under every `[data-theme]` attribute with all four gates green, because the drift gate cannot see a generator and its output moving together.

### Governance

- **The amendment has landed.** ADR-0001, decision 1, said `tokens.json` "is carried verbatim" and that this repository "never edits a value"; its options table rejected editing `tokens.json` to fix failing contrast pairs. [ADR-0002](docs/adr/0002-decided-values-move-and-spec-constants-are-measured.md) merged with #9 and replaces ADR-0001's points 1 and 2: a decided value may move in `tokens.json` when the decision is recorded in the token's `$description` with the ratio it now measures and the contrast gate is green, and the build is a pure function of `tokens.json` **and** `scripts/lib/spec.mjs`, with every colour that file composes measured by a row in `contrast-pairs.json`. ADR-0001 now carries an `Amended by:` line naming ADR-0002; its points 3, 4 and 5 stand unchanged. **No ADR was edited by #9 or #18.** #20 edits one sentence of ADR-0002, point 3, and no decision in it: the point named the two `spec:` roles the ring had, and the themed ring has twelve, so the sentence now states the rule the roles follow instead of listing names that no longer exist. Both records still read `Status: Proposed`.
- **The signature is on record, and the four decisions above ask nothing further of the owner.** ADR-0002 records that the tertiary-text rows, the input border and the focus ring were carried as debt awaiting a decision, and that "The decision was taken and signed by the owner". README, "The source of truth is the design workstream's values", says the same of the primitives: they moved "in one signed pass" (ADR-0002).
- What was decided, and therefore what the first tag carries:

  1. `color.slate.600` / `text.tertiary`: `#66737F` -> `#5A6672`
  2. `color.slate.700` / `text.secondary`: `#56626E` -> `#4C5763`
  3. `semantic.border.input`: `{color.slate.300}` -> `{color.slate.500}`
  4. Focus ring geometry: `0 0 0 3px rgba(43,75,219,.35)` -> `0 0 0 2px #2B4BDB, 0 0 0 5px rgba(43,75,219,.35)`, and with it the preset's `ringWidth.DEFAULT` `3px` -> `2px` and `ringColor.DEFAULT` `rgba(43,75,219,0.35)` -> `#2B4BDB`

  The first four were recorded here, decided in ADR-0002, and landed by #9. There are not two lists. A fifth was decided by the owner and landed with #20:

  5. Focus ring colour: themed. The core follows `[data-theme]` — `semantic.theme.<t>.accent-ink`, with `semantic.theme.<t>.on-inverse` for the new on-inverse variant — so the light core moves `#2B4BDB` -> `#2340C4`, and `ringColor.DEFAULT` `#2B4BDB` -> `var(--focus-ring-color)`
- Still open, and not #20's to close. Both records read `Status: Proposed`, in the files and in `docs/adr/README.md`; moving them to `Accepted` is a change to the ADRs and belongs in a pull request that edits them. #20 edits ADR-0002's point 3, to refresh role names that no longer existed and to say what now enforces the naming rule, and leaves the status where it is: a status move is the owner's call on the decision, not a consequence of touching the file that records it. `AGENTS.md` still repeats ADR-0001's single-input sentence — "The build must stay a pure function of `tokens.json`" — and needs the same amendment; ADR-0002 leaves it untouched on purpose, because a pull request that edits `AGENTS.md` needs a second human reviewer under that file's own rule. One thing on this list has closed. #18 opened an owner decision of its own, `B-themed-ring` — whether the focus ring gains a themed variant, or the shortfall it measured on the dark grounds is accepted with a stated reason. **The owner decided: theme the ring**, and #20 implements that decision and enforces it, so `B-themed-ring` is closed. No owner decision is open in this repository.

### Added

- `package.json` is `private: true` and no longer carries `publishConfig`: a package consumed by git ref must not be publishable, and `private: true` does not affect git-dependency installs.
- `RELEASE.md`: the tagging procedure.
- This changelog.
