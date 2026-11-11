# Ethereal Sky Glass

Status: Foundation. The engine and the first tokens are in the package; the palette is not decided. Decided by zôÖma, through the lead session: the family, its theme ids, that Givre stays selectable, the automatic opaque fallback, and the two gates that stand between this family and being a default.

## Why

"Givre & Nuit" (`givre-nuit.md`) is flat on purpose: opaque surfaces, no gradient. The next direction is the opposite material — translucent surfaces over a sky — and it cannot be reached by changing values, because the package had no way to say "translucent" that a gate could measure. The contrast gate refused every translucent background, a gradient was forbidden everywhere, and each generator kept its own list of the three themes.

This is the engine for that direction, not the direction itself. The values the new themes carry are initial values, chosen so that every gate is green, and are expected to move when the palette is designed.

## What is decided

1. **A second theme family, `ciel`**, with two themes: `ciel` is its light theme and `ciel-nuit` its dark one. The ids are the `[data-theme]` attribute values.
2. **The `givre` family stays selectable, complete**: `light`, `dark`, `black`. Nothing about it changes, and `light` is still the default theme.
3. **`ciel` becomes a default only after two gates pass**: WCAG AA on the worst-case backdrop, which `docs/adr/0003` makes measurable, and a frame-rate gate this package does not hold.
4. **Translucency is never required to read the interface.** Where the reader asks for less transparency or more contrast, or the platform forces its colours, every surface is opaque.

## The theme registry

`scripts/lib/themes.mjs` is the one list of themes. Each entry is a family in a mode:

| id | family | mode | scheme | default |
|---|---|---|---|---|
| `light` | `givre` | light | light | yes |
| `dark` | `givre` | dark | dark | |
| `black` | `givre` | black | dark | |
| `ciel` | `ciel` | light | light | |
| `ciel-nuit` | `ciel` | dark | dark | |

Every generator reads it: the CSS theme blocks, the Tailwind preset, the TypeScript types, the Swift and Compose bindings, the native manifest. `scripts/build.mjs` holds `tokens.json` to it in both directions, so a theme cannot be declared in one place and missing from another. Consumers read the same list as `@kodera/design-tokens/themes`.

A family carries the rules its themes are held to:

| family | material | gradient |
|---|---|---|
| `givre` | `flat`: opaque surfaces only | `none`: every gradient is one colour (D-UI3) |
| `ciel` | `glass`: translucent materials are allowed | `controlled`: a bounded gradient grammar |

## The foundation values

`ciel` starts from the Givre `light` values and `ciel-nuit` from the Givre `dark` values, each through primitives of its own (`color.theme-ciel.*`, `color.theme-ciel-nuit.*`), with the grounds moved towards a sky: a pale blue page in `ciel`, an indigo cast on the grounds of `ciel-nuit`, and a shadow colour of its own in each. Every other role keeps its twin's value until the palette is designed.

They are **not pinned**. `test/fixtures/themes.json` pins decided values and does not list these themes. `test/sky-glass.selftest.mjs` holds the shape instead: the same roles and types as the default theme, values that resolve through the theme's own primitives, and every contrast row of the Givre twin at the same minimum, with no exemption.

## Materials

A material is what a surface is made of. It is a tier of its own, because it is a composite and not a colour: `material.theme-<theme>.<level>` holds it and `semantic.material.<theme>.<level>` is the name a consumer addresses.

| field | what it is | held to |
|---|---|---|
| `tint` | the colour of the surface | a reference to an opaque colour token |
| `alpha` | how much of the tint is painted | a number in (0, 1] |
| `blur` | the blur of the backdrop filter | a pixel length, at most 64px |
| `saturation` | the `saturate()` boost of the backdrop filter | a number in [1, 2] |
| `border` | the specular edge | a reference to a colour token |
| `shadow` | the shadow the surface casts | a reference to a shadow token |
| `canvas` | what the opaque fallback is composited over | a reference to an opaque colour token |

There are four levels, the same in every theme, lowest first: `bar` (fixed to an edge, content scrolls under it), `panel` (part of the layout), `popover` (transient, above the content), `dialog` (modal, above the scrim). Each level is at least as opaque as the one below it.

A flat family declares the four levels with alpha 1, no blur and no boost, so the role set is identical in every theme and a component asks for "the popover material" without knowing which family is on screen. The grammar gate refuses a translucent, blurred or saturated material in a flat family.

### What the build emits

Inside each `[data-theme]` block, per level: `--material-<level>-tint`, `-fallback`, `-blur`, `-saturate`, `-border`, `-shadow`, and the two properties a surface paints with, `--material-<level>-bg` and `--material-<level>-backdrop`.

- **The default is opaque, in every theme.** `-bg` is the fallback — the tint at its alpha composited over the canvas — and `-backdrop` is `none`.
- **The glass is switched on afterwards**, for the glass family only, under `@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))`: `-bg` becomes the tint and `-backdrop` becomes `blur() saturate()`.
- **It is switched off again**, after that, under each of `prefers-reduced-transparency: reduce`, `prefers-contrast: more` and `forced-colors: active`. Three separate blocks, on purpose: a browser that does not know one of the queries skips that block and keeps the others, where a single negated query would turn the glass off for everyone.
- **`.material-bar`, `.material-panel`, `.material-popover`, `.material-dialog`** paint with those properties: background, backdrop filter (prefixed and unprefixed), a 1px specular border and the shadow. They hold no value of their own.

Nothing is an inline style. The preset adds `material-<level>` and `material-<level>-border` as colours and `material-<level>` as a shadow, each a `var()`.

### How a material is measured

`contrast-pairs.json` declares, per glass theme, a **backdrop set**: everything the theme paints that can lie behind one of its materials — the page, the grounds content sits on, running ink, the near-black rail. Every level of every theme is held to the same seven rows: `ink`, `ink-2`, `ink-3` and `accent-ink` at 4.5:1, an `ink-4` icon, the control boundary and the focus ring core at 3:1. A translucent level is measured over its theme's set, on the worst ground, and on its opaque fallback (`docs/adr/0003`). Two stacks are measured as well: a dialog over the scrim, and a popover over a panel.

The initial alphas are what that gate allows with the rail in the set: 0.92 to 0.97 in `ciel`, 0.90 to 0.96 in `ciel-nuit`. They are a floor found by the gate, not a look. A more transparent material needs a narrower claim about what lies behind it, or different inks, and either is a design decision.

## Acceptance

- `npm test` green: grammar, contrast, drift, units.
- `test/theme-registry.selftest.mjs`: the registry, a census of every generated artefact against it, and the build refusing a theme that is in `tokens.json` and not in the registry or the reverse.
- `test/sky-glass.selftest.mjs`: the family's foundation contract and the material tier — source, stylesheet, preset and rows — each clause with a mutation that asserts its own message, and a sandbox build refusing an incomplete tier.
- `test/check-grammar.selftest.mjs`: every way a material is not a material.
- `test/check-contrast.selftest.mjs` and `test/backdrop-contrast.selftest.mjs`: the worst-case gate and its maths.

## Consumers

Nothing changes for a consumer that does not opt in: the three Givre themes emit the same custom properties with the same values, and the new themes are two more `[data-theme]` blocks. Adopting the family is a consumer change, made behind the two gates above.
