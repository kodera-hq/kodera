// "Givre & Nuit" (v0.5.0): the properties zôÖma approved, read from the
// source, so a later value change that undoes one fails here with a sentence
// instead of passing every other gate.
//
//   no gradient     every theme's page-grad is flat: each stop is the page; no
//                   gradient token anywhere in the tree has two colours; and no
//                   linear-gradient the build emits, in the CSS or the preset,
//                   has two distinct stop colours (D-UI3)
//   dark steps      dark grounds get lighter in order, inverse to elevated
//   near-black rail every theme's inverse (the rail) is near-black
//   own hover       action-hover is each theme's own primitive, never another
//                   theme's cobalt
//   action rows     the fill is gated at 3:1 on surface and page in every theme
//   radius ladder   sm < md < lg < xl, with md 10, lg 16, xl 20
//
// Each clause has a mutation below that asserts its own message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, indexTokens, resolve, resolveValue, parseColor, luminance } from '../scripts/lib/tokens.mjs';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const register = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');
const presetText = readFileSync(join(ROOT, 'dist/tailwind.preset.js'), 'utf8');

const THEMES = ['light', 'dark', 'black'];
/** Darkest first: the rail, then the page, sidebar, work area and overlays. */
const DARK_STEPS = ['inverse', 'page', 'sunken', 'surface', 'elevated'];
/** The rail is near-black in every theme: below this relative luminance. */
const RAIL_MAX_LUMINANCE = 0.02;
const RADII = { md: 10, lg: 16, xl: 20 };

const lum = (theme, role, index) => luminance(parseColor(resolve(`semantic.theme.${theme}.${role}`, index)));

function checkNoGradient(source) {
  const index = indexTokens(source);
  for (const theme of THEMES) {
    const page = resolve(`semantic.theme.${theme}.page`, index);
    const stops = resolve(`semantic.theme.${theme}.page-grad`, index);
    stops.forEach((stop, i) => {
      assert.equal(
        stop.color.toUpperCase(),
        page.toUpperCase(),
        `${theme}.page-grad: stop ${i} is ${stop.color}, not the flat page ${page} (no gradient, D-UI3)`,
      );
    });
  }
  // Every gradient token anywhere in the tree, not only the theme groups: a
  // top-level primitive reaches the CSS and the preset as surely as a role.
  const walk = (node, path, inherited) => {
    const type = node.$type ?? inherited;
    if ('$value' in node) {
      if (type !== 'gradient') return;
      const stops = resolve(path, index);
      const colours = new Set(
        stops.map((stop) => (typeof stop.color === 'string' && stop.color.startsWith('{') ? resolveValue(stop.color, index) : stop.color).toUpperCase()),
      );
      assert.equal(colours.size, 1, `${path}: a gradient with ${colours.size} distinct colours (no gradient, D-UI3)`);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$') && child && typeof child === 'object') walk(child, path ? `${path}.${key}` : key, type);
    }
  };
  walk(source, '', undefined);
}

