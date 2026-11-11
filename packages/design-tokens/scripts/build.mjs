#!/usr/bin/env node
// Generate dist/ from tokens.json. Pure function of tokens.json: same input,
// byte-identical output, no clock, no environment, no network.
//
//   node scripts/build.mjs           write dist/
//   node scripts/build.mjs --check   regenerate in memory and diff against
//                                    dist/ on disk; exit 1 on any difference
//
// The variable NAMES are not invented here. They reproduce the names in the
// design drop's tokens.css, because the delivered HTML prototypes and the
// component spec tables address those names directly: renaming --surface to
// --color-surface-default would not break a build, it would silently unstyle
// every prototype. Anything additive (a token the drop's hand-written CSS
// happened to omit) is emitted too — a token that generates no output is a
// token a consumer cannot use.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildNative } from './lib/native.mjs';
import { ROOT, loadTokens, walkTokens, indexTokens, resolve, resolveValue, parseColor, toHex } from './lib/tokens.mjs';
import { MATERIAL_LEVELS, resolveMaterial } from './lib/material.mjs';
import { resolveGradient } from './lib/gradient.mjs';
import { THEMES, THEME_REGISTRY, THEME_FAMILIES, DEFAULT_THEME, themeSelector, assertThemeGroups } from './lib/themes.mjs';
import {
  SPEC,
  focusRingLayers,
  focusRingIndicatorWidth,
  focusRingProperty,
  focusRingColorProperty,
} from './lib/spec.mjs';

const DIST = join(ROOT, 'dist');
const CHECK = process.argv.includes('--check');

const tree = loadTokens();
const tokens = walkTokens(tree);
const index = indexTokens(tree);
const byPath = new Map(tokens.map((t) => [t.path, t]));

// The themes come from the registry (scripts/lib/themes.mjs) and from nowhere
// else. Every per-theme group below is held to it: the same ids, in the same
// order, so a theme cannot be declared in tokens.json and missing from the
// registry, or the other way round.
const own = (node) => Object.keys(node ?? {}).filter((k) => !k.startsWith('$'));

const themeGroups = tree.semantic?.theme;
assertThemeGroups('expected complete theme set', own(themeGroups));
const themeRoles = Object.keys(themeGroups[DEFAULT_THEME]);

// Elevation is themed like the roles above, in a group of its own: a shadow is
// not a colour, and the `--c-*` roles are the colour contract
// (docs/specs/shell-themes.md). Same themes, same levels in each.
const elevationGroups = tree.semantic?.elevation;
assertThemeGroups('expected elevation for the complete theme set', own(elevationGroups));
const elevationLevels = own(elevationGroups[DEFAULT_THEME]);
if (!elevationLevels.length) throw new Error(`${DEFAULT_THEME}: no elevation level`);
for (const name of THEMES) {
  if (own(elevationGroups[name]).join(',') !== elevationLevels.join(',')) {
    throw new Error(`${name}: incomplete elevation level set`);
  }
}
if (!themeRoles.length) throw new Error(`${DEFAULT_THEME}: incomplete theme role set`);
for (const name of THEMES) {
  if (Object.keys(themeGroups[name]).join(',') !== themeRoles.join(',')) {
    throw new Error(`${name}: incomplete theme role set`);
  }
}

// Materials are themed like elevation, in a tier of their own: a material is a
// composite, not a colour (docs/specs/ethereal-sky-glass.md). Every theme
// declares the same four levels — a flat family declares them opaque — so a
// component can ask for a level without knowing which family is on screen.
const materialGroups = tree.semantic?.material;
assertThemeGroups('expected materials for the complete theme set', own(materialGroups));
if (own(tree.material).join(',') !== THEMES.map((name) => `theme-${name}`).join(',')) {
  throw new Error(`expected material primitives for the complete theme set: ${THEMES.map((name) => `material.theme-${name}`).join(', ')}`);
}
for (const name of THEMES) {
  for (const [what, group] of [[name, materialGroups[name]], [`material.theme-${name}`, tree.material[`theme-${name}`]]]) {
    if (own(group).join(',') !== MATERIAL_LEVELS.join(',')) {
      throw new Error(`${what}: incomplete material level set; the levels are ${MATERIAL_LEVELS.join(', ')}`);
    }
  }
}
/** Every theme's four materials, resolved to what they paint. */
const materials = Object.fromEntries(THEMES.map((name) => [name, MATERIAL_LEVELS.map((level) => resolveMaterial(name, level, index))]));
/** The themes in which at least one level shows or filters what is behind it. */
const glassThemes = THEMES.filter((name) => materials[name].some((material) => material.glass));

