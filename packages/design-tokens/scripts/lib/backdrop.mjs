// Worst-case contrast on a translucent background.
//
// A translucent surface has no colour of its own: what a user sees is the
// surface laid over whatever is behind it, and with `backdrop-filter` that
// "whatever" is first blurred and saturated. The contrast gate cannot measure
// one such colour, because there is not one. It measures a bound instead, over
// a declared set of opaque backdrop extremes, and docs/adr/0003 is the argument
// for why the bound holds. In short:
//
//   blur       is a weighted average with non-negative weights that sum to 1,
//              so a blurred pixel is a convex combination of backdrop colours:
//              channel by channel it lies between the lowest and the highest
//              value any backdrop has in that channel.
//   saturate   is a LINEAR map (the CSS `saturate()` matrix), so it sends the
//              convex hull of the backdrops onto the convex hull of their
//              images. It is not convex-safe on its own — it can push a channel
//              outside the range the backdrops span — which is why it is
//              applied here, to every extreme, instead of being argued away.
//   source-over is affine and increasing in the colour underneath, channel by
//              channel, so it keeps a channel-wise bound a channel-wise bound.
//   luminance  is increasing in every channel.
//
// Together: every colour the stack can paint lies inside the channel-wise box
// spanned by the images of the extremes. Its luminance is therefore at least
// the luminance of the box's FLOOR (the lowest value of each channel). That
// corner is not a colour the backdrop holds; it is what bounds every blend from
// below, and a blend CAN be darker than both of its ends — pure red and pure
// blue average to a purple darker than either — so the declared extremes alone
// are not a worst case for a dark foreground. Upwards no corner is needed:
// relative luminance is a convex function of the encoded channels, and a convex
// function reaches its maximum over a hull at one of the points that span it,
// so the lightest blend is the lightest vertex. The gate measures every
// extreme, the floor, and the lightest vertex.
//
// The floor is conservative, not exact: for backdrops of very different hues
// it is darker than anything a blur can produce. For the near-collinear sets
// this package declares — a sky gradient, a ramp of greys — it is within a
// rounding step of the darkest extreme.
//
// One more thing has to hold for a minimum to exist at all: the foreground must
// be on one side of that luminance range. If it lies inside, some blend of the
// extremes matches it and the worst case is 1:1, whatever the ends measure.

import { luminance, contrastRatio } from './tokens.mjs';

const CHANNELS = ['r', 'g', 'b'];

/**
 * The CSS `saturate(amount)` filter on a gamma-encoded sRGB colour, as Filter
 * Effects defines it, NOT clamped: the caller clamps, because a clamp is where
 * a convex hull stops being one and that has to be handled, not hidden.
 */
export function saturate(color, amount) {
  const { r, g, b } = color;
  return {
    r: (0.213 + 0.787 * amount) * r + (0.715 - 0.715 * amount) * g + (0.072 - 0.072 * amount) * b,
    g: (0.213 - 0.213 * amount) * r + (0.715 + 0.285 * amount) * g + (0.072 - 0.072 * amount) * b,
    b: (0.213 - 0.213 * amount) * r + (0.715 - 0.715 * amount) * g + (0.072 + 0.928 * amount) * b,
  };
}

const clampChannel = (x) => Math.min(255, Math.max(0, x));
const clamp = (color) => ({ r: clampChannel(color.r), g: clampChannel(color.g), b: clampChannel(color.b) });
const inGamut = (color) => CHANNELS.every((c) => color[c] >= 0 && color[c] <= 255);

/** Source-over of `paint` (a colour with an alpha) on an opaque colour, unrounded. */
function over(paint, under) {
  const a = paint.a ?? 1;
  return {
    r: paint.r * a + under.r * (1 - a),
    g: paint.g * a + under.g * (1 - a),
    b: paint.b * a + under.b * (1 - a),
  };
}

/** The channel-wise box around a set of colours: its lowest and highest corner. */
function box(colors) {
  const corner = (pick) => Object.fromEntries(CHANNELS.map((c) => [c, pick(...colors.map((color) => color[c]))]));
  return { floor: corner(Math.min), ceiling: corner(Math.max) };
}

/** The eight corners of a box: the vertices whose hull is the box itself. */
function corners({ floor, ceiling }) {
  const out = [];
  for (const r of [floor.r, ceiling.r]) for (const g of [floor.g, ceiling.g]) for (const b of [floor.b, ceiling.b]) out.push({ r, g, b });
  return out;
}

