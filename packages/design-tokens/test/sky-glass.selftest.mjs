// "Ethereal Sky Glass": the `ciel` family (docs/specs/ethereal-sky-glass.md).
//
// The family ships as a FOUNDATION: its role values are initial, not decided,
// so nothing here pins a hex. What is held instead is the shape a later palette
// has to keep, read from the source:
//
//   a twin in each mode  `ciel` is the family's light theme and `ciel-nuit` its
//                        dark one, each the counterpart of a Givre theme
//   the same roles       every role, level and type the default theme declares
//   its own values       a role resolves through its own theme's primitives or
//                        a shared ramp, never through another theme's
//   the same bar         every contrast row its Givre twin is held to, at the
//                        same minimum, and no exemption
//
// Each clause has a mutation below that asserts its own message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, indexTokens, resolve, aliasTarget } from '../scripts/lib/tokens.mjs';
import { THEMES, DEFAULT_THEME, themesOfFamily, themeInfo, themeSelector } from '../scripts/lib/themes.mjs';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const register = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');

/** Each theme of the family, and the Givre theme it is the counterpart of. */
const TWIN = { ciel: 'light', 'ciel-nuit': 'dark' };
const CIEL = Object.keys(TWIN);

const own = (node) => Object.keys(node ?? {}).filter((key) => !key.startsWith('$'));
const mutate = (source, edit) => {
  const copy = structuredClone(source);
  edit(copy);
  return copy;
};

function checkFamily() {
  assert.deepEqual(themesOfFamily('ciel'), CIEL, 'the ciel family is ciel and ciel-nuit');
  assert.equal(themeInfo('ciel').mode, 'light', 'ciel is the light theme of its family');
  assert.equal(themeInfo('ciel-nuit').mode, 'dark', 'ciel-nuit is the dark theme of its family');
  for (const theme of CIEL) {
    assert.equal(themeInfo(theme).mode, themeInfo(TWIN[theme]).mode, `${theme}: the same mode as its Givre twin ${TWIN[theme]}`);
    assert.equal(themeInfo(theme).default, false, `${theme}: not the default until its gates say so`);
  }
  assert.equal(DEFAULT_THEME, 'light', 'the default theme is still Givre light');
  assert.deepEqual(themesOfFamily('givre'), ['light', 'dark', 'black'], 'the givre family stays selectable, complete');
}

function checkRoles(source) {
  const index = indexTokens(source);
  const roles = own(source.semantic.theme[DEFAULT_THEME]);
  const levels = own(source.semantic.elevation[DEFAULT_THEME]);
  for (const theme of CIEL) {
    assert.deepEqual(own(source.semantic.theme[theme]), roles, `${theme}: the role set of the default theme, in its order`);
    assert.deepEqual(own(source.semantic.elevation[theme]), levels, `${theme}: the elevation levels of the default theme`);
    /** No step of an alias chain may be another theme's primitive. */
    const assertOwn = (path) => {
      // Followed all the way down: a role that reaches another theme's value
      // through an alias is that theme's value under a second name.
      for (let cursor = path; cursor !== null; cursor = aliasTarget(index.get(cursor).value)) {
        const foreign = THEMES.find((other) => other !== theme && new RegExp(`^(color|shadow)\\.theme-${other}\\.`).test(cursor));
        assert.equal(foreign, undefined, `${path}: resolves through ${cursor}, a primitive of the ${foreign} theme`);
      }
    };
    for (const role of roles) {
      const path = `semantic.theme.${theme}.${role}`;
      assert.equal(index.get(path).type, index.get(`semantic.theme.${DEFAULT_THEME}.${role}`).type, `${path}: the type the default theme gives this role`);
      assertOwn(path);
    }
    for (const level of levels) {
      const path = `semantic.elevation.${theme}.${level}`;
      assertOwn(path);
      // A shadow is drawn in a colour, and that colour is a reference too.
      const ink = aliasTarget(resolve(path, index).color);
      assert.ok(ink?.startsWith(`color.theme-${theme}.`), `${path}: drawn in ${ink ?? 'a literal'}, not in a shadow colour of its own theme`);
    }
  }
}