const flat = (path) => {
  if (!byPath.has(path)) throw new Error(`build expects the token "${path}" and tokens.json does not define it`);
  return resolve(path, index);
};

// --- Spec constants ---------------------------------------------------------
// The frost page gradient and the focus ring are fixed by the design system and
// are not tokens. The themed page gradients are: `semantic.theme.*.page-grad`
// and the `color.theme-*.page-grad` primitives behind them reach dist/ through
// the `case 'gradient'` branch below, like any other value. Only the frost
// gradient that `--bg-page` carries is composed from the constants here. Both
// constants live in scripts/lib/spec.mjs because the contrast gate reads them
// too: a geometry only the build knows is a geometry no check can measure. Each
// is anchored to a token it derives from, so a palette change flows through and
// a token rename fails the build rather than the browser. ADR-0002.
//
// The ring's core is a theme role, so it is emitted inside each theme block
// below rather than once on `:root`. The default theme's selector carries
// `:root` with it, which is how the unthemed default keeps working.

// --- Path → CSS custom property --------------------------------------------
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// The two names the design drop chose that a mechanical mapping would miss.
// CSS ONLY: the delivered prototypes address `--bg-page-flat` and `--hairline`
// by name. The Tailwind preset uses the mechanical names instead
// (`surface-page`, `border-hairline`) because the token test keys off the
// family — the first segment — and `bg-page-flat` would put a token in a family
// called `bg`, where `bg-page-flat` reads as the utility rather than the token.
const CSS_ALIASES = {
  'semantic.surface.page': 'bg-page-flat',
  'semantic.border.hairline': 'hairline',
};

const CSS_PREFIX = {
  'font.family': 'font',
  'font.size': 'text',
  'font.weight': 'weight',
  'font.tracking': 'tracking',
  'font.lineHeight': 'leading',
  space: 'sp',
  radius: 'r',
  shadow: 'shadow',
  'motion.duration': 'dur',
  'motion.easing': 'ease',
  breakpoint: 'breakpoint',
};

function cssName(path) {
  if (CSS_ALIASES[path]) return CSS_ALIASES[path];
  if (path.startsWith('semantic.theme.')) return `c-${path.split('.').slice(3).join('-')}`;
  // Declared once per theme block, so the name carries no theme.
  if (path.startsWith('semantic.elevation.')) return `elevation-${path.split('.').slice(3).join('-')}`;
  return mechanicalName(path);
}

/** The name before the CSS-only aliases are applied. */
function mechanicalName(path) {
  const seg = path.split('.');

  if (seg[0] === 'color') return seg.slice(1).map(kebab).join('-');
  if (seg[0] === 'component') return seg.slice(1).map(kebab).join('-');

  if (seg[0] === 'semantic') {
    const rest = seg.slice(1).map(kebab);
    // `surface.default` is just `--surface`; `.default` is the absence of a
    // variant, not a variant named "default".
    if (rest.at(-1) === 'default') rest.pop();
    return rest.join('-');
  }

  const twoLevel = `${seg[0]}.${seg[1]}`;
  const prefix = CSS_PREFIX[twoLevel] ?? CSS_PREFIX[seg[0]];
  if (!prefix) throw new Error(`no CSS naming rule for "${path}"`);
  const tail = (CSS_PREFIX[twoLevel] ? seg.slice(2) : seg.slice(1)).map(kebab).join('-');
  return `${prefix}-${tail}`;
}

// --- Value → CSS ------------------------------------------------------------
// Quote a family name only when it is not a bare CSS identifier. Quoting is not
// cosmetic: `'sans-serif'` is a font NAMED "sans-serif", not the generic
// keyword, so the fallback at the end of the stack quietly stops working.
function quoteFamily(name) {
  const bareIdentifier = /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
  return bareIdentifier ? name : `'${name}'`;
}

