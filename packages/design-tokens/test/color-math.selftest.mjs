// The colour maths the contrast gate rests on, and the focus ring it measures.
//
// `composite()` is the whole difference between the ratio a translucent colour
// reports and the ratio a user sees. It has no output of its own — nothing in
// dist/ changes when it is wrong — so the only thing that can notice a broken
// one is a test that pins the numbers. Every assertion below states the colour
// and the ratio it must produce, so a regression names what moved rather than
// only that something did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ROOT,
  loadTokens,
  indexTokens,
  resolve,
  parseColor,
  composite,
  contrastRatio,
  toHex,
} from '../scripts/lib/tokens.mjs';
import {
  SPEC,
  SPEC_COLORS,
  THEMES,
  focusRingLayers,
  focusRingIndicator,
  focusRingOuter,
  focusRingRef,
} from '../scripts/lib/spec.mjs';

const tree = loadTokens();
const index = indexTokens(tree);
const at2 = (n) => Number(n.toFixed(2));
const color = (path) => parseColor(resolve(path, index));

const WHITE = color('semantic.surface.default');
const PAGE = color('semantic.surface.page');
const COBALT = color('semantic.action.primary');

test('a translucent foreground is flattened onto the background before it is measured', () => {
  // The ring COMPONENTS.md delivered: cobalt.500 at 35 %. Read as opaque cobalt
  // it reports 6.70:1; what it paints on white is #B5C0F2 at 1.78:1, and 1.78
  // is the number SC 1.4.11 judges.
  const halo = composite({ ...COBALT, a: 0.35 }, WHITE);
  assert.equal(toHex(halo), '#B5C0F2');
  assert.equal(at2(contrastRatio(halo, WHITE)), 1.78);
  assert.equal(at2(contrastRatio(COBALT, WHITE)), 6.70);

  const onPage = composite({ ...COBALT, a: 0.35 }, PAGE);
  assert.equal(toHex(onPage), '#B5C0F2');
  assert.equal(at2(contrastRatio(onPage, PAGE)), 1.78);

  // Keep the former frost arithmetic independent of the current page role.
  const frost = color('color.frost.100');
  const onFrost = composite({ ...COBALT, a: 0.35 }, frost);
  assert.equal(toHex(onFrost), '#AAB8EE');
  assert.equal(at2(contrastRatio(onFrost, frost)), 1.74);
});

test('an opaque foreground passes through unchanged, and a missing alpha is opaque', () => {
  assert.deepEqual(composite({ ...COBALT, a: 1 }, WHITE), { r: 43, g: 75, b: 219, a: 1 });
  // `{r, g, b}` with no `a` is a colour nobody said was translucent. Treating
  // it as transparent would erase every hex token in the suite.
  assert.deepEqual(composite({ r: 43, g: 75, b: 219 }, WHITE), { r: 43, g: 75, b: 219, a: 1 });
});

test('compositing onto a translucent background is an error, not a guess', () => {
  assert.throws(
    () => composite({ ...COBALT, a: 0.35 }, { ...WHITE, a: 0.5 }),
    /cannot composite onto a translucent background/,
  );
});

test('the ring is measured as it is painted: an opaque indicator inside a translucent halo', () => {
  // The light ring, on the two unthemed surfaces a page with no [data-theme]
  // still paints. Light is the default theme and nothing else; it is named
  // here rather than defaulted to, because a ring read for the wrong theme is
  // the defect the themed ring closes.
  const layers = focusRingLayers(index, 'light');
  assert.equal(layers.length, 2, 'the ring is two-tone');
  assert.deepEqual(layers.map((l) => l.width), ['2px', '5px'], 'innermost first');

  const indicator = focusRingIndicator(index, 'light');
  assert.equal(indicator.color.a, 1, 'the tone against the control is opaque; a translucent one is what SC 1.4.11 rejected');
  assert.equal(at2(contrastRatio(composite(indicator.color, WHITE), WHITE)), 8.07);
  assert.equal(at2(contrastRatio(composite(indicator.color, PAGE), PAGE)), 8.07);

  const outer = focusRingOuter(index, 'light');
  assert.equal(at2(contrastRatio(composite(outer.color, WHITE), WHITE)), 1.86);
  assert.equal(at2(contrastRatio(composite(outer.color, PAGE), PAGE)), 1.86);

  const frost = color('color.frost.100');
  assert.equal(at2(contrastRatio(composite(indicator.color, frost), frost)), 7.23);
  assert.equal(at2(contrastRatio(composite(outer.color, frost), frost)), 1.82);
  assert.ok(
    contrastRatio(composite(outer.color, WHITE), WHITE) < 3,
    'the halo alone stays below 3:1 — if it ever clears it, the opaque core is carrying nothing and the ring needs a decision, not a silent pass',
  );
});

