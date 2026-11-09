# ADR-0008: Tailwind 4, with the tokens preset loaded unchanged through `@config`

**Status:** Accepted
**Deciders:** the crew

## Context

`docs/dev/BASELINE.md` held `tailwindcss` at 3 on purpose: the tokens preset is shared with `kodera-web`, which is on 3.x (ADR-0004), and Tailwind 4 is CSS-first, so moving one consumer alone looked like it would stop the preset being shareable. Tailwind 3's own tree carried two advisories the console had to accept (`braces`, `postcss-selector-parser`), and the coming UI and UX rework is to be built on Tailwind 4.

Tailwind 4 still reads a JavaScript configuration, presets included, when a stylesheet names it with `@config`. The preset can therefore stay exactly the artefact it is today. It is not read the same way, though: Tailwind 4 ignores the preset's `ringColor.DEFAULT` and `transitionDuration.DEFAULT`, and pairs each of the preset's font sizes with a line height of its own scale, where Tailwind 3 left the line height inherited. A Tailwind 3 consumer, such as the hub, keeps reading the preset as before; any Tailwind 4 consumer needs the same compatibility lines this console carries in `src/index.css`.

## Decision

The console runs Tailwind 4 through `@tailwindcss/vite`. `src/index.css` loads `tailwind.config.ts` with `@config`, and that file keeps `presets: [koderaPreset]` and declares no value of its own. The few behaviours Tailwind 4 changed are held at their Tailwind 3 value in `src/index.css`, each guarded by a test (`docs/specs/tailwind-4-migration.md`). A reviewer checks a pull request against this: no theme value is declared in CSS or in the config except those compatibility lines, and every one of them names the token custom property or Tailwind default it keeps.

## Options considered

| Option | Why not |
|---|---|
| Stay on Tailwind 3 | Keeps two accepted advisories that exist only because of Tailwind 3, and builds the rework on a major that receives no new work. |
| Rewrite the theme as a CSS-first `@theme` now | A second source of truth beside the preset until the tokens package publishes one, and a visual change hidden inside a toolchain change. It belongs to the rework, with the tokens package. |
| `@tailwindcss/postcss` | Measured broken with Vite here: the self-hosted fonts' relative URLs stop resolving at build time. |

## Consequences

- The supported browsers become Tailwind 4's floor: Safari 16.4+, Chrome and Edge 111+, Firefox 128+, accepted by the product owner.
- The hub can stay on Tailwind 3 and keep the same preset; the two repositories no longer have to cross together. A consumer that moves to Tailwind 4 copies the compatibility lines, or the tokens package publishes them.
- The compatibility lines in `src/index.css` are the rework's starting point: each is removed as a design decision, with the screens it moves.
- Revisit when the tokens package publishes a Tailwind 4 theme of its own; this ADR is then superseded by the one that adopts it.
