// The worst-case bound for a translucent background (scripts/lib/backdrop.mjs,
// docs/adr/0003). Like the compositing in lib/tokens.mjs it has no output of
// its own — nothing in dist/ moves when it is wrong — so it is pinned here
// three ways:
//
//   numbers     worked by hand in the comments, so a refactor that changes a
//               result has to change a number someone can check
//   the traps   the two cases where "measure the extremes" is not a worst case:
//               a blend darker than both of its ends, and a foreground whose
//               luminance lies between the backdrops
//   the bound   brute force. Thousands of blends of the backdrops are pushed
//               through the same stack the browser paints — blur as a random
//               convex combination, `saturate()` with its clamp, source-over —
//               and none may measure below the minimum the gate reports

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, contrastRatio, luminance, toHex } from '../scripts/lib/tokens.mjs';
import { worstCaseContrast, saturate } from '../scripts/lib/backdrop.mjs';

const c = parseColor;
const named = (...hexes) => hexes.map((hex) => ({ ref: hex, color: c(hex) }));
const glass = (color, saturation = 1) => ({ color: c(color), saturation });
const CLEAR = { color: { r: 0, g: 0, b: 0, a: 0 }, saturation: 1 };

const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.005, `${what}: ${actual.toFixed(4)}, expected ${expected}`);

test('the minimum is taken over every backdrop, on the composited ground', () => {
  // 72 % white over white is white; over #DCE6F0 it is (245.2, 248, 250.8),
  // floored to #F5F8FA with luminance 0.9344. The ink #1E2933 has luminance
  // 0.0210: (0.9344 + 0.05) / (0.0210 + 0.05) = 13.86.
  const result = worstCaseContrast({
    foreground: c('#1E2933'),
    layers: [glass('rgba(255, 255, 255, 0.72)')],
    backdrops: named('#FFFFFF', '#DCE6F0'),
  });
  close(result.ratio, 13.86, 'ink on glass over the page and its tint');
  assert.equal(toHex(result.background), '#F5F8FA');
  assert.equal(result.measured, 4, 'two extremes, the darkest blend and the lightest blend');
  assert.equal(result.straddles, false);

  // On white alone the same glass is white: the plain 14.79:1 of ink on white.
  const alone = worstCaseContrast({ foreground: c('#1E2933'), layers: [glass('rgba(255, 255, 255, 0.72)')], backdrops: named('#FFFFFF') });
  close(alone.ratio, contrastRatio(c('#1E2933'), c('#FFFFFF')), 'glass over white is white');
});

test('adding a backdrop can only lower the minimum', () => {
  const base = { foreground: c('#5C6874'), layers: [glass('rgba(255, 255, 255, 0.72)')] };
  const light = worstCaseContrast({ ...base, backdrops: named('#FFFFFF') });
  const withRail = worstCaseContrast({ ...base, backdrops: named('#FFFFFF', '#111827') });
  close(light.ratio, 5.7, 'tertiary ink on glass over white');
  // 72 % white over #111827 is (188.4, 190.3, 194.5): #BCBEC2, 3.06:1.
  close(withRail.ratio, 3.06, 'tertiary ink on glass over the near-black rail');
  assert.equal(toHex(withRail.background), '#BCBEC2');
  assert.ok(withRail.ratio < light.ratio);
});

test('a blend can be darker than both of its ends, so the ends alone are not the worst case', () => {
  // Pure red and pure blue average to (128, 0, 128), whose luminance (0.0615)
  // is below red's (0.2126) AND blue's (0.0722). Black text measures 2.44:1 on
  // blue, its darker end, and 2.23:1 on the blend.
  const [red, blue, purple] = [c('#FF0000'), c('#0000FF'), { r: 128, g: 0, b: 128 }];
  assert.ok(luminance(purple) < Math.min(luminance(red), luminance(blue)));
  const onEnds = Math.min(contrastRatio(c('#000000'), red), contrastRatio(c('#000000'), blue));
  const onBlend = contrastRatio(c('#000000'), purple);
  assert.ok(onBlend < onEnds, 'the blend is the worse ground');

  const result = worstCaseContrast({ foreground: c('#000000'), layers: [CLEAR], backdrops: named('#FF0000', '#0000FF') });
  assert.ok(result.ratio <= onBlend, `the reported minimum ${result.ratio} must not exceed what the blend measures (${onBlend})`);
  assert.equal(result.worst, 'the darkest any blend of the backdrops can be');

  // Upwards the ends are enough: luminance is convex, so the lightest blend is
  // the lightest end. White text measures 4.00:1 on red and nothing is lighter.
  const white = worstCaseContrast({ foreground: c('#FFFFFF'), layers: [CLEAR], backdrops: named('#FF0000', '#0000FF') });
  close(white.ratio, 4.0, 'white on the lighter end');
});