test('each theme paints its own ring, and the two variants are different rings', () => {
  // A single ring value cannot clear 3:1 on every ground this package ships,
  // which is the whole reason the core follows [data-theme]. Two rings that
  // resolve to one colour, or a variant that resolves to the other's, is that
  // single value back with more names on it.
  const cores = THEMES.map((theme) => focusRingIndicator(index, theme).literal);
  assert.equal(new Set(cores).size >= 2, true, 'the themes do not all paint one core');
  for (const theme of THEMES) {
    assert.notEqual(
      focusRingIndicator(index, theme).literal,
      focusRingIndicator(index, theme, 'on-inverse').literal,
      `${theme}: the on-inverse ring must not be the ring for normal grounds`,
    );
  }
});

/**
 * The tone against the control is opaque, on every ring the build composes.
 *
 * This is the guarantee the default ring's inverted halo rows buy, stated where
 * a row cannot state it. On the on-inverse variant the 35 % halo genuinely
 * clears 3:1 on two of the nine grounds it is painted on — 3.04:1 on
 * `dark.inverse`, 3.15:1 on `black.inverse-2` — so an inverted row there would
 * assert something false, and the contrast gate reports a translucent-only ring
 * on those two grounds as a PASS on its own row. The invariant holds on all of
 * them, and it is the reason the halo is never the indicator.
 */
function assertOpaqueIndicators() {
  for (const variant of Object.keys(SPEC.focusRing.variants)) {
    for (const theme of THEMES) {
      assert.equal(
        focusRingIndicator(index, theme, variant).color.a,
        1,
        `${theme}/${variant}: the tone against the control is translucent, and a translucent indicator is what SC 1.4.11 rejected \u2014 its ratio is whatever the ground behind it happens to make it`,
      );
    }
  }
}

test('the tone against the control is opaque on every theme and every variant', () => {
  assertOpaqueIndicators();

  // The mutation it exists for: drop the opaque core and the halo becomes the
  // indicator. It is loud elsewhere — 57 contrast problems — but on the two
  // grounds above the gate's own rows say PASS, so "loud elsewhere" is not the
  // same as guarded.
  const real = SPEC.focusRing.layers;
  try {
    SPEC.focusRing.layers = real.slice(1);
    assert.throws(
      () => assertOpaqueIndicators(),
      /light\/default: the tone against the control is translucent/,
    );
  } finally {
    SPEC.focusRing.layers = real;
  }
});

test('a ring whose layers are not ordered innermost first is rejected rather than measured', () => {
  // The two roles above are "innermost" and "outermost". A list ordered the
  // other way makes both of them lie while every ratio still prints.
  const real = SPEC.focusRing.layers;
  try {
    SPEC.focusRing.layers = [...real].reverse();
    assert.throws(() => focusRingLayers(index, 'light'), /must be listed innermost first/);
    SPEC.focusRing.layers = [];
    assert.throws(() => focusRingLayers(index, 'light'), /declares no layer/);
    SPEC.focusRing.layers = [{ id: 'core', width: '2', alpha: 1 }];
    assert.throws(() => focusRingLayers(index, 'light'), /expected a pixel length/);
    SPEC.focusRing.layers = [{ id: 'core', width: '2px', alpha: 0 }];
    assert.throws(() => focusRingLayers(index, 'light'), /expected a number in \(0, 1\]/);
  } finally {
    SPEC.focusRing.layers = real;
  }
});

test('a ring asked for by an unknown theme or variant is refused, not silently defaulted', () => {
  // The failure mode this replaces: a caller that omitted the theme used to get
  // the one ring there was. A default here would put the light ring back on
  // every dark ground and print a ratio for it.
  assert.throws(() => focusRingLayers(index, 'sepia'), /"sepia" is not a theme; the themes are light, dark, black/);
  assert.throws(() => focusRingLayers(index, undefined), /undefined is not a theme/);
  assert.throws(
    () => focusRingLayers(index, 'light', 'on-nothing'),
    /"on-nothing" is not a ring variant; the variants are default, on-inverse/,
  );
});

