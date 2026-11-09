#!/usr/bin/env node
// Contrast gate — WCAG 2.1 relative luminance, the same maths as
// kodera-visio/scripts/check-contrast.py, run over contrast-pairs.json.
//
// The five ways a contrast suite lies, and what stops each here:
//
//   A translucent colour is measured as if it were opaque.  Every foreground
//     is composited onto its background before it is measured, at whatever
//     alpha the colour itself carries. There is no per-row field to omit and
//     no branch to skip: the focus ring's halo reports 6.70:1 read as opaque
//     cobalt and the 1.78:1 it actually paints once composited, and that
//     difference is the whole distance between an indicator that satisfies
//     SC 1.4.11 and one that only says it does.
//   A colour the build composes is not measured at all.  A `spec:` reference
//     reads the ring out of scripts/lib/spec.mjs by role — the tone against
//     the control, the tone against the background — so these rows measure the
//     ring that ships. A geometry change moves the rows with it; it cannot
//     leave them describing a ring that is no longer there. ADR-0002.
//   A renamed token silently empties the suite.  An unresolvable pair is a
//     hard FAIL, never a skipped row.
//   A failure is "temporarily" tolerated and nobody remembers.  A failing pair
//     must be listed in contrast-known-failures.json with a written reason, and
//     an entry whose pair now passes fails the gate so the file cannot rot.
//   An excuse outlives the pair it was written for.  Each allowlist entry is
//     bound to the pair's `fg`, `bg` and `min`, and to the ratio it was written
//     at. A pair re-pointed at other tokens or at another `spec:` role, a
//     loosened minimum, or a colour that moved in either direction since the
//     ruling fails the gate instead of quietly inheriting the old reason. That
//     is the same rule as the line above, applied while the pair is still
//     failing: an entry stops covering a pair the moment the pair stops being
//     the one it describes, and an entry whose pair clears its minimum is
//     deleted rather than re-measured. A minimum loosened far enough for the
//     pair to clear it lands there too, reported as an entry to delete rather
//     than as a loosened bound; the split is at the minimum, so only one of the
//     two ever fires on a row.
//     test/check-contrast.selftest.mjs mutates one of them per test and asserts
//     the note the gate prints, not the exit code. On a row addressed by a
//     token path it covers every one: the `fg` binding, the `bg` binding, a
//     loosened minimum, drift in either direction, a missing `reason`, a
//     missing `decision`, and both routes to a pair that clears — a colour that
//     improved, and a minimum loosened far enough. Those last two run on an
//     exempt row, the half of that branch under which a stale entry looks
//     harmless; `exempt` picks the verdict label there and nothing else. On a
//     row addressed by a `spec:` role it covers the seam the roles opened: the
//     `fg` binding, against the literal the role paints and against another
//     role, and drift in either direction. The `bg` binding, the minimum and
//     the missing `reason` and `decision` are not repeated there — each
//     compares two fields of the row without reading the composed colour, so a
//     role-addressed copy would re-run the token-path test over the same lines
//     of the gate.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadTokens, indexTokens, resolve, parseColor, composite, contrastRatio, toHex } from './lib/tokens.mjs';
import { SPEC_COLORS } from './lib/spec.mjs';

const tree = loadTokens();
const index = indexTokens(tree);

const { pairs } = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));

const allowFile = join(ROOT, 'contrast-known-failures.json');
const allowlist = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : { failures: [] };
const allowed = new Map(allowlist.failures.map((f) => [f.id, { ...f, used: false }]));

/** How far a measured ratio may drift from the one an entry was written at. */
const RATIO_SLACK = 0.05;

/**
 * Why an allowlist entry does not cover the pair it names, or null when it
 * does. Every field an entry carries is checked, so the entry describes the
 * pair as measured today, not the pair as it was when someone wrote the excuse.
 *
 * Reached only for a pair that is still below its minimum. A pair that has
 * started passing is refused earlier, by the rule that an entry cannot outlive
 * the problem it describes; the two are one rule split at the minimum, not two
 * verdicts on the same row. `fgAlpha` is not among the fields checked because
 * no row carries one: compositing is unconditional and the alpha travels with
 * the colour (ADR-0002), so an entry has nothing to be bound to there.
 */
function bindingProblem(excuse, pair, ratio) {
  if (!excuse.reason || !excuse.reason.trim()) return 'contrast-known-failures.json entry has no reason';
  if (!excuse.decision || !excuse.decision.trim()) return 'contrast-known-failures.json entry has no decision';
  for (const key of ['fg', 'bg']) {
    if ((excuse[key] ?? null) !== (pair[key] ?? null)) {
      return (
        `contrast-known-failures.json entry was written for ${key} ${JSON.stringify(excuse[key] ?? null)} ` +
        `but the pair now measures ${key} ${JSON.stringify(pair[key] ?? null)} — a different pair, not the one excused`
      );
    }
  }
  if (excuse.min !== pair.min) {
    return `contrast-known-failures.json entry was written for min ${excuse.min}, the pair now requires ${pair.min}`;
  }
  if (typeof excuse.ratio !== 'number') return 'contrast-known-failures.json entry records no ratio';
  if (ratio < excuse.ratio - RATIO_SLACK) {
    return (
      `measures ${ratio.toFixed(2)}, worse than the ${excuse.ratio.toFixed(2)} the entry was written for — ` +
      'the colour moved under the excuse; decide the new value, do not inherit the old reason'
    );
  }
  if (ratio > excuse.ratio + RATIO_SLACK) {
    return (
      `measures ${ratio.toFixed(2)}, not the ${excuse.ratio.toFixed(2)} the entry was written for — ` +
      'the colour moved; re-read the ruling and record the ratio it now covers. Once it clears the ' +
      'minimum the entry is deleted, not re-measured'
    );
  }
  return null;
}