test('a foreground whose luminance lies between the backdrops has no minimum', () => {
  // Mid grey on a faint glass over black and white: 6.5:1 at one end, 3.2:1 at
  // the other, and 1:1 on the grey a blur produces half way.
  const result = worstCaseContrast({ foreground: c('#777777'), layers: [glass('rgba(255, 255, 255, 0.2)')], backdrops: named('#000000', '#FFFFFF') });
  assert.equal(result.straddles, true);
  assert.equal(result.ratio, 1);
  assert.equal(result.worst, 'a blend of the backdrops that matches the foreground');
  // The same foreground, once every backdrop is on one side of it, has one.
  const oneSide = worstCaseContrast({ foreground: c('#777777'), layers: [glass('rgba(255, 255, 255, 0.2)')], backdrops: named('#000000', '#222222') });
  assert.equal(oneSide.straddles, false);
  assert.ok(oneSide.ratio > 1);
});

test('saturate() is the CSS matrix: identity at 1, luma grey at 0, outside the gamut when it boosts', () => {
  const sky = c('#6699CC');
  const same = saturate(sky, 1);
  for (const channel of ['r', 'g', 'b']) close(same[channel], sky[channel], `saturate(1).${channel}`);
  const grey = saturate(sky, 0);
  // 0.213 * 102 + 0.715 * 153 + 0.072 * 204 = 145.81 on every channel.
  for (const channel of ['r', 'g', 'b']) close(grey[channel], 145.81, `saturate(0).${channel}`);
  const boosted = saturate(sky, 2);
  // 1.787 * 102 - 0.715 * 153 - 0.072 * 204 = 58.19; blue leaves the gamut at 262.19.
  close(boosted.r, 58.19, 'saturate(2).r');
  close(boosted.b, 262.19, 'saturate(2).b');
  assert.ok(boosted.b > 255, 'a boost is not convex-safe: it can leave the range the backdrops span');
});

test('stacked layers are composited bottom first, each over what the one below painted', () => {
  // The light scrim rgba(47, 58, 69, .55) over white is (140.6, 146.65, 152.7);
  // a 90 % white sheet over that is (243.56, 244.165, 244.77). Over the rail
  // #111827 the scrim gives (33.5, 42.7, 55.5) and the sheet over it
  // (232.85, 233.77, 235.05), floored to #E8E9EB.
  const result = worstCaseContrast({
    foreground: c('#1E2933'),
    layers: [glass('rgba(47, 58, 69, 0.55)'), glass('rgba(255, 255, 255, 0.9)')],
    backdrops: named('#FFFFFF', '#111827'),
  });
  assert.equal(toHex(result.background), '#E8E9EB');
  close(result.ratio, 12.17, 'ink on a sheet over the scrim over the rail');
});

test('an opaque fallback is measured as it is, beside the glass', () => {
  const result = worstCaseContrast({
    foreground: c('#5C6874'),
    layers: [glass('rgba(255, 255, 255, 0.72)')],
    backdrops: named('#FFFFFF'),
    extras: [{ ref: 'the opaque fallback', color: c('#808080') }],
  });
  assert.equal(result.worst, 'the opaque fallback');
  close(result.ratio, contrastRatio(c('#5C6874'), c('#808080')), 'the fallback is the worst ground');
});

test('what the bound cannot measure is refused rather than guessed', () => {
  const ok = { foreground: c('#1E2933'), layers: [glass('rgba(255, 255, 255, 0.72)')], backdrops: named('#FFFFFF') };
  assert.throws(() => worstCaseContrast({ ...ok, foreground: c('rgba(30, 41, 51, 0.5)') }), /needs an opaque foreground/);
  assert.throws(() => worstCaseContrast({ ...ok, backdrops: [] }), /needs at least one backdrop/);
  assert.throws(() => worstCaseContrast({ ...ok, layers: [] }), /needs at least one layer/);
  assert.throws(
    () => worstCaseContrast({ ...ok, backdrops: [{ ref: 'veil', color: c('rgba(0, 0, 0, 0.5)') }] }),
    /backdrop "veil" is not opaque/,
  );
});

