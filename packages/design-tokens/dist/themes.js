// GENERATED FILE — DO NOT EDIT.
// Written by scripts/build.mjs from the theme registry (scripts/lib/themes.mjs),
// the one list every generator reads. Editing this file by hand is undone by
// the next build and caught by `npm run check:drift`.

/** Every theme, in the order tokens.css declares its `[data-theme]` block. */
export const themes = Object.freeze([
  Object.freeze({ id: "light", family: "givre", mode: "light", scheme: "light", default: true }),
  Object.freeze({ id: "dark", family: "givre", mode: "dark", scheme: "dark", default: false }),
  Object.freeze({ id: "black", family: "givre", mode: "black", scheme: "dark", default: false }),
]);

/** The `[data-theme]` attribute values, in the same order. */
export const themeIds = Object.freeze(themes.map((theme) => theme.id));

/** The theme an unthemed document renders in: its block also carries `:root`. */
export const defaultTheme = "light";

/** What each family allows, and the themes it holds. */
export const themeFamilies = Object.freeze({
  "givre": Object.freeze({ material: "flat", gradient: "none", themes: Object.freeze(["light","dark","black"]) }),
});

/** The theme of `family` in `mode`, or undefined when that family has none. */
export function themeFor(family, mode) {
  return themes.find((theme) => theme.family === family && theme.mode === mode);
}
