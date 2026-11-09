#!/usr/bin/env node
// Grammar gate — DESIGN_HANDOFF section A, made executable.
//
// Two classes of check, both guarding failures that are otherwise silent:
//
//   DTCG validity  A leaf with no `$type` still generates CSS; the generator
//                  just guesses. A `{reference}` pointing at a token that was
//                  renamed away resolves to the literal string "{color.foo}",
//                  which a browser drops on the floor with no error.
//   Naming grammar A token whose path does not match the grammar cannot be
//                  addressed by the mechanical path → CSS-variable → Tailwind
//                  key mapping the build relies on, so it silently ships as a
//                  variable nobody can name.
//
// Anything that legitimately deviates lives in token-grammar-exceptions.json
// with a written reason. There is no way to pass by being quiet.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, RESERVED, loadTokens, walkTokens, aliasTarget, indexTokens, resolve } from './lib/tokens.mjs';

// Closed list, per DESIGN_HANDOFF A3. `component` is the third tier (ADR-0004).
// It was empty until the shell geometry aliases landed; it is declared here so
// a component token does not arrive as a grammar failure.
const ROOT_GROUPS = new Set([
  'color',
  'semantic',
  'font',
  'space',
  'radius',
  'shadow',
  'motion',
  'breakpoint',
  'component',
]);

const TIER_OF = {
  color: 'primitive',
  font: 'primitive',
  space: 'primitive',
  radius: 'primitive',
  shadow: 'primitive',
  motion: 'primitive',
  breakpoint: 'primitive',
  semantic: 'semantic',
  component: 'component',
};

// A path segment is either a name (`slate`, `primary`, `on-primary`) or a
// numeric scale step (`900`, `4`, `2xl`). Both are lowercase, both are stable
// under the kebab-case mapping the build applies.
const NAME_SEGMENT = /^[a-z][a-z0-9-]*$/;
const SCALE_SEGMENT = /^[0-9]+[a-z]*$/;

const MAX_SEGMENTS = 4; // category.role.variant.state

const exceptionsFile = join(ROOT, 'token-grammar-exceptions.json');
const exceptions = existsSync(exceptionsFile)
  ? JSON.parse(readFileSync(exceptionsFile, 'utf8'))
  : { exceptions: [] };
const excused = new Map(exceptions.exceptions.map((e) => [`${e.path}|${e.rule}`, e]));

const tree = loadTokens();
const tokens = walkTokens(tree);
const index = indexTokens(tree);

const problems = [];
const fail = (path, rule, detail) => {
  const key = `${path}|${rule}`;
  const excuse = excused.get(key);
  if (excuse) {
    if (!excuse.reason || !excuse.reason.trim()) {
      problems.push({ path, rule, detail: 'listed in token-grammar-exceptions.json with no reason' });
    } else {
      excused.set(key, { ...excuse, used: true });
    }
    return;
  }
  problems.push({ path, rule, detail });
};

// --- A group must not be empty, and must not collide with a reserved key -----
const groupsSeen = [];
(function collectGroups(node, path) {
  for (const [key, child] of Object.entries(node)) {
    if (RESERVED.has(key)) continue;
    if (key.startsWith('$')) {
      problems.push({
        path: [...path, key].join('.'),
        rule: 'reserved-key',
        detail: `"${key}" is $-prefixed but is not a DTCG reserved key`,
      });
      continue;
    }
    if (child === null || typeof child !== 'object') continue;
    if ('$value' in child) continue;
    groupsSeen.push([...path, key].join('.'));
    collectGroups(child, [...path, key]);
  }
})(tree, []);