/**
 * Carry a set of backdrop colours up through one layer: the layer's own
 * backdrop filter first, then the layer painted over the result.
 *
 * `exact` are colours the stack really paints — one per declared extreme, when
 * nothing is blurred across a boundary. `hull` is a vertex set whose convex
 * hull contains every colour a blur can produce. The two differ only once a
 * saturation boost leaves the gamut: clamping is not linear, so past that point
 * the hull is widened to the box around the clamped vertices, which still
 * contains everything and is the tightest thing that provably does.
 */
function through(layer, { exact, hull }) {
  let nextExact = exact;
  let nextHull = hull;
  const amount = layer.saturation ?? 1;
  if (amount !== 1) {
    nextExact = exact.map((point) => ({ ...point, color: clamp(saturate(point.color, amount)) }));
    const mapped = hull.map((color) => saturate(color, amount));
    nextHull = mapped.every(inGamut) ? mapped : corners(box(mapped.map(clamp)));
  }
  return {
    exact: nextExact.map((point) => ({ ...point, color: over(layer.color, point.color) })),
    hull: nextHull.map((color) => over(layer.color, color)),
  };
}

const rounded = (color, round = Math.round) => ({ r: round(color.r), g: round(color.g), b: round(color.b), a: 1 });

/**
 * The lowest contrast `foreground` can have on a stack of translucent layers
 * over any blend of `backdrops`.
 *
 *   foreground  an opaque colour `{r, g, b}`
 *   layers      bottom first, the measured background LAST; each
 *               `{ color: {r, g, b, a}, saturation }`, where `saturation` is
 *               the `saturate()` amount of that layer's own backdrop filter
 *   backdrops   `[{ ref, color }]`, opaque, at least one
 *   extras      `[{ ref, color }]`, opaque backgrounds to measure as they are —
 *               the opaque fallback a material paints when the glass is off
 *
 * Returns `{ ratio, background, worst, measured, straddles }`: the minimum
 * ratio, the background colour it was measured on, a label for that
 * background, how many backgrounds were measured, and whether the foreground's
 * luminance lies inside the range the backdrop can reach — in which case the
 * ratio is 1, because a blend can match the foreground exactly.
 */
export function worstCaseContrast({ foreground, layers, backdrops, extras = [] }) {
  if ((foreground.a ?? 1) < 1) throw new Error('worst-case contrast needs an opaque foreground');
  if (!layers.length) throw new Error('worst-case contrast needs at least one layer');
  if (!backdrops.length) throw new Error('worst-case contrast needs at least one backdrop');
  for (const { ref, color } of [...backdrops, ...extras]) {
    if ((color.a ?? 1) < 1) throw new Error(`backdrop "${ref}" is not opaque`);
  }

  let state = { exact: backdrops.map(({ ref, color }) => ({ ref, color })), hull: backdrops.map(({ color }) => color) };
  for (const layer of layers) state = through(layer, state);

  const { floor } = box(state.hull);
  // The lightest blend is a vertex (luminance is convex in the encoded channels).
  const lightest = state.hull.reduce((a, b) => (luminance(rounded(a, Math.ceil)) >= luminance(rounded(b, Math.ceil)) ? a : b));
  // Rounded outwards: the bound must not be tightened by the rounding.
  const darkestBlend = rounded(floor, Math.floor);
  const lightestBlend = rounded(lightest, Math.ceil);
  const candidates = [
    ...state.exact.map(({ ref, color }) => ({ worst: ref, background: rounded(color) })),
    { worst: 'the darkest any blend of the backdrops can be', background: darkestBlend },
    { worst: 'the lightest any blend of the backdrops can be', background: lightestBlend },
    ...extras.map(({ ref, color }) => ({ worst: ref, background: rounded(color) })),
  ];

  const fg = luminance(foreground);
  if (fg > luminance(darkestBlend) && fg < luminance(lightestBlend)) {
    // Some blend between the two bounds has the foreground's own luminance.
    const nearest = candidates.reduce((a, b) => (contrastRatio(foreground, a.background) <= contrastRatio(foreground, b.background) ? a : b));
    return { ratio: 1, background: nearest.background, worst: 'a blend of the backdrops that matches the foreground', measured: candidates.length, straddles: true };
  }

  let result = null;
  for (const candidate of candidates) {
    const ratio = contrastRatio(foreground, candidate.background);
    if (result === null || ratio < result.ratio) result = { ...candidate, ratio };
  }
  return { ...result, measured: candidates.length, straddles: false };
}
