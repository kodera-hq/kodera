// Native exports are source-derived data; refusal cases must name their cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, indexTokens, resolve, parseColor } from '../scripts/lib/tokens.mjs';
import { THEMES } from '../scripts/lib/themes.mjs';

const bytes = readFileSync(join(ROOT, 'tokens.json'));
const tree = JSON.parse(bytes);
const names = ['native/KoderaTokens.swift', 'native/KoderaTokens.kt', 'native/manifest.json'];
const web = ['tokens.css', 'tailwind.preset.js', 'tokens.d.ts'];
const generate = async (source = bytes) => (await import('../scripts/lib/native.mjs')).buildNative(source);
const mutation = async (change, diagnostic) => {
  const changed = structuredClone(tree);
  change(changed);
  await assert.rejects(() => generate(Buffer.from(JSON.stringify(changed))), diagnostic);
};

test('native build emits SwiftUI, Compose and an explicit versioned manifest', async () => {
  // This assertion also establishes the initial, observable pre-implementation red.
  for (const name of names) assert.ok(readFileSync(join(ROOT, 'dist', name)).length, name);
  const outputs = await generate();
  assert.deepEqual(Object.keys(outputs), names);
  for (const name of names) assert.equal(outputs[name], readFileSync(join(ROOT, 'dist', name), 'utf8'));
  const manifest = JSON.parse(outputs[names[2]]);
  assert.equal(manifest.format, 'kodera-native-tokens/1');
  assert.equal(manifest.source.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.source.path, 'tokens.json');
  const digest = createHash('sha256').update(bytes).digest('hex');
  for (const name of names.slice(0, 2)) {
    assert.ok(outputs[name].includes(`// Public source checksum (SHA-256)\n// ${digest}\n// Source file: tokens.json\n`), `${name}: standalone public source identity`);
    assert.ok(!outputs[name].includes('// tokens.json SHA-256:'), `${name}: no credential-like source assignment`);
  }
  const exports = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).exports;
  assert.equal(exports['./native/swift'], './dist/native/KoderaTokens.swift');
  assert.equal(exports['./native/compose'], './dist/native/KoderaTokens.kt');
  assert.equal(exports['./native/manifest'], './dist/native/manifest.json');
});

test('native generation is reproducible and source identity covers bytes', async () => {
  assert.deepEqual(await generate(), await generate(Buffer.from(bytes)));
  const reformatted = Buffer.from(`${JSON.stringify(tree)}\n`);
  const a = JSON.parse((await generate())[names[2]]);
  const b = JSON.parse((await generate(reformatted))[names[2]]);
  assert.notEqual(a.source.sha256, b.source.sha256);
  assert.deepEqual(a.entries, b.entries);
});

test('all themes have the same native roles and exact sRGB/alpha provenance', async () => {
  const outputs = await generate();
  const manifest = JSON.parse(outputs[names[2]]);
  const index = indexTokens(tree);
  const roles = Object.keys(tree.semantic.theme.light).filter(k => !k.startsWith('$') && k !== 'page-grad');
  for (const theme of THEMES) {
    const native = theme.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    const entries = manifest.entries.filter(e => e.api.startsWith(`KoderaTokens.${native}.`));
    assert.equal(entries.length, roles.length);
    for (const role of roles) {
      const path = `semantic.theme.${theme}.${role}`;
      const entry = entries.find(e => e.path === path);
      assert.ok(entry, path);
      assert.equal(entry.type, 'color');
      assert.deepEqual(entry.value, parseColor(resolve(path, index)));
      const c = parseColor(resolve(path, index));
      const numeric = n => Number.isInteger(n) ? `${n}.0` : String(n);
      const swift = outputs[names[0]].split(`public static let ${native} = Palette(`)[1].split('\n    )')[0];
      const compose = outputs[names[1]].split(`public val ${native} = Palette(`)[1].split('\n    )')[0];
      const member = entry.api.split('.').at(-1);
      assert.ok(swift.includes(`${member}: Color(.sRGB, red: ${numeric(c.r / 255)}, green: ${numeric(c.g / 255)}, blue: ${numeric(c.b / 255)}, opacity: ${numeric(c.a)})`), `${path}: Swift equality`);
      assert.ok(compose.includes(`${member} = Color(red = ${numeric(c.r / 255)}f, green = ${numeric(c.g / 255)}f, blue = ${numeric(c.b / 255)}f, alpha = ${numeric(c.a)}f)`), `${path}: Compose equality`);
      assert.equal(entry.aliases[0], path);
      assert.ok(entry.aliases.length >= 2, `${path}: alias provenance`);
    }
  }
  const alpha = manifest.entries.find(e => e.path === 'semantic.theme.light.scrim');
  assert.ok(alpha.value.a > 0 && alpha.value.a < 1);
  assert.ok(manifest.excluded.some(e => e.path === 'semantic.theme.light.page-grad' && /gradient/.test(e.reason)));
  assert.ok(manifest.excluded.some(e => e.path === 'semantic.elevation.light.raised' && /elevation/.test(e.reason)));
});