/** Top-level comma split: a colour like rgba(0, 0, 0, .5) keeps its own commas. */
function splitStops(args) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of args) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** What the build actually emits: every linear-gradient in the CSS and the preset is one colour. */
function checkEmittedFlat(styles, presetSource) {
  const found = [
    ...[...styles.matchAll(/(--[\w-]+):\s*linear-gradient\((.*)\);/g)].map((m) => ['tokens.css', m[1], m[2]]),
    ...[...presetSource.matchAll(/([\w"-]+):\s*"linear-gradient\((.*)\)"/g)].map((m) => ['preset', m[1], m[2]]),
  ];
  assert.ok(found.length > 0, 'dist: no linear-gradient found, so this check would pass vacuously');
  for (const [file, name, args] of found) {
    const stops = splitStops(args).filter((part) => !/^-?[\d.]+(deg|turn|rad)$|^to /.test(part));
    const colours = new Set(stops.map((stop) => stop.replace(/\s+-?[\d.]+%$/, '').toUpperCase()));
    assert.equal(colours.size, 1, `dist: ${file} ${name} is a linear-gradient with ${colours.size} distinct colours (no gradient, D-UI3)`);
  }
}

function checkDarkSteps(source) {
  const index = indexTokens(source);
  for (let i = 1; i < DARK_STEPS.length; i += 1) {
    const [lower, upper] = [DARK_STEPS[i - 1], DARK_STEPS[i]];
    assert.ok(
      lum('dark', lower, index) < lum('dark', upper, index),
      `dark: ${lower} must be darker than ${upper}, or the surfaces stop separating`,
    );
  }
}

function checkRail(source) {
  const index = indexTokens(source);
  for (const theme of THEMES) {
    const l = lum(theme, 'inverse', index);
    assert.ok(l < RAIL_MAX_LUMINANCE, `${theme}.inverse: luminance ${l.toFixed(4)} is not a near-black rail`);
  }
}

function checkOwnHover(source) {
  for (const theme of THEMES) {
    const ref = source.semantic.theme[theme]['action-hover'].$value;
    assert.match(
      ref,
      new RegExp(`^\\{color\\.theme-${theme}\\.`),
      `${theme}.action-hover: ${ref} is not this theme's own primitive`,
    );
  }
}

function checkActionRows(pairs) {
  for (const theme of THEMES) {
    for (const bg of ['surface', 'page']) {
      const id = `theme.${theme}/action/${bg}`;
      const row = pairs.pairs.find((r) => r.id === id);
      assert.ok(row, `${id}: the action fill must be a gated row`);
      assert.equal(row.fg, `semantic.theme.${theme}.action`, `${id}: must measure the action fill`);
      assert.equal(row.bg, `semantic.theme.${theme}.${bg}`, `${id}: must measure against ${bg}`);
      assert.ok(row.min >= 3 && !row.expect, `${id}: must be normative at 3:1 or more`);
    }
  }
}

function checkRadius(source) {
  const px = (name) => Number(/^(\d+)px$/.exec(source.radius[name].$value)?.[1]);
  const ladder = ['sm', 'md', 'lg', 'xl'];
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(px(ladder[i - 1]) < px(ladder[i]), `radius: ${ladder[i - 1]} must be smaller than ${ladder[i]}`);
  }
  for (const [name, value] of Object.entries(RADII)) {
    assert.equal(px(name), value, `radius.${name}: ${px(name)}px, decided ${value}px`);
  }
}

/** The reviewer's case: a top-level two-stop primitive, built for real in a sandbox. */
const BRAND_GRAD = {
  $type: 'gradient',
  $value: [
    { color: '#2B4BDB', position: 0 },
    { color: '#5B33C9', position: 1 },
  ],
  $extensions: { 'io.kodera.css-gradient': { angle: '125deg' } },
};

const mutate = (edit) => {
  const copy = structuredClone(tree);
  edit(copy);
  return copy;
};

test('no theme paints a gradient', () => checkNoGradient(tree));
test('nothing the build emits is a gradient', () => checkEmittedFlat(css, presetText));
test('dark grounds get lighter in order, from the rail to overlays', () => checkDarkSteps(tree));
test('the rail is near-black in every theme', () => checkRail(tree));
test('each theme hovers with its own cobalt', () => checkOwnHover(tree));
test('the action fill is gated at 3:1 on surface and page in every theme', () => checkActionRows(register));
test('the radius ladder rises and holds the decided steps', () => checkRadius(tree));

test('every clause fails on its own mutation', () => {
  assert.throws(
    () => checkNoGradient(mutate((t) => (t.color['theme-dark']['page-grad'].$value[1].color = '#161D25'))),
    /dark\.page-grad: stop 1 is #161D25, not the flat page #0B0E14 \(no gradient, D-UI3\)/,
  );
  assert.throws(
    () => checkNoGradient(mutate((t) => (t.color['theme-light']['page-grad'].$value[2].color = '#5B33C9'))),
    /light\.page-grad: stop 2 is #5B33C9, not the flat page #FFFFFF/,
  );
  assert.throws(
    () => checkNoGradient(mutate((t) => (t.color['brand-grad'] = BRAND_GRAD))),
    /color\.brand-grad: a gradient with 2 distinct colours \(no gradient, D-UI3\)/,
  );
  assert.throws(
    () => checkEmittedFlat(`${css}\n:root { --x: linear-gradient(115deg, var(--white) 0%, rgba(0, 0, 0, .5) 100%); }\n`, presetText),
    /dist: tokens\.css --x is a linear-gradient with 2 distinct colours/,
  );
  assert.throws(
    () => checkEmittedFlat('', presetText.replace('#FFFFFF 45%', '#EEF3F8 45%')),
    /dist: preset frost is a linear-gradient with 2 distinct colours/,
  );
  assert.throws(() => checkEmittedFlat('', ''), /no linear-gradient found, so this check would pass vacuously/);
  assert.throws(
    () => checkDarkSteps(mutate((t) => (t.color['theme-dark'].surface.$value = '#0D1017'))),
    /dark: sunken must be darker than surface, or the surfaces stop separating/,
  );
  assert.throws(
    () => checkDarkSteps(mutate((t) => (t.color['theme-dark'].elevated.$value = '#121722'))),
    /dark: surface must be darker than elevated/,
  );
  assert.throws(
    () => checkRail(mutate((t) => (t.color['theme-light'].inverse.$value = '#2F3A45'))),
    /light\.inverse: luminance 0\.0406 is not a near-black rail/,
  );
  assert.throws(
    () => checkOwnHover(mutate((t) => (t.semantic.theme.dark['action-hover'].$value = '{color.cobalt.500}'))),
    /dark\.action-hover: \{color\.cobalt\.500\} is not this theme's own primitive/,
  );
  const withoutRow = structuredClone(register);
  withoutRow.pairs = withoutRow.pairs.filter((r) => r.id !== 'theme.black/action/page');
  assert.throws(() => checkActionRows(withoutRow), /theme\.black\/action\/page: the action fill must be a gated row/);
  const repointed = structuredClone(register);
  repointed.pairs.find((r) => r.id === 'theme.dark/action/surface').bg = 'semantic.theme.dark.elevated';
  assert.throws(() => checkActionRows(repointed), /theme\.dark\/action\/surface: must measure against surface/);
  const loosened = structuredClone(register);
  loosened.pairs.find((r) => r.id === 'theme.light/action/surface').min = 2;
  assert.throws(() => checkActionRows(loosened), /theme\.light\/action\/surface: must be normative at 3:1 or more/);
  assert.throws(
    () => checkRadius(mutate((t) => (t.radius.lg.$value = '24px'))),
    /radius: lg must be smaller than xl/,
  );
  assert.throws(
    () => checkRadius(mutate((t) => (t.radius.md.$value = '8px'))),
    /radius\.md: 8px, decided 10px/,
  );
});

test('a two-stop primitive outside the themes is caught in the source and in what the build emits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'givre-nuit-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'token-grammar-exceptions.json'), join(dir, 'token-grammar-exceptions.json'));
    const source = mutate((t) => (t.color['brand-grad'] = BRAND_GRAD));
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(source));
    const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env: {} });
    assert.equal(run.status, 0, `the sandbox build must succeed, or this case proves nothing:\n${run.stderr}`);
    const builtCss = readFileSync(join(dir, 'dist/tokens.css'), 'utf8');
    assert.match(builtCss, /#2B4BDB 0%,#5B33C9 100%/, 'the sandbox build emits the two-stop gradient');
    assert.throws(() => checkNoGradient(source), /color\.brand-grad: a gradient with 2 distinct colours/);
    assert.throws(
      () => checkEmittedFlat(builtCss, readFileSync(join(dir, 'dist/tailwind.preset.js'), 'utf8')),
      /dist: tokens\.css --[\w-]*brand-grad is a linear-gradient with 2 distinct colours/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
