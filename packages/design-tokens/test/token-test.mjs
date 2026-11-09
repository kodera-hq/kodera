// The token-resolution guard, generalised from kodera-web/src/tailwind-tokens.test.ts
// and exported so hub and console run the same check against the same preset.
//
// The failure it exists to catch:
//
//   A Tailwind colour class that names a token which does not exist produces NO
//   CSS rule and NO error. The build succeeds, the class stays in the markup,
//   and the element falls back to preflight — for `border-*` that is
//   `border: 0 solid #e5e7eb`, a light grey line. The hub shipped exactly that
//   on two membership cards, and nothing anywhere went red.
//
// So: any class whose first segment after the utility prefix names one of our
// own colour families must resolve to a real key in the preset. A class that
// touches no custom family (`border-b`, `text-center`, `bg-gradient-to-br`) is
// none of this check's business and is skipped by construction.
//
// Usage in a consumer:
//
//   import preset from '@kodera/design-tokens/tailwind-preset';
//   import { assertClassesResolve, sourceFiles } from '@kodera/design-tokens/token-test';
//
//   assertClassesResolve({ files: sourceFiles('src'), preset });

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The utility prefixes that take a colour token. */
export const DEFAULT_PREFIXES = [
  'bg', 'text', 'border', 'divide',
  'border-t', 'border-r', 'border-b', 'border-l', 'border-x', 'border-y', 'border-s', 'border-e',
  'ring', 'fill', 'stroke',
];

// The names a walk never enters, matched as whole path segments below the scanned root.
const SKIPPED_SEGMENTS = new Set(['node_modules', 'dist', '.git']);

/**
 * Recursively list source files under `dir`, `.ts .tsx .js .jsx .astro .html` by default.
 *
 * By default a directory or file is skipped when its own name is exactly
 * `node_modules`, `dist` or `.git`. Only the segments below `dir` are judged,
 * never the path around it: the default used to be `/node_modules|dist|\.git/`
 * tested against the whole path, which skipped `src/features/distribution/`, a
 * file named `dist.ts`, anything under `.github`, and every file of a checkout
 * that sits under a `dist` directory — silently, since a walk that returns
 * fewer files is not an error.
 *
 * `ignore`, when given, replaces that default, as it always did, and is tested
 * against the whole path.
 */
export function sourceFiles(dir, { extensions = /\.(?:tsx?|jsx?|astro|html)$/, ignore } = {}) {
  const skip = ignore ? (name, path) => ignore.test(path) : (name) => SKIPPED_SEGMENTS.has(name);
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip(entry.name, path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (extensions.test(entry.name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function colorsOf(preset) {
  const colors = preset?.theme?.extend?.colors ?? preset?.theme?.colors;
  if (!colors || typeof colors !== 'object') {
    throw new Error('the preset carries no theme.extend.colors — nothing could ever be judged against it');
  }
  return colors;
}

/** The families the preset owns: the first hyphen-separated segment of every key. */
export function familiesOf(preset) {
  return new Set(Object.keys(colorsOf(preset)).map((key) => key.split('-')[0]));
}

/**
 * Does `key` name a colour Tailwind would actually emit?
 * Handles both flat keys (`surface-muted`) and nested scales (`slate` → `900`).
 */
export function resolvesInPreset(preset, key) {
  const colors = colorsOf(preset);

  const direct = colors[key];
  if (typeof direct === 'string') return true;
  // A bare group name only resolves when the group declares DEFAULT.
  if (direct && typeof direct === 'object') return typeof direct.DEFAULT === 'string';

  const parts = key.split('-');
  for (let i = 1; i < parts.length; i++) {
    const group = colors[parts.slice(0, i).join('-')];
    const step = parts.slice(i).join('-');
    if (group && typeof group === 'object' && typeof group[step] === 'string') return true;
  }
  return false;
}

/**
 * Every `<prefix>-<rest>` occurrence in `source` whose `<rest>` starts with one
 * of the preset's families. Stops at `/` (opacity modifier) and `[` (arbitrary
 * value) by construction, since neither is in the character class.
 */
export function scanClasses(source, { families, prefixes = DEFAULT_PREFIXES }) {
  const found = [];
  if (prefixes.length === 0) return found;
  // A single longest-prefix match keeps border-l-* distinct from border-*.
  // A word boundary also matches after a hyphen, so it would mistake a token
  // such as c-text-c-muted for a second utility. Never start inside a name.
  const utilities = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  for (const match of source.matchAll(new RegExp(String.raw`(?<![\w-])(${utilities})-([a-z][a-z0-9-]*)`, 'g'))) {
    const [, prefix, rest] = match;
    if (families.has(rest.split('-')[0])) found.push({ prefix, rest, className: `${prefix}-${rest}` });
  }
  return found;
}

/**
 * Scan `files` and throw when any class naming one of our colour families does
 * not resolve in `preset`.
 *
 * @param {object}   options
 * @param {string[]} options.files       Source files to scan. Empty is an error, not a pass.
 * @param {object}   options.preset      The Tailwind preset to judge against.
 * @param {string[]} [options.prefixes]  Utility prefixes to consider.
 * @param {number}   [options.minFiles]  Fewer scanned files than this is a broken caller.
 * @param {number}   [options.minMatches] Fewer matched classes than this means the matcher found nothing.
 * @returns {{files: number, matched: string[], unresolved: string[]}}
 */
export function assertClassesResolve({ files, preset, prefixes = DEFAULT_PREFIXES, minFiles = 1, minMatches = 1 }) {
  if (!Array.isArray(files)) throw new TypeError('assertClassesResolve needs a `files` array');

  // Both guards are about the check itself. A walker that returns nothing makes
  // every assertion below pass vacuously, which is the same silent success this
  // whole file exists to prevent.
  if (files.length < minFiles) {
    throw new Error(`token test scanned ${files.length} file(s), expected at least ${minFiles} — the file walker is not reaching the source`);
  }

  const families = familiesOf(preset);
  const matched = [];
  const unresolved = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { className, rest } of scanClasses(source, { families, prefixes })) {
      matched.push(className);
      if (!resolvesInPreset(preset, rest)) {
        unresolved.push(`${file}: ${className} → no token "${rest}" in the preset`);
      }
    }
  }

  if (matched.length < minMatches) {
    throw new Error(`token test matched ${matched.length} colour class(es), expected at least ${minMatches} — the matcher is silently matching nothing`);
  }

  if (unresolved.length) {
    throw new Error(
      `${unresolved.length} Tailwind class(es) name a token family but resolve to no token. ` +
        'Each emits no CSS and no error at build time:\n  ' +
        unresolved.join('\n  '),
    );
  }

  return { files: files.length, matched, unresolved };
}
