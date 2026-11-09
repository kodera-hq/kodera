import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, indexTokens, resolve, parseColor, composite, contrastRatio } from '../scripts/lib/tokens.mjs';
import { SPEC, SPEC_COLORS, focusRingColorProperty } from '../scripts/lib/spec.mjs';
import preset from '../dist/tailwind.preset.js';

const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/themes.json'), 'utf8'));
const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');
const geometry = { 'rail-width': '76px', 'rail-item-width': '68px', 'header-height': '56px', 'sidebar-width': '264px', 'document-max-width': '780px', 'document-min-width': '360px', 'dock-width': '340px', 'dock-offset': '24px' };

/**
 * The preset's ring keys are references, never values.
 *
 * The CSS side of the ring is pinned by literal value in every theme block, so
 * a ring frozen there is caught. The preset side had nothing: replacing the
 * `var()` with a hex gives both ring utilities one theme's ring under every
 * `[data-theme]` attribute — the exact defect the themed ring closes — and the
 * drift gate cannot see it, because the generator and its output move together.
 * This is the `c-*` rule above applied to the ring: one key per variant, each
 * key a reference to the custom property that variant declares, and that
 * property declared in the generated CSS.
 */
function checkRingIsDynamic(styles, config) {
  const variants = Object.keys(SPEC.focusRing.variants);
  // Tailwind reads the bare `ring` class off DEFAULT; `default` is the absence
  // of a variant, not a variant named "default". Restated here rather than
  // imported, so a change to the build's naming policy has to be made twice.
  const presetKey = (variant) => (variant === 'default' ? 'DEFAULT' : variant);
  const ringColor = config.theme.extend.ringColor;
  assert.deepEqual(
    Object.keys(ringColor),
    variants.map(presetKey),
    'the preset carries one ring key per variant, and no others',
  );
  for (const variant of variants) {
    const key = presetKey(variant);
    const property = focusRingColorProperty(variant);
    assert.match(
      ringColor[key],
      /^var\(--[a-z0-9-]+\)$/,
      `ring ${key}: dynamic preset — a value here freezes one theme's ring into every theme`,
    );
    assert.equal(
      ringColor[key],
      `var(${property})`,
      `ring ${key}: dynamic preset — the reference must be ${property}, the property this variant declares`,
    );
    assert.ok(styles.includes(`  ${property}: `), `${property}: the property the preset points at is declared in CSS`);
  }
}

