// Elevation (DESIGN_HANDOFF A10) and breakpoints (A13): what the build must
// emit, and the ways it can be wrong without any other gate noticing.
//
// A shadow frozen to one theme renders, and a breakpoint out of order compiles:
// Tailwind sorts nothing it is not asked to, and a light shadow on a dark
// ground is merely invisible. So the contract is read here, from the source,
// the generated CSS and the preset, and every clause below, and every error
// the build and the grammar gate raise for these tokens, has a mutation that
// asserts its own message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, indexTokens, resolve, resolveValue } from '../scripts/lib/tokens.mjs';
import preset from '../dist/tailwind.preset.js';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');

const THEMES = ['light', 'dark', 'black'];
/** Weakest first. */
const LEVELS = ['raised', 'overlay', 'drawer', 'dialog'];
/** The levels that reproduce today's two shadows, field for field. */
const SAME_AS = { raised: 'card', overlay: 'pop' };
const GEOMETRY = ['offsetX', 'offsetY', 'blur', 'spread'];

const px = (v) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  assert.ok(m, `${v}: a px dimension`);
  return Number(m[1]);
};

const rem = (v) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(v);
  assert.ok(m, `${v}: a rem dimension`);
  return Number(m[1]);
};

function themeBlock(styles, theme) {
  const selector = theme === 'light' ? ':root, \\[data-theme="light"\\]' : `\\[data-theme="${theme}"\\]`;
  return styles.match(new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`))?.[1];
}

function checkElevation(source, styles, config) {
  const index = indexTokens(source);
  const shadow = (theme, level) => resolve(`semantic.elevation.${theme}.${level}`, index);

  for (const theme of THEMES) {
    const levels = Object.keys(source.semantic.elevation[theme]).filter((k) => !k.startsWith('$'));
    assert.deepEqual(levels, LEVELS, `${theme}: four elevation levels, weakest first`);
    for (const level of LEVELS) {
      assert.equal(
        shadow(theme, level).color,
        level === 'raised' ? `{color.theme-${theme}.shadow-1}` : `{color.theme-${theme}.shadow-2}`,
        `${theme}.${level}: drawn in this theme's own shadow colour`,
      );
    }
  }

  for (const level of LEVELS) {
    // A dark UI cannot reuse a light shadow.
    const painted = THEMES.map((theme) => resolveValue(shadow(theme, level).color, index));
    assert.equal(new Set(painted).size, THEMES.length, `${level}: a distinct shadow in each theme`);
    // One geometry per level: only the colour follows the theme.
    for (const theme of THEMES.slice(1)) {
      for (const field of GEOMETRY) {
        assert.equal(shadow(theme, level)[field], shadow('light', level)[field], `${theme}.${level}: the light geometry (${field})`);
      }
    }
    if (SAME_AS[level]) {
      const today = resolve(`shadow.${SAME_AS[level]}`, index);
      for (const field of GEOMETRY) {
        assert.equal(shadow('light', level)[field], today[field], `${level}: the shadow.${SAME_AS[level]} geometry (${field})`);
      }
    }
  }

  // A ladder: each level is softer and wider than the one below it.
  for (let i = 1; i < LEVELS.length; i++) {
    const [low, high] = [shadow('light', LEVELS[i - 1]), shadow('light', LEVELS[i])];
    assert.ok(px(high.blur) > px(low.blur), `${LEVELS[i]}: blur rises above ${LEVELS[i - 1]}`);
  }

  for (const theme of THEMES) {
    const block = themeBlock(styles, theme);
    assert.ok(block, `${theme}: CSS boundary missing`);
    for (const level of LEVELS) {
      const { offsetX, offsetY, blur, spread, color } = shadow(theme, level);
      const value = `${offsetX} ${offsetY} ${blur} ${spread} ${resolveValue(color, index)}`;
      assert.ok(block.includes(`  --elevation-${level}: ${value};`), `${theme}.${level}: scoped CSS`);
    }
  }

  const boxShadow = config.theme.extend.boxShadow;
  for (const level of LEVELS) {
    assert.equal(boxShadow[level], `var(--elevation-${level})`, `${level}: dynamic preset`);
  }
  assert.deepEqual(
    Object.keys(boxShadow).filter((k) => k.startsWith('theme-')),
    [],
    'the themed shadow primitives stay out of the preset',
  );
}

