// Self-test for the guard itself.
//
// The check in token-test.mjs is the only thing standing between a renamed
// token and a silently unstyled element, so it gets the treatment every guard
// deserves: a fixture that must PASS, a fixture that must FAIL, and assertions
// that the check breaks loudly when it is wired up wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import preset from '../dist/tailwind.preset.js';
import { assertClassesResolve, sourceFiles, familiesOf, resolvesInPreset, scanClasses } from './token-test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVES = join(HERE, 'fixtures', 'resolves');
const UNRESOLVED = join(HERE, 'fixtures', 'unresolved');

test('the preset declares the families the design system names', () => {
  const families = familiesOf(preset);
  for (const family of ['slate', 'frost', 'cobalt', 'green', 'amber', 'red', 'surface', 'border', 'text', 'action', 'ink']) {
    assert.ok(families.has(family), `preset has no colour family "${family}"`);
  }
});

test('resolution handles flat keys, nested scales and groups without a DEFAULT', () => {
  assert.ok(resolvesInPreset(preset, 'slate-900'), 'nested scale step');
  assert.ok(resolvesInPreset(preset, 'surface-muted'), 'flat semantic key');
  assert.ok(resolvesInPreset(preset, 'action'), 'flat key whose value is a string');
  assert.ok(resolvesInPreset(preset, 'white'), 'single-segment key');
  assert.equal(resolvesInPreset(preset, 'slate'), false, 'a scale with no DEFAULT is not a colour');
  assert.equal(resolvesInPreset(preset, 'slate-950'), false, 'a step that does not exist');
});

test('a fixture using only real tokens passes', () => {
  const report = assertClassesResolve({ files: sourceFiles(RESOLVES), preset });
  assert.equal(report.unresolved.length, 0);
  for (const cls of ['bg-surface', 'border-slate-200', 'text-ink-2', 'fill-green-500', 'stroke-amber-600', 'ring-cobalt-500']) {
    assert.ok(report.matched.includes(cls), `expected the scanner to match ${cls}`);
  }
});

test('classes that touch none of our families are skipped, not judged', () => {
  const families = familiesOf(preset);
  const matched = scanClasses('border-b text-center bg-gradient-to-br border-coral-line', { families });
  assert.deepEqual(matched, []);
});

test('the fixture that must fail, fails — naming every broken class and only those', () => {
  let error;
  try {
    assertClassesResolve({ files: sourceFiles(UNRESOLVED), preset });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof Error, 'the broken fixture did not fail the check');

  for (const cls of ['bg-slate-950', 'border-surface-raised', 'text-ink-4']) {
    assert.match(error.message, new RegExp(cls.replace(/-/g, '\\-')), `expected ${cls} to be reported`);
  }
  assert.doesNotMatch(error.message, /coral/, 'a retired family is not ours to judge');
  assert.match(error.message, /3 Tailwind class\(es\)/);
});

test('an empty file list is an error, never a pass', () => {
  assert.throws(() => assertClassesResolve({ files: [], preset }), /the file walker is not reaching the source/);
});

test('a scan that matches nothing is an error, never a pass', () => {
  const noClasses = join(HERE, 'fixtures', 'unresolved', 'Broken.tsx');
  assert.throws(
    () => assertClassesResolve({ files: [noClasses], preset, prefixes: ['divide'] }),
    /silently matching nothing/,
  );
});

test('a preset with no colours is an error, never a pass', () => {
  assert.throws(() => assertClassesResolve({ files: [join(RESOLVES, 'Good.tsx')], preset: { theme: {} } }), /nothing could ever be judged against it/);
});

