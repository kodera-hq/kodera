// Spring motion (scripts/lib/spring.mjs): a token holds the physics, the build
// solves it once and emits what the curve looks like. Three things are held:
//
//   the solution  the closed form the build samples is the motion of the spring
//                 the token declares: checked against a numerical integration
//                 of the same equation, which shares no code with it
//   the profile   the numbers each platform consumes — damping ratio, response,
//                 settling time, overshoot — pinned for the three springs
//   the output    CSS declares every spring as the plain ease-out, switches the
//                 sampled curve on only where `linear()` exists, and off again
//                 under reduced motion; the preset points at the properties
//
// Each output clause has a mutation below that asserts its own message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib/tokens.mjs';
import { springProfile } from '../scripts/lib/spring.mjs';
import preset from '../dist/tailwind.preset.js';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');
const types = readFileSync(join(ROOT, 'dist/tokens.d.ts'), 'utf8');

/** The springs, restated: a fourth one, or a retuned one, is changed here too. */
const SPRINGS = {
  snappy: { stiffness: 420, damping: 34, mass: 1, dampingRatio: 0.8295, response: 0.3066, durationMs: 400 },
  gentle: { stiffness: 170, damping: 26, mass: 1, dampingRatio: 0.9971, response: 0.4819, durationMs: 650 },
  bouncy: { stiffness: 300, damping: 18, mass: 1, dampingRatio: 0.5196, response: 0.3628, durationMs: 700 },
};
const NAMES = Object.keys(SPRINGS);

const declared = (source, name) => source.motion.spring[name].$value;
const samples = (easing) => /^linear\((.*)\)$/.exec(easing)[1].split(', ').map(Number);

/**
 * `m x'' + c x' + k (x - 1) = 0` from rest at 0, by fourth-order Runge-Kutta.
 * Deliberately not the closed form: a second derivation of the same motion.
 */