function checkContract(source, styles, config) {
  assert.deepEqual(Object.keys(source.semantic.theme ?? {}), ['light', 'dark', 'black'], 'complete theme set');
  const index = indexTokens(source);
  for (const [theme, expected] of Object.entries(fixture)) {
    const roles = source.semantic.theme[theme];
    assert.deepEqual(Object.keys(roles), Object.keys(expected), `${theme}: complete role set`);
    const block = styles.match(new RegExp(`\\[data-theme="${theme}"\\] \\{([^}]+)\\}`))?.[1];
    assert.ok(block, `${theme}: CSS boundary missing`);
    const declared = [...block.matchAll(/--c-([\w-]+): ([^;]+);/g)];
    assert.equal(declared.length, Object.keys(expected).length, `${theme}: CSS declaration count`);
    for (const [role, value] of Object.entries(expected)) {
      if (role === 'page-grad') {
        const stops = [...value.matchAll(/(#[A-F0-9]{6}) (\d+)%/g)].map((m) => ({ color: m[1], position: Number(m[2]) / 100 }));
        assert.equal(index.get(`semantic.theme.${theme}.${role}`).type, 'gradient');
        assert.deepEqual(resolve(`semantic.theme.${theme}.${role}`, index), stops, `${theme}: gradient stops`);
        assert.equal(source.color[`theme-${theme}`][role].$extensions['io.kodera.css-gradient'].angle, '115deg');
      } else {
        assert.equal(resolve(`semantic.theme.${theme}.${role}`, index), value, `${theme}.${role}: reference value`);
      }
      assert.equal(declared.find((m) => m[1] === role)?.[2], value, `${theme}.${role}: scoped CSS`);
      if (role !== 'page-grad') {
        assert.equal(config.theme.extend.colors[`c-${role}`], `var(--c-${role})`, `${role}: dynamic preset`);
      }
    }
  }
  assert.match(styles, /:root, \[data-theme="light"\]/, 'unthemed default is light');
  checkRingIsDynamic(styles, config);
  assert.equal(config.theme.extend.colors['c-page-grad'], undefined, 'gradients are not colors');
  assert.equal(config.theme.extend.backgroundImage['c-page-gradient'], 'var(--c-page-grad)');
  for (const [role, value] of Object.entries(geometry)) {
    assert.equal(resolve(`component.shell.${role}`, index), value, `${role}: geometry`);
    assert.ok(styles.includes(`--shell-${role}: ${value};`), `${role}: CSS geometry`);
    assert.equal(config.theme.extend.spacing[`shell-${role}`], `var(--shell-${role})`, `${role}: preset geometry`);
  }
}

test('three complete themes and shell geometry match the fixed reference', () => checkContract(tree, css, preset));

// The reference sizes a rail item as the rail less one spacing step, so a 12 px
// sentence-case label fits (design specification `design/reference/assets/kodera.css`,
// `--rail-item`). The token is a literal, so this keeps the two from drifting apart
// when either moves.
function checkRailItemFitsRail(source) {
  const index = indexTokens(source);
  const px = (path) => Number.parseFloat(resolve(path, index));
  assert.equal(
    px('component.shell.rail-item-width'),
    px('component.shell.rail-width') - px('space.2'),
    'rail item: the rail less one spacing step',
  );
}

test('a rail item is the rail less one spacing step', () => checkRailItemFitsRail(tree));

function checkWhiteFoundation(source, styles) {
  const index = indexTokens(source);
  for (const role of ['page', 'surface', 'sunken', 'elevated']) {
    assert.equal(resolve(`semantic.theme.light.${role}`, index), '#FFFFFF', `WHITE_LIGHT_PAGE_SURFACE:${role}`);
  }
  assert.deepEqual(resolve('semantic.theme.light.page-grad', index), [
    { color: '#FFFFFF', position: 0 },
    { color: '#FFFFFF', position: 0.45 },
    { color: '#FFFFFF', position: 1 },
  ], 'WHITE_LIGHT_GRADIENT');
  assert.equal(resolve('semantic.surface.page', index), '#FFFFFF', 'WHITE_LEGACY_FALLBACK');
  const light = styles.match(/:root, \[data-theme="light"\] \{([^}]+)\}/)?.[1];
  assert.ok(light, 'WHITE_LIGHT_DEFAULT_SCOPE');
  for (const role of ['page', 'surface', 'sunken', 'elevated']) {
    assert.ok(light.includes(`--c-${role}: #FFFFFF;`), `WHITE_LIGHT_SCOPED_CSS:${role}`);
    assert.equal((styles.match(new RegExp(`--c-${role}:`, 'g')) ?? []).length, 3, `WHITE_THEME_BOUNDARY_COUNT:${role}`);
  }
  assert.ok(light.includes('--c-page-grad: linear-gradient(115deg,#FFFFFF 0%,#FFFFFF 45%,#FFFFFF 100%);'), 'WHITE_LIGHT_SCOPED_GRADIENT');
}

test('white-light page surfaces and default/scoped declarations agree with legacy fallback', () => {
  checkWhiteFoundation(tree, css);
  const page = structuredClone(tree);
  page.color['theme-light'].page.$value = '#EEF3F8';
  assert.throws(() => checkWhiteFoundation(page, css), /WHITE_LIGHT_PAGE_SURFACE:page/);
  const sunken = structuredClone(tree);
  sunken.color['theme-light'].sunken.$value = '#F7FAFD';
  assert.throws(() => checkWhiteFoundation(sunken, css), /WHITE_LIGHT_PAGE_SURFACE:sunken/);
  const gradient = structuredClone(tree);
  gradient.color['theme-light']['page-grad'].$value[0].color = '#DCE6F0';
  assert.throws(() => checkWhiteFoundation(gradient, css), /WHITE_LIGHT_GRADIENT/);
  const legacy = structuredClone(tree);
  legacy.semantic.surface.page.$value = '{color.frost.100}';
  assert.throws(() => checkWhiteFoundation(legacy, css), /WHITE_LEGACY_FALLBACK/);
  assert.throws(() => checkWhiteFoundation(tree, css.replace(':root, [data-theme="light"] {', '[data-theme="light"] {')), /WHITE_LIGHT_DEFAULT_SCOPE/);
  assert.throws(() => checkWhiteFoundation(tree, css.replace('--c-page: #FFFFFF;', '--c-page: #EEF3F8;')), /WHITE_LIGHT_SCOPED_CSS:page/);
  assert.throws(() => checkWhiteFoundation(tree, css + '\n:root { --c-page: #EEF3F8; }'), /WHITE_THEME_BOUNDARY_COUNT:page/);
  checkWhiteFoundation(tree, css);
});

test('the CSS variable type enumerates the declarations actually generated', () => {
  const types = readFileSync(join(ROOT, 'dist/tokens.d.ts'), 'utf8');
  const names = [...new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))].sort();
  const typed = [...types.matchAll(/\| '(--[a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(typed, names, 'no phantom or missing CSS variables');
});

/**
 * A `spec:` role or a token path, resolved to a colour: the same two forms the
 * contrast gate accepts. A measurement of a colour the build composes has to
 * read it the way the build composes it, at its real alpha; naming the token
 * behind it would report the opaque source instead of the tone that is painted,
 * and would keep reporting it after the geometry moved. An unknown role is a
 * hard error rather than a fall-through to token resolution, so a misspelling
 * cannot become a row that measures nothing.
 */
function measurementColor(ref, index) {
  if (typeof ref === 'string' && ref.startsWith('spec:')) {
    const role = SPEC_COLORS[ref];
    if (!role) throw new Error(`unknown spec reference "${ref}" — the roles are ${Object.keys(SPEC_COLORS).join(', ')}`);
    return role(index);
  }
  return parseColor(resolve(ref, index));
}

function checkContrastCoverage(register) {
  const index = indexTokens(tree);
  for (const [theme, roles] of Object.entries(fixture)) {
    for (const role of Object.keys(roles).filter((r) => r !== 'page-grad')) {
      const path = `semantic.theme.${theme}.${role}`;
      assert.ok([...register.pairs, ...register.measurements].some((row) => row.fg === path || row.bg === path), `${path}: missing contrast coverage`);
    }
    const actualHover = register.pairs.find((row) => row.id === `theme.${theme}/on-inverse/action-hover`);
    assert.equal(actualHover?.min, 4.5, `${theme}: actual button text criterion`);
  }
  for (const row of register.pairs.filter((r) => r.id.startsWith('theme.'))) {
    assert.ok([3, 4.5].includes(row.min));
    assert.equal(row.exempt, undefined, 'no new exemptions');
    assert.equal(row.expect, undefined, 'no inverted theme acceptance');
  }
  return register.measurements.map((row) => {
    assert.ok(['decorative', 'capability'].includes(row.kind), `${row.id}: explicit measurement kind`);
    assert.ok(row.purpose?.trim(), `${row.id}: measurement purpose required`);
    assert.equal(row.min, undefined, `${row.id}: non-normative measurement has no acceptance minimum`);
    const bg = measurementColor(row.bg, index);
    const fg = composite(measurementColor(row.fg, index), bg);
    return `${row.id}: ${contrastRatio(fg, bg).toFixed(3)}:1 (${row.kind}, not normative acceptance)`;
  });
}

test('contrast covers every new color and explicitly reports non-normative measurements', () => {
  const register = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
  for (const measurement of checkContrastCoverage(register)) console.log(measurement);
  const missing = structuredClone(register);
  missing.measurements = missing.measurements.filter((r) => !r.fg.endsWith('.shadow-1'));
  assert.throws(() => checkContrastCoverage(missing), /shadow-1: missing contrast coverage/);
  const silent = structuredClone(register);
  silent.measurements[0].purpose = '';
  assert.throws(() => checkContrastCoverage(silent), /measurement purpose required/);
  const weakened = structuredClone(register);
  weakened.pairs.find((r) => r.id === 'theme.dark/on-inverse/action-hover').min = 3;
  assert.throws(() => checkContrastCoverage(weakened), /actual button text criterion/);
  const misspelt = structuredClone(register);
  misspelt.measurements.find((r) => r.id === 'focus-ring-on-inverse-halo/theme.dark.inverse').fg = 'spec:focus-ring.core';
  assert.throws(() => checkContrastCoverage(misspelt), /unknown spec reference "spec:focus-ring\.core"/);
});

test('the acceptance contract detects missing, changed and frozen output', () => {
  checkContract(tree, css, preset);
  const missingTheme = structuredClone(tree);
  delete missingTheme.semantic.theme.black;
  assert.throws(() => checkContract(missingTheme, css, preset), /complete theme set/);
  const missingRole = structuredClone(tree);
  delete missingRole.semantic.theme.dark.ink;
  assert.throws(() => checkContract(missingRole, css, preset), /complete role set/);
  const changed = structuredClone(tree);
  changed.color['theme-light']['ink-3'].$value = '#000000';
  assert.throws(() => checkContract(changed, css, preset), /light.ink-3: reference value/);
  assert.throws(() => checkContract(tree, css.replace(/  --c-ink: [^;]+;\n/, ''), preset), /CSS declaration count/);
  const frozen = structuredClone(preset);
  frozen.theme.extend.colors['c-ink'] = '#2F3A45';
  assert.throws(() => checkContract(tree, css, frozen), /ink: dynamic preset/);
  // The same freeze on the ring: one theme's indicator painted under every
  // attribute, by both ring utilities, with dist/ still a faithful build of the
  // source that produced it.
  const frozenRing = structuredClone(preset);
  frozenRing.theme.extend.ringColor.DEFAULT = '#2340C4';
  assert.throws(() => checkContract(tree, css, frozenRing), /ring DEFAULT: dynamic preset — a value here freezes/);
  const halfRing = structuredClone(preset);
  delete halfRing.theme.extend.ringColor['on-inverse'];
  assert.throws(() => checkContract(tree, css, halfRing), /one ring key per variant/);
  const strayRing = structuredClone(preset);
  // A name no variant will ever take: a mutation that borrows a plausible one
  // stops proving anything on the day that variant becomes real.
  strayRing.theme.extend.ringColor['on-nothing'] = 'var(--focus-ring-on-nothing-color)';
  assert.throws(() => checkContract(tree, css, strayRing), /one ring key per variant/);
  const danglingRing = structuredClone(preset);
  danglingRing.theme.extend.ringColor.DEFAULT = 'var(--focus-ring-colour)';
  assert.throws(() => checkContract(tree, css, danglingRing), /the reference must be --focus-ring-color/);
  const narrow = structuredClone(tree);
  narrow.space['shell-rail-width'].$value = '56px';
  assert.throws(() => checkContract(narrow, css, preset), /rail-width: geometry/);
});

test('the standalone build is deterministic, input-sensitive and rejects incomplete maps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-theme-build-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'tokens.json'), join(dir, 'tokens.json'));
    const build = () => spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env: {} });
    const output = () => ['tokens.css', 'tailwind.preset.js', 'tokens.d.ts'].map((f) => readFileSync(join(dir, 'dist', f), 'utf8'));
    assert.equal(build().status, 0);
    const first = output();
    assert.equal(build().status, 0);
    assert.deepEqual(output(), first, 'identical input must yield byte-identical output');
    const changed = structuredClone(tree);
    changed.color['theme-dark'].ink.$value = '#FFFFFF';
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(changed));
    assert.equal(build().status, 0);
    assert.notEqual(output()[0], first[0], 'source changes must reach CSS');
    const noAngle = structuredClone(tree);
    delete noAngle.color['theme-dark']['page-grad'].$extensions;
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(noAngle));
    const invalidGradient = build();
    assert.notEqual(invalidGradient.status, 0);
    assert.match(invalidGradient.stderr, /gradient angle metadata/);
    delete changed.semantic.theme.black.ink;
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(changed));
    const broken = build();
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /black.*incomplete theme role set/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