test('native dimensions, weights and family fallbacks have explicit mapping', async () => {
  const outputs = await generate();
  const m = JSON.parse(outputs[names[2]]);
  for (const [path, api, value, swiftUnit, composeUnit] of [
    ['space.4', 'Space.s4', 16, 'pt', 'dp'],
    ['radius.md', 'Radius.md', 10, 'pt', 'dp'],
    ['font.size.lg', 'FontSize.lg', 16, 'pt', 'sp'],
  ]) {
    const e = m.entries.find(e => e.path === path);
    assert.equal(e.api, `KoderaTokens.${api}`);
    assert.equal(e.value, value);
    assert.deepEqual(e.units, { source: 'px', swift: swiftUnit, compose: composeUnit });
  }
  assert.equal(m.entries.find(e => e.path === 'font.weight.semibold').value, 600);
  assert.deepEqual(m.entries.find(e => e.path === 'font.family.sans').value, {
    primary: 'Plus Jakarta Sans', fallbacks: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  });
  assert.match(outputs[names[0]], /import SwiftUI/);
  assert.match(outputs[names[0]], /public struct Palette: Sendable/);
  assert.match(outputs[names[0]], /public struct Family: Sendable/);
  assert.match(outputs[names[0]], /static let semibold: Font.Weight = \.semibold/);
  assert.match(outputs[names[1]], /package io\.kodera\.tokens/);
  assert.match(outputs[names[1]], /val lg = 16\.sp/);
  assert.match(outputs[names[1]], /val semibold = ComposeFontWeight\(600\)/);
});