function themeBlock(styles, theme) {
  const opened = styles.split(`\n${themeSelector(theme)} {\n`);
  assert.equal(opened.length, 2, `${theme}: exactly one CSS block`);
  return opened[1].split('\n}')[0];
}

function checkCss(source, styles) {
  const index = indexTokens(source);
  for (const theme of CIEL) {
    const block = themeBlock(styles, theme);
    for (const role of own(source.semantic.theme[theme])) {
      const path = `semantic.theme.${theme}.${role}`;
      if (index.get(path).type !== 'color') continue;
      assert.ok(block.includes(`  --c-${role}: ${resolve(path, index)};`), `${theme}: --c-${role} carries the value tokens.json resolves to`);
    }
  }
}

/** A Givre row's ciel counterpart: the same id with the theme swapped. */
const twinId = (id, theme) => id.replace(`theme.${TWIN[theme]}/`, `theme.${theme}/`);
/** The legacy page-gradient stops of the Givre themes: literals ciel does not paint. */
const isLegacyStop = (row) => /\/ink-3\/#[0-9A-F]{6}$/.test(row.id);

function checkBar(contrast) {
  for (const theme of CIEL) {
    const givre = contrast.pairs.filter((row) => row.id.startsWith(`theme.${TWIN[theme]}/`) && !isLegacyStop(row));
    assert.ok(givre.length > 100, `${TWIN[theme]}: too few rows to hold a twin to, so this check would pass vacuously`);
    for (const row of givre) {
      const id = twinId(row.id, theme);
      const twin = contrast.pairs.find((candidate) => candidate.id === id);
      assert.ok(twin, `${id}: ${theme} must be held to the row ${row.id} holds ${TWIN[theme]} to`);
      assert.equal(twin.min, row.min, `${id}: the minimum of ${row.id}`);
      assert.equal(twin.fg, row.fg.replaceAll(`.${TWIN[theme]}.`, `.${theme}.`), `${id}: measures the same foreground role`);
      assert.equal(twin.bg, row.bg.replaceAll(`.${TWIN[theme]}.`, `.${theme}.`), `${id}: measures the same background role`);
    }
    for (const row of contrast.pairs.filter((candidate) => candidate.id.startsWith(`theme.${theme}/`))) {
      assert.ok([3, 4.5].includes(row.min), `${row.id}: a minimum of 3 or 4.5`);
      assert.equal(row.exempt, undefined, `${row.id}: no exemption in a family that is not decided yet`);
      assert.equal(row.expect, undefined, `${row.id}: no inverted acceptance`);
    }
    const index = indexTokens(tree);
    for (const role of own(tree.semantic.theme[theme])) {
      const path = `semantic.theme.${theme}.${role}`;
      if (index.get(path).type !== 'color') continue;
      assert.ok(
        [...contrast.pairs, ...contrast.measurements].some((row) => row.fg === path || row.bg === path),
        `${path}: a colour with no contrast row`,
      );
    }
  }
}

test('ciel is a family of two themes, light and dark, beside a complete givre', () => checkFamily());
test('each ciel theme declares the roles of the default theme, through its own values', () => checkRoles(tree));
test('each ciel theme has its own CSS block, carrying what tokens.json resolves to', () => checkCss(tree, css));
test('each ciel theme is held to every contrast row of its Givre twin', () => checkBar(register));

