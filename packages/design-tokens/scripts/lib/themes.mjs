// The theme registry: the one list of themes this package ships.
//
// Every generator reads it — the CSS theme blocks, the Tailwind preset, the
// TypeScript types, the Swift and Compose bindings, the native manifest and the
// `themes` artefact consumers import. None of them keeps a list of its own: a
// theme spelled in one generator and not in another is a theme that exists on
// one platform only, and nothing fails until a user picks it there.
//
// A theme is a FAMILY in a MODE. The family carries the rules a theme is held
// to (docs/specs/ethereal-sky-glass.md): a flat family paints opaque surfaces and no gradient, a
// glass family may declare translucent materials and a controlled gradient.
// The mode says which side of the light/dark axis the theme is on, which is
// what a consumer needs to follow the device setting inside one family.
//
// The ids are the `[data-theme]` attribute values and the group names under
// `semantic.theme`, `semantic.elevation` and `semantic.material` in
// tokens.json. scripts/build.mjs holds tokens.json to this list, in this
// order: a theme that is here and not there, or there and not here, fails the
// build rather than the browser.

/** What a family allows. A family that is not here does not exist. */
export const THEME_FAMILIES = Object.freeze({
  givre: Object.freeze({
    // "Givre & Nuit" (docs/specs/givre-nuit.md): opaque surfaces, no gradient (D-UI3).
    material: 'flat',
    gradient: 'none',
  }),
  ciel: Object.freeze({
    // "Ethereal Sky Glass" (docs/specs/ethereal-sky-glass.md): translucent
    // materials over a sky, and a gradient held to the controlled grammar.
    material: 'glass',
    gradient: 'controlled',
  }),
});

const MODES = ['light', 'dark', 'black'];
/** What `color-scheme` a mode renders native controls in. */
const SCHEME_OF = { light: 'light', dark: 'dark', black: 'dark' };

/**
 * The themes, in the order the generated CSS declares them.
 *
 * `default: true` marks the theme an unthemed document gets: its block also
 * carries `:root`. Exactly one theme has it.
 */
export const THEME_REGISTRY = Object.freeze(
  [
    { id: 'light', family: 'givre', mode: 'light' },
    { id: 'dark', family: 'givre', mode: 'dark' },
    { id: 'black', family: 'givre', mode: 'black' },
    { id: 'ciel', family: 'ciel', mode: 'light', default: true },
    { id: 'ciel-nuit', family: 'ciel', mode: 'dark' },
  ].map((theme) => Object.freeze({ default: false, ...theme, scheme: SCHEME_OF[theme.mode] })),
);

// Validated at load, so a malformed entry fails every generator and every gate
// at once instead of the first one that happens to read the bad field.
(function validate() {
  const seen = new Set();
  const slots = new Set();
  for (const theme of THEME_REGISTRY) {
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id)) throw new Error(`theme registry: ${JSON.stringify(theme.id)} is not a lowercase kebab id`);
    if (seen.has(theme.id)) throw new Error(`theme registry: "${theme.id}" is registered twice`);
    seen.add(theme.id);
    if (!Object.hasOwn(THEME_FAMILIES, theme.family)) {
      throw new Error(`theme registry: "${theme.id}" names the family ${JSON.stringify(theme.family)}; the families are ${Object.keys(THEME_FAMILIES).join(', ')}`);
    }
    if (!MODES.includes(theme.mode)) {
      throw new Error(`theme registry: "${theme.id}" names the mode ${JSON.stringify(theme.mode)}; the modes are ${MODES.join(', ')}`);
    }
    const slot = `${theme.family}/${theme.mode}`;
    if (slots.has(slot)) throw new Error(`theme registry: two themes claim ${slot}`);
    slots.add(slot);
  }
  const defaults = THEME_REGISTRY.filter((theme) => theme.default);
  if (defaults.length !== 1) throw new Error(`theme registry: exactly one default theme is required, found ${defaults.length}`);
})();

/** Every theme id, in declaration order. */
export const THEMES = Object.freeze(THEME_REGISTRY.map((theme) => theme.id));

