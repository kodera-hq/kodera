// Shared reader for tokens.json plus the colour maths the contrast gate needs.
//
// Deliberately dependency-free plain Node: this package is installed from a git
// tag by both front-ends, and npm does not run an install or a build step for a
// git dependency. Anything that needed `npm install` to produce `dist/` would
// install as an empty package with no error at all.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** DTCG keys that are metadata, not child groups. */
export const RESERVED = new Set([
  '$schema',
  '$value',
  '$type',
  '$description',
  '$extensions',
  '$deprecated',
]);

export function loadTokens(file = join(ROOT, 'tokens.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A leaf is any object carrying its own `$value`. Groups never do. */
function isLeaf(node) {
  return node !== null && typeof node === 'object' && !Array.isArray(node) && '$value' in node;
}

/**
 * Depth-first walk yielding one record per leaf token.
 * `$type` inherits from the nearest ancestor group that declares one, per DTCG.
 */
export function walkTokens(tree) {
  const out = [];
  const visit = (node, path, inheritedType) => {
    const type = node.$type ?? inheritedType;
    if (isLeaf(node)) {
      out.push({
        path: path.join('.'),
        segments: [...path],
        value: node.$value,
        type,
        ownType: node.$type ?? null,
        description: node.$description ?? null,
        node,
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (RESERVED.has(key)) continue;
      if (child === null || typeof child !== 'object') continue;
      visit(child, [...path, key], type);
    }
  };
  for (const [key, child] of Object.entries(tree)) {
    if (RESERVED.has(key)) continue;
    if (child === null || typeof child !== 'object') continue;
    visit(child, [key], tree.$type);
  }
  return out;
}

/** `{color.slate.900}` → `color.slate.900`, or null when the value is not an alias. */
export function aliasTarget(value) {
  if (typeof value !== 'string') return null;
  const m = /^\{([^}]+)\}$/.exec(value.trim());
  return m ? m[1] : null;
}

/** Index of every leaf by its dotted path. */
export function indexTokens(tree) {
  const index = new Map();
  for (const t of walkTokens(tree)) index.set(t.path, t);
  return index;
}

/**
 * Follow aliases to the literal value.
 * Throws on a dangling reference or a cycle — both are silent no-ops otherwise.
 */
export function resolve(path, index, seen = []) {
  const token = index.get(path);
  if (!token) throw new Error(`dangling reference: "${path}" resolves to no token`);
  const target = aliasTarget(token.value);
  if (target === null) return token.value;
  if (seen.includes(path)) throw new Error(`reference cycle: ${[...seen, path].join(' → ')}`);
  return resolve(target, index, [...seen, path]);
}

/** Resolve any `$value`, whether it is an alias, a literal, or a literal hex. */
export function resolveValue(value, index) {
  const target = aliasTarget(value);
  return target === null ? value : resolve(target, index);
}

// ---------------------------------------------------------------------------
// Colour maths — WCAG 2.1, identical to the checker kodera-visio already runs.
// ---------------------------------------------------------------------------

/** `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb()` and `rgba()` → `{r, g, b, a}` with 0-255 channels. */
export function parseColor(input) {
  if (typeof input !== 'string') throw new Error(`not a colour: ${JSON.stringify(input)}`);
  const value = input.trim();

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) throw new Error(`not a colour: ${input}`);
    const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p));
    const a = parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
    if ([r, g, b, a].some(Number.isNaN)) throw new Error(`not a colour: ${input}`);
    return { r, g, b, a };
  }

  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (!hex) throw new Error(`not a colour: ${input}`);
  let h = hex[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) throw new Error(`not a colour: ${input}`);
  const n = (i) => Number.parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

export function toHex({ r, g, b }) {
  const c = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).toUpperCase().padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Flatten a translucent colour onto an opaque one.
 * Every foreground the contrast gate measures goes through here, because a
 * translucent colour read as if it were opaque reports a ratio no user ever
 * sees: the focus ring's 35 % halo reads as 6.70:1 opaque cobalt and paints
 * #B5C0F2 at 1.78:1 on white. This function has no output of its own — nothing
 * in dist/ moves when it is wrong — so the numbers it must produce are pinned
 * in test/color-math.selftest.mjs.
 */
export function composite(fg, bg) {
  const a = fg.a ?? 1;
  if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  if ((bg.a ?? 1) < 1) throw new Error('cannot composite onto a translucent background');
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

export function luminance(color) {
  const lin = [color.r, color.g, color.b]
    .map((x) => x / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