// The grounds the ring is claimed to clear are DERIVED from the theme roles,
// not copied from them. A copy proves only "claim ⊆ rows": a ground added to
// the themes later, carrying a text row of its own, satisfies every other rule
// in this repository while the ring is never measured on it. Reading the roles
// closes the other direction, and the classification below is exhaustive — a
// role matching no rule fails this file by name rather than falling silently
// into or out of the claim.
//
// One theme is read, not three: test/theme-contract.selftest.mjs already holds
// the three themes to an identical role set, so a role present in one is
// present in all.
//
// The seven shell containers take the ring for normal grounds, together with the
// painted status, cursor and tag backgrounds; `inverse`, `inverse-2` and `bad` take the
// on-inverse variant, because the normal core is the wrong side of that ground.
// `elevated` is a container: a menu item or a dialog button is focused on it.
const SHELL_CONTAINERS = new Set(['page', 'surface', 'sunken', 'muted', 'muted-2', 'hairline', 'elevated']);

// Roles no control is focused on top of: inks and `*-fg` foregrounds, lines,
// shadows, the scrim, the page gradient, and the control fills (`disabled` is
// one: a disabled control's own fill). A control fill is the
// ground of the ring drawn AROUND that control, which no row measures in either
// direction today. In the light theme the core `#2340C4` is `light.action-hover`
// exactly, so a focused primary button draws its ring at 1.20:1 against its
// resting fill and 1.00:1 against its hovered one; dark and black draw 3.12:1
// and 3.59:1 on the same two fills. That is a separate gap, and the fills are
// listed here rather than left out silently, so its absence is a decision.
const NOT_A_GROUND = new Set([
  'page-grad',
  'border', 'border-soft', 'border-strong', 'border-input', 'rail-line',
  'shadow-1', 'shadow-2', 'scrim',
  'ink', 'ink-2', 'ink-3', 'ink-4', 'accent-ink', 'placeholder',
  'on-inverse', 'on-inverse-dim', 'on-disabled',
  'action', 'action-hover', 'disabled',
  'ok', 'ok-ink', 'ok-border', 'ok-on-dark',
  'warn', 'warn-ink',
  'bad-ink', 'bad-on-dark',
  'cursor-1', 'cursor-2', 'cursor-3', 'cursor-4', 'cursor-5', 'cursor-6',
]);

/** Which ground list a theme role belongs to, or null when it is not a ground. */
function classifyGround(role) {
  if (SHELL_CONTAINERS.has(role)) return 'normal';
  if (NOT_A_GROUND.has(role) || /-fg$/.test(role)) return null;
  if (/^inverse(-\d+)?$/.test(role) || role === 'bad') return 'inverse';
  if (/-(bg|soft)$/.test(role)) return 'painted';
  throw new Error(
    `theme role "${role}" is neither classified as a ground the focus ring must clear nor listed as not a ground; classify it before it ships`,
  );
}

/** The three ground lists, read off the theme roles themselves. */
function themeGrounds(source) {
  const buckets = { normal: [], painted: [], inverse: [] };
  for (const role of Object.keys(source.semantic.theme.light)) {
    const kind = classifyGround(role);
    if (kind) buckets[kind].push(role);
  }
  return buckets;
}

/**
 * What each ring variant is claimed to clear, and what carries its halo.
 *
 * A variant absent from here is a ring the build paints in every theme with
 * nothing saying where it is meant to work. That is how a third variant added
 * to the spec would otherwise ship a full ring — a custom property and a
 * `ring-*` utility — measured by no row at all.
 */