test('materials and springs are additive native members, derived from the source', async () => {
  const { resolveMaterial, MATERIAL_LEVELS } = await import('../scripts/lib/material.mjs');
  const { springProfile } = await import('../scripts/lib/spring.mjs');
  const outputs = await generate();
  const manifest = JSON.parse(outputs[names[2]]);
  const index = indexTokens(tree);
  const native = id => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const numeric = n => Number.isInteger(n) ? `${n}.0` : String(n);
  const sw = c => `Color(.sRGB, red: ${numeric(c.r / 255)}, green: ${numeric(c.g / 255)}, blue: ${numeric(c.b / 255)}, opacity: ${numeric(c.a)})`;
  for (const theme of THEMES) {
    for (const level of MATERIAL_LEVELS) {
      const path = `semantic.material.${theme}.${level}`;
      const entry = manifest.entries.find(e => e.path === path);
      assert.ok(entry, path);
      assert.equal(entry.type, 'material');
      assert.equal(entry.api, `KoderaTokens.MaterialSet.${native(theme)}.${level}`);
      assert.deepEqual(entry.aliases, [path, `material.theme-${theme}.${level}`]);
      const material = resolveMaterial(theme, level, index);
      assert.deepEqual(entry.value, {
        tint: { r: material.tint.r, g: material.tint.g, b: material.tint.b, a: 1 },
        alpha: material.alpha,
        blur: material.blur,
        saturation: material.saturation,
        border: parseColor(material.border),
        fallback: material.fallback,
      }, `${path}: the manifest carries what the source resolves to`);
      const swift = outputs[names[0]].split('public enum MaterialSet {')[1].split(`public static let ${native(theme)} = Materials(`)[1].split('\n        )')[0];
      assert.ok(swift.includes(`${level}: Material(tint: ${sw(entry.value.tint)}, alpha: ${numeric(material.alpha)}, blur: ${numeric(material.blur)}, saturation: ${numeric(material.saturation)}, border: ${sw(entry.value.border)}, fallback: ${sw(entry.value.fallback)})`), `${path}: Swift equality`);
      const compose = outputs[names[1]].split('public object MaterialSet {')[1].split(`public val ${native(theme)} = Materials(`)[1].split('\n        )')[0];
      assert.ok(compose.includes(`${level} = Material(tint = `) && compose.includes(`alpha = ${numeric(material.alpha)}f, blur = ${material.blur}.dp, saturation = ${numeric(material.saturation)}f`), `${path}: Compose equality`);
    }
  }
  for (const name of Object.keys(tree.motion.spring).filter(k => !k.startsWith('$'))) {
    const entry = manifest.entries.find(e => e.path === `motion.spring.${name}`);
    const profile = springProfile(tree.motion.spring[name].$value);
    assert.deepEqual(entry.value, { ...tree.motion.spring[name].$value, dampingRatio: profile.dampingRatio, response: profile.response, settlingMs: profile.durationMs });
    assert.equal(entry.api, `KoderaTokens.Motion.${name}`);
    assert.ok(outputs[names[0]].includes(`public static let ${name} = Spring(stiffness: ${numeric(entry.value.stiffness)}, damping: ${numeric(entry.value.damping)}, mass: ${numeric(entry.value.mass)}, dampingRatio: ${numeric(profile.dampingRatio)}, response: ${numeric(profile.response)}, settlingDuration: ${numeric(profile.durationMs / 1000)})`), `${name}: Swift equality`);
    assert.ok(outputs[names[1]].includes(`public val ${name} = Spring(stiffness = ${numeric(entry.value.stiffness)}f, damping = ${numeric(entry.value.damping)}f, mass = ${numeric(entry.value.mass)}f, dampingRatio = ${numeric(profile.dampingRatio)}f, response = ${numeric(profile.response)}f, settlingMillis = ${profile.durationMs})`), `${name}: Compose equality`);
  }
  // Nothing the tier declares is left in the excluded list as "outside the surface".
  assert.ok(!manifest.excluded.some(e => /^(semantic\.material|material|motion\.spring)\./.test(e.path)), 'materials and springs are native entries, not exclusions');
  assert.equal(manifest.format, 'kodera-native-tokens/1', 'additive: the format a consumer pins does not change');
  // A source that declares neither still builds, and emits neither.
  const without = structuredClone(tree);
  delete without.material; delete without.semantic.material; delete without.motion.spring;
  const bare = await generate(Buffer.from(JSON.stringify(without)));
  assert.ok(!bare[names[0]].includes('MaterialSet') && !bare[names[0]].includes('public enum Motion'), 'no tier, no members');
  assert.ok(bare[names[0]].includes('public enum Theme: String, CaseIterable, Sendable {'), 'the registry is always emitted');
});

test('native refuses a malformed material tier or spring', async () => {
  await mutation(t => { delete t.semantic.material['ciel-nuit']; }, /native: materials must be declared for /);
  await mutation(t => { delete t.semantic.material.dark.dialog; }, /native: material levels differ in dark/);
  await mutation(t => { t.material['theme-ciel'].bar.$value.alpha = 0; }, /native: material: material\.theme-ciel\.bar: alpha: 0 is not a number in \(0, 1\]/);
  await mutation(t => { t.material['theme-ciel'].bar.$value.tint = '{color.theme-ciel.glass-edge}'; }, /native: material: material\.theme-ciel\.bar: tint: "color\.theme-ciel\.glass-edge" is translucent/);
  await mutation(t => { t.semantic.material.ciel.bar.$value = '{material.theme-ciel.panel}'; }, /native: material semantic\.material\.ciel\.bar must reference material\.theme-ciel\.bar/);
  await mutation(t => { t.motion.spring.snappy.$value.stiffness = 0; }, /native: spring motion\.spring\.snappy/);
  await mutation(t => { t.motion.spring.snappy.$type = 'cubicBezier'; }, /native: type motion\.spring\.snappy: expected spring, got cubicBezier/);
});