function checkBreakpoints(source, styles, config) {
  const steps = Object.entries(source.breakpoint).filter(([k]) => !k.startsWith('$'));
  assert.ok(steps.length >= 4 && steps.length <= 5, `four or five breakpoints, not ${steps.length}`);
  let previous = 360 / 16; // the smallest device designed for; every step is wider
  for (const [name, token] of steps) {
    const width = rem(token.$value);
    assert.ok(width > previous, `breakpoint ${name}: ${width}rem must be wider than ${previous}rem, mobile-first`);
    previous = width;
    assert.ok(styles.includes(`  --breakpoint-${name}: ${token.$value};`), `breakpoint ${name}: reaches the CSS`);
  }
  assert.deepEqual(
    config.theme.extend.screens,
    Object.fromEntries(steps.map(([name, token]) => [name, token.$value])),
    'the preset screens are the breakpoint tokens',
  );
}

test('elevation: four themed levels, one geometry each, a ladder, distinct per theme, dynamic in the preset', () =>
  checkElevation(tree, css, preset));

test('breakpoints: four or five mobile-first rem steps above 360px, in the CSS and the preset', () =>
  checkBreakpoints(tree, css, preset));

test('every elevation clause turns red on its own mutation', () => {
  const mutate = (edit) => {
    const copy = structuredClone(tree);
    edit(copy);
    return copy;
  };

  const reordered = mutate((t) => {
    const { raised, ...rest } = t.semantic.elevation.dark;
    t.semantic.elevation.dark = { ...rest, raised };
  });
  assert.throws(() => checkElevation(reordered, css, preset), /dark: four elevation levels, weakest first/);

  const borrowed = mutate((t) => (t.shadow['theme-dark'].dialog.$value.color = '{color.theme-light.shadow-2}'));
  assert.throws(() => checkElevation(borrowed, css, preset), /dark\.dialog: drawn in this theme's own shadow colour/);

  const sameInk = mutate((t) => (t.color['theme-black']['shadow-2'].$value = t.color['theme-dark']['shadow-2'].$value));
  assert.throws(() => checkElevation(sameInk, css, preset), /overlay: a distinct shadow in each theme/);

  const offGeometry = mutate((t) => (t.shadow['theme-dark'].drawer.$value.blur = '70px'));
  assert.throws(() => checkElevation(offGeometry, css, preset), /dark\.drawer: the light geometry \(blur\)/);

  const notCard = mutate((t) => THEMES.forEach((th) => (t.shadow[`theme-${th}`].raised.$value.offsetY = '10px')));
  assert.throws(() => checkElevation(notCard, css, preset), /raised: the shadow\.card geometry \(offsetY\)/);

  const flat = mutate((t) => THEMES.forEach((th) => (t.shadow[`theme-${th}`].drawer.$value.blur = '40px')));
  assert.throws(() => checkElevation(flat, css, preset), /drawer: blur rises above overlay/);

  const notPx = mutate((t) => THEMES.forEach((th) => (t.shadow[`theme-${th}`].dialog.$value.blur = '5rem')));
  assert.throws(() => checkElevation(notPx, css, preset), /5rem: a px dimension/);

  const noBoundary = css.replace('[data-theme="black"] {', '[data-theme="blak"] {');
  assert.throws(() => checkElevation(tree, noBoundary, preset), /black: CSS boundary missing/);

  const unscoped = css.replace(/(\[data-theme="dark"\] \{[^}]*?)  --elevation-raised: [^;]+;\n/, '$1');
  assert.notEqual(unscoped, css, 'the mutation removed a declaration');
  assert.throws(() => checkElevation(tree, unscoped, preset), /dark\.raised: scoped CSS/);

  const frozen = structuredClone(preset);
  frozen.theme.extend.boxShadow.overlay = '0px 20px 50px -20px rgba(47,58,69,.35)';
  assert.throws(() => checkElevation(tree, css, frozen), /overlay: dynamic preset/);

  const leaked = structuredClone(preset);
  leaked.theme.extend.boxShadow['theme-light.raised'] = '0px 8px 24px -16px rgba(47,58,69,.25)';
  assert.throws(() => checkElevation(tree, css, leaked), /the themed shadow primitives stay out of the preset/);
});

test('every breakpoint clause turns red on its own mutation', () => {
  const mutate = (edit) => {
    const copy = structuredClone(tree);
    edit(copy);
    return copy;
  };

  const six = mutate((t) => (t.breakpoint['3xl'] = { $value: '120rem' }));
  assert.throws(() => checkBreakpoints(six, css, preset), /four or five breakpoints, not 6/);

  const inPx = mutate((t) => (t.breakpoint.md.$value = '768px'));
  assert.throws(() => checkBreakpoints(inPx, css, preset), /768px: a rem dimension/);

  const disordered = mutate((t) => (t.breakpoint.lg.$value = '44rem'));
  assert.throws(() => checkBreakpoints(disordered, css, preset), /breakpoint lg: 44rem must be wider than 48rem/);

  const tooNarrow = mutate((t) => (t.breakpoint.sm.$value = '20rem'));
  assert.throws(() => checkBreakpoints(tooNarrow, css, preset), /breakpoint sm: 20rem must be wider than 22\.5rem/);

  const missingCss = css.replace(/  --breakpoint-xl: [^;]+;/, '');
  assert.throws(() => checkBreakpoints(tree, missingCss, preset), /breakpoint xl: reaches the CSS/);

  const stale = structuredClone(preset);
  stale.theme.extend.screens.md = '768px';
  assert.throws(() => checkBreakpoints(tree, css, stale), /the preset screens are the breakpoint tokens/);
});

/** A copy of the scripts on a mutated source: each run returns its exit status and output. */
function sandbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'elevation-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'token-grammar-exceptions.json'), join(dir, 'token-grammar-exceptions.json'));
    fn((source, script) => {
      writeFileSync(join(dir, 'tokens.json'), JSON.stringify(source));
      return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: {} });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mutated = (edit) => {
  const copy = structuredClone(tree);
  edit(copy);
  return copy;
};

test('the grammar gate refuses a composite reference that is dangling, misplaced, cyclic or not a colour', () =>
  sandbox((run) => {
    assert.equal(run(tree, 'scripts/check-grammar.mjs').status, 0, 'the unmutated source passes');
    const refused = (source, message) => {
      const result = run(source, 'scripts/check-grammar.mjs');
      assert.notEqual(result.status, 0, `refused: ${message}`);
      assert.match(result.stderr, message);
    };
    refused(
      mutated((t) => (t.shadow['theme-dark'].overlay.$value.color = '{color.theme-dark.shadow-9}')),
      /shadow\.theme-dark\.overlay {2}\[alias\] {2}color: dangling reference: "color\.theme-dark\.shadow-9"/,
    );
    refused(
      mutated((t) => (t.shadow.card.$value.offsetY = '{space.2}')),
      /shadow\.card {2}\[alias\] {2}offsetY: a reference is allowed in a composite's "color" only/,
    );
    refused(
      mutated((t) => (t.shadow['theme-light'].raised.$value.color = '{space.4}')),
      /shadow\.theme-light\.raised {2}\[alias\] {2}color: "space\.4" is a dimension token, not a colour/,
    );
    refused(
      mutated((t) => (t.color['theme-black']['shadow-2'].$value = '{semantic.theme.black.shadow-2}')),
      /shadow\.theme-black\.overlay {2}\[alias\] {2}color: reference cycle/,
    );
  }));

test('the build refuses an incomplete, empty, colliding or uncoloured elevation set', () =>
  sandbox((run) => {
    assert.equal(run(tree, 'scripts/build.mjs').status, 0, 'the unmutated source builds');
    const refused = (source, message) => {
      const result = run(source, 'scripts/build.mjs');
      assert.notEqual(result.status, 0, `refused: ${message}`);
      assert.match(result.stderr, message);
    };
    refused(
      mutated((t) => delete t.semantic.elevation.black),
      /expected elevation for the complete theme set: light, dark, black/,
    );
    refused(
      mutated((t) => (t.semantic.elevation.light = { $description: 'none' })),
      /light: no elevation level/,
    );
    refused(
      mutated((t) => delete t.semantic.elevation.black.dialog),
      /black: incomplete elevation level set/,
    );
    const renamed = (to) =>
      mutated((t) =>
        THEMES.forEach((th) => {
          const group = t.semantic.elevation[th];
          group[to] = group.raised;
          delete group.raised;
        }),
      );
    refused(renamed('card'), /elevation level "card" collides with the shadow primitive of that name/);
    refused(renamed('lg'), /elevation level "lg" would replace Tailwind's own shadow-lg/);
    refused(
      mutated((t) => (t.shadow['theme-dark'].overlay.$value.color = '{space.4}')),
      /shadow\.theme-dark\.overlay: shadow color: not a colour: 16px/,
    );
  }));