// --- Per-token checks -------------------------------------------------------
for (const token of tokens) {
  const { path, segments, value, type } = token;

  if (value === undefined) fail(path, 'dtcg-value', 'leaf has no $value');
  if (!type) fail(path, 'dtcg-type', 'no $type, own or inherited from an ancestor group');

  if (!ROOT_GROUPS.has(segments[0])) {
    fail(path, 'root-group', `"${segments[0]}" is not one of ${[...ROOT_GROUPS].join(' · ')}`);
  }

  if (segments.length < 2) fail(path, 'depth', 'a token needs at least category.role');
  if (segments.length > MAX_SEGMENTS) {
    fail(path, 'depth', `${segments.length} segments, the grammar allows at most ${MAX_SEGMENTS}`);
  }

  for (const seg of segments) {
    if (NAME_SEGMENT.test(seg) || SCALE_SEGMENT.test(seg)) continue;
    fail(path, 'segment-case', `segment "${seg}" is not lowercase kebab or a numeric scale step`);
  }

  // Aliases must land somewhere.
  const target = aliasTarget(value);
  if (target !== null) {
    try {
      resolve(path, index);
    } catch (error) {
      fail(path, 'alias', error.message);
    }
  }

  // A composite value may reference a colour token in its `color` field (a
  // shadow drawn in a theme colour). The build resolves that one field in
  // place; a reference anywhere else, or one that lands on something that is
  // not a colour, would reach the CSS as a literal "{…}" string or a length
  // where a colour belongs, which a browser drops silently.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [field, inner] of Object.entries(value)) {
      const innerTarget = aliasTarget(inner);
      if (innerTarget === null) continue;
      if (field !== 'color') {
        fail(path, 'alias', `${field}: a reference is allowed in a composite's "color" only`);
        continue;
      }
      // `resolve` throws on a dangling reference and on a cycle alike.
      try {
        resolve(innerTarget, index);
      } catch (error) {
        fail(path, 'alias', `${field}: ${error.message}`);
        continue;
      }
      if (index.get(innerTarget).type !== 'color') {
        fail(path, 'alias', `${field}: "${innerTarget}" is a ${index.get(innerTarget).type} token, not a colour`);
      }
    }
  }

  // A2: literals live in the primitive tier only.
  const tier = TIER_OF[segments[0]];
  if ((tier === 'semantic' || tier === 'component') && target === null) {
    fail(path, 'tier', `${tier} token holds a literal value; it must reference another token`);
  }
  if (tier === 'component' && target !== null && !target.startsWith('semantic.')) {
    fail(path, 'tier', `component token references "${target}"; it must reference a semantic token`);
  }
}

// --- An exception nobody triggered is stale -------------------------------
for (const [key, excuse] of excused) {
  if (!excuse.used) {
    problems.push({
      path: excuse.path,
      rule: excuse.rule,
      detail: 'listed in token-grammar-exceptions.json but the token no longer breaks that rule — delete the entry',
    });
  }
}

// --- Report -----------------------------------------------------------------
const counts = { primitive: 0, semantic: 0, component: 0, unknown: 0 };
for (const t of tokens) counts[TIER_OF[t.segments[0]] ?? 'unknown']++;

const described = tokens.filter((t) => TIER_OF[t.segments[0]] !== 'primitive' && t.description).length;

console.log('Token grammar — tokens.json');
console.log('─'.repeat(72));
console.log(`  primitive  ${String(counts.primitive).padStart(4)}`);
console.log(`  semantic   ${String(counts.semantic).padStart(4)}`);
console.log(
  `  component  ${String(counts.component).padStart(4)}   ` +
    (counts.component === 0 ? '(tier reserved by ADR-0004, still empty)' : '(third tier, ADR-0004)'),
);
if (counts.unknown) console.log(`  unknown    ${String(counts.unknown).padStart(4)}`);
console.log(`  ${'total'.padEnd(10)} ${String(tokens.length).padStart(4)}   in ${groupsSeen.length} groups`);
console.log('');
console.log(`  aliases resolved            ${tokens.filter((t) => aliasTarget(t.value) !== null).length}`);
console.log(`  grammar exceptions excused  ${exceptions.exceptions.length}`);
console.log(
  `  non-primitive tokens with a $description  ${described}/${counts.semantic + counts.component}` +
    '   (informational — DESIGN_HANDOFF A1 wants all of them)',
);
console.log('─'.repeat(72));

if (problems.length) {
  console.error(`\n${problems.length} grammar problem(s):\n`);
  for (const p of problems) console.error(`  FAIL  ${p.path}  [${p.rule}]  ${p.detail}`);
  console.error('\nFix the token, or record the deviation in token-grammar-exceptions.json with a reason.');
  process.exit(1);
}

console.log('\nOK — 0 grammar problems, 0 dangling references.');
