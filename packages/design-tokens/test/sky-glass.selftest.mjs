// "Ethereal Sky Glass": the `ciel` family (docs/specs/ethereal-sky-glass.md).
//
// The family ships as a FOUNDATION: its role values are initial, not decided,
// so nothing here pins a hex. What is held instead is the shape a later palette
// has to keep, read from the source:
//
//   a twin in each mode  `ciel` is the family's light theme and `ciel-nuit` its
//                        dark one, each the counterpart of a Givre theme
//   the same roles       every role, level and type its Givre twin declares
//   its own values       a role resolves through its own theme's primitives or
//                        a shared ramp, never through another theme's
//   the same bar         every contrast row its Givre twin is held to, at the
//                        same minimum, and no exemption
//   materials            four levels in every theme; opaque in the flat family;
//                        emitted so that the opaque fallback is the default and
//                        the glass is switched on only where it can be drawn
//                        and the reader has not asked for less; every level
//                        held to the same rows, over a set that contains the
//                        canvas it is declared over
//   a sky                a gradient under the controlled grammar: a zenith, the
//                        page and a horizon, each a named colour of the theme,
//                        each a backdrop extreme, with text held to its minimum
//                        straight on it
//
// Each clause has a mutation below that asserts its own message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, indexTokens, resolve, aliasTarget, parseColor, composite, toHex } from '../scripts/lib/tokens.mjs';
import { THEMES, DEFAULT_THEME, themesOfFamily, themeInfo, themeSelector } from '../scripts/lib/themes.mjs';
import { MATERIAL_LEVELS } from '../scripts/lib/material.mjs';
import preset from '../dist/tailwind.preset.js';

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
  }
  // Promoted by owner decision B2 once both gates stood: WCAG AA over the
  // worst-case backdrop (this package) and the frame-rate guard (the console's
  // end-to-end suite, at most three blurred surfaces on screen).
  assert.equal(DEFAULT_THEME, 'ciel', 'the default theme is Ciel light');
  assert.equal(themeInfo('ciel-nuit').default, false, 'ciel-nuit is the dark side of the default family, not a second default');
  assert.deepEqual(themesOfFamily('givre'), ['light', 'dark', 'black'], 'the givre family stays selectable, complete');
}

