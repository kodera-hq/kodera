# Givre & Nuit

Status: Decided by zôÖma (D-UI1 to D-UI4, through the lead session). Ships as `v0.5.0`. Consumers repin separately.

## Why

The three themes were complete but flat. In dark, page, surface and muted sat within a few steps of each other, and the primary button fill measured 2.88:1 against the form, so the main action sank. Nothing in the rail or the grounds said "Kodera" at a glance. The aim is the most visible gain for the least churn: change values, keep every name.

## What

1. **Light is "Givre"**: the white foundation (`white-ink-foundation.md`) with a deeper slate ink.
2. **Dark is "Nuit"**: a cool near-black with five ordered steps, `inverse` < `page` < `sunken` < `surface` < `elevated`, and a brighter cobalt.
3. **The rail is near-black in every theme** (`inverse`), so light and dark read as one product.
4. **No gradient.** Plain cobalt only (D-UI3). Every `page-grad` stop is the page colour, no gradient token anywhere in the tree has two colours, and no `linear-gradient` the build emits has two distinct stops.
5. **Each theme hovers with its own cobalt.** `action-hover` is a theme primitive, never the light cobalt reused in dark.
6. **Rounder corners**: radius `md` 10, `lg` 16, `xl` 20 px.

The values are listed in `CHANGELOG.md`, `v0.5.0`. Automatique (follow the device) stays the consumers' default theme (D-UI2); black is kept (D-UI4).

## Acceptance

- `npm test` green: grammar, contrast (483 rows, 0 fail), drift, units.
- `test/givre-nuit.selftest.mjs` holds properties 2 to 6 and the six `action` rows. Each clause has a mutation that asserts its own message; the gradient clause is also proven on a sandbox build of a top-level two-stop primitive.
- The new rows `theme.<theme>/action/surface` and `/action/page` (3:1) are a floor, not a pin. Old `action` on old `surface` (`#3B57DE` on `#171E26`) measures 2.88:1 and fails; the old `action` alone measures 3.05:1 and 3.32:1 on the new grounds and passes. The decided values are pinned by `test/fixtures/themes.json` (36 role values: light 5, dark 27, black 4, of which dark `disabled` and `on-disabled` move through their references).

## Consumers

The console and Keycloak take every colour from the roles, so a repin moves them. The visual baselines must be regenerated in every theme. Component changes (filled current item, cobalt active rail tile, cobalt live-room dock) are handed to each consumer's owner separately; this package only provides the values.
