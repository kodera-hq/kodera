// The values the design system fixes that tokens.json v0.1 does not carry as
// tokens, and the derivations that turn them into colours.
//
// They live here rather than inside scripts/build.mjs because two things read
// them: the build, which emits them, and the contrast gate, which measures
// them. A geometry the build owns privately is a geometry the gate cannot
// check — and a focus ring the gate cannot check is how a 1.78:1 halo ships
// under a label describing a ring that is not there. ADR-0002 records that,
// and the rule it sets: every colour composed from a constant here is measured
// by a row in contrast-pairs.json, through the `spec:` references below.
//
// Each constant is still anchored to tokens.json — the colours are token
// paths, never hexes — so a palette change flows through and a token rename
// fails the build and the gate rather than the browser.

import { resolve, parseColor } from './tokens.mjs';

/**
 * The complete theme set, in the order the generated CSS declares it.
 * scripts/build.mjs holds tokens.json to it: a theme that is not here, or a
 * role one theme is missing, fails the build rather than the browser.
 */
export const THEMES = ['light', 'dark', 'black'];

export const SPEC = {
  // Owner white-light correction: preserve the legacy gradient API and stop geometry.
  pageGradient: {
    angle: '115deg',
    stops: [['color.white', '0%'], ['color.white', '45%'], ['color.white', '100%']],
  },

  // COMPONENTS.md delivered the ring as "0 0 0 3px rgba(43,75,219,.35) on
  // every interactive element". That halo alone composites to #B5C0F2 on white
  // and measures 1.78:1, which does not satisfy SC 1.4.11 for the one indicator
  // a keyboard user has to locate themselves with. The ring is two-tone: an
  // opaque core, with the delivered halo kept at its 3 px width, pushed outside
  // the core.
  //
  // The core FOLLOWS `[data-theme]`. A single ring value cannot clear 3:1 on
  // every ground this package ships: the cobalt the ring was first built from
  // measures below 3:1 on all eight shell grounds of the dark theme, on five of
  // the black theme's eight, and on two of the light theme's own — its two
  // inverse panels. So each variant below names a THEME ROLE rather than one
  // token, and the core is resolved once per theme:
  //
  //   `default`      controls on a normal ground — surface, sunken, page,
  //                  hairline, muted, muted-2, and the painted status and tag
  //                  backgrounds. Core: the theme's `accent-ink`.
  //   `on-inverse`   controls on an inverse panel, where the normal core is the
  //                  wrong side of the ground. Core: the theme's `on-inverse`.
  //
  // Both are gated: contrast-pairs.json carries a normative row at 3:1 for
  // every ground each variant is claimed to clear, in all three themes.
  focusRing: {
    variants: {
      default: 'accent-ink',
      'on-inverse': 'on-inverse',
    },
    // `layers` is the ring as painted, INNERMOST FIRST — the order box-shadow
    // takes, where the first layer paints on top of the ones after it. The
    // first layer is therefore the tone that sits against the control, which is
    // the tone SC 2.4.13 measures against the unfocused surface; the last is
    // the tone that touches the background. One list serves every variant and
    // every theme: the geometry is shared, only the core colour is themed.
    // contrast-pairs.json addresses both tones by role, so changing this list
    // changes what the gate measures.
    layers: [
      { id: 'core', width: '2px', alpha: 1 },
      { id: 'halo', width: '5px', alpha: 0.35 },
    ],
  },
};

/** The variant a consumer gets without asking for one. */
const DEFAULT_VARIANT = 'default';

/**
 * `default` is the absence of a variant, not a variant named "default" — the
 * same rule scripts/build.mjs applies to `semantic.surface.default`. One
 * function, so the CSS property and the `spec:` reference cannot drift apart.
 */
const variantSuffix = (variant) => (variant === DEFAULT_VARIANT ? '' : `-${variant}`);

/** The custom property a variant's full two-tone ring is emitted as. */
export const focusRingProperty = (variant) => `--focus-ring${variantSuffix(variant)}`;

/**
 * The custom property carrying that variant's indicator tone alone.
 * Tailwind's `ring` utility is single-tone and reads this one, so it follows
 * `[data-theme]` instead of freezing one theme's ring into the preset.
 */
export const focusRingColorProperty = (variant) => `${focusRingProperty(variant)}-color`;