function checkRoles(source) {
  const index = indexTokens(source);
  // Held to the Givre twin, not to the default theme: since B2 the default is
  // a ciel theme, and a family measured against itself would prove nothing.
  for (const theme of CIEL) {
    const twin = TWIN[theme];
    const roles = own(source.semantic.theme[twin]);
    const levels = own(source.semantic.elevation[twin]);
    assert.deepEqual(own(source.semantic.theme[theme]), roles, `${theme}: the role set of its Givre twin, in its order`);
    assert.deepEqual(own(source.semantic.elevation[theme]), levels, `${theme}: the elevation levels of its Givre twin`);
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
      assert.equal(index.get(path).type, index.get(`semantic.theme.${twin}.${role}`).type, `${path}: the type its Givre twin gives this role`);
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

// --- Materials -----------------------------------------------------------------

/** The levels, restated: a fifth level, or a renamed one, has to be changed here too. */
const LEVELS = ['bar', 'panel', 'popover', 'dialog'];
const PARTS = ['tint', 'fallback', 'blur', 'saturate', 'border', 'shadow', 'bg', 'backdrop'];
const OPAQUE_WHEN = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'];
const SUPPORTS = '@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {';

/** A material as the source declares it, read here without scripts/lib/material.mjs. */
function declared(source, theme, level) {
  const index = indexTokens(source);
  const value = source.material[`theme-${theme}`][level].$value;
  const color = (field) => parseColor(resolve(aliasTarget(value[field]), index));
  return { ...value, tintColor: color('tint'), canvasColor: color('canvas') };
}

function checkMaterialSource(source) {
  assert.deepEqual([...MATERIAL_LEVELS], LEVELS, 'the material levels are bar, panel, popover, dialog');
  for (const theme of THEMES) {
    assert.deepEqual(own(source.semantic.material[theme]), LEVELS, `${theme}: the four material levels, lowest first`);
    for (const level of LEVELS) {
      assert.equal(
        source.semantic.material[theme][level].$value,
        `{material.theme-${theme}.${level}}`,
        `semantic.material.${theme}.${level}: the name of its own theme's level`,
      );
      const material = declared(source, theme, level);
      assert.equal(material.canvas, `{color.theme-${theme}.page}`, `${theme}.${level}: declared over its own theme's page`);
      if (themeInfo(theme).family === 'givre') {
        assert.deepEqual(
          [material.alpha, material.blur, material.saturation],
          [1, '0px', 1],
          `${theme}.${level}: a flat family's material is opaque, unblurred and unsaturated`,
        );
      }
    }
    // Each level at least as opaque as the one below it: what sits higher carries more.
    for (let i = 1; i < LEVELS.length; i += 1) {
      assert.ok(
        declared(source, theme, LEVELS[i]).alpha >= declared(source, theme, LEVELS[i - 1]).alpha,
        `${theme}: ${LEVELS[i]} must be at least as opaque as ${LEVELS[i - 1]}`,
      );
    }
  }
  for (const theme of themesOfFamily('ciel')) {
    assert.ok(
      LEVELS.some((level) => declared(source, theme, level).alpha < 1),
      `${theme}: a glass family with no translucent level is a flat family under another name`,
    );
  }
}

/** The body of the one top-level at-rule that opens with `opener`. */
function atRule(styles, opener) {
  const parts = styles.split(`\n${opener}\n`);
  assert.equal(parts.length, 2, `tokens.css: exactly one \`${opener}\` block`);
  return { body: parts[1].split('\n}\n')[0], at: parts[0].length };
}

function checkMaterialCss(source, styles) {
  const glassSelector = `:is(${themesOfFamily('ciel').map(themeSelector).join(', ')})`;

  for (const theme of THEMES) {
    const block = themeBlock(styles, theme);
    for (const level of LEVELS) {
      for (const part of PARTS) {
        assert.equal(
          (block.match(new RegExp(`^  --material-${level}-${part}: `, 'gm')) ?? []).length,
          1,
          `${theme}: --material-${level}-${part} declared once in the theme block`,
        );
      }
      // The default, in every theme, is the surface that always reads.
      assert.ok(
        block.includes(`  --material-${level}-bg: var(--material-${level}-fallback);`),
        `${theme}: --material-${level}-bg defaults to the opaque fallback`,
      );
      assert.ok(block.includes(`  --material-${level}-backdrop: none;`), `${theme}: --material-${level}-backdrop defaults to none`);

      const material = declared(source, theme, level);
      const fallback = toHex(composite({ ...material.tintColor, a: material.alpha }, material.canvasColor));
      assert.ok(
        block.includes(`  --material-${level}-fallback: ${fallback};`),
        `${theme}: --material-${level}-fallback is the tint at its alpha over the canvas (${fallback})`,
      );
      if (material.alpha === 1) {
        assert.ok(block.includes(`  --material-${level}-tint: ${fallback};`), `${theme}: an opaque material's tint is its fallback`);
      } else {
        const { r, g, b } = material.tintColor;
        assert.ok(
          block.includes(`  --material-${level}-tint: rgba(${r}, ${g}, ${b}, ${material.alpha});`),
          `${theme}: --material-${level}-tint carries the material's alpha`,
        );
      }
      assert.ok(block.includes(`  --material-${level}-blur: ${material.blur};`), `${theme}: --material-${level}-blur`);
      assert.ok(block.includes(`  --material-${level}-saturate: ${material.saturation};`), `${theme}: --material-${level}-saturate`);
    }
  }

  // The glass is switched on in one place: under @supports, for the glass family only.
  const supports = atRule(styles, SUPPORTS);
  assert.ok(supports.body.startsWith(`  ${glassSelector} {\n`), `the glass is enabled for ${glassSelector} and no other selector`);
  assert.equal((supports.body.match(/\{$/gm) ?? []).length, 1, 'the @supports block holds one rule');
  for (const level of LEVELS) {
    assert.ok(supports.body.includes(`    --material-${level}-bg: var(--material-${level}-tint);`), `@supports: ${level} paints its tint`);
    assert.ok(
      supports.body.includes(`    --material-${level}-backdrop: blur(var(--material-${level}-blur)) saturate(var(--material-${level}-saturate));`),
      `@supports: ${level} filters its backdrop, blur first`,
    );
  }
  const enabled = [...styles.matchAll(/--material-[a-z]+-bg: var\(--material-[a-z]+-tint\);/g)];
  assert.equal(enabled.length, LEVELS.length, 'the tint is switched on under @supports and nowhere else');
  assert.equal((styles.match(/-backdrop: blur\(/g) ?? []).length, LEVELS.length, 'a backdrop filter is switched on under @supports and nowhere else');

  // ...and off again, AFTER it, for each reader preference and platform mode.
  for (const query of OPAQUE_WHEN) {
    const media = atRule(styles, `@media ${query} {`);
    assert.ok(media.at > supports.at, `@media ${query} must come after @supports, or the glass wins the cascade`);
    assert.ok(media.body.startsWith(`  ${glassSelector} {\n`), `@media ${query}: resets ${glassSelector}`);
    for (const level of LEVELS) {
      assert.ok(media.body.includes(`    --material-${level}-bg: var(--material-${level}-fallback);`), `@media ${query}: ${level} is its opaque fallback`);
      assert.ok(media.body.includes(`    --material-${level}-backdrop: none;`), `@media ${query}: ${level} filters nothing`);
    }
  }

  // The classes paint with the switching properties and hold no value of their own.
  for (const level of LEVELS) {
    const rule = styles.split(`\n.material-${level} {\n`);
    assert.equal(rule.length, 2, `.material-${level}: exactly one rule`);
    const declarations = rule[1].split('\n}')[0].split('\n').map((line) => line.trim());
    assert.deepEqual(
      declarations,
      [
        `background-color: var(--material-${level}-bg);`,
        `-webkit-backdrop-filter: var(--material-${level}-backdrop);`,
        `backdrop-filter: var(--material-${level}-backdrop);`,
        `border: 1px solid var(--material-${level}-border);`,
        `box-shadow: var(--material-${level}-shadow);`,
      ],
      `.material-${level}: paints with the switching properties only`,
    );
  }
}

function checkMaterialPreset(config) {
  const { colors, boxShadow } = config.theme.extend;
  for (const level of LEVELS) {
    assert.equal(colors[`material-${level}`], `var(--material-${level}-bg)`, `preset: material-${level} follows the switch, never one theme's tint`);
    assert.equal(colors[`material-${level}-border`], `var(--material-${level}-border)`, `preset: material-${level}-border`);
    assert.equal(boxShadow[`material-${level}`], `var(--material-${level}-shadow)`, `preset: shadow material-${level}`);
  }
}

/** What every level is held to: the role, its minimum. */
const HELD = [
  ['ink', 'semantic.theme.%.ink', 4.5],
  ['ink-2', 'semantic.theme.%.ink-2', 4.5],
  ['ink-3', 'semantic.theme.%.ink-3', 4.5],
  ['accent-ink', 'semantic.theme.%.accent-ink', 4.5],
  ['icon-ink-4', 'semantic.theme.%.ink-4', 3],
  ['border-input', 'semantic.theme.%.border-input', 3],
  ['focus-ring', 'spec:focus-ring.%.indicator', 3],
];

/** The row ids the material tier owns: `material.<theme>.<level>/<what>`. */
const MATERIAL_ROW = /^material\.([a-z0-9-]+)\.([a-z]+)\/(.+)$/;

function checkMaterialRows(source, contrast) {
  const sets = contrast.backdropSets ?? {};

  // Every row in the `material.` namespace, not a list someone keeps: a row
  // added later — a new stack, a new role — is held to the same bar the day it
  // is added, and cannot arrive exempt, inverted, loosened or measured on
  // something that is not the material its id names.
  const owned = contrast.pairs.filter((row) => row.id.startsWith('material.'));
  assert.ok(owned.length >= THEMES.length * LEVELS.length * HELD.length, `only ${owned.length} material rows were read, so this sweep would pass vacuously`);
  for (const row of owned) {
    const [, theme, level] = MATERIAL_ROW.exec(row.id) ?? [];
    assert.ok(THEMES.includes(theme) && LEVELS.includes(level), `${row.id}: a material row is named material.<theme>.<level>/<what>`);
    assert.ok([3, 4.5].includes(row.min), `${row.id}: a minimum of 3 or 4.5, not ${row.min}`);
    assert.equal(row.exempt, undefined, `${row.id}: no exemption on a material`);
    assert.equal(row.expect, undefined, `${row.id}: no inverted acceptance on a material`);
    assert.equal(row.bg, `semantic.material.${theme}.${level}`, `${row.id}: measured on the material its id names, by the name a consumer uses`);
    if (declared(source, theme, level).alpha < 1) {
      assert.equal(row.backdropSet, theme, `${row.id}: a translucent material is measured over its own theme's set`);
      assert.equal(sets[theme]?.theme, theme, `${row.id}: backdropSets.${theme} holds the extremes of its own theme`);
    } else {
      assert.equal(row.backdropSet, undefined, `${row.id}: an opaque material binds no set`);
      assert.equal(row.layers, undefined, `${row.id}: nothing shows through an opaque material`);
    }
  }
  assert.equal(
    contrast.measurements.filter((row) => row.id.startsWith('material.')).length,
    0,
    'a material is never a non-normative measurement: every material row is held to a minimum',
  );

  // Completeness: the rows every level must have. The sweep above holds them.
  for (const theme of THEMES) {
    const glass = themeInfo(theme).family === 'ciel';
    if (glass) {
      const set = sets[theme];
      assert.ok(set, `backdropSets.${theme}: a glass theme declares what can lie behind its materials`);
      assert.equal(set.theme, theme, `backdropSets.${theme}: bound to its own theme`);
      assert.ok(
        set.members.includes(`semantic.theme.${theme}.page`),
        `backdropSets.${theme}: holds the page every material of the theme is declared over`,
      );
    }
    for (const level of LEVELS) {
      for (const [name, fg, min] of HELD) {
        const id = `material.${theme}.${level}/${name}`;
        const row = contrast.pairs.find((candidate) => candidate.id === id);
        assert.ok(row, `${id}: every material level is held to this row`);
        assert.equal(row.fg, fg.replaceAll('%', theme), `${id}: measures its own theme's ${name}`);
        assert.equal(row.min, min, `${id}: a minimum of ${min}`);
        assert.equal(row.layers, undefined, `${id}: the level itself, with nothing stacked under it`);
      }
    }
  }
}

// --- The sky ---------------------------------------------------------------------

/** The stops of a theme's page gradient, as the source writes them. */
const skyStops = (source, theme) => source.color[`theme-${theme}`]['page-grad'].$value;
const ON_THE_SKY = [
  ['ink', 'semantic.theme.%.ink', 4.5],
  ['ink-2', 'semantic.theme.%.ink-2', 4.5],
  ['ink-3', 'semantic.theme.%.ink-3', 4.5],
  ['accent-ink', 'semantic.theme.%.accent-ink', 4.5],
  ['focus-ring', 'spec:focus-ring.%.indicator', 3],
];

function checkSky(source, contrast, styles) {
  const index = indexTokens(source);
  for (const theme of CIEL) {
    const stops = skyStops(source, theme);
    const refs = stops.map((stop) => aliasTarget(stop.color));
    assert.ok(stops.length >= 2 && stops.length <= 4, `${theme}.page-grad: between two and four stops, not ${stops.length}`);
    refs.forEach((ref, i) => {
      assert.ok(ref?.startsWith(`color.theme-${theme}.`), `${theme}.page-grad: stop ${i} is ${JSON.stringify(stops[i].color)}, not a named colour of its own theme`);
    });
    assert.equal(refs[0], `color.theme-${theme}.sky-zenith`, `${theme}.page-grad: starts at the zenith`);
    assert.equal(refs.at(-1), `color.theme-${theme}.sky-horizon`, `${theme}.page-grad: ends at the horizon`);
    assert.ok(refs.includes(`color.theme-${theme}.page`), `${theme}.page-grad: passes through the flat page colour, so a client that paints --c-page alone is on the sky`);
    assert.equal(source.semantic.theme[theme]['page-grad'].$value, `{color.theme-${theme}.page-grad}`, `${theme}: the page-grad role names its own theme's sky`);

    const members = contrast.backdropSets?.[theme]?.members ?? [];
    for (const ref of refs) {
      const role = ref.replace(`color.theme-${theme}.`, `semantic.theme.${theme}.`);
      assert.ok(members.includes(ref) || members.includes(role), `backdropSets.${theme}: the sky stop ${ref} is not one of its extremes`);
    }

    for (const [name, fg, min] of ON_THE_SKY) {
      const id = `theme.${theme}/${name}/page-grad`;
      const row = contrast.pairs.find((candidate) => candidate.id === id);
      assert.ok(row, `${id}: text straight on the sky is held to this row`);
      assert.equal(row.fg, fg.replaceAll('%', theme), `${id}: measures its own theme's ${name}`);
      assert.equal(row.bg, `semantic.theme.${theme}.page-grad`, `${id}: measured on the gradient, so over every stop`);
      assert.equal(row.min, min, `${id}: a minimum of ${min}`);
      assert.equal(row.exempt ?? row.expect, undefined, `${id}: no exemption and no inverted acceptance`);
    }

    const painted = stops.map((stop, i) => `${resolve(refs[i], index)} ${Number((stop.position * 100).toFixed(4))}%`).join(',');
    const angle = source.color[`theme-${theme}`]['page-grad'].$extensions['io.kodera.css-gradient'].angle;
    assert.ok(
      themeBlock(styles, theme).includes(`  --c-page-grad: linear-gradient(${angle},${painted});`),
      `${theme}: --c-page-grad is the sky tokens.json declares`,
    );
  }
}

/** A sandbox build of a mutated source; hands back the finished process. */
function build(source) {
  const dir = mkdtempSync(join(tmpdir(), 'sky-glass-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(source));
    return spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ciel is a family of two themes, light and dark, beside a complete givre', () => checkFamily());
test('each ciel theme declares the roles of its Givre twin, through its own values', () => checkRoles(tree));
test('each ciel theme has its own CSS block, carrying what tokens.json resolves to', () => checkCss(tree, css));
test('each ciel theme is held to every contrast row of its Givre twin', () => checkBar(register));

test('every theme declares the four materials, opaque in the flat family', () => checkMaterialSource(tree));
test('the stylesheet defaults every material to its opaque fallback and switches the glass on last', () => checkMaterialCss(tree, css));
test('the preset addresses a material through the switching properties', () => checkMaterialPreset(preset));
test('every material level is held to the same rows, a translucent one over its own theme\'s set', () => checkMaterialRows(tree, register));

test('every material clause fails on its own mutation', () => {
  const bar = (t, theme) => t.material[`theme-${theme}`].bar.$value;
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => delete t.semantic.material.black.dialog)),
    /black: the four material levels, lowest first/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => (t.semantic.material.ciel.bar.$value = '{material.theme-ciel.panel}'))),
    /semantic\.material\.ciel\.bar: the name of its own theme's level/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => (bar(t, 'dark').alpha = 0.8))),
    /dark\.bar: a flat family's material is opaque, unblurred and unsaturated/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => (bar(t, 'light').blur = '12px'))),
    /light\.bar: a flat family's material is opaque, unblurred and unsaturated/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => (bar(t, 'ciel').canvas = '{color.theme-ciel.surface}'))),
    /ciel\.bar: declared over its own theme's page/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => (bar(t, 'ciel-nuit').alpha = 0.99))),
    /ciel-nuit: panel must be at least as opaque as bar/,
  );
  assert.throws(
    () => checkMaterialSource(mutate(tree, (t) => LEVELS.forEach((level) => (t.material['theme-ciel'][level].$value.alpha = 1)))),
    /ciel: a glass family with no translucent level is a flat family under another name/,
  );

  // The stylesheet. Each mutation is one way the opaque default stops being the default.
  const ciel = '[data-theme="ciel"] {';
  assert.throws(
    () => checkMaterialCss(tree, css.replace('  --material-bar-bg: var(--material-bar-fallback);\n  --material-bar-backdrop: none;\n  --material-panel-tint: rgba(255', '  --material-bar-bg: var(--material-bar-tint);\n  --material-bar-backdrop: none;\n  --material-panel-tint: rgba(255')),
    /ciel: --material-bar-bg defaults to the opaque fallback/,
  );
  assert.throws(
    () => checkMaterialCss(tree, css.replace(SUPPORTS, '@media all {')),
    /exactly one `@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\) \{` block/,
  );
  assert.throws(
    () => {
      const glass = `:is(${themesOfFamily('ciel').map(themeSelector).join(', ')}) {\n    --material-bar-bg: var(--material-bar-tint);`;
      assert.ok(css.includes(glass), 'the glass block was not found, so this mutation would prove nothing');
      return checkMaterialCss(tree, css.replace(glass, glass.replace(':is(', ':is([data-theme="dark"], ')));
    },
    /the glass is enabled for :is\(.*\[data-theme="ciel"\], \[data-theme="ciel-nuit"\]\) and no other selector/,
  );
  for (const query of OPAQUE_WHEN) {
    assert.throws(
      () => checkMaterialCss(tree, css.replace(`@media ${query} {`, '@media (min-width: 1px) {')),
      new RegExp(`exactly one \`@media ${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\` block`),
    );
  }
  // The same rules in the other order: the reader's preference loses the cascade.
  const [before, glassOn] = css.split(`\n${SUPPORTS}\n`);
  const supportsBlock = `${SUPPORTS}\n${glassOn.split('\n}\n')[0]}\n}\n`;
  const reordered = `${before}\n${glassOn.slice(glassOn.indexOf('\n}\n') + 3).replace('\n.material-bar {', `\n${supportsBlock}\n.material-bar {`)}`;
  assert.throws(() => checkMaterialCss(tree, reordered), /must come after @supports, or the glass wins the cascade/);
  assert.throws(
    () => checkMaterialCss(tree, css.replace('.material-bar {\n  background-color: var(--material-bar-bg);', '.material-bar {\n  background-color: rgba(255, 255, 255, 0.92);')),
    /\.material-bar: paints with the switching properties only/,
  );
  assert.throws(
    () => checkMaterialCss(tree, `${css}\n.glass { --material-bar-bg: var(--material-bar-tint); }\n`),
    /the tint is switched on under @supports and nowhere else/,
  );
  assert.throws(
    () => checkMaterialCss(tree, css.replace(`${ciel}`, `${ciel}\n  --material-bar-fallback: #000000;`)),
    /ciel: --material-bar-fallback declared once in the theme block/,
  );
  const fallback = /(\[data-theme="ciel"\] \{[^}]*?  --material-bar-fallback: )#[0-9A-F]{6};/;
  assert.match(css, fallback, 'the ciel bar fallback was not found, so the next mutation would prove nothing');
  assert.throws(
    () => checkMaterialCss(tree, css.replace(fallback, '$1#EEF5FC;')),
    /ciel: --material-bar-fallback is the tint at its alpha over the canvas/,
  );

  const frozen = structuredClone(preset);
  frozen.theme.extend.colors['material-bar'] = 'rgba(255, 255, 255, 0.92)';
  assert.throws(() => checkMaterialPreset(frozen), /preset: material-bar follows the switch, never one theme's tint/);

  // The register.
  const dropRow = (id) => mutate(register, (r) => (r.pairs = r.pairs.filter((row) => row.id !== id)));
  const editRow = (id, edit) => mutate(register, (r) => edit(r.pairs.find((row) => row.id === id)));
  assert.throws(() => checkMaterialRows(tree, dropRow('material.ciel.bar/ink-3')), /material\.ciel\.bar\/ink-3: every material level is held to this row/);
  assert.throws(() => checkMaterialRows(tree, dropRow('material.black.dialog/focus-ring')), /material\.black\.dialog\/focus-ring: every material level is held to this row/);
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel-nuit.popover/ink-2', (row) => (row.min = 3))),
    /material\.ciel-nuit\.popover\/ink-2: a minimum of 4\.5/,
  );
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel.panel/ink', (row) => delete row.backdropSet)),
    /material\.ciel\.panel\/ink: a translucent material is measured over its own theme's set/,
  );
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel.panel/ink', (row) => (row.backdropSet = ['semantic.theme.ciel.surface']))),
    /material\.ciel\.panel\/ink: a translucent material is measured over its own theme's set/,
  );
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel.dialog/ink', (row) => (row.bg = 'semantic.theme.ciel.elevated'))),
    /material\.ciel\.dialog\/ink: measured on the material its id names, by the name a consumer uses/,
  );
  // The sweep: rows OUTSIDE the required list are held to the same bar. Each
  // of these is a row nobody listed, arriving in the namespace with a way out.
  const addRow = (row) =>
    mutate(register, (r) =>
      r.pairs.push({ id: 'material.ciel.bar/placeholder', fg: 'semantic.theme.ciel.placeholder', bg: 'semantic.material.ciel.bar', label: 'scratch', min: 4.5, backdropSet: 'ciel', ...row }),
    );
  assert.doesNotThrow(() => checkMaterialRows(tree, addRow({})), 'a well-formed extra row is accepted, so the refusals below are about what they change');
  assert.throws(() => checkMaterialRows(tree, addRow({ exempt: true })), /material\.ciel\.bar\/placeholder: no exemption on a material/);
  assert.throws(() => checkMaterialRows(tree, addRow({ expect: 'fail' })), /material\.ciel\.bar\/placeholder: no inverted acceptance on a material/);
  assert.throws(() => checkMaterialRows(tree, addRow({ min: 1.5 })), /material\.ciel\.bar\/placeholder: a minimum of 3 or 4\.5, not 1\.5/);
  assert.throws(
    () => checkMaterialRows(tree, addRow({ bg: 'semantic.theme.ciel.surface', backdropSet: undefined })),
    /material\.ciel\.bar\/placeholder: measured on the material its id names/,
  );
  assert.throws(
    () => checkMaterialRows(tree, addRow({ bg: 'semantic.material.ciel.dialog' })),
    /material\.ciel\.bar\/placeholder: measured on the material its id names/,
  );
  assert.throws(
    () => checkMaterialRows(tree, addRow({ backdropSet: 'ciel-nuit' })),
    /material\.ciel\.bar\/placeholder: a translucent material is measured over its own theme's set/,
  );
  assert.throws(
    () => checkMaterialRows(tree, addRow({ backdropSet: ['semantic.theme.ciel.surface'] })),
    /material\.ciel\.bar\/placeholder: a translucent material is measured over its own theme's set/,
  );
  assert.throws(
    () => checkMaterialRows(tree, addRow({ id: 'material.ciel.sheet/ink' })),
    /material\.ciel\.sheet\/ink: a material row is named material\.<theme>\.<level>\/<what>/,
  );
  assert.throws(
    () => checkMaterialRows(tree, addRow({ id: 'material.light.bar/placeholder', fg: 'semantic.theme.light.placeholder', bg: 'semantic.material.light.bar' })),
    /material\.light\.bar\/placeholder: an opaque material binds no set/,
  );
  // The stacked rows that ship are in the sweep too, not only the ones added here.
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel.dialog/ink+scrim', (row) => (row.exempt = true))),
    /material\.ciel\.dialog\/ink\+scrim: no exemption on a material/,
  );
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel-nuit.popover/ink-3+panel', (row) => (row.expect = 'fail'))),
    /material\.ciel-nuit\.popover\/ink-3\+panel: no inverted acceptance on a material/,
  );
  assert.throws(
    () => checkMaterialRows(tree, mutate(register, (r) => r.measurements.push({ id: 'material.ciel.bar/ink-4', fg: 'semantic.theme.ciel.ink-4', bg: 'semantic.material.ciel.bar', kind: 'capability', purpose: 'x' }))),
    /a material is never a non-normative measurement/,
  );
  assert.throws(
    () => checkMaterialRows(tree, mutate(register, (r) => (r.backdropSets.ciel.theme = 'ciel-nuit'))),
    /backdropSets\.ciel holds the extremes of its own theme/,
  );
  assert.throws(
    () => checkMaterialRows(tree, editRow('material.ciel.bar/ink', (row) => (row.layers = ['semantic.theme.ciel.scrim']))),
    /material\.ciel\.bar\/ink: the level itself, with nothing stacked under it/,
  );
  assert.throws(
    () => checkMaterialRows(tree, mutate(register, (r) => (r.backdropSets.ciel.members = r.backdropSets.ciel.members.filter((m) => !m.endsWith('.page'))))),
    /backdropSets\.ciel: holds the page every material of the theme is declared over/,
  );
  assert.throws(
    () => checkMaterialRows(tree, mutate(register, (r) => delete r.backdropSets['ciel-nuit'])),
    /material\.ciel-nuit\.bar\/ink: backdropSets\.ciel-nuit holds the extremes of its own theme/,
  );

  checkMaterialSource(tree);
  checkMaterialCss(tree, css);
  checkMaterialRows(tree, register);
});