/** The theme an unthemed document renders in. */
export const DEFAULT_THEME = THEME_REGISTRY.find((theme) => theme.default).id;

/** The registry entry for `id`. An unknown id is an error, never `undefined`. */
export function themeInfo(id) {
  const theme = THEME_REGISTRY.find((entry) => entry.id === id);
  if (!theme) throw new Error(`${JSON.stringify(id)} is not a theme; the themes are ${THEMES.join(', ')}`);
  return theme;
}

/** What the family of theme `id` allows. */
export const familyRules = (id) => THEME_FAMILIES[themeInfo(id).family];

/** The ids of one family, in declaration order. */
export function themesOfFamily(family) {
  if (!Object.hasOwn(THEME_FAMILIES, family)) {
    throw new Error(`${JSON.stringify(family)} is not a theme family; the families are ${Object.keys(THEME_FAMILIES).join(', ')}`);
  }
  return THEMES.filter((id) => themeInfo(id).family === family);
}

/**
 * The theme a reference belongs to, read from where the token lives — a theme
 * role, an elevation level or a material (`semantic.<group>.<theme>.*`), a
 * theme primitive (`color.theme-<theme>.*`, `shadow.theme-<theme>.*`,
 * `material.theme-<theme>.*`) or a composed role (`spec:<role>.<theme>.<tone>`).
 * Null for a reference that belongs to no theme: a shared ramp, a literal.
 *
 * A reference that is shaped like a themed one and names a theme the registry
 * does not hold is an error, not "no theme": a gate that read it as unthemed
 * would stop asking whose extremes it is measured over.
 */
export function themeOfPath(ref) {
  if (typeof ref !== 'string') return null;
  let id = null;
  const spec = /^spec:[a-z-]+\.([a-z0-9-]+)\.[a-z]+$/.exec(ref);
  const seg = ref.split('.');
  if (spec) [, id] = spec;
  else if (seg[0] === 'semantic' && ['theme', 'elevation', 'material'].includes(seg[1]) && seg.length > 2) [, , id] = seg;
  else if (['color', 'shadow', 'material'].includes(seg[0]) && seg[1]?.startsWith('theme-')) id = seg[1].slice('theme-'.length);
  if (id === null) return null;
  if (!THEMES.includes(id)) throw new Error(`"${ref}" names the theme "${id}", which the registry does not hold (${THEMES.join(', ')})`);
  return id;
}

/**
 * The selector the default theme claims the document root with: the root,
 * unless another registered theme claims it. A bare `:root` would tie with
 * `[data-theme="<other>"]` on the same element, and the block declared later
 * would win: with a default declared after another theme, a root that names
 * that other theme would paint the default. `:where()` keeps the specificity of
 * `:root` alone, one attribute selector, so the theme blocks still override
 * each other by order and by nothing else.
 */
export const DEFAULT_ROOT_SELECTOR = `:root:where(:not(${THEMES.filter((id) => id !== DEFAULT_THEME)
  .map((id) => `[data-theme="${id}"]`)
  .join(', ')}))`;

/** The selector a theme's block is declared under. The default theme also owns the unclaimed root. */
export function themeSelector(id) {
  const attribute = `[data-theme="${themeInfo(id).id}"]`;
  return id === DEFAULT_THEME ? `${DEFAULT_ROOT_SELECTOR}, ${attribute}` : attribute;
}

/**
 * Hold a per-theme group of tokens.json to the registry: the same ids, in the
 * same order. `keys` are the group's own child names, `$`-prefixed metadata
 * already removed; `expectation` opens the message, so each group keeps the
 * sentence its callers and their tests already know.
 */
export function assertThemeGroups(expectation, keys) {
  if (!Array.isArray(keys) || keys.join(',') !== THEMES.join(',')) {
    throw new Error(
      `${expectation}: ${THEMES.join(', ')} (the registry, scripts/lib/themes.mjs); ` +
        `tokens.json declares ${keys?.length ? keys.join(', ') : 'none'}`,
    );
  }
}
