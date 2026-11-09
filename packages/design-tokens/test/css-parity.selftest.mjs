// Parity with the design drop's hand-written tokens.css.
//
// The delivered HTML prototypes and the component spec tables address these
// custom properties BY NAME. Renaming one does not fail a build anywhere: the
// browser drops the unknown `var()` and the element falls back to its inherited
// or initial value, so a prototype quietly loses its background rather than
// erroring. The frozen list below is the contract, not a style preference.
//
// The list is deliberately allowed to be a SUBSET of what the build emits —
// tokens the drop's hand-written CSS happened to omit (--border-input, the
// weight and leading scales, --action-danger) are additive and welcome. What is
// not allowed is a name disappearing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'dist', 'tokens.css'), 'utf8');

const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));

/** Every custom property declared by design-drop/tokens.css, v0.1. */
const FROZEN = [
  '--slate-900', '--slate-700', '--slate-600', '--slate-500',
  '--slate-300', '--slate-200', '--slate-150', '--slate-100',
  '--frost-200', '--frost-100', '--white', '--black',
  '--cobalt-600', '--cobalt-500', '--cobalt-100',
  '--green-600', '--green-500', '--green-100',
  '--amber-600', '--amber-500', '--amber-100',
  '--red-600', '--red-500', '--red-100',
  '--bg-page', '--bg-page-flat',
  '--surface', '--surface-muted', '--surface-accent', '--surface-inverse',
  '--border', '--border-soft', '--hairline',
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-placeholder',
  '--text-inverse', '--text-accent', '--text-success', '--text-warning', '--text-danger',
  '--action-primary', '--action-primary-hover', '--action-on-primary', '--focus-ring',
  '--font-sans', '--font-mono',
  '--text-xs', '--text-sm', '--text-md', '--text-lg',
  '--text-xl', '--text-2xl', '--text-3xl', '--text-4xl',
  '--tracking-tight', '--tracking-snug',
  '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-8', '--sp-10', '--sp-12',
  '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-full',
  '--shadow-card', '--shadow-pop',
  '--ease-out', '--dur-fast', '--dur-base', '--dur-slow',
];

test('every custom property the design drop declares is still emitted', () => {
  const missing = FROZEN.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], 'these names are addressed by the delivered prototypes and the spec tables');
});

test('the generated file carries the do-not-edit header', () => {
  assert.match(css, /GENERATED FILE — DO NOT EDIT/);
});

function checkLegacyWhitePage(styles) {
  assert.match(styles, /--bg-page: linear-gradient\(115deg, var\(--white\) 0%, var\(--white\) 45%, var\(--white\) 100%\);/, 'LEGACY_WHITE_GRADIENT');
  assert.match(styles, /--bg-page-flat: #FFFFFF;/, 'LEGACY_WHITE_FALLBACK');
}

test('the legacy page gradient and flat fallback stay white', () => {
  checkLegacyWhitePage(css);
  assert.throws(() => checkLegacyWhitePage(css.replace('var(--white) 0%', 'var(--frost-200) 0%')), /LEGACY_WHITE_GRADIENT/);
  assert.throws(() => checkLegacyWhitePage(css.replace('--bg-page-flat: #FFFFFF;', '--bg-page-flat: #EEF3F8;')), /LEGACY_WHITE_FALLBACK/);
  checkLegacyWhitePage(css);
});

test('every theme declares both rings, an opaque core inside a translucent halo', () => {
  // The ring fails in two opposite ways. Drop the opaque core and the indicator
  // is back to a 35 % halo, which SC 1.4.11 rejects and which measures 1.86:1
  // on white; drop the halo's alpha and the contrast gate would measure a colour
  // no user ever sees. The core is first so it paints against the control.
  //
  // Every block is listed, and the values are literals rather than a pattern.
  // A ring declared in one block and not the others is the unthemed ring
  // returning under a new name: the one declaration would win under every
  // attribute, and the theme that reads it is not the theme that painted it.
  const rings = {
    ':root, [data-theme="light"]': [
      '--focus-ring: 0 0 0 2px #2340C4, 0 0 0 5px rgba(35, 64, 196, 0.35);',
      '--focus-ring-color: #2340C4;',
      '--focus-ring-on-inverse: 0 0 0 2px #FFFFFF, 0 0 0 5px rgba(255, 255, 255, 0.35);',
      '--focus-ring-on-inverse-color: #FFFFFF;',
    ],
    '[data-theme="dark"]': [
      '--focus-ring: 0 0 0 2px #AEBEFF, 0 0 0 5px rgba(174, 190, 255, 0.35);',
      '--focus-ring-color: #AEBEFF;',
      '--focus-ring-on-inverse: 0 0 0 2px #F3F7FB, 0 0 0 5px rgba(243, 247, 251, 0.35);',
      '--focus-ring-on-inverse-color: #F3F7FB;',
    ],
    '[data-theme="black"]': [
      '--focus-ring: 0 0 0 2px #AEBEFF, 0 0 0 5px rgba(174, 190, 255, 0.35);',
      '--focus-ring-color: #AEBEFF;',
      '--focus-ring-on-inverse: 0 0 0 2px #F7FAFC, 0 0 0 5px rgba(247, 250, 252, 0.35);',
      '--focus-ring-on-inverse-color: #F7FAFC;',
    ],
  };

  for (const [selector, declarations] of Object.entries(rings)) {
    const opened = css.split(`${selector} {`);
    assert.equal(opened.length, 2, `${selector} must open exactly one block`);
    const block = opened[1].split('}')[0];
    for (const declaration of declarations) {
      assert.ok(block.includes(declaration), `${selector} must declare ${declaration}`);
    }
  }

  // ...and nowhere else. A copy on `:root` outside the theme blocks would be
  // shadowed here by the light block and would win nothing, but it would still
  // be a second place the ring is written down.
  assert.equal((css.match(/--focus-ring:/g) ?? []).length, 3, 'one ring declaration per theme, no more');
});

test('the generic font keywords are not quoted into family names', () => {
  // `'sans-serif'` would be a font NAMED sans-serif; the fallback stops working
  // and nothing reports it.
  assert.doesNotMatch(css, /'sans-serif'|'monospace'|'system-ui'|'ui-monospace'/);
  assert.match(css, /--font-sans: 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;/);
});

test('a spot check of values still matches the design drop', () => {
  for (const [name, value] of [
    ['--slate-900', '#2F3A45'],
    ['--cobalt-500', '#2B4BDB'],
    ['--surface-inverse', '#2F3A45'],
    ['--r-lg', '16px'],
    ['--dur-base', '200ms'],
    ['--ease-out', 'cubic-bezier(0.2, 0.7, 0.3, 1)'],
  ]) {
    assert.match(css, new RegExp(`${name}: ${value.replace(/[.()*+?^$|[\]\\]/g, '\\$&')}[;\\s]`), `${name} moved`);
  }
});
