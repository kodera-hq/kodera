// The theme registry (scripts/lib/themes.mjs) is the one list of themes. This
// file holds three things to it, and proves each one fails when it is broken:
//
//   the list      what the registry declares, restated here on purpose, so a
//                 theme cannot be added or re-filed by editing one file
//   the census    every generated artefact names exactly the registered themes:
//                 the CSS blocks, the `themes` module and its types, the Swift
//                 and Compose palettes, the native manifest. A theme one
//                 generator emits and the registry does not hold — or the
//                 reverse — is a theme that exists on one platform only
//   the sources   tokens.json is held to the registry by the build, in both
//                 directions, and no generator spells a theme list of its own

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../scripts/lib/tokens.mjs';
import {
  THEME_REGISTRY,
  THEME_FAMILIES,
  THEMES,
  DEFAULT_THEME,
  themeInfo,
  themesOfFamily,
  themeSelector,
  familyRules,
  assertThemeGroups,
} from '../scripts/lib/themes.mjs';
import * as published from '../dist/themes.js';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const tree = JSON.parse(read('tokens.json'));

/** The registry, restated. Changing the themes means changing this too. */
const EXPECTED = [
  { id: 'light', family: 'givre', mode: 'light', scheme: 'light', default: true },
  { id: 'dark', family: 'givre', mode: 'dark', scheme: 'dark', default: false },
  { id: 'black', family: 'givre', mode: 'black', scheme: 'dark', default: false },
];
const EXPECTED_FAMILIES = {
  givre: { material: 'flat', gradient: 'none' },
};

/** `ciel-nuit` → `cielNuit`: the member name a native binding gives a theme. */
const nativeName = (id) => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

test('the registry lists every theme once, as a family in a mode', () => {
  assert.deepEqual(THEME_REGISTRY.map((theme) => ({ ...theme })), EXPECTED);
  assert.deepEqual(JSON.parse(JSON.stringify(THEME_FAMILIES)), EXPECTED_FAMILIES);
  assert.deepEqual([...THEMES], EXPECTED.map((theme) => theme.id));
  assert.equal(DEFAULT_THEME, 'light');
  assert.deepEqual(themesOfFamily('givre'), ['light', 'dark', 'black']);
  assert.equal(themeSelector('light'), ':root, [data-theme="light"]');
  assert.equal(themeSelector('dark'), '[data-theme="dark"]');
  assert.deepEqual(familyRules('black'), EXPECTED_FAMILIES.givre);
  assert.ok(Object.isFrozen(THEME_REGISTRY) && Object.isFrozen(THEME_REGISTRY[0]), 'the registry is not mutable at run time');
});

test('an unknown theme or family is an error, never a silent default', () => {
  assert.throws(() => themeInfo('sepia'), /"sepia" is not a theme; the themes are light, dark, black/);
  assert.throws(() => themeSelector('sepia'), /"sepia" is not a theme/);
  assert.throws(() => themesOfFamily('aurora'), /"aurora" is not a theme family/);
  assert.throws(
    () => assertThemeGroups('expected complete theme set', ['light', 'dark']),
    /expected complete theme set: light, dark, black \(the registry, scripts\/lib\/themes\.mjs\); tokens\.json declares light, dark$/,
  );
  assert.throws(() => assertThemeGroups('expected complete theme set', [...THEMES].reverse()), /expected complete theme set: /);
  assert.throws(() => assertThemeGroups('expected complete theme set', []), /tokens\.json declares none/);
  assert.throws(() => assertThemeGroups('expected complete theme set', undefined), /tokens\.json declares none/);
});

/**
 * Every generated artefact names exactly the registered themes, in registry
 * order where the artefact has an order. Reads text, so a mutated artefact can
 * be handed to it.
 */