function ringClaim(source) {
  const { normal, painted, inverse } = themeGrounds(source);
  return {
    // `inverted`: the halo carries at least one `expect: "fail"` row per theme,
    // pinning it as never the indicator. One per theme and not one per ground:
    // the default halo was measured over all 57 theme-and-ground combinations
    // and spans 1.01:1 to 2.27:1, and 57 inverted rows would restate that
    // spread rather than guard it. What the rule proves is that the pin exists
    // in every theme; what it does not prove is that every ground carries one.
    default: { grounds: [...normal, ...painted], halo: 'inverted' },
    // `reported`: the on-inverse halo reaches 3.04:1 on `dark.inverse` and
    // 3.15:1 on `black.inverse-2`, so an inverted row would assert something
    // false. It carries a non-normative measurement on every ground instead, so
    // each figure quoted for it is computed by a row rather than copied into
    // prose. The opaque-core invariant above is what holds "the halo is never
    // the indicator" on the two grounds where no row can.
    'on-inverse': { grounds: inverse, halo: 'reported' },
  };
}

function assertRingCoverage(pairs, measurements, source = tree) {
  // The regression this file exists for: rows pointed at `semantic.action.primary`
  // print one ratio for any geometry, including the single 35 % halo that
  // measures 1.86:1 on white. Addressing the ring by role is what ties the row
  // to what ships, and carrying the theme in the role is what ties it to the
  // ring that theme actually paints.
  const variants = Object.keys(SPEC.focusRing.variants);
  const claim = ringClaim(source);
  const suffix = (variant) => (variant === 'default' ? '' : `-${variant}`);
  for (const variant of variants) {
    assert.match(
      variant,
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      `"${variant}" cannot be a ring variant: it does not spell a CSS custom property name or a spec role`,
    );
  }
  // Derived from the variants the spec declares, not from the two that were
  // known when this was written.
  const roleRef = new RegExp(`^spec:focus-ring(${variants.map(suffix).join('|')})\\.(${THEMES.join('|')})\\.(indicator|outer)$`);

  const ring = pairs.filter((p) => String(p.fg).startsWith('spec:focus-ring'));
  for (const pair of ring) {
    assert.match(pair.fg, roleRef, `${pair.id} must name a ring role, and name the theme in it`);
    if (pair.fg.endsWith('.indicator')) {
      assert.equal(pair.min, 3.0, `${pair.id} is the indicator and is gated at 3:1`);
      assert.equal(pair.expect, undefined, `${pair.id} must be gated, not inverted`);
    } else {
      assert.equal(pair.expect, 'fail', `${pair.id} pins the halo as never the indicator`);
    }
  }

  // Every tone the spec exposes carries a row somewhere. This is the assertion
  // that grows with the spec instead of with what someone remembered to write
  // down: a variant added to `SPEC.focusRing.variants` adds two roles per theme
  // to `SPEC_COLORS`, and rows have to exist for them before the ring that
  // variant paints can ship.
  const measured = new Set([...pairs, ...measurements].map((row) => row.fg));
  for (const ref of Object.keys(SPEC_COLORS)) {
    assert.ok(measured.has(ref), `${ref} is a colour the build composes and no row measures it`);
  }

  for (const variant of variants) {
    const declared = claim[variant];
    assert.ok(
      declared,
      `the ${variant} ring is painted in every theme and no ground list says which grounds it is claimed to clear`,
    );
    for (const theme of THEMES) {
      const indicator = focusRingRef(variant, theme, 'indicator');
      const grounds = new Set(ring.filter((p) => p.fg === indicator).map((p) => p.bg));
      for (const ground of declared.grounds) {
        assert.ok(
          grounds.has(`semantic.theme.${theme}.${ground}`),
          `${theme}: the ${variant} ring is claimed to clear ${ground} and no row measures it`,
        );
      }

      const halo = focusRingRef(variant, theme, 'outer');
      if (declared.halo === 'inverted') {
        assert.ok(
          pairs.some((p) => p.fg === halo && p.expect === 'fail'),
          `${theme}: the ${variant} ring's halo carries no inverted row, so nothing pins it as never the indicator`,
        );
      } else {
        const reported = new Set(measurements.filter((p) => p.fg === halo).map((p) => p.bg));
        for (const ground of declared.grounds) {
          assert.ok(
            reported.has(`semantic.theme.${theme}.${ground}`),
            `${theme}: the ${variant} ring's halo is reported on no row for ${ground}, so any figure quoted for it is copied rather than computed`,
          );
        }
      }
    }
  }
}