function cssValue(token) {
  const value = resolveValue(token.value, index);
  switch (token.type) {
    case 'fontFamily':
      return value.map(quoteFamily).join(', ');
    case 'cubicBezier':
      return `cubic-bezier(${value.join(', ')})`;
    case 'shadow': {
      const { offsetX, offsetY, blur, spread } = value;
      // The colour may be a reference to a colour token (DTCG composite).
      const color = resolveValue(value.color, index);
      try {
        parseColor(color);
      } catch (error) {
        throw new Error(`${token.path}: shadow color: ${error.message}`);
      }
      return `${offsetX} ${offsetY} ${blur} ${spread} ${color}`;
    }
    case 'gradient': {
      // Direction is CSS-specific metadata on the primitive, not a stop. A stop
      // is a literal colour or a reference to one (scripts/lib/gradient.mjs);
      // either way the value painted is emitted, in the package's hex dialect.
      const { angle, stops } = resolveGradient(token, index);
      // Rounded to four decimals: 0.55 * 100 is 55.00000000000001 in binary floating point.
      const percent = (position) => Number((position * 100).toFixed(4));
      return `linear-gradient(${angle},${stops.map((stop) => `${stop.color} ${percent(stop.position)}%`).join(',')})`;
    }
    default:
      return String(value);
  }
}