// --- The bound, by brute force ----------------------------------------------

/** A small deterministic generator: the same blends on every run and machine. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const clamp255 = (x) => Math.min(255, Math.max(0, x));

/** A random convex combination of `colors`: what a blur can produce from them. */
function blend(colors, random) {
  const weights = colors.map(() => random() ** 3);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out = { r: 0, g: 0, b: 0 };
  colors.forEach((color, i) => {
    for (const channel of ['r', 'g', 'b']) out[channel] += (color[channel] * weights[i]) / total;
  });
  return out;
}

/** One layer as a browser paints it: filter the backdrop, clamp, paint over it. */
function paint(layer, under) {
  const filtered = saturate(under, layer.saturation ?? 1);
  const a = layer.color.a ?? 1;
  const out = {};
  for (const channel of ['r', 'g', 'b']) out[channel] = layer.color[channel] * a + clamp255(filtered[channel]) * (1 - a);
  return out;
}

/** A colour the stack can paint under `layers[depth]`: every layer blurs what is below it. */
function sample(layers, backdrops, depth, random) {
  if (depth === 0) return blend(backdrops, random);
  const below = [0, 1, 2].map(() => paint(layers[depth - 1], sample(layers, backdrops, depth - 1, random)));
  return blend(below, random);
}

const STACKS = [
  { name: 'light glass over a sky', fg: '#1E2933', layers: [glass('rgba(255, 255, 255, 0.72)', 1.8)], backdrops: ['#BBD7F5', '#F4F9FE', '#FFFFFF'] },
  { name: 'dark glass over a twilight', fg: '#EDF1F7', layers: [glass('rgba(16, 22, 38, 0.8)', 1.6)], backdrops: ['#0A1020', '#2A2F5A', '#141B33'] },
  { name: 'a boost that leaves the gamut', fg: '#FFFFFF', layers: [glass('rgba(0, 0, 0, 0.5)', 2)], backdrops: ['#3366CC', '#224488', '#CC3344'] },
  { name: 'two filtered layers', fg: '#1E2933', layers: [glass('rgba(255, 255, 255, 0.6)', 1.5), glass('rgba(255, 255, 255, 0.7)', 1.3)], backdrops: ['#111827', '#FFFFFF', '#2B4BDB'] },
  { name: 'unrelated hues, dark foreground', fg: '#000000', layers: [glass('rgba(255, 255, 255, 0.5)')], backdrops: ['#FF0000', '#0000FF', '#00FF00'] },
  { name: 'unrelated hues, light foreground', fg: '#FFFFFF', layers: [glass('rgba(0, 0, 0, 0.6)', 1.4)], backdrops: ['#FF0000', '#0000FF', '#00FF00'] },
];

test('no blend of the backdrops measures below the reported minimum', () => {
  for (const stack of STACKS) {
    const foreground = c(stack.fg);
    const backdrops = stack.backdrops.map(c);
    const reported = worstCaseContrast({ foreground, layers: stack.layers, backdrops: named(...stack.backdrops) });
    const random = lcg(0x5eed);
    let lowest = Infinity;
    for (let i = 0; i < 4000; i += 1) {
      const under = sample(stack.layers, backdrops, stack.layers.length - 1, random);
      const ground = paint(stack.layers.at(-1), under);
      lowest = Math.min(lowest, contrastRatio(foreground, ground));
    }
    assert.ok(
      lowest >= reported.ratio - 1e-9,
      `${stack.name}: a blend measures ${lowest.toFixed(4)}, below the reported minimum ${reported.ratio.toFixed(4)}`,
    );
  }
});

test('the brute force is able to fail: a bound read off the extremes alone is beaten by a blend', () => {
  // The same search, against the naive bound. If this did not find a blend
  // below it, the test above would prove nothing about the corners.
  const foreground = c('#000000');
  const backdrops = ['#FF0000', '#0000FF'].map(c);
  const naive = Math.min(...backdrops.map((backdrop) => contrastRatio(foreground, backdrop)));
  const random = lcg(0x5eed);
  let lowest = Infinity;
  for (let i = 0; i < 4000; i += 1) lowest = Math.min(lowest, contrastRatio(foreground, blend(backdrops, random)));
  assert.ok(lowest < naive - 0.1, `expected a blend below ${naive.toFixed(2)}, the lowest was ${lowest.toFixed(2)}`);
});