function checkCensus(artefacts, registry = THEME_REGISTRY) {
  const ids = registry.map((theme) => theme.id);

  const blocks = [...artefacts.css.matchAll(/^((?::root, )?)\[data-theme="([^"]+)"\] \{$/gm)];
  assert.deepEqual(blocks.map((m) => m[2]), ids, 'tokens.css: one [data-theme] block per registered theme, in registry order');
  for (const [, root, id] of blocks) {
    assert.equal(root !== '', registry.find((theme) => theme.id === id).default, `tokens.css: only the default theme's block carries :root (${id})`);
  }

  assert.deepEqual(artefacts.published.themes.map((theme) => ({ ...theme })), registry.map((theme) => ({ ...theme })), 'themes.js: the registry, entry for entry');
  assert.deepEqual([...artefacts.published.themeIds], ids, 'themes.js: themeIds');
  assert.equal(artefacts.published.defaultTheme, registry.find((theme) => theme.default).id, 'themes.js: defaultTheme');
  assert.deepEqual(
    Object.fromEntries(Object.entries(artefacts.published.themeFamilies).map(([name, family]) => [name, [...family.themes]])),
    Object.fromEntries(Object.keys(THEME_FAMILIES).map((name) => [name, registry.filter((theme) => theme.family === name).map((theme) => theme.id)])),
    'themes.js: each family holds its registered themes',
  );

  const union = /^export type ThemeId = (.+);$/m.exec(artefacts.themeTypes)?.[1];
  assert.ok(union, 'themes.d.ts: ThemeId is declared');
  assert.deepEqual(union.split(' | ').map((v) => v.slice(1, -1)), ids, 'themes.d.ts: ThemeId is the registered ids');

  const natives = ids.map(nativeName);
  assert.deepEqual([...artefacts.swift.matchAll(/^ {4}public static let (\w+) = Palette\($/gm)].map((m) => m[1]), natives, 'Swift: one Palette per registered theme');
  assert.deepEqual([...artefacts.kotlin.matchAll(/^ {4}public val (\w+) = Palette\($/gm)].map((m) => m[1]), natives, 'Compose: one Palette per registered theme');

  const manifest = JSON.parse(artefacts.manifest);
  const themed = manifest.entries.filter((entry) => entry.path.startsWith('semantic.theme.'));
  assert.deepEqual([...new Set(themed.map((entry) => entry.path.split('.')[2]))], ids, 'manifest: theme entries for the registered themes');
  assert.deepEqual([...new Set(themed.map((entry) => entry.api.split('.')[1]))], natives, 'manifest: native theme names follow the registry');
}

const shipped = () => ({
  css: read('dist/tokens.css'),
  published,
  themeTypes: read('dist/themes.d.ts'),
  swift: read('dist/native/KoderaTokens.swift'),
  kotlin: read('dist/native/KoderaTokens.kt'),
  manifest: read('dist/native/manifest.json'),
});

test('every generated artefact names exactly the registered themes', () => checkCensus(shipped()));

test('a theme one generator emits and the registry does not hold is refused, artefact by artefact', () => {
  const base = shipped();
  const mutated = (edit) => ({ ...base, ...edit(base) });

  // A theme added to one generator but not the registry: each output on its own.
  assert.throws(
    () => checkCensus(mutated((a) => ({ css: `${a.css}\n[data-theme="sepia"] {\n  --c-page: #F4ECD8;\n}\n` }))),
    /tokens\.css: one \[data-theme\] block per registered theme/,
  );
  assert.throws(
    () => checkCensus(mutated((a) => ({ swift: a.swift.replace('    public struct Family: Sendable {', '    public static let sepia = Palette(\n    )\n    public struct Family: Sendable {') }))),
    /Swift: one Palette per registered theme/,
  );
  assert.throws(
    () => checkCensus(mutated((a) => ({ kotlin: a.kotlin.replace('    public data class Family(', '    public val sepia = Palette(\n    )\n    public data class Family(') }))),
    /Compose: one Palette per registered theme/,
  );
  assert.throws(
    () => checkCensus(mutated((a) => ({ themeTypes: a.themeTypes.replace(/^(export type ThemeId = .+);$/m, "$1 | 'sepia';") }))),
    /themes\.d\.ts: ThemeId is the registered ids/,
  );
  assert.throws(
    () => checkCensus(mutated((a) => ({ published: { ...a.published, themes: [...a.published.themes, { id: 'sepia', family: 'givre', mode: 'light', scheme: 'light', default: false }] } }))),
    /themes\.js: the registry, entry for entry/,
  );
  assert.throws(
    () =>
      checkCensus(
        mutated((a) => {
          const manifest = JSON.parse(a.manifest);
          manifest.entries.push({ path: 'semantic.theme.sepia.page', api: 'KoderaTokens.sepia.page' });
          return { manifest: JSON.stringify(manifest) };
        }),
      ),
    /manifest: theme entries for the registered themes/,
  );

  // ...and the reverse: a registered theme one generator dropped.
  const last = THEMES.at(-1);
  assert.throws(
    () => checkCensus(mutated((a) => ({ css: a.css.replace(`[data-theme="${last}"] {`, '[data-theme="gone"] {') }))),
    /tokens\.css: one \[data-theme\] block per registered theme/,
  );
  assert.throws(
    () => checkCensus(mutated((a) => ({ kotlin: a.kotlin.replace(`    public val ${nativeName(last)} = Palette(`, '    public val gone = Palette(') }))),
    /Compose: one Palette per registered theme/,
  );
  // The default moved to a block that is not the registry's default.
  assert.throws(
    () => checkCensus(mutated((a) => ({ css: a.css.replace(':root, [data-theme="light"] {', '[data-theme="light"] {') }))),
    /only the default theme's block carries :root \(light\)/,
  );

  checkCensus(base);
});

/** A copy of the generator and its source, to break one thing in. */
function sandbox(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-registry-'));
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'token-grammar-exceptions.json'), join(dir, 'token-grammar-exceptions.json'));
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify(tree));
  edit(dir);
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env: {} });
  rmSync(dir, { recursive: true, force: true });
  return run;
}