function integrate({ stiffness, damping, mass }, seconds) {
  const acceleration = (x, v) => (-damping * v - stiffness * (x - 1)) / mass;
  const dt = 1 / 20000;
  let [x, v] = [0, 0];
  for (let t = 0; t < seconds - dt / 2; t += dt) {
    const [k1x, k1v] = [v, acceleration(x, v)];
    const [k2x, k2v] = [v + (dt / 2) * k1v, acceleration(x + (dt / 2) * k1x, v + (dt / 2) * k1v)];
    const [k3x, k3v] = [v + (dt / 2) * k2v, acceleration(x + (dt / 2) * k2x, v + (dt / 2) * k2v)];
    const [k4x, k4v] = [v + dt * k3v, acceleration(x + dt * k3x, v + dt * k3v)];
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return x;
}

test('the three springs are snappy, gentle and bouncy, with the physics pinned', () => {
  assert.deepEqual(Object.keys(tree.motion.spring).filter((key) => !key.startsWith('$')), NAMES);
  for (const name of NAMES) {
    const { stiffness, damping, mass, ...profile } = SPRINGS[name];
    assert.deepEqual(declared(tree, name), { stiffness, damping, mass }, `${name}: the declared physics`);
    const actual = springProfile(declared(tree, name));
    for (const [field, value] of Object.entries(profile)) assert.equal(actual[field], value, `${name}: ${field}`);
  }
});

test('the sampled curve is the motion of the spring the token declares', () => {
  for (const name of NAMES) {
    const spring = declared(tree, name);
    const profile = springProfile(spring);
    const curve = samples(profile.easing);
    assert.equal(curve.length, 33, `${name}: 32 segments`);
    assert.equal(curve[0], 0, `${name}: starts at rest on 0`);
    assert.equal(curve.at(-1), 1, `${name}: ends exactly on its target`);
    // Every sample but the last, which is snapped to the target, against the integration.
    for (let i = 1; i < curve.length - 1; i += 4) {
      const expected = integrate(spring, (profile.durationMs / 1000) * (i / 32));
      assert.ok(Math.abs(curve[i] - expected) < 1e-3, `${name}: sample ${i} is ${curve[i]}, the spring is at ${expected.toFixed(4)}`);
    }
    // Settled: within 0.2 % of the target when the duration ends, and from then on.
    for (const late of [1, 1.25, 2]) {
      const position = integrate(spring, (profile.durationMs / 1000) * late);
      assert.ok(Math.abs(position - 1) <= 0.0021, `${name}: ${position.toFixed(4)} at ${late}× its duration is not settled`);
    }
  }
});

test('each spring keeps the character its name promises', () => {
  const [snappy, gentle, bouncy] = NAMES.map((name) => springProfile(declared(tree, name)));
  assert.ok(snappy.durationMs < gentle.durationMs, 'snappy settles before gentle');
  assert.ok(snappy.overshoot < 0.02, `snappy barely overshoots (${snappy.overshoot})`);
  assert.equal(gentle.overshoot, 0, 'gentle never passes its target');
  assert.ok(samples(gentle.easing).every((value, i, all) => i === 0 || value >= all[i - 1]), 'gentle only ever approaches');
  assert.ok(bouncy.overshoot > 0.1 && bouncy.overshoot <= 0.25, `bouncy overshoots visibly, within the bound (${bouncy.overshoot})`);
  assert.ok(Math.max(...samples(bouncy.easing)) > 1.1, 'the overshoot survives the sampling');
});

test('the profile is a pure function of the three numbers', () => {
  const spring = declared(tree, 'bouncy');
  assert.deepEqual(springProfile(spring), springProfile({ ...spring }));
  // Scaling stiffness, damping and mass together is the same spring.
  const scaled = springProfile({ stiffness: spring.stiffness * 2, damping: spring.damping * 2, mass: spring.mass * 2 });
  const base = springProfile(spring);
  for (const field of ['dampingRatio', 'response', 'durationMs', 'overshoot', 'easing']) assert.equal(scaled[field], base[field], field);
});

/** The body of the one block that opens with `opener`. */
function block(styles, opener) {
  const parts = styles.split(`\n${opener}\n`);
  assert.equal(parts.length, 2, `tokens.css: exactly one \`${opener}\` block`);
  return { body: parts[1].split('\n}\n')[0], at: parts[0].length };
}

const SUPPORTS = '@supports (transition-timing-function: linear(0, 1)) {';
const REDUCED = '@media (prefers-reduced-motion: reduce) {';

function checkSpringCss(source, styles) {
  const root = styles.split('\n:root {\n')[1]?.split('\n}\n')[0];
  assert.ok(root, 'tokens.css: the :root block');
  const supports = block(styles, SUPPORTS);
  const reduced = block(styles, REDUCED);
  assert.ok(reduced.at > supports.at, 'reduced motion must come after @supports, or the spring wins the cascade');
  for (const blockBody of [supports.body, reduced.body]) assert.ok(blockBody.startsWith('  :root {\n'), 'the spring is switched on :root');

  for (const name of NAMES) {
    const profile = springProfile(declared(source, name));
    // The default, for every client: an easing that cannot overshoot.
    assert.ok(root.includes(`  --spring-${name}: var(--ease-out);`), `--spring-${name} defaults to the plain ease-out`);
    assert.ok(root.includes(`  --spring-${name}-duration: ${profile.durationMs}ms;`), `--spring-${name}-duration is when the spring has settled`);
    assert.ok(supports.body.includes(`    --spring-${name}: ${profile.easing};`), `@supports: --spring-${name} is the sampled spring`);
    assert.ok(reduced.body.includes(`    --spring-${name}: var(--ease-out);`), `reduced motion: --spring-${name} is the plain ease-out again`);
  }
  // Every `linear(` that is a value, which leaves out the @supports condition itself.
  const sampled = styles.replaceAll(SUPPORTS, '').match(/: linear\(/g) ?? [];
  assert.equal(sampled.length, NAMES.length, 'a sampled easing is declared under @supports and nowhere else');
  assert.match(root, /^  --ease-out: cubic-bezier\(/m, 'the fallback easing is declared');
}

function checkSpringPreset(config) {
  const { transitionTimingFunction, transitionDuration } = config.theme.extend;
  for (const name of NAMES) {
    assert.equal(transitionTimingFunction[`spring-${name}`], `var(--spring-${name})`, `preset: ease-spring-${name} follows the switch`);
    assert.equal(transitionDuration[`spring-${name}`], `var(--spring-${name}-duration)`, `preset: duration-spring-${name}`);
  }
  // What was there before is still there.
  assert.equal(transitionTimingFunction.out, 'cubic-bezier(0.2, 0.7, 0.3, 1)');
  assert.deepEqual([transitionDuration.fast, transitionDuration.base, transitionDuration.slow, transitionDuration.DEFAULT], ['120ms', '200ms', '320ms', '200ms']);
}

test('the stylesheet declares every spring as the plain ease-out and switches the curve on last', () => checkSpringCss(tree, css));
test('the preset addresses a spring through its two properties', () => checkSpringPreset(preset));
test('the types name both properties of every spring', () => {
  for (const name of NAMES) {
    assert.ok(types.includes(`| '--spring-${name}'`), `--spring-${name} is typed`);
    assert.ok(types.includes(`| '--spring-${name}-duration'`), `--spring-${name}-duration is typed`);
    assert.ok(types.includes(`| 'motion.spring.${name}'`), `motion.spring.${name} is a token path`);
  }
});

test('every output clause fails on its own mutation', () => {
  assert.throws(
    () => checkSpringCss(tree, css.replace('  --spring-bouncy: var(--ease-out);\n  --spring-bouncy-duration', `  --spring-bouncy: ${springProfile(declared(tree, 'bouncy')).easing};\n  --spring-bouncy-duration`)),
    /--spring-bouncy defaults to the plain ease-out/,
  );
  assert.throws(() => checkSpringCss(tree, css.replace('--spring-snappy-duration: 400ms;', '--spring-snappy-duration: 200ms;')), /--spring-snappy-duration is when the spring has settled/);
  assert.throws(() => checkSpringCss(tree, css.replace(SUPPORTS, '@media all {')), /exactly one `@supports \(transition-timing-function: linear\(0, 1\)\) \{` block/);
  assert.throws(() => checkSpringCss(tree, css.replace(REDUCED, '@media (min-width: 1px) {')), /exactly one `@media \(prefers-reduced-motion: reduce\) \{` block/);
  // The two blocks in the other order: the reader's preference loses the cascade.
  const [head, tail] = css.split(`\n${SUPPORTS}\n`);
  const supportsBlock = `${SUPPORTS}\n${tail.split('\n}\n')[0]}\n}\n`;
  const reordered = `${head}\n${tail.slice(tail.indexOf('\n}\n') + 3)}\n${supportsBlock}`;
  assert.throws(() => checkSpringCss(tree, reordered), /reduced motion must come after @supports, or the spring wins the cascade/);
  assert.throws(
    () => checkSpringCss(tree, css.replace(/(@media \(prefers-reduced-motion: reduce\) \{\n  :root \{\n)    --spring-snappy: var\(--ease-out\);\n/, '$1')),
    /reduced motion: --spring-snappy is the plain ease-out again/,
  );
  assert.throws(
    () => checkSpringCss(tree, `${css}\n.card { transition-timing-function: linear(0, 0.5, 1); }\n`),
    /a sampled easing is declared under @supports and nowhere else/,
  );
  // A retuned token with a stylesheet that was not rebuilt.
  const retuned = structuredClone(tree);
  retuned.motion.spring.gentle.$value.stiffness = 200;
  assert.throws(() => checkSpringCss(retuned, css), /--spring-gentle-duration is when the spring has settled|@supports: --spring-gentle is the sampled spring/);

  const frozen = structuredClone(preset);
  frozen.theme.extend.transitionTimingFunction['spring-bouncy'] = springProfile(declared(tree, 'bouncy')).easing;
  assert.throws(() => checkSpringPreset(frozen), /preset: ease-spring-bouncy follows the switch/);
  const noDuration = structuredClone(preset);
  delete noDuration.theme.extend.transitionDuration['spring-snappy'];
  assert.throws(() => checkSpringPreset(noDuration), /preset: duration-spring-snappy/);

  checkSpringCss(tree, css);
  checkSpringPreset(preset);
});