test('every clause fails on its own mutation', () => {
  assert.throws(
    () => checkRoles(mutate(tree, (t) => delete t.semantic.theme['ciel-nuit'].ink)),
    /ciel-nuit: the role set of the default theme, in its order/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => delete t.semantic.elevation.ciel.dialog)),
    /ciel: the elevation levels of the default theme/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => (t.semantic.theme.ciel.ink.$value = '{color.theme-light.ink}'))),
    /semantic\.theme\.ciel\.ink: resolves through color\.theme-light\.ink, a primitive of the light theme/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => (t.color['theme-ciel-nuit'].surface.$value = '{color.theme-dark.surface}'))),
    /semantic\.theme\.ciel-nuit\.surface: resolves through color\.theme-dark\.surface, a primitive of the dark theme/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => (t.semantic.elevation.ciel.raised.$value = '{shadow.theme-light.raised}'))),
    /semantic\.elevation\.ciel\.raised: resolves through shadow\.theme-light\.raised, a primitive of the light theme/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => (t.shadow['theme-ciel-nuit'].dialog.$value.color = '{color.theme-dark.shadow-2}'))),
    /semantic\.elevation\.ciel-nuit\.dialog: drawn in color\.theme-dark\.shadow-2, not in a shadow colour of its own theme/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => (t.semantic.theme.ciel.ink.$type = 'dimension'))),
    /semantic\.theme\.ciel\.ink: the type the default theme gives this role/,
  );

  assert.throws(() => checkCss(tree, css.replace('[data-theme="ciel-nuit"] {', '[data-theme="ciel-night"] {')), /ciel-nuit: exactly one CSS block/);
  const page = resolve('semantic.theme.ciel.page', indexTokens(tree));
  assert.throws(
    () => checkCss(tree, css.replace(`[data-theme="ciel"] {\n  --c-page: ${page};`, '[data-theme="ciel"] {\n  --c-page: #FFFFFF;')),
    /ciel: --c-page carries the value tokens\.json resolves to/,
  );

  const without = (id) => mutate(register, (r) => (r.pairs = r.pairs.filter((row) => row.id !== id)));
  assert.throws(
    () => checkBar(without('theme.ciel/ink-3/page')),
    /theme\.ciel\/ink-3\/page: ciel must be held to the row theme\.light\/ink-3\/page holds light to/,
  );
  assert.throws(
    () => checkBar(without('theme.ciel-nuit/focus-ring/surface')),
    /theme\.ciel-nuit\/focus-ring\/surface: ciel-nuit must be held to the row theme\.dark\/focus-ring\/surface holds dark to/,
  );
  const row = (r, id) => r.pairs.find((candidate) => candidate.id === id);
  assert.throws(
    () => checkBar(mutate(register, (r) => (row(r, 'theme.ciel/ink-2/surface').min = 3))),
    /theme\.ciel\/ink-2\/surface: the minimum of theme\.light\/ink-2\/surface/,
  );
  assert.throws(
    () => checkBar(mutate(register, (r) => (row(r, 'theme.ciel-nuit/ink/page').bg = 'semantic.theme.ciel-nuit.elevated'))),
    /theme\.ciel-nuit\/ink\/page: measures the same background role/,
  );
  assert.throws(
    () => checkBar(mutate(register, (r) => (row(r, 'theme.ciel/action/page').fg = 'semantic.theme.light.action'))),
    /theme\.ciel\/action\/page: measures the same foreground role/,
  );
  assert.throws(
    () => checkBar(mutate(register, (r) => (row(r, 'theme.ciel/ink/page').exempt = true))),
    /theme\.ciel\/ink\/page: no exemption in a family that is not decided yet/,
  );
  assert.throws(
    () =>
      checkBar(
        mutate(register, (r) => {
          const uses = (candidate) => [candidate.fg, candidate.bg].includes('semantic.theme.ciel.rail-line');
          r.pairs = r.pairs.filter((candidate) => !uses(candidate));
          r.measurements = r.measurements.filter((candidate) => !uses(candidate));
        }),
      ),
    /semantic\.theme\.ciel\.rail-line: a colour with no contrast row/,
  );

  checkRoles(tree);
  checkCss(tree, css);
  checkBar(register);
});
