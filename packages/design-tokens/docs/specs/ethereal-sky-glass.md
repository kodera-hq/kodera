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

## Acceptance

- `npm test` green: grammar, contrast, drift, units.
- `test/theme-registry.selftest.mjs`: the registry, a census of every generated artefact against it, and the build refusing a theme that is in `tokens.json` and not in the registry or the reverse.
- `test/sky-glass.selftest.mjs`: the family's foundation contract, each clause with a mutation that asserts its own message.

## Consumers

Nothing changes for a consumer that does not opt in: the three Givre themes emit the same custom properties with the same values, and the new themes are two more `[data-theme]` blocks. Adopting the family is a consumer change, made behind the two gates above.