/** `sepia`, a complete copy of the default theme under a name the registry does not hold. */
function withUnregisteredTheme(source) {
  const copy = structuredClone(source);
  for (const group of ['theme', 'elevation']) copy.semantic[group].sepia = structuredClone(copy.semantic[group][DEFAULT_THEME]);
  return copy;
}

test('the build holds tokens.json to the registry in both directions', () => {
  assert.equal(sandbox(() => {}).status, 0, 'an untouched sandbox builds, or the refusals below prove nothing');

  const unregistered = sandbox((dir) => writeFileSync(join(dir, 'tokens.json'), JSON.stringify(withUnregisteredTheme(tree))));
  assert.notEqual(unregistered.status, 0, 'a theme in tokens.json that the registry does not hold must fail the build');
  assert.match(unregistered.stderr, /expected complete theme set: light, dark, black \(the registry, [^)]+\); tokens\.json declares light, dark, black, sepia/);

  // The reverse: the registry holds a theme tokens.json does not declare.
  const tokenless = sandbox((dir) => {
    const file = join(dir, 'scripts/lib/themes.mjs');
    const source = readFileSync(file, 'utf8');
    const patched = source.replace("{ id: 'black', family: 'givre', mode: 'black' },", "{ id: 'noir', family: 'givre', mode: 'black' },");
    assert.notEqual(patched, source, 'the sandbox registry was not patched, so this case would pass vacuously');
    writeFileSync(file, patched);
  });
  assert.notEqual(tokenless.status, 0, 'a registered theme with no tokens must fail the build');
  assert.match(tokenless.stderr, /expected complete theme set: light, dark, noir \(the registry, [^)]+\); tokens\.json declares light, dark, black/);

  const elevationOnly = sandbox((dir) => {
    const copy = structuredClone(tree);
    copy.semantic.elevation.sepia = structuredClone(copy.semantic.elevation[DEFAULT_THEME]);
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(copy));
  });
  assert.notEqual(elevationOnly.status, 0);
  assert.match(elevationOnly.stderr, /expected elevation for the complete theme set: light, dark, black .*tokens\.json declares light, dark, black, sepia/);
});

test('the native generator is held to the same registry', async () => {
  const { buildNative } = await import('../scripts/lib/native.mjs');
  assert.throws(
    () => buildNative(Buffer.from(JSON.stringify(withUnregisteredTheme(tree)))),
    /native: themes must be light, dark, black/,
  );
});

/** Every generator and gate source, comments removed. */
function generatorSources(dir = join(ROOT, 'scripts')) {
  const files = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  visit(dir);
  return files
    .filter((file) => !file.endsWith(join('lib', 'themes.mjs')))
    .map((file) => [file.slice(ROOT.length + 1), readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')]);
}

/** No source but the registry spells two theme ids side by side in a list. */
function checkNoPrivateList(sources, ids = THEMES) {
  const id = `['"\`](?:${ids.join('|')})['"\`]`;
  const list = new RegExp(`${id}\\s*,\\s*${id}`);
  for (const [file, text] of sources) {
    assert.doesNotMatch(text, list, `${file}: a private theme list — import it from scripts/lib/themes.mjs instead`);
  }
}

test('no generator keeps a theme list of its own', () => {
  const sources = generatorSources();
  assert.ok(sources.length >= 6, 'the scan found fewer sources than the package has, so it would pass vacuously');
  checkNoPrivateList(sources);
  assert.throws(
    () => checkNoPrivateList([...sources, ['scripts/lib/native.mjs', "const THEMES = ['light', 'dark', 'black'];"]]),
    /scripts\/lib\/native\.mjs: a private theme list/,
  );
  assert.throws(
    () => checkNoPrivateList([['scripts/build.mjs', 'for (const name of ["dark", "black"]) emit(name);']]),
    /scripts\/build\.mjs: a private theme list/,
  );
});