/** A `spec:` role, a token path, or a literal colour, resolved to `{r, g, b, a}`. */
function colorOf(ref) {
  if (typeof ref === 'string' && ref.startsWith('spec:')) {
    const role = SPEC_COLORS[ref];
    // Not a fall-through to token resolution: a misspelt role that quietly
    // became a dangling token path would read as the wrong kind of mistake.
    if (!role) throw new Error(`unknown spec reference "${ref}" — the roles are ${Object.keys(SPEC_COLORS).join(', ')}`);
    return role(index);
  }
  if (typeof ref === 'string' && (ref.startsWith('#') || ref.startsWith('rgb'))) return parseColor(ref);
  return parseColor(resolve(ref, index));
}

const rows = [];
let hardFailures = 0;

for (const pair of pairs) {
  const row = { ...pair, ratio: null, verdict: null, note: '' };

  try {
    const bg = colorOf(pair.bg);
    // A translucent background would be measured as the colour behind it and
    // nothing would say so — the same silence this gate exists to break.
    if ((bg.a ?? 1) < 1) {
      throw new Error(`background "${pair.bg}" is translucent; a row measures against what is actually painted there`);
    }
    // Unconditional. A row cannot opt out of compositing, because the one that
    // did is how a 1.78:1 focus ring passed at 6.70:1.
    const fg = composite(colorOf(pair.fg), bg);
    row.fgHex = toHex(fg);
    row.bgHex = toHex(bg);
    row.ratio = contrastRatio(fg, bg);
  } catch (error) {
    // Not a SKIP. A row that cannot be measured is a row that is not guarding
    // anything, and a suite of unmeasurable rows exits 0 on every palette.
    row.verdict = 'FAIL';
    row.note = error.message;
    hardFailures++;
    rows.push(row);
    continue;
  }

  const clears = row.ratio >= pair.min;

  if (pair.expect === 'fail') {
    if (clears) {
      row.verdict = 'FAIL';
      row.note = 'forbidden pair now clears its minimum — the palette moved under the rule; update DESIGN_SYSTEM.md §2 or this row';
      hardFailures++;
    } else {
      row.verdict = 'FORBIDDEN';
      row.note = 'stays below the minimum, as the rule requires';
    }
    rows.push(row);
    continue;
  }

  const excuse = allowed.get(pair.id);

  if (clears) {
    row.verdict = pair.exempt ? 'EXEMPT' : 'PASS';
    if (excuse) {
      excuse.used = true;
      row.verdict = 'FAIL';
      row.note = 'listed in contrast-known-failures.json but the pair passes now — delete the entry';
      hardFailures++;
    }
    rows.push(row);
    continue;
  }

  // Below the minimum. Exempt or not, it needs a written reason on file.
  if (!excuse) {
    row.verdict = 'FAIL';
    row.note = pair.exempt
      ? 'exempt rows still need an entry in contrast-known-failures.json saying why'
      : 'below the minimum and not in contrast-known-failures.json';
    hardFailures++;
    rows.push(row);
    continue;
  }

  excuse.used = true;
  const problem = bindingProblem(excuse, pair, row.ratio);
  if (problem) {
    row.verdict = 'FAIL';
    row.note = problem;
    hardFailures++;
  } else {
    row.verdict = pair.exempt ? 'EXEMPT' : 'ALLOWED';
    row.note = excuse.reason;
  }
  rows.push(row);
}

// An allowlist entry naming a pair that no longer exists is a stale exemption
// waiting to cover a different failure.
const orphans = [...allowed.values()].filter((f) => !f.used);

// --- Report -----------------------------------------------------------------
const w = (s, n) => String(s).padEnd(n);
const COL = { id: 36, fg: 9, bg: 9, ratio: 7, min: 5, verdict: 10 };

console.log('Contrast gate — WCAG 2.1, contrast-pairs.json over tokens.json');
console.log('='.repeat(112));
console.log(
  `${w('pair', COL.id)}${w('fg', COL.fg)}${w('bg', COL.bg)}${w('ratio', COL.ratio)}${w('min', COL.min)}${w('verdict', COL.verdict)}label`,
);
console.log('-'.repeat(112));

for (const row of rows) {
  const ratio = row.ratio === null ? '—' : row.ratio.toFixed(2);
  console.log(
    `${w(row.id, COL.id)}${w(row.fgHex ?? '—', COL.fg)}${w(row.bgHex ?? '—', COL.bg)}` +
      `${w(ratio, COL.ratio)}${w(row.min.toFixed(1), COL.min)}${w(row.verdict, COL.verdict)}${row.label}`,
  );
  if (row.note && row.verdict !== 'FORBIDDEN') console.log(`${' '.repeat(COL.id)}↳ ${row.note}`);
}

const tally = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
console.log('='.repeat(112));
console.log(
  `${rows.length} pairs — ` +
    ['PASS', 'ALLOWED', 'EXEMPT', 'FORBIDDEN', 'FAIL']
      .map((v) => `${tally[v] ?? 0} ${v.toLowerCase()}`)
      .join(', '),
);

if (orphans.length) {
  console.error('\nStale entries in contrast-known-failures.json (no pair carries that id):');
  for (const o of orphans) console.error(`  FAIL  ${o.id}`);
}

if (hardFailures || orphans.length) {
  console.error(
    `\n${hardFailures + orphans.length} contrast problem(s). Fix the token, or add the pair to ` +
      'contrast-known-failures.json with a reason. Nothing here passes by being quiet.',
  );
  process.exit(1);
}

console.log('\nOK — every pair either clears its minimum or carries a written reason.');