test('each ciel theme paints a controlled sky whose stops are backdrop extremes, with text held on it', () => checkSky(tree, register, css));

test('every sky clause fails on its own mutation', () => {
  const edited = (edit) => mutate(tree, edit);
  assert.throws(
    () => checkSky(edited((t) => (skyStops(t, 'ciel')[0].color = '#E0ECFB')), register, css),
    /ciel\.page-grad: stop 0 is "#E0ECFB", not a named colour of its own theme/,
  );
  assert.throws(
    () => checkSky(edited((t) => (skyStops(t, 'ciel-nuit')[2].color = '{color.theme-dark.muted}')), register, css),
    /ciel-nuit\.page-grad: stop 2 is "\{color\.theme-dark\.muted\}", not a named colour of its own theme/,
  );
  assert.throws(
    () => checkSky(edited((t) => skyStops(t, 'ciel').reverse()), register, css),
    /ciel\.page-grad: starts at the zenith/,
  );
  assert.throws(
    () => checkSky(edited((t) => (skyStops(t, 'ciel')[1].color = '{color.theme-ciel.muted}')), register, css),
    /ciel\.page-grad: passes through the flat page colour/,
  );
  assert.throws(
    () => checkSky(edited((t) => skyStops(t, 'ciel').push({ color: '{color.theme-ciel.sky-horizon}', position: 1 }, { color: '{color.theme-ciel.sky-horizon}', position: 1 })), register, css),
    /ciel\.page-grad: between two and four stops, not 5/,
  );
  assert.throws(
    () => checkSky(edited((t) => (t.semantic.theme.ciel['page-grad'].$value = '{color.theme-ciel-nuit.page-grad}')), register, css),
    /ciel: the page-grad role names its own theme's sky/,
  );
  assert.throws(
    () => checkSky(tree, mutate(register, (r) => (r.backdropSets.ciel.members = r.backdropSets.ciel.members.filter((m) => !m.endsWith('sky-zenith')))), css),
    /backdropSets\.ciel: the sky stop color\.theme-ciel\.sky-zenith is not one of its extremes/,
  );
  assert.throws(
    () => checkSky(tree, mutate(register, (r) => (r.pairs = r.pairs.filter((row) => row.id !== 'theme.ciel-nuit/ink-3/page-grad'))), css),
    /theme\.ciel-nuit\/ink-3\/page-grad: text straight on the sky is held to this row/,
  );
  assert.throws(
    () => checkSky(tree, mutate(register, (r) => (r.pairs.find((row) => row.id === 'theme.ciel/ink/page-grad').bg = 'semantic.theme.ciel.page')), css),
    /theme\.ciel\/ink\/page-grad: measured on the gradient, so over every stop/,
  );
  assert.throws(
    () => checkSky(tree, register, css.replace(/(\[data-theme="ciel"\] \{\n(?:.*\n)*?  --c-page-grad: )linear-gradient\([^;]+\);/, '$1linear-gradient(180deg,#EEF5FC 0%,#EEF5FC 100%);')),
    /ciel: --c-page-grad is the sky tokens\.json declares/,
  );
  checkSky(tree, register, css);
});

test('the build refuses an incomplete material tier', () => {
  assert.equal(build(tree).status, 0, 'the unmutated source builds, or the refusals below prove nothing');
  const refused = (source, message) => {
    const result = build(source);
    assert.notEqual(result.status, 0, `refused: ${message}`);
    assert.match(result.stderr, message);
  };
  refused(mutate(tree, (t) => delete t.semantic.material['ciel-nuit']), /expected materials for the complete theme set: light, dark, black, ciel, ciel-nuit .*tokens\.json declares light, dark, black, ciel$/m);
  refused(mutate(tree, (t) => delete t.semantic.material.dark.popover), /dark: incomplete material level set; the levels are bar, panel, popover, dialog/);
  refused(mutate(tree, (t) => delete t.material['theme-black']), /expected material primitives for the complete theme set: /);
  refused(mutate(tree, (t) => delete t.material['theme-ciel'].bar), /material\.theme-ciel: incomplete material level set/);
  refused(mutate(tree, (t) => (t.material['theme-ciel'].bar.$value.alpha = 0)), /material: material\.theme-ciel\.bar: alpha: 0 is not a number in \(0, 1\]/);
});

test('every clause fails on its own mutation', () => {
  assert.throws(
    () => checkRoles(mutate(tree, (t) => delete t.semantic.theme['ciel-nuit'].ink)),
    /ciel-nuit: the role set of its Givre twin, in its order/,
  );
  assert.throws(
    () => checkRoles(mutate(tree, (t) => delete t.semantic.elevation.ciel.dialog)),
    /ciel: the elevation levels of its Givre twin/,
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
    /semantic\.theme\.ciel\.ink: the type its Givre twin gives this role/,
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