function rgba(hex, alpha) {
  const { r, g, b } = parseColor(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** A focus-ring layer as CSS: the token's own hex when opaque, `rgba()` when not. */
function tone(layer) {
  return layer.alpha === 1 ? layer.literal : rgba(layer.literal, layer.alpha);
}

const RING_VARIANTS = Object.keys(SPEC.focusRing.variants);

/** Every custom property the rings declare, in the order a theme block emits them. */
const RING_VARIABLES = RING_VARIANTS.flatMap((variant) => [
  focusRingProperty(variant),
  focusRingColorProperty(variant),
]);

/**
 * One theme's rings as CSS: per variant, the full two-tone box-shadow — one
 * layer per tone, in the order lib/spec.mjs lists them, innermost first, which
 * is the order box-shadow paints on top in — and the indicator tone on its own.
 *
 * The indicator gets a property of its own because Tailwind's `ring` utility is
 * single-tone: the preset points `ringColor` at it, so the utility follows
 * `[data-theme]` instead of freezing one theme's ring into dist/. It carries
 * whatever `tone()` produces, alpha included, rather than the opaque token
 * behind it.
 */
function focusRingDeclarations(theme) {
  return RING_VARIANTS.flatMap((variant) => {
    const layers = focusRingLayers(index, theme, variant);
    const shadow = layers.map((layer) => `0 0 0 ${layer.width} ${tone(layer)}`).join(', ');
    return [
      `  ${focusRingProperty(variant)}: ${shadow};`,
      `  ${focusRingColorProperty(variant)}: ${tone(layers[0])};`,
    ];
  });
}

// --- Materials --------------------------------------------------------------
// A level is emitted as its parts, inside each theme block, plus the two
// properties a surface actually paints with: `-bg` and `-backdrop`. Those two
// START as the opaque fallback and no filter, in every theme. The glass is
// switched on afterwards, under `@supports`, and switched back off for a reader
// who asked for less transparency or more contrast, or whose platform forces
// its colours — so the default is the surface that always reads, and
// translucency is something a capable, willing client opts into.
const MATERIAL_PARTS = ['tint', 'fallback', 'blur', 'saturate', 'border', 'shadow', 'bg', 'backdrop'];
const materialProperty = (level, part) => `--material-${level}-${part}`;
/** Every custom property the materials declare, in the order a theme block emits them. */
const MATERIAL_VARIABLES = MATERIAL_LEVELS.flatMap((level) => MATERIAL_PARTS.map((part) => materialProperty(level, part)));

function materialDeclarations(theme) {
  return materials[theme].flatMap((material) => {
    const { level, tint, alpha } = material;
    const paint = alpha === 1 ? toHex(tint) : `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${alpha})`;
    const value = {
      tint: paint,
      fallback: toHex(material.fallback),
      blur: `${material.blur}px`,
      saturate: String(material.saturation),
      border: material.border,
      shadow: cssValue(byPath.get(material.shadow.path)),
      bg: `var(${materialProperty(level, 'fallback')})`,
      backdrop: 'none',
    };
    return MATERIAL_PARTS.map((part) => `  ${materialProperty(level, part)}: ${value[part]};`);
  });
}

/** The two switching properties of every level, set to `on` (the glass) or off (the fallback). */
function materialSwitch(on, indent) {
  return MATERIAL_LEVELS.flatMap((level) => [
    `${indent}${materialProperty(level, 'bg')}: var(${materialProperty(level, on ? 'tint' : 'fallback')});`,
    `${indent}${materialProperty(level, 'backdrop')}: ${
      on ? `blur(var(${materialProperty(level, 'blur')})) saturate(var(${materialProperty(level, 'saturate')}))` : 'none'
    };`,
  ]);
}

/** The reader preferences and platform modes under which every surface is opaque. */
const OPAQUE_WHEN = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'];
/** A client that can draw the glass at all. The prefixed form is Safari before 18. */
const GLASS_SUPPORT = '((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))';

function buildMaterialCss() {
  // `:is()` keeps the specificity of one attribute selector, so these rules
  // override a theme block by coming after it and by nothing else.
  const selector = `:is(${glassThemes.map(themeSelector).join(', ')})`;
  const glass = glassThemes.length
    ? [
        `@supports ${GLASS_SUPPORT} {\n  ${selector} {\n${materialSwitch(true, '    ').join('\n')}\n  }\n}`,
        ...OPAQUE_WHEN.map((query) => `@media ${query} {\n  ${selector} {\n${materialSwitch(false, '    ').join('\n')}\n  }\n}`),
      ]
    : [];
  const classes = MATERIAL_LEVELS.map(
    (level) =>
      `.material-${level} {\n` +
      `  background-color: var(${materialProperty(level, 'bg')});\n` +
      `  -webkit-backdrop-filter: var(${materialProperty(level, 'backdrop')});\n` +
      `  backdrop-filter: var(${materialProperty(level, 'backdrop')});\n` +
      `  border: 1px solid var(${materialProperty(level, 'border')});\n` +
      `  box-shadow: var(${materialProperty(level, 'shadow')});\n` +
      '}',
  );
  return [
    `/* Materials: bar, panel, popover, dialog. Each theme block above declares every
   level opaque: \`--material-<level>-bg\` is the fallback and \`-backdrop\` is
   \`none\`. The glass is enabled here, only where the client can draw it, and
   disabled again for a reader who asked for less transparency or more contrast,
   or whose platform forces its colours. */`,
    ...glass,
    ...classes,
  ].join('\n\n');
}

// --- dist/tokens.css --------------------------------------------------------
const HEADER = `/* GENERATED FILE — DO NOT EDIT.
   Written by scripts/build.mjs from tokens.json, which is the source of truth.
   Editing this file by hand is undone by the next build and caught by
   \`npm run check:drift\`. Change tokens.json instead. */`;

function pick(prefix) {
  return tokens.filter((t) => t.path === prefix || t.path.startsWith(`${prefix}.`));
}

function declare(token) {
  const line = `  --${cssName(token.path)}: ${cssValue(token)};`;
  const note = token.description ? ` /* ${token.description} */` : '';
  return line + note;
}

function buildCss() {
  const gradient = `linear-gradient(${SPEC.pageGradient.angle}, ${SPEC.pageGradient.stops
    .map(([path, stop]) => `var(--${cssName(path)}) ${stop}`)
    .join(', ')})`;

  const sections = [
    ['primitives — colour', pick('color').map(declare)],
    [
      'semantic — surfaces and boundaries',
      [
        `  --bg-page: ${gradient};`,
        ...pick('semantic.surface').map(declare),
        ...pick('semantic.border').map(declare),
      ],
    ],
    ['semantic — text', pick('semantic.text').map(declare)],
    ['semantic — actions', pick('semantic.action').map(declare)],
    ['semantic — controls', pick('semantic.control').map(declare)],
    ['type', pick('font').map(declare)],
    ['space (4px base)', pick('space').map(declare)],
    ['radius', pick('radius').map(declare)],
    ['elevation', pick('shadow').map(declare)],
    ['motion', pick('motion').map(declare)],
    ['breakpoints (min-width, mobile-first; not usable inside a media query)', pick('breakpoint').map(declare)],
    ['shell geometry', [...pick('semantic.layout'), ...pick('component.shell')].map(declare)],
  ];

  const body = sections
    .map(([title, lines]) => `  /* ${title} */\n${lines.join('\n')}`)
    .join('\n\n');

  const themes = THEMES.map((name) => {
    const selector = themeSelector(name);
    const values = themeRoles.map((role) => `  --c-${role}: ${cssValue(byPath.get(`semantic.theme.${name}.${role}`))};`);
    const elevation = elevationLevels.map(
      (level) => `  --elevation-${level}: ${cssValue(byPath.get(`semantic.elevation.${name}.${level}`))};`,
    );
    return `${selector} {\n${[...values, ...focusRingDeclarations(name), ...elevation, ...materialDeclarations(name)].join('\n')}\n}`;
  }).join('\n\n');

  return `${HEADER}\n:root {\n${body}\n}\n\n/* Complete shell themes, and the focus ring, which follows them; the legacy\n   variables above retain their values. */\n${themes}\n\n${buildMaterialCss()}\n`;
}

// --- dist/tailwind.preset.js ------------------------------------------------
// Nicknames the design drop's preset introduced on top of the semantic names.
// They are the ergonomic path (`text-ink-2` beats `text-text-secondary`); the
// mechanical names are emitted as well so every semantic token resolves.
const PRESET_NICKNAMES = {
  ink: 'semantic.text.primary',
  'ink-2': 'semantic.text.secondary',
  'ink-3': 'semantic.text.tertiary',
  'ink-placeholder': 'semantic.text.placeholder',
  action: 'semantic.action.primary',
  'action-hover': 'semantic.action.primaryHover',
};

// Tailwind's bare classes (`rounded`, `text-base`, `duration-*`) read DEFAULT,
// not our step name. Both keys are emitted: dropping the step name is how
// `rounded-md` silently falls back to Tailwind's own 0.375rem.
const PRESET_DEFAULTS = { fontSize: 'md', borderRadius: 'md', transitionDuration: 'base' };
const PRESET_RENAMES = { fontSize: { md: 'base' } };

const js = (v) => JSON.stringify(v);

function scaleObject(prefix, transform = (t) => resolveValue(t.value, index)) {
  const out = {};
  for (const t of pick(prefix)) {
    if (t.path === prefix) continue;
    out[t.path.slice(prefix.length + 1)] = transform(t);
  }
  return out;
}

function withDefaults(kind, obj) {
  const renames = PRESET_RENAMES[kind] ?? {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (renames[k]) out[renames[k]] = v;
  }
  const step = PRESET_DEFAULTS[kind];
  if (step && step in obj) out.DEFAULT = obj[step];
  return out;
}

function literal(obj, indent) {
  const pad = ' '.repeat(indent);
  const entries = Object.entries(obj).map(([k, v]) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : js(k);
    const value = Array.isArray(v)
      ? `[${v.map(js).join(', ')}]`
      : v && typeof v === 'object'
        ? literal(v, indent + 2)
        : js(v);
    return `${pad}  ${key}: ${value},`;
  });
  return `{\n${entries.join('\n')}\n${pad}}`;
}

function buildPreset() {
  const colors = {};
  for (const [key, child] of Object.entries(tree.color)) {
    if (key.startsWith('$')) continue;
    // Theme primitives are implementation values; consumers use scoped c-*.
    if (THEMES.some((name) => key === `theme-${name}`)) continue;
    colors[key] = '$value' in child ? flat(`color.${key}`) : scaleObject(`color.${key}`);
  }
  // Both filters, and both are load-bearing. `type === 'color'` keeps the
  // non-colour semantics out of the colour map — the selected-control ring
  // width is a dimension and belongs to ringWidth below. The theme and layout
  // groups are excluded on top of that: their colours are real colours, but
  // they are scoped per theme and reach consumers as the `c-*` entries added
  // after this loop, never as one flat value that would freeze the light theme.
  const flatSemantic = pick('semantic').filter(
    (t) => t.type === 'color' && !t.path.startsWith('semantic.theme.') && !t.path.startsWith('semantic.layout.'),
  );
  for (const t of flatSemantic) colors[mechanicalName(t.path)] = flat(t.path);
  for (const [nick, path] of Object.entries(PRESET_NICKNAMES)) colors[nick] = flat(path);
  for (const role of themeRoles) {
    if (byPath.get(`semantic.theme.${DEFAULT_THEME}.${role}`).type === 'color') colors[`c-${role}`] = `var(--c-${role})`;
  }
  // A material's ground and its edge, as colours: `bg-material-bar` paints
  // whichever of the glass and the fallback the stylesheet has switched on.
  // The filter is not a colour; the `.material-<level>` class carries all of it.
  for (const level of MATERIAL_LEVELS) {
    colors[`material-${level}`] = `var(${materialProperty(level, 'bg')})`;
    colors[`material-${level}-border`] = `var(${materialProperty(level, 'border')})`;
  }

  // The themed shadow primitives are implementation values, like the theme
  // colour primitives: consumers use the elevation levels, each a `var()` so it
  // follows `[data-theme]` instead of freezing the light theme's shadow.
  const shadows = Object.fromEntries(
    pick('shadow')
      .filter((t) => !THEMES.some((name) => t.path.startsWith(`shadow.theme-${name}.`)))
      .map((t) => [t.path.slice('shadow.'.length), cssValue(t)]),
  );
  // Tailwind's own shadow scale, which an elevation level of the same name
  // would silently replace in every consumer.
  const TAILWIND_SHADOWS = ['DEFAULT', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner', 'none'];
  for (const level of elevationLevels) {
    if (level in shadows) throw new Error(`elevation level "${level}" collides with the shadow primitive of that name`);
    if (TAILWIND_SHADOWS.includes(level)) throw new Error(`elevation level "${level}" would replace Tailwind's own shadow-${level}`);
    shadows[level] = `var(--elevation-${level})`;
  }
  for (const level of MATERIAL_LEVELS) shadows[`material-${level}`] = `var(${materialProperty(level, 'shadow')})`;

  const gradient = `linear-gradient(${SPEC.pageGradient.angle}, ${SPEC.pageGradient.stops
    .map(([path, stop]) => `${flat(path)} ${stop}`)
    .join(', ')})`;

  const theme = {
    colors,
    spacing: {
      ...scaleObject('space'),
      ...Object.fromEntries(pick('component.shell').map((t) => [mechanicalName(t.path), `var(--${cssName(t.path)})`])),
    },
    fontFamily: scaleObject('font.family'),
    fontSize: withDefaults('fontSize', scaleObject('font.size')),
    fontWeight: Object.fromEntries(
      Object.entries(scaleObject('font.weight')).map(([k, v]) => [k, String(v)]),
    ),
    lineHeight: Object.fromEntries(
      Object.entries(scaleObject('font.lineHeight')).map(([k, v]) => [k, String(v)]),
    ),
    letterSpacing: scaleObject('font.tracking'),
    borderRadius: withDefaults('borderRadius', scaleObject('radius')),
    boxShadow: shadows,
    backgroundImage: { frost: gradient, 'c-page-gradient': 'var(--c-page-grad)' },
    // Tailwind's ring utility is single-tone, so it carries the indicator —
    // the tone SC 1.4.11 measures. The full two-tone ring is on --focus-ring
    // and --focus-ring-on-inverse. Each key is a `var()` rather than a value:
    // the ring follows `[data-theme]`, and a hex here would freeze one theme's
    // ring into every theme, which is the defect the themed ring closes.
    // `ring-on-inverse` is the variant for a control on an inverse panel.
    // `control-selection` is the selected-control ring, a different indicator
    // with its own token; it must never be the width the bare `ring` utility
    // gets, or the two states render identically.
    ringColor: Object.fromEntries(
      RING_VARIANTS.map((variant) => [
        // Tailwind reads the bare `ring` class off DEFAULT; `default` is the
        // absence of a variant, not a variant named "default".
        variant === 'default' ? 'DEFAULT' : variant,
        `var(${focusRingColorProperty(variant)})`,
      ]),
    ),
    ringWidth: {
      DEFAULT: focusRingIndicatorWidth(),
      'control-selection': flat('semantic.control.selection-ring-width'),
    },
    transitionTimingFunction: Object.fromEntries(
      pick('motion.easing').map((t) => [t.path.slice('motion.easing.'.length), cssValue(t)]),
    ),
    transitionDuration: withDefaults('transitionDuration', scaleObject('motion.duration')),
    // Mobile-first min-widths, Tailwind 4's own five steps, all named here so
    // the package rather than Tailwind's defaults is the source.
    screens: scaleObject('breakpoint'),
  };

  return `// GENERATED FILE — DO NOT EDIT.
// Written by scripts/build.mjs from tokens.json, which is the source of truth.
// Editing this file by hand is undone by the next build and caught by
// \`npm run check:drift\`. Change tokens.json instead.
//
// Colour keys are flat names on purpose: the token test in test/token-test.mjs
// asserts that every \`bg-/text-/border-/ring-/fill-/stroke-\` class naming one
// of these families resolves to a real key. A class that names a key which does
// not exist emits NO CSS and NO error — for \`border-*\` the element falls back
// to preflight's \`border: 0 solid #e5e7eb\`, a light grey line on our page.
//
// The c-* colors follow the complete ${THEMES.join('/')} CSS theme boundary.
// Legacy colors remain static. The elevation shadows (raised, overlay, drawer,
// dialog) follow the theme too. Breakpoints are supplied; z-index is not.

/** @type {{theme: {extend: Record<string, unknown>}}} */
export default {
  theme: {
    extend: ${literal(theme, 4)},
  },
};
`;
}

// --- dist/tokens.d.ts -------------------------------------------------------
function buildTypes() {
  const vars = [...new Set([
    '--bg-page',
    ...RING_VARIABLES,
    ...MATERIAL_VARIABLES,
    // A material is emitted as its parts above, never as one property.
    ...tokens.filter((t) => t.type !== 'material').map((t) => `--${cssName(t.path)}`),
  ])].sort();
  const paths = tokens.map((t) => t.path).sort();

  return `// GENERATED FILE — DO NOT EDIT.
// Written by scripts/build.mjs from tokens.json, which is the source of truth.

/** Every dotted token path in tokens.json. */
export type TokenPath =
${paths.map((p) => `  | '${p}'`).join('\n')};

/** Every custom property declared by dist/tokens.css. */
export type TokenCssVariable =
${vars.map((v) => `  | '${v}'`).join('\n')};

export interface KoderaTailwindPreset {
  theme: {
    extend: {
      colors: Record<string, string | Record<string, string>>;
      spacing: Record<string, string>;
      fontFamily: Record<string, string[]>;
      fontSize: Record<string, string>;
      fontWeight: Record<string, string>;
      lineHeight: Record<string, string>;
      letterSpacing: Record<string, string>;
      borderRadius: Record<string, string>;
      boxShadow: Record<string, string>;
      backgroundImage: Record<string, string>;
      ringColor: Record<string, string>;
      ringWidth: Record<string, string>;
      transitionTimingFunction: Record<string, string>;
      transitionDuration: Record<string, string>;
      screens: Record<string, string>;
    };
  };
}

declare const preset: KoderaTailwindPreset;
export default preset;
`;
}

// --- dist/themes.js and dist/themes.d.ts ------------------------------------
// The registry as a consumer reads it: a theme switcher, a `color-scheme`
// rule, a "follow the device" setting inside one family. Emitted from the same
// module every generator above reads, so a consumer's list cannot disagree with
// the blocks tokens.css declares.
const GENERATED_FROM_REGISTRY = `// GENERATED FILE — DO NOT EDIT.
// Written by scripts/build.mjs from the theme registry (scripts/lib/themes.mjs),
// the one list every generator reads. Editing this file by hand is undone by
// the next build and caught by \`npm run check:drift\`.`;

function buildThemes() {
  const entry = (theme) =>
    `  Object.freeze({ id: ${js(theme.id)}, family: ${js(theme.family)}, mode: ${js(theme.mode)}, scheme: ${js(theme.scheme)}, default: ${theme.default} }),`;
  const family = ([name, rules]) =>
    `  ${js(name)}: Object.freeze({ material: ${js(rules.material)}, gradient: ${js(rules.gradient)}, themes: Object.freeze(${js(
      THEME_REGISTRY.filter((theme) => theme.family === name).map((theme) => theme.id),
    )}) }),`;
  return `${GENERATED_FROM_REGISTRY}

/** Every theme, in the order tokens.css declares its \`[data-theme]\` block. */
export const themes = Object.freeze([
${THEME_REGISTRY.map(entry).join('\n')}
]);

/** The \`[data-theme]\` attribute values, in the same order. */
export const themeIds = Object.freeze(themes.map((theme) => theme.id));

/** The theme an unthemed document renders in: its block also carries \`:root\`. */
export const defaultTheme = ${js(DEFAULT_THEME)};

/** What each family allows, and the themes it holds. */
export const themeFamilies = Object.freeze({
${Object.entries(THEME_FAMILIES).map(family).join('\n')}
});

/** The theme of \`family\` in \`mode\`, or undefined when that family has none. */
export function themeFor(family, mode) {
  return themes.find((theme) => theme.family === family && theme.mode === mode);
}
`;
}

function buildThemeTypes() {
  const union = (values) => [...new Set(values)].map((v) => `'${v}'`).join(' | ');
  return `${GENERATED_FROM_REGISTRY}

/** A \`[data-theme]\` attribute value. */
export type ThemeId = ${union(THEMES)};
export type ThemeFamily = ${union(Object.keys(THEME_FAMILIES))};
export type ThemeMode = ${union(THEME_REGISTRY.map((theme) => theme.mode))};
export type ThemeScheme = ${union(THEME_REGISTRY.map((theme) => theme.scheme))};

export interface ThemeInfo {
  readonly id: ThemeId;
  readonly family: ThemeFamily;
  readonly mode: ThemeMode;
  /** The \`color-scheme\` native controls render in under this theme. */
  readonly scheme: ThemeScheme;
  /** True for the one theme an unthemed document renders in. */
  readonly default: boolean;
}

export interface ThemeFamilyInfo {
  /** \`flat\`: opaque surfaces only. \`glass\`: translucent materials are allowed. */
  readonly material: ${union(Object.values(THEME_FAMILIES).map((rules) => rules.material))};
  /** \`none\`: every gradient is one colour. \`controlled\`: the bounded gradient grammar applies. */
  readonly gradient: ${union(Object.values(THEME_FAMILIES).map((rules) => rules.gradient))};
  readonly themes: readonly ThemeId[];
}

export declare const themes: readonly ThemeInfo[];
export declare const themeIds: readonly ThemeId[];
export declare const defaultTheme: ThemeId;
export declare const themeFamilies: Readonly<Record<ThemeFamily, ThemeFamilyInfo>>;
export declare function themeFor(family: ThemeFamily, mode: ThemeMode): ThemeInfo | undefined;
`;
}

// --- Emit or diff -----------------------------------------------------------
const artefacts = {
  'tokens.css': buildCss(),
  'tailwind.preset.js': buildPreset(),
  'tokens.d.ts': buildTypes(),
  'themes.js': buildThemes(),
  'themes.d.ts': buildThemeTypes(),
  ...buildNative(readFileSync(join(ROOT, 'tokens.json'))),
};

if (CHECK) {
  const drifted = [];
  for (const [name, content] of Object.entries(artefacts)) {
    const file = join(DIST, name);
    if (!existsSync(file)) {
      drifted.push(`${name}: missing from dist/ — it was never built, or it was deleted`);
      continue;
    }
    const onDisk = readFileSync(file, 'utf8');
    if (onDisk !== content) {
      drifted.push(`${name}: differs from a fresh build (${onDisk.length} bytes on disk, ${content.length} generated)`);
    }
  }
  if (drifted.length) {
    console.error('Drift — dist/ is not what tokens.json generates:\n');
    for (const d of drifted) console.error(`  FAIL  ${d}`);
    console.error('\nRun `npm run build` and commit dist/.');
    process.exit(1);
  }
  console.log(`OK — dist/ matches a fresh build (${Object.keys(artefacts).join(', ')}).`);
} else {
  mkdirSync(DIST, { recursive: true });
  for (const [name, content] of Object.entries(artefacts)) {
    mkdirSync(dirname(join(DIST, name)), { recursive: true });
    writeFileSync(join(DIST, name), content, 'utf8');
    console.log(`wrote dist/${name}  (${content.length} bytes)`);
  }
}