// The walk skips `node_modules`, `dist` and `.git` only as whole path segments
// below the root it was given. It used to test `/node_modules|dist|\.git/`
// against the whole absolute path, so each tree below lost files it should
// have scanned, and the guard judged fewer files without saying so. The trees
// extend the three in the console's walk test (open kodera-console #125) with
// `dist.ts`, `.github/` and a nested `node_modules`, so the two walks can be
// held to one behaviour.
function walked(files, under = '') {
  const base = mkdtempSync(join(tmpdir(), 'source-walk-'));
  try {
    const root = join(base, under);
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    return sourceFiles(root)
      .map((path) => relative(root, path).split(sep).join('/'))
      .sort();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('the walk scans a name that only contains a skipped name', () => {
  assert.deepEqual(
    walked([
      'features/distribution/Card.tsx',
      'features/redistribute.ts',
      'features/dist.ts',
      'app/.github-like/x.ts',
      '.github/scripts/check.ts',
      'ui/Button.tsx',
    ]),
    [
      '.github/scripts/check.ts',
      'app/.github-like/x.ts',
      'features/dist.ts',
      'features/distribution/Card.tsx',
      'features/redistribute.ts',
      'ui/Button.tsx',
    ],
  );
});

test('the walk skips node_modules, dist and .git as whole segments, at any depth', () => {
  assert.deepEqual(
    walked([
      'node_modules/pkg/index.js',
      'features/dist/bundle.js',
      'features/nested/node_modules/pkg/index.js',
      '.git/hooks/pre-commit.js',
      'ui/Button.tsx',
    ]),
    ['ui/Button.tsx'],
  );
});

test('the walk judges only the segments below the root, not the checkout around it', () => {
  assert.deepEqual(walked(['features/Home.tsx'], join('dist', '.github', 'node_modules', 'src')), ['features/Home.tsx']);
});

test('a caller-supplied ignore replaces the default and is tested against the whole path', () => {
  const base = mkdtempSync(join(tmpdir(), 'source-walk-'));
  try {
    for (const file of ['dist/bundle.js', 'features/Home.tsx', 'features/skip-me/Card.tsx']) {
      mkdirSync(dirname(join(base, file)), { recursive: true });
      writeFileSync(join(base, file), '');
    }
    const listed = (options) =>
      sourceFiles(base, options)
        .map((path) => relative(base, path).split(sep).join('/'))
        .sort();
    // `dist` is walked: the segment rule is the default, and `ignore` replaces it.
    assert.deepEqual(listed({ ignore: /features\/skip-me/ }), ['dist/bundle.js', 'features/Home.tsx']);
    // A regex that matches nothing walks everything, as the console's call does.
    assert.deepEqual(listed({ ignore: /(?!)/ }), ['dist/bundle.js', 'features/Home.tsx', 'features/skip-me/Card.tsx']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Keep acceptance independent of DEFAULT_PREFIXES so an omitted utility cannot
// erase its own test. Every refusal has a valid match from an existing prefix.
const ADDED_PREFIXES = ['divide', 'border-t', 'border-r', 'border-b', 'border-l', 'border-x', 'border-y', 'border-s', 'border-e'];

function withSource(source, check) {
  const root = mkdtempSync(join(tmpdir(), 'token-resolution-'));
  try {
    const file = join(root, 'Classes.tsx');
    writeFileSync(file, source);
    return check(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rejectsMissingRole(guard, prefix) {
  withSource(`bg-c-border-soft hover:${prefix}-c-missing/50`, (file) => {
    assert.throws(
      () => guard({ files: [file], preset }),
      (error) => {
        assert.equal(error.message,
          '1 Tailwind class(es) name a token family but resolve to no token. ' +
          'Each emits no CSS and no error at build time:\n  ' +
          `${file}: ${prefix}-c-missing → no token "c-missing" in the preset`);
        return true;
      },
      `${prefix} must reject its missing role beside a valid existing class`,
    );
  });
}

for (const prefix of ADDED_PREFIXES) {
  test(`${prefix} rejects a missing role beside a valid existing class`, () => {
    rejectsMissingRole(assertClassesResolve, prefix);
  });

  test(`${prefix} resolves theme roles with variants and opacity`, () => {
    withSource(`bg-c-border-soft ${prefix}-c-border-soft md:hover:!${prefix}-c-bad/50`, (file) => {
      const report = assertClassesResolve({ files: [file], preset });
      assert.deepEqual(report.matched.sort(), ['bg-c-border-soft', `${prefix}-c-border-soft`, `${prefix}-c-bad`].sort());
    });
  });
}

test('new utilities skip non-colour classes and unrelated families', () => {
  withSource('bg-c-border-soft border-l-2 divide-y divide-y-2 border-x-0 border-s-[3px] divide-dashed divide-coral-line border-e-coral-line', (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset }).matched, ['bg-c-border-soft']);
  });
});

test('caller prefixes replace defaults and accept custom multi-segment utilities', () => {
  withSource('outline-c-border-soft acme-border-c-bad divide-c-missing border-l-c-missing', (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset, prefixes: ['outline', 'acme-border'] }).matched,
      ['outline-c-border-soft', 'acme-border-c-bad']);
  });
  withSource('bg-c-border-soft divide-c-missing border-l-c-missing', (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset, prefixes: ['bg'] }).matched, ['bg-c-border-soft']);
  });
});

test('custom families and overlapping prefixes use the whole utility', () => {
  const custom = { theme: { colors: { brand: { DEFAULT: '#fff', soft: '#eee' }, l: { DEFAULT: '#fff' } } } };
  withSource('divide-brand border-l-brand-soft', (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset: custom }).matched.sort(), ['border-l-brand-soft', 'divide-brand']);
  });
  // An explicit caller override keeps border-l as a colour in family l.
  withSource('border-l', (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset: custom, prefixes: ['border'] }).matched, ['border-l']);
  });
});

test('utility-like role suffixes are never scanned as separate classes', () => {
  const custom = { theme: { extend: { colors: {
    'c-text-c-missing': '#fff', 'c-border-l-c-missing': '#fff', 'c-divide-c-missing': '#fff',
  } } } };
  const classes = ['bg-c-text-c-missing', 'divide-c-border-l-c-missing', 'border-l-c-divide-c-missing'];
  withSource(classes.join(' '), (file) => {
    assert.deepEqual(assertClassesResolve({ files: [file], preset: custom }).matched.sort(), classes.sort());
  });
  assert.deepEqual(scanClasses('unrelated-divide-c-missing unrelated-border-l-c-missing', { families: new Set(['c']) }), []);
});

test('new coverage preserves minimum file and match floors', () => {
  withSource('divide-c-border-soft', (file) => {
    assert.throws(() => assertClassesResolve({ files: [file], preset, minFiles: 2 }), /scanned 1 file\(s\), expected at least 2/);
    assert.throws(() => assertClassesResolve({ files: [file], preset, minMatches: 2 }), /matched 1 colour class\(es\), expected at least 2/);
  });
});

for (const prefix of ADDED_PREFIXES) {
  test(`omitting ${prefix} independently defeats its missing-role acceptance`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-omission-'));
    try {
      const original = readFileSync(join(HERE, 'token-test.mjs'), 'utf8');
      const entry = `'${prefix}',`;
      assert.equal(original.split(entry).length, 2, 'mutation must remove exactly one default entry');
      const mutant = join(root, 'guard.mjs');
      writeFileSync(mutant, original.replace(entry, ''));
      const guard = await import(pathToFileURL(mutant).href);
      assert.throws(() => rejectsMissingRole(guard.assertClassesResolve, prefix), {
        code: 'ERR_ASSERTION',
        operator: 'throws',
        message: `Missing expected exception: ${prefix} must reject its missing role beside a valid existing class`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