test('native refuses incomplete themes and missing supported groups', async () => {
  await mutation(t => { delete t.semantic.theme.dark.ink; }, /native: theme roles/);
  await mutation(t => { delete t.semantic.theme.black; }, /native: themes/);
  await mutation(t => { delete t.font.family; }, /native: missing group font.family/);
});

test('native refuses unresolved aliases and cycles', async () => {
  await mutation(t => { t.space['4'].$value = '{space.missing}'; }, /dangling reference/);
  await mutation(t => { t.space['4'].$value = '{space.5}'; t.space['5'].$value = '{space.4}'; }, /reference cycle/);
});

test('native refuses wrong types, non-px dimensions and invalid colors', async () => {
  await mutation(t => { t.space['4'].$type = 'color'; }, /native: type space.4/);
  await mutation(t => { t.space['4'].$value = '1rem'; }, /native: px dimension space.4/);
  await mutation(t => { t.color['theme-light'].scrim.$value = 'rgba(0,0,0,2)'; }, /native: color range/);
  await mutation(t => { t.color['theme-light'].scrim.$value = 'rgba(0oops,0,0,0.5)'; }, /native: color syntax/);
  await mutation(t => { t.font.weight.semibold.$value = 650; }, /native: font weight/);
  await mutation(t => { t.color['theme-light'].scrim.$value = 'rgba(0,0,0)'; }, /native: color syntax/);
  await mutation(t => { t.font.family.sans.$value = ['']; }, /native: font family/);
  await mutation(t => { for (const theme of THEMES) t.semantic.theme[theme].ink.$type = 'gradient'; }, /native: type semantic.theme.light.ink/);
});

test('native refuses identifier collisions and alias type laundering', async () => {
  await mutation(t => { t.space['shellRailWidth'] = { $value: '1px' }; }, /native: identifier collision/);
  await mutation(t => { t.space['4'].$value = '{font.weight.regular}'; }, /native: type font.weight.regular/);
});

test('integrated build preserves web bytes and drift refuses missing or edited native output', () => {
  const fixture = mkdtempSync(join(ROOT, 'test', '.native-fixture-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(fixture, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'tokens.json'), join(fixture, 'tokens.json'));
    cpSync(join(ROOT, 'package.json'), join(fixture, 'package.json'));
    const build = (args = []) => spawnSync(process.execPath, ['scripts/build.mjs', ...args], { cwd: fixture, encoding: 'utf8', timeout: 15000 });
    let r = build();
    assert.equal(r.status, 0, r.stderr);
    for (const name of web) assert.equal(readFileSync(join(fixture, 'dist', name), 'utf8'), readFileSync(join(ROOT, 'dist', name), 'utf8'), name);
    const original = names.map(name => readFileSync(join(fixture, 'dist', name), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
    pkg.version = '999.0.0';
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(pkg));
    r = build();
    assert.equal(r.status, 0, r.stderr);
    names.forEach((name, i) => assert.equal(readFileSync(join(fixture, 'dist', name), 'utf8'), original[i]));
    rmSync(join(fixture, 'dist', names[0]));
    r = build(['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /native\/KoderaTokens.swift: missing/);
    assert.equal(build().status, 0);
    writeFileSync(join(fixture, 'dist', names[1]), 'changed');
    r = build(['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /native\/KoderaTokens.kt: differs/);
    // The artifact set also refuses manifest removal.
    rmSync(join(fixture, 'dist', names[2]));
    r = build(['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /native\/manifest.json: missing/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