/** The `spec:` reference contrast-pairs.json names one tone of one ring by. */
export const focusRingRef = (variant, theme, role) => `spec:focus-ring${variantSuffix(variant)}.${theme}.${role}`;

/** `'5px'` → `5`. A width that is not a plain pixel length is a spec error. */
function px(width, id) {
  if (typeof width !== 'string' || !/^\d+(\.\d+)?px$/.test(width)) {
    throw new Error(`focus ring layer "${id}" has width ${JSON.stringify(width)}; expected a pixel length such as "3px"`);
  }
  return Number.parseFloat(width);
}

/**
 * The ring's geometry, validated: one entry per tone, innermost first.
 *
 * The ordering is validated rather than assumed: the roles below are "innermost"
 * and "outermost", and a list that is not ordered by width makes both of them
 * lie. An unchecked assumption in a check is the check's weakest part.
 */
function ringGeometry() {
  const { layers } = SPEC.focusRing;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error('the focus ring declares no layer, so there is no indicator to measure');
  }

  let previous = 0;
  return layers.map((layer) => {
    const width = px(layer.width, layer.id);
    if (width <= previous) {
      throw new Error(
        `focus ring layers must be listed innermost first and grow outwards; "${layer.id}" is ${layer.width} after ${previous}px`,
      );
    }
    previous = width;
    if (!(layer.alpha > 0) || layer.alpha > 1) {
      throw new Error(`focus ring layer "${layer.id}" has alpha ${layer.alpha}; expected a number in (0, 1]`);
    }
    return layer;
  });
}

/** The width of the tone painted against the control. Shared by every variant. */
export function focusRingIndicatorWidth() {
  return ringGeometry()[0].width;
}

/**
 * The token a variant's opaque core is taken from, in `theme`.
 *
 * Both arguments are required and both are checked here. A theme that defaulted
 * to light would put the light ring back on every dark ground silently, which
 * is the defect this function exists to make impossible to reintroduce.
 */
export function focusRingSource(theme, variant = DEFAULT_VARIANT) {
  if (!THEMES.includes(theme)) {
    throw new Error(`focus ring: ${JSON.stringify(theme)} is not a theme; the themes are ${THEMES.join(', ')}`);
  }
  const role = SPEC.focusRing.variants[variant];
  if (!role) {
    throw new Error(
      `focus ring: ${JSON.stringify(variant)} is not a ring variant; the variants are ${Object.keys(SPEC.focusRing.variants).join(', ')}`,
    );
  }
  return `semantic.theme.${theme}.${role}`;
}

/**
 * One variant's ring in one theme, as painted: one entry per tone, innermost
 * first, each carrying the colour it paints with — alpha included, so the gate
 * composites what the user sees rather than the opaque token behind it.
 */
export function focusRingLayers(index, theme, variant = DEFAULT_VARIANT) {
  const source = focusRingSource(theme, variant);
  const literal = resolve(source, index);
  const base = parseColor(literal);
  return ringGeometry().map((layer) => ({ ...layer, source, literal, color: { ...base, a: layer.alpha } }));
}

/** The tone painted against the control — what a keyboard user has to locate. */
export function focusRingIndicator(index, theme, variant = DEFAULT_VARIANT) {
  return focusRingLayers(index, theme, variant)[0];
}

/** The outermost tone, the one painted straight onto the background. */
export function focusRingOuter(index, theme, variant = DEFAULT_VARIANT) {
  return focusRingLayers(index, theme, variant).at(-1);
}

/**
 * The colours contrast-pairs.json can name with a `spec:` reference. They are
 * roles, not layer names: a row asks for "the indicator of the dark theme's
 * on-inverse ring" and gets whatever the spec above currently makes that
 * indicator, at its real alpha. Naming a layer instead would let a geometry
 * change quietly leave the row measuring a tone the ring no longer has, and
 * leaving the theme out of the name would let a row measure the light ring on a
 * ground the dark ring is what actually paints.
 */
export const SPEC_COLORS = Object.fromEntries(
  Object.keys(SPEC.focusRing.variants).flatMap((variant) =>
    THEMES.flatMap((theme) => [
      [focusRingRef(variant, theme, 'indicator'), (index) => focusRingIndicator(index, theme, variant).color],
      [focusRingRef(variant, theme, 'outer'), (index) => focusRingOuter(index, theme, variant).color],
    ])),
);