/** A row by id, or a named failure — a mutation on a row that is not there proves nothing. */
function row(register, id) {
  const found = register.find((r) => r.id === id);
  if (!found) throw new Error(`no row with id "${id}" to mutate; the assertion below would prove nothing`);
  return found;
}

test('every ground the themed ring is claimed to clear carries a normative row', () => {
  const { pairs, measurements } = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
  assertRingCoverage(pairs, measurements);

  // A ground quietly dropped is the claim quietly narrowed.
  assert.throws(
    () => assertRingCoverage(pairs.filter((p) => p.id !== 'theme.dark/focus-ring/muted-2'), measurements),
    /dark: the default ring is claimed to clear muted-2 and no row measures it/,
  );
  assert.throws(
    () => assertRingCoverage(pairs.filter((p) => p.id !== 'theme.black/focus-ring-on-inverse/inverse-2'), measurements),
    /black: the on-inverse ring is claimed to clear inverse-2 and no row measures it/,
  );
  assert.throws(
    () => assertRingCoverage(pairs.filter((p) => p.id !== 'theme.light/focus-ring-on-inverse/bad'), measurements),
    /light: the on-inverse ring is claimed to clear bad and no row measures it/,
  );
  // A halo row quietly deleted takes the pin with it, and the two themed ones
  // are the newest and least missed. Deleting all four is caught by the same
  // rule and named the same way, rather than by whichever line reads a row that
  // is no longer there.
  assert.throws(
    () => assertRingCoverage(pairs.filter((p) => !p.id.startsWith('focus-ring-halo/theme.')), measurements),
    /spec:focus-ring\.dark\.outer is a colour the build composes and no row measures it/,
  );
  assert.throws(
    () => assertRingCoverage(pairs.filter((p) => !String(p.fg).endsWith('.outer')), measurements),
    /spec:focus-ring\.light\.outer is a colour the build composes and no row measures it/,
  );
  // And a halo row demoted rather than deleted — still measured, no longer
  // pinned — is the same loss with the row still in the file.
  assert.throws(
    () => assertRingCoverage(
      pairs.filter((p) => p.id !== 'focus-ring-halo/theme.dark.surface'),
      [...measurements, { id: 'demoted', fg: 'spec:focus-ring.dark.outer', bg: 'semantic.theme.dark.surface' }],
    ),
    /dark: the default ring's halo carries no inverted row, so nothing pins it as never the indicator/,
  );
  // A quoted figure whose measurement row is gone is a hand-copied figure again.
  assert.throws(
    () => assertRingCoverage(pairs, measurements.filter((p) => p.id !== 'focus-ring-on-inverse-halo/theme.black.inverse-2')),
    /black: the on-inverse ring's halo is reported on no row for inverse-2/,
  );
  // A role with no theme in it measures whichever ring the spec hands back.
  const untethered = structuredClone(pairs);
  row(untethered, 'theme.dark/focus-ring/surface').fg = 'spec:focus-ring.indicator';
  assert.throws(() => assertRingCoverage(untethered, measurements), /must name a ring role, and name the theme in it/);
  const loosened = structuredClone(pairs);
  row(loosened, 'theme.black/focus-ring-on-inverse/inverse').min = 1.5;
  assert.throws(() => assertRingCoverage(loosened, measurements), /is the indicator and is gated at 3:1/);
  const promoted = structuredClone(pairs);
  delete row(promoted, 'focus-ring-halo/surface.default').expect;
  assert.throws(() => assertRingCoverage(promoted, measurements), /pins the halo as never the indicator/);

  // A ground added to the themes later has to be measured, without this file
  // being edited to notice it — and a role the rules cannot place stops the
  // suite by name rather than being silently excluded from the claim.
  const seventhTag = structuredClone(tree);
  seventhTag.semantic.theme.light['t7-bg'] = seventhTag.semantic.theme.light['t6-bg'];
  assert.throws(
    () => assertRingCoverage(pairs, measurements, seventhTag),
    /light: the default ring is claimed to clear t7-bg and no row measures it/,
  );
  const unplaceable = structuredClone(tree);
  unplaceable.semantic.theme.light.tint = unplaceable.semantic.theme.light['t6-bg'];
  assert.throws(
    () => assertRingCoverage(pairs, measurements, unplaceable),
    /theme role "tint" is neither classified as a ground the focus ring must clear nor listed as not a ground/,
  );
});
