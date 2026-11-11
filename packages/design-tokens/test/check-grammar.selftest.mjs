// Self-test for the grammar gate itself.
//
// The gate is the one place a token's shape is decided, so it is the one place
// a malformed token can be let through by a rule that was widened to admit a
// new kind. Each test below copies the gate and its inputs into a scratch
// directory, breaks exactly one thing, and asserts the gate goes red for that
// reason. The refusals were written before the tiers they guard: a rule that is
// only ever seen passing is a rule nobody has seen work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib/tokens.mjs';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));

/** Run the gate over a mutated copy of tokens.json; nothing else changes. */
function gate(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grammar-selftest-'));
  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'token-grammar-exceptions.json'), join(dir, 'token-grammar-exceptions.json'));
    const copy = structuredClone(tree);
    edit(copy);
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify(copy));
    const result = spawnSync(process.execPath, ['scripts/check-grammar.mjs'], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
/** The gate's own report line for one problem: `FAIL  path  [rule]  detail`. */
const problem = (path, rule, detail = '') => new RegExp(`^  FAIL  ${rx(path)}  \\[${rx(rule)}\\]  ${detail}`, 'm');

/** Break one thing, and assert the gate fails for each expected reason. */
function refuses(name, edit, expected) {
  test(name, () => {
    const { status, output } = gate(edit);
    assert.equal(status, 1, `the gate exited ${status} instead of failing:\n${output}`);
    for (const pattern of [expected].flat()) {
      assert.match(output, pattern, `the gate failed, but not for the reason under test:\n${output}`);
    }
  });
}

test('an untouched copy of the gate and its source passes', () => {
  const { status, output } = gate();
  assert.equal(status, 0, output);
  assert.match(output, /OK — 0 grammar problems, 0 dangling references\./);
});

// --- The closed grammar ------------------------------------------------------
refuses(
  'a token under a root group the grammar does not list is refused',
  (t) => (t.sky = { $type: 'color', zenith: { $value: '#BBD7F5' } }),
  problem('sky.zenith', 'root-group', '"sky" is not one of '),
);

refuses(
  'a fifth path segment is refused: a tier is addressed in at most four',
  (t) => (t.semantic.surface.glass = { bar: { tint: { $value: '{color.white}' } } }),
  problem('semantic.surface.glass.bar.tint', 'depth', '5 segments, the grammar allows at most 4'),
);

refuses(
  'a literal in the semantic tier is refused: only a primitive holds a value',
  (t) => (t.semantic.surface.glass = { $value: 'rgba(255, 255, 255, 0.72)' }),
  problem('semantic.surface.glass', 'tier', 'semantic token holds a literal value; it must reference another token'),
);

refuses(
  'a component token that skips the semantic tier is refused',
  (t) => (t.component.shell.glass = { $type: 'color', $value: '{color.white}' }),
  problem('component.shell.glass', 'tier', 'component token references "color\\.white"; it must reference a semantic token'),
);

// --- A material, before the grammar has a tier for one -------------------------
// Refused today because nothing called `material` exists. The tier that admits a
// well-formed material must keep refusing this one, for a reason of its own.
refuses(
  'a material that is not a complete composite is refused',
  (t) => (t.material = { $type: 'material', 'theme-light': { bar: { $value: { tint: '#FFFFFF', alpha: 2 } } } }),
  /^  FAIL  material\.theme-light\.bar  \[/m,
);
