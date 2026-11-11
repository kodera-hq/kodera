#!/usr/bin/env node
// `npm test` — the four gates, in the order that makes a failure readable.
//
//   grammar   tokens.json is valid DTCG and follows the naming grammar
//   contrast  every declared pair clears its minimum or carries a reason
//   drift     dist/ is exactly what tokens.json generates
//   units     the token-resolution guard, the grammar gate's own self-test,
//             CSS parity with the design drop, the
//             colour maths the contrast gate rests on, the control rings, the
//             worst-case bound for a translucent background, the
//             contrast gate's own self-test (each way it must fail, fails),
//             the theme registry every generator reads,
//             the shell themes' own contract, elevation and breakpoints, and
//             the Givre & Nuit properties (no gradient, dark steps, rail, radii),
//             and the Sky Glass family's foundation contract
//
// Every gate runs even when an earlier one fails, so one command tells you
// everything that is wrong rather than one thing at a time.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const gates = [
  ['grammar', ['scripts/check-grammar.mjs']],
  ['contrast', ['scripts/check-contrast.mjs']],
  ['drift', ['scripts/build.mjs', '--check']],
  [
    'units',
    [
      '--test',
      '--test-reporter=spec',
      'test/token-test.selftest.mjs',
      'test/check-grammar.selftest.mjs',
      'test/css-parity.selftest.mjs',
      'test/color-math.selftest.mjs',
      'test/control-selection-ring.selftest.mjs',
      'test/backdrop-contrast.selftest.mjs',
      'test/check-contrast.selftest.mjs',
      'test/theme-registry.selftest.mjs',
      'test/theme-contract.selftest.mjs',
      'test/elevation-breakpoints.selftest.mjs',
      'test/cursor-and-tag-palettes.selftest.mjs',
      'test/native-generation.selftest.mjs',
      'test/givre-nuit.selftest.mjs',
      'test/sky-glass.selftest.mjs',
    ],
  ],
];

const failed = [];

for (const [name, args] of gates) {
  console.log(`\n[1m── ${name} ${'─'.repeat(Math.max(0, 68 - name.length))}[0m\n`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}

console.log(`\n${'═'.repeat(72)}`);
if (failed.length) {
  console.error(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('All four gates green: grammar, contrast, drift, units.');
