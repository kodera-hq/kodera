// Self-test for the grammar gate itself.
//
// The gate is the one place a token's shape is decided, so it is the one place
// a malformed token can be let through by a rule that was widened to admit a
// new kind. Each test below copies the gate and its inputs into a scratch
// directory, breaks exactly one thing, and asserts the gate goes red for that
// reason. The refusals were written before the tiers they guard: a rule that is
// only ever seen passing is a rule nobody has seen work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib/tokens.mjs';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));

/** Run the gate over a mutated copy of tokens.json; nothing else changes. */
function gate(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grammar-selftest-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'token-grammar-exceptions.json'), join(dir, 'token-grammar-exceptions.json'));
    const copy = structuredClone(tree);
    edit(copy);
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(copy));
    const result = spawnSync(process.execPath, ['scripts/check-grammar.mjs'], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
/** The gate's own report line for one problem: `FAIL  path  [rule]  detail`. */
const problem = (path, rule, detail = '') => new RegExp(`^  FAIL  ${rx(path)}  \\[${rx(rule)}\\]  ${detail}`, 'm');

/** Break one thing, and assert the gate fails for each expected reason. */
function refuses(name, edit, expected) {
  test(name, () => {
    const { status, output } = gate(edit);
    assert.equal(status, 1, `the gate exited ${status} instead of failing:\n${output}`);
    for (const pattern of [expected].flat()) {
      assert.match(output, pattern, `the gate failed, but not for the reason under test:\n${output}`);
    }
  });
}

test('an untouched copy of the gate and its source passes', () => {
  const { status, output } = gate();
  assert.equal(status, 0, output);
  assert.match(output, /OK — 0 grammar problems, 0 dangling references\./);
});

// --- The closed grammar ------------------------------------------------------
refuses(
  'a token under a root group the grammar does not list is refused',
  (t) => (t.sky = { $type: 'color', zenith: { $value: '#BBD7F5' } }),
  problem('sky.zenith', 'root-group', '"sky" is not one of '),
);

refuses(
  'a fifth path segment is refused: a tier is addressed in at most four',
  (t) => (t.semantic.surface.glass = { bar: { tint: { $value: '{color.white}' } } }),
  problem('semantic.surface.glass.bar.tint', 'depth', '5 segments, the grammar allows at most 4'),
);

refuses(
  'a literal in the semantic tier is refused: only a primitive holds a value',
  (t) => (t.semantic.surface.glass = { $value: 'rgba(255, 255, 255, 0.72)' }),
  problem('semantic.surface.glass', 'tier', 'semantic token holds a literal value; it must reference another token'),
);

refuses(
  'a component token that skips the semantic tier is refused',
  (t) => (t.component.shell.glass = { $type: 'color', $value: '{color.white}' }),
  problem('component.shell.glass', 'tier', 'component token references "color\\.white"; it must reference a semantic token'),
);

// --- The material tier ---------------------------------------------------------
//
// `material` is a root the grammar admits for exactly one shape. Every refusal
// below starts from the same well-formed material — the light theme's bar, flat
// as its family requires — and changes one thing, so the reason the gate gives
// is the only thing that differs between two cases.
const FLAT_BAR = () => ({
  tint: '{color.theme-light.surface}',
  alpha: 1,
  blur: '0px',
  saturation: 1,
  border: '{color.theme-light.border}',
  shadow: '{shadow.theme-light.raised}',
  canvas: '{color.theme-light.page}',
});

/** Declare the light bar, as a primitive and under the name a consumer addresses. */
const withBar = (change = () => {}, alias = '{material.theme-light.bar}') => (t) => {
  const value = FLAT_BAR();
  change(value, t);
  t.material = { $type: 'material', 'theme-light': { bar: { $value: value } } };
  t.semantic.material = { $type: 'material', light: { bar: { $value: alias } } };
};

const BAR = 'material.theme-light.bar';

test('a well-formed material is accepted, as a primitive and through its semantic name', () => {
  const { status, output } = gate(withBar());
  assert.equal(status, 0, output);
});

refuses(
  'a material that is not a complete composite is refused',
  (t) => (t.material = { $type: 'material', 'theme-light': { bar: { $value: { tint: '#FFFFFF', alpha: 2 } } } }),
  [
    problem(BAR, 'material', 'missing field "blur"'),
    problem(BAR, 'material', 'missing field "canvas"'),
    problem(BAR, 'material', 'tint: must be a reference to a color token'),
    problem(BAR, 'material', 'alpha: 2 is not a number in \\(0, 1\\]'),
  ],
);

for (const [name, change, detail] of [
  ['an alpha of zero', (v) => (v.alpha = 0), 'alpha: 0 is not a number in \\(0, 1\\]'],
  ['an alpha above one', (v) => (v.alpha = 1.2), 'alpha: 1\\.2 is not a number in \\(0, 1\\]'],
  ['an alpha written as text', (v) => (v.alpha = '0.5'), 'alpha: "0\\.5" is not a number in \\(0, 1\\]'],
  ['a blur that is not a pixel length', (v) => (v.blur = '2rem'), 'blur: "2rem" is not a pixel length such as "24px"'],
  ['a blur wider than a compositor should be asked for', (v) => (v.blur = '80px'), 'blur: 80px is wider than the 64px'],
  ['a saturation that desaturates', (v) => (v.saturation = 0.8), 'saturation: 0\\.8 is not a number in \\[1, 2\\]'],
  ['a saturation beyond the cap', (v) => (v.saturation = 3), 'saturation: 3 is not a number in \\[1, 2\\]'],
  ['a field the build does not read', (v) => (v.opacity = 0.5), 'unknown field "opacity"; a material is tint, alpha, blur, saturation, border, shadow, canvas'],
  ['a missing field', (v) => delete v.shadow, 'missing field "shadow"'],
  ['a literal tint', (v) => (v.tint = '#FFFFFF'), 'tint: must be a reference to a color token'],
  ['a tint that carries an alpha of its own', (v) => (v.tint = '{color.theme-light.scrim}'), 'tint: "color\\.theme-light\\.scrim" is translucent; the tint is opaque'],
  ['a translucent canvas', (v) => (v.canvas = '{color.theme-light.scrim}'), 'canvas: "color\\.theme-light\\.scrim" is translucent; the canvas is what the opaque fallback is composited over'],
  ['a border that is not a colour', (v) => (v.border = '{space.4}'), 'border: "space\\.4" is a dimension token, not a color'],
  ['a shadow that is not a shadow', (v) => (v.shadow = '{color.white}'), 'shadow: "color\\.white" is a color token, not a shadow'],
  ['a tint that names no token', (v) => (v.tint = '{color.theme-light.glass}'), 'tint: dangling reference: "color\\.theme-light\\.glass" resolves to no token'],
  [
    'a translucent material in a flat family',
    (v) => (v.alpha = 0.8),
    'the givre family is flat: a material in "light" has alpha 1, blur 0px and saturation 1, not alpha 0\\.8, blur 0px and saturation 1',
  ],
  ['a blurred material in a flat family', (v) => (v.blur = '12px'), 'the givre family is flat: .* not alpha 1, blur 12px and saturation 1'],
  ['a saturated material in a flat family', (v) => (v.saturation = 1.4), 'the givre family is flat: .* not alpha 1, blur 0px and saturation 1\\.4'],
]) {
  refuses(`a material with ${name} is refused`, withBar(change), problem(BAR, 'material', detail));
}

refuses(
  'a material for a theme the registry does not hold is refused',
  (t) => (t.material = { $type: 'material', 'theme-sepia': { bar: { $value: FLAT_BAR() } } }),
  problem('material.theme-sepia.bar', 'material', '"sepia" is not a registered theme; the themes are '),
);

refuses(
  'a material level outside the four is refused',
  (t) => (t.material = { $type: 'material', 'theme-light': { sheet: { $value: FLAT_BAR() } } }),
  problem('material.theme-light.sheet', 'material', '"sheet" is not a material level; the levels are bar, panel, popover, dialog'),
);

refuses(
  'a token under `material` that is not a material is refused',
  (t) => (t.material = { 'theme-light': { bar: { $type: 'color', $value: '#FFFFFF' } } }),
  problem(BAR, 'material', '\\$type is "color"; a token here is a material'),
);

refuses(
  'a material declared anywhere else in the tree is refused',
  (t) => (t.color.glass = { $type: 'material', $value: FLAT_BAR() }),
  problem('color.glass', 'material', 'a material lives at material\\.theme-<theme>\\.<level> or semantic\\.material\\.<theme>\\.<level>'),
);

refuses(
  'a semantic material that names another theme\'s level is refused',
  (t) => {
    withBar()(t);
    t.material['theme-dark'] = { bar: { $value: { ...FLAT_BAR(), tint: '{color.theme-dark.surface}', canvas: '{color.theme-dark.page}' } } };
    t.semantic.material.light.bar.$value = '{material.theme-dark.bar}';
  },
  problem('semantic.material.light.bar', 'material', "must reference \\{material\\.theme-light\\.bar\\}, its own theme's level, and nothing else"),
);

refuses(
  'a material primitive that aliases another material is refused',
  (t) => {
    withBar()(t);
    t.material['theme-light'].panel = { $value: '{material.theme-light.bar}' };
  },
  problem('material.theme-light.panel', 'material', 'a material primitive holds the composite itself, not a reference to another material'),
);

refuses(
  'a material composite in the semantic tier is refused twice over: a literal, and not its own primitive',
  (t) => (t.semantic.material = { $type: 'material', light: { bar: { $value: FLAT_BAR() } } }),
  [
    problem('semantic.material.light.bar', 'tier', 'semantic token holds a literal value'),
    problem('semantic.material.light.bar', 'material', 'must reference \\{material\\.theme-light\\.bar\\}'),
  ],
);

// --- Springs -------------------------------------------------------------------
const SPRING = 'motion.spring.snappy';
const withSpring = (value, type = 'spring') => (t) => (t.motion.spring = { $type: type, snappy: { $value: value } });

test('a well-formed spring is accepted', () => {
  const { status, output } = gate(withSpring({ stiffness: 420, damping: 34, mass: 1 }));
  assert.equal(status, 0, output);
});

for (const [name, value, detail] of [
  ['a negative stiffness', { stiffness: -1, damping: 34, mass: 1 }, 'stiffness: -1 is not a positive number'],
  ['a missing damping', { stiffness: 420, mass: 1 }, 'missing field "damping"'],
  ['a zero mass', { stiffness: 420, damping: 34, mass: 0 }, 'mass: 0 is not a positive number'],
  ['a field no platform reads', { stiffness: 420, damping: 34, mass: 1, bounce: 0.3 }, 'unknown field "bounce"; a spring is stiffness, damping, mass'],
  // Damping ratio 0.115: the first swing passes the target by 69 %.
  ['a spring that rings', { stiffness: 300, damping: 4, mass: 1 }, 'overshoots its target by 6\\d\\.\\d %, past the 25 % a spring here may; damp it'],
  // Critically damped and slow: more than two seconds to come within 0.2 %.
  ['a spring that does not settle in time', { stiffness: 8, damping: 6, mass: 1 }, 'does not settle within 1500ms; stiffen it or damp it'],
]) {
  refuses(`${name} is refused`, withSpring(value), problem(SPRING, 'spring', detail));
}

refuses(
  'a spring that is not a composite is refused',
  withSpring('cubic-bezier(0.2, 0.7, 0.3, 1)'),
  problem(SPRING, 'spring', 'a spring is a composite of stiffness, damping, mass'),
);

refuses(
  'a token under motion.spring that is not a spring is refused',
  withSpring([0.2, 0.7, 0.3, 1], 'cubicBezier'),
  problem(SPRING, 'spring', '\\$type is "cubicBezier"; a token here is a spring'),
);

refuses(
  'a spring declared anywhere else in the tree is refused',
  (t) => (t.motion.easing.spring = { $type: 'spring', $value: { stiffness: 420, damping: 34, mass: 1 } }),
  problem('motion.easing.spring', 'spring', 'a spring lives at motion\\.spring\\.<name>'),
);

// --- Gradients -----------------------------------------------------------------
//
// One colour everywhere (D-UI3), except a ciel theme's own gradient, which is
// held to the controlled grammar: bounded, every stop a named colour of its own
// theme, anchored at 0 and 1. The subject is a three-stop sky built in the
// scratch copy; each refusal changes one thing about it.
const SKY = 'color.theme-ciel.page-grad';
const withSky = (change = () => {}) => (t) => {
  const ciel = t.color['theme-ciel'];
  ciel['sky-zenith'] = { $value: '#D7E8FA' };
  ciel['sky-horizon'] = { $value: '#F8FBFE' };
  ciel['page-grad'].$value = [
    { color: '{color.theme-ciel.sky-zenith}', position: 0 },
    { color: '{color.theme-ciel.page}', position: 0.5 },
    { color: '{color.theme-ciel.sky-horizon}', position: 1 },
  ];
  change(ciel['page-grad'], t);
};

test('a controlled gradient is accepted in a ciel theme', () => {
  const { status, output } = gate(withSky());
  assert.equal(status, 0, output);
});

for (const [name, change, detail] of [
  [
    'a raw colour stop',
    (g) => (g.$value[0].color = '#D7E8FA'),
    'stop 0: #D7E8FA is a raw colour; every stop of a controlled gradient is a reference to a colour of its own theme',
  ],
  [
    'more stops than the bound',
    (g) => (g.$value = [0, 0.25, 0.5, 0.75, 1].map((position, i) => ({ color: i % 2 ? '{color.theme-ciel.page}' : '{color.theme-ciel.sky-zenith}', position }))),
    '5 stops; a controlled gradient has at most 4',
  ],
  [
    'a stop that is another theme\'s colour',
    (g) => (g.$value[0].color = '{color.theme-light.muted-2}'),
    'stop 0: "color\\.theme-light\\.muted-2" is not a colour of the "ciel" theme \\(color\\.theme-ciel\\.\\*\\)',
  ],
  [
    'a stop taken from a shared ramp',
    (g) => (g.$value[2].color = '{color.frost.200}'),
    'stop 2: "color\\.frost\\.200" is not a colour of the "ciel" theme',
  ],
  [
    'a translucent stop',
    (g) => (g.$value[1].color = '{color.theme-ciel.scrim}'),
    'stop 1: "color\\.theme-ciel\\.scrim" is translucent; a stop is a ground, and a ground is opaque',
  ],
  ['a stop that is not a colour', (g) => (g.$value[0].color = '{space.4}'), 'stop 0: "space\\.4" is a dimension token, not a colour'],
  ['a stop that names no token', (g) => (g.$value[0].color = '{color.theme-ciel.sky-nadir}'), 'stop 0: dangling reference: "color\\.theme-ciel\\.sky-nadir" resolves to no token'],
  ['a first stop that is not at 0', (g) => (g.$value[0].position = 0.1), 'positions run from 0\\.1 to 1; a controlled gradient is anchored at 0 and at 1'],
  ['a last stop that is not at 1', (g) => (g.$value[2].position = 0.9), 'positions run from 0 to 0\\.9; a controlled gradient is anchored at 0 and at 1'],
  ['positions that do not rise', (g) => (g.$value[1].position = 0), 'stop 1: position 0 does not rise above stop 0 \\(0\\)'],
  ['a position outside the gradient', (g) => (g.$value[1].position = 1.5), 'stop 1: position 1\\.5 is not a number in \\[0, 1\\]'],
  ['a stop with a field of its own', (g) => (g.$value[1].hint = 0.3), 'stop 1: a stop is a color and a position, nothing else'],
  ['no angle', (g) => delete g.$extensions, 'missing or invalid gradient angle metadata'],
  ['a single stop', (g) => (g.$value = g.$value.slice(0, 1)), 'a gradient is a list of at least two stops'],
]) {
  refuses(`a ciel gradient with ${name} is refused`, withSky(change), problem(SKY, 'gradient', detail));
}

refuses(
  'a gradient added to a Givre theme is refused, at the primitive and at the role that names it',
  (t) => (t.color['theme-dark']['page-grad'].$value[1].color = '#161D25'),
  [
    problem('color.theme-dark.page-grad', 'gradient', 'a gradient of 2 colours in "dark": the givre family paints no gradient, every stop is one colour \\(no gradient, D-UI3\\)'),
    problem('semantic.theme.dark.page-grad', 'gradient', 'a gradient of 2 colours in "dark": the givre family paints no gradient'),
  ],
);

refuses(
  'a Givre role that names a ciel gradient is refused: the sky does not reach Givre through an alias',
  withSky((g, t) => (t.semantic.theme.light['page-grad'].$value = '{color.theme-ciel.page-grad}')),
  problem('semantic.theme.light.page-grad', 'gradient', 'a gradient of 3 colours in "light": the givre family paints no gradient'),
);

refuses(
  'a gradient that belongs to no theme is refused',
  (t) =>
    (t.color['brand-grad'] = {
      $type: 'gradient',
      $value: [
        { color: '#2B4BDB', position: 0 },
        { color: '#5B33C9', position: 1 },
      ],
      $extensions: { 'io.kodera.css-gradient': { angle: '125deg' } },
    }),
  problem('color.brand-grad', 'gradient', 'a gradient of 2 colours belongs to no theme; only a theme of a controlled-gradient family may declare one'),
);

refuses(
  'a ciel role that names another theme\'s gradient is refused',
  withSky((g, t) => {
    const nuit = t.color['theme-ciel-nuit'];
    nuit['sky-zenith'] = { $value: '#0A1020' };
    nuit['page-grad'].$value = [
      { color: '{color.theme-ciel-nuit.sky-zenith}', position: 0 },
      { color: '{color.theme-ciel-nuit.page}', position: 1 },
    ];
    t.semantic.theme.ciel['page-grad'].$value = '{color.theme-ciel-nuit.page-grad}';
  }),
  problem('semantic.theme.ciel.page-grad', 'gradient', 'references "color\\.theme-ciel-nuit\\.page-grad"; a gradient role of "ciel" names a gradient of its own theme'),
);
