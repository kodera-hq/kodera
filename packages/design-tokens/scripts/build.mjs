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
import { ROOT, loadTokens, walkTokens, indexTokens, resolve, resolveValue, parseColor, aliasTarget } from './lib/tokens.mjs';
import {
  SPEC,
  THEMES,
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

const themeGroups = tree.semantic?.theme;
if (!themeGroups || Object.keys(themeGroups).join(',') !== THEMES.join(',')) {
  throw new Error('expected complete theme set: light, dark, black');
}
const themeRoles = Object.keys(themeGroups.light);

// Elevation is themed like the roles above, in a group of its own: a shadow is
// not a colour, and the `--c-*` roles are the colour contract
// (docs/specs/shell-themes.md). Same three themes, same levels in each.
const elevationGroups = tree.semantic?.elevation;
if (!elevationGroups || Object.keys(elevationGroups).filter((k) => !k.startsWith('$')).join(',') !== THEMES.join(',')) {
  throw new Error('expected elevation for the complete theme set: light, dark, black');
}
const elevationLevels = Object.keys(elevationGroups.light).filter((k) => !k.startsWith('$'));
if (!elevationLevels.length) throw new Error('light: no elevation level');
for (const name of THEMES) {
  if (Object.keys(elevationGroups[name]).filter((k) => !k.startsWith('$')).join(',') !== elevationLevels.join(',')) {
    throw new Error(`${name}: incomplete elevation level set`);
  }
}
if (!themeRoles.length) throw new Error('light: incomplete theme role set');
for (const name of THEMES) {
  if (Object.keys(themeGroups[name]).join(',') !== themeRoles.join(',')) {
    throw new Error(`${name}: incomplete theme role set`);
  }
}

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
// below rather than once on `:root`. The light block's selector carries `:root`
// with it, which is how the unthemed default keeps working.

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
      // Stop lists use the package's existing hex-color token dialect.
      // Direction is CSS-specific metadata on the primitive, not a stop.
      let source = token;
      while (aliasTarget(source.value)) source = index.get(aliasTarget(source.value));
      const angle = source.node.$extensions?.['io.kodera.css-gradient']?.angle;
      if (typeof angle !== 'string' || !/^-?\d+(?:\.\d+)?deg$/.test(angle)) {
        throw new Error(`${token.path}: missing or invalid gradient angle metadata`);
      }
      if (!Array.isArray(value) || value.length < 2) throw new Error(`${token.path}: invalid gradient stop list`);
      const stops = value.map((stop) => {
        if (!stop || !Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) {
          throw new Error(`${token.path}: invalid gradient stop position`);
        }
        parseColor(stop.color);
        return `${stop.color} ${stop.position * 100}%`;
      });
      return `linear-gradient(${angle},${stops.join(',')})`;
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
    const selector = name === 'light' ? ':root, [data-theme="light"]' : `[data-theme="${name}"]`;
    const values = themeRoles.map((role) => `  --c-${role}: ${cssValue(byPath.get(`semantic.theme.${name}.${role}`))};`);
    const elevation = elevationLevels.map(
      (level) => `  --elevation-${level}: ${cssValue(byPath.get(`semantic.elevation.${name}.${level}`))};`,
    );
    return `${selector} {\n${[...values, ...focusRingDeclarations(name), ...elevation].join('\n')}\n}`;
  }).join('\n\n');

  return `${HEADER}\n:root {\n${body}\n}\n\n/* Complete shell themes, and the focus ring, which follows them; the legacy\n   variables above retain their values. */\n${themes}\n`;
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
    if (byPath.get(`semantic.theme.light.${role}`).type === 'color') colors[`c-${role}`] = `var(--c-${role})`;
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
// The c-* colors follow the complete light/dark/black CSS theme boundary.
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
    ...tokens.map((t) => `--${cssName(t.path)}`),
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

// --- Emit or diff -----------------------------------------------------------
const artefacts = {
  'tokens.css': buildCss(),
  'tailwind.preset.js': buildPreset(),
  'tokens.d.ts': buildTypes(),
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
