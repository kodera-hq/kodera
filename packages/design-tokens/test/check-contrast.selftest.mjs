// Self-test for the contrast gate itself.
//
// The gate's allowlist is the one place a failing pair is tolerated on purpose,
// so it is the one place a failure can hide. Each test below copies the gate
// and its inputs into a scratch directory, breaks exactly one thing, and
// asserts the gate goes red for that reason and no other. A gate nobody has
// seen fail is a decoration; this file is where each way it must fail, fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SPEC_COLORS } from '../scripts/lib/spec.mjs';
import { composite, contrastRatio, indexTokens, loadTokens, luminance, parseColor, resolve, toHex } from '../scripts/lib/tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['tokens.json', 'contrast-pairs.json', 'contrast-known-failures.json'];

/** A literal as a RegExp fragment. Every occurrence, not just the first one. */
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The report line for `id`, measuring `ratio` — the gate's own printed number. */
const measures = (id, ratio) => new RegExp(`^${rx(id)}\\s+\\S+\\s+\\S+\\s+${rx(ratio.toFixed(2))}\\s`, 'm');

/** A throwaway copy of the gate and everything it reads; nothing else. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'contrast-selftest-'));
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  for (const file of INPUTS) cpSync(join(ROOT, file), join(dir, file));
  return dir;
}

function runGate(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-contrast.mjs')], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const writeJson = (dir, file, data) => writeFileSync(join(dir, file), JSON.stringify(data, null, 2));

/**
 * Break one thing with `mutate`, run the gate, assert it fails and says why.
 *
 * `expected` is one pattern or several, all of which must appear. `absent` is
 * the same for a note the gate must NOT print: the verdict it would reach if it
 * read the mutation as some other kind of problem. A test that only asserts the
 * note it wants cannot tell "the gate said this" from "the gate said this among
 * other things".
 */
function assertFailsFor(name, mutate, expected, absent = []) {
  test(name, () => {
    const dir = scratch();
    try {
      mutate(dir);
      const { status, output } = runGate(dir);
      assert.equal(status, 1, `the gate exited ${status} instead of failing:\n${output}`);
      for (const pattern of [expected].flat()) {
        assert.match(output, pattern, `the gate failed, but not for the reason under test:\n${output}`);
      }
      for (const pattern of [absent].flat()) {
        assert.doesNotMatch(output, pattern, `the gate also failed for a reason this mutation must not reach:\n${output}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** An allowlisted pair whose ratio stays below its minimum through the mutation. */
function excusedPair(dir, id) {
  const pair = readJson(dir, 'contrast-pairs.json').pairs.find((p) => p.id === id);
  const entry = readJson(dir, 'contrast-known-failures.json').failures.find((f) => f.id === id);
  assert.ok(pair && entry, `${id} must be a pair with an allowlist entry for this test to mean anything`);
  return { pair, entry };
}

const editPairs = (dir, edit) => {
  const data = readJson(dir, 'contrast-pairs.json');
  edit(data.pairs);
  writeJson(dir, 'contrast-pairs.json', data);
};
const editAllowlist = (dir, edit) => {
  const data = readJson(dir, 'contrast-known-failures.json');
  edit(data.failures);
  writeJson(dir, 'contrast-known-failures.json', data);
};

test('an untouched copy of the gate and its inputs passes', () => {
  const dir = scratch();
  try {
    const { status, output } = runGate(dir);
    assert.equal(status, 0, output);
    assert.match(output, /OK — every pair either clears its minimum or carries a written reason/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The first allowlisted row, whichever it is on this branch: the seven
// mutations that follow need a pair that fails its minimum and carries an
// excuse, not a specific colour. It has to be addressed by token path, because
// one of them moves the colour itself; a `spec:` row's colour is composed in
// scripts/lib/spec.mjs and there is no token to edit.
//
// That is a limit of these seven mutations, not of the gate. The other half of
// the binding — a row addressed by a `spec:` role, which is the half that only
// exists at all since the roles landed — is mutated further down this file,
// against a subject built for it.
const TOKEN_PATH_SUBJECT = () => {
  const entry = readJson(ROOT, 'contrast-known-failures.json').failures[0];
  assert.ok(
    !String(entry.fg).startsWith('spec:'),
    `${entry.id} is allowlisted by a spec: role; these mutations edit tokens.json and cannot move it`,
  );
  return entry.id;
};

assertFailsFor(
  'a pair re-pointed at a different background keeps its id but loses its excuse',
  (dir) => {
    const { pair } = excusedPair(dir, TOKEN_PATH_SUBJECT());
    // Any other opaque surface on which the pair STILL fails: the excuse names a
    // pair, and this is not it. Re-pointing it at a surface where it clears
    // would be reported as an entry to delete instead, which is a different
    // reason; which surfaces qualify depends on the subject's own ink.
    const index = indexTokens(readJson(dir, 'tokens.json'));
    const fg = parseColor(resolve(pair.fg, index));
    const other = ['semantic.surface.inverse', 'semantic.surface.default', 'semantic.surface.muted'].find(
      (bg) => bg !== pair.bg && contrastRatio(fg, parseColor(resolve(bg, index))) < pair.min,
    );
    assert.ok(other, `${pair.id}: no other surface keeps the pair failing, so a re-pointed pair cannot be built`);
    editPairs(dir, (pairs) => {
      pairs.find((p) => p.id === pair.id).bg = other;
    });
  },
  /written for bg .* but the pair now measures bg .* a different pair, not the one excused/,
);

assertFailsFor(
  'an allowlist entry that names a different foreground than the pair it excuses fails',
  (dir) => {
    editAllowlist(dir, (failures) => {
      failures.find((f) => f.id === TOKEN_PATH_SUBJECT()).fg = 'semantic.text.primary';
    });
  },
  /written for fg "semantic\.text\.primary" but the pair now measures fg .* a different pair, not the one excused/,
);

assertFailsFor(
  'loosening a pair\'s minimum does not let its old excuse stand',
  (dir) => {
    const { pair } = excusedPair(dir, TOKEN_PATH_SUBJECT());
    editPairs(dir, (pairs) => {
      // Still failing after the loosening, so the binding check is what fires.
      pairs.find((p) => p.id === pair.id).min = pair.min - 0.1;
    });
  },
  /written for min [\d.]+, the pair now requires [\d.]+/,
);

assertFailsFor(
  'a colour that got worse since the ruling is not covered by the ruling',
  (dir) => {
    const { pair } = excusedPair(dir, TOKEN_PATH_SUBJECT());
    // Push the foreground towards the background: same pair, worse ratio. The
    // new ink is the old one with 60 % of the background laid over it, so the
    // move is derived from the subject rather than a literal tuned to one ink.
    //
    // The literal lands on the pair's OWN token, not on the ramp step it
    // aliases. Following the alias would move a shared primitive and drag
    // unrelated gated rows that read it below their minimum, so the gate would
    // go red partly for a reason this test is not about.
    const tokens = readJson(dir, 'tokens.json');
    const index = indexTokens(tokens);
    const fg = parseColor(resolve(pair.fg, index));
    const bg = parseColor(resolve(pair.bg, index));
    const path = pair.fg.split('.');
    let node = tokens;
    for (const key of path) node = node[key];
    node.$value = toHex(composite({ ...bg, a: 0.6 }, fg));
    writeJson(dir, 'tokens.json', tokens);
  },
  /worse than the [\d.]+ the entry was written for/,
);

assertFailsFor(
  'a recorded ratio that no longer matches what is measured fails until it is re-read',
  (dir) => {
    editAllowlist(dir, (failures) => {
      failures.find((f) => f.id === TOKEN_PATH_SUBJECT()).ratio -= 1;
    });
  },
  /not the [\d.]+ the entry was written for — the colour moved; re-read the ruling/,
);

assertFailsFor(
  'an entry with no decision is not a ruling',
  (dir) => {
    editAllowlist(dir, (failures) => {
      delete failures.find((f) => f.id === TOKEN_PATH_SUBJECT()).decision;
    });
  },
  /entry has no decision/,
);

assertFailsFor(
  'an entry with no reason is not an excuse',
  (dir) => {
    editAllowlist(dir, (failures) => {
      failures.find((f) => f.id === TOKEN_PATH_SUBJECT()).reason = '   ';
    });
  },
  /entry has no reason/,
);

// --- Rows addressed by a `spec:` role ---------------------------------------
//
// Everything above moves a row addressed by a token path. A row addressed by a
// role is the seam the binding has to cover as well: its colour is composed in
// scripts/lib/spec.mjs, so re-pointing it at the literal that role paints today
// leaves the ratio untouched and only the `fg` binding can see that the row has
// stopped following the spec. No shipped row is both role-addressed and
// allowlisted — the ring clears its minimums — so the subject is built in the
// scratch copy rather than borrowed from the repository. Building it is setup
// and not one of the breaks: the test right below it holds that state to the
// same bar as the untouched tree, so each mutation after it is still the only
// thing wrong when the gate goes red.
const ROLE_SUBJECT = 'focus-ring/surface.default';
const ROLE_SUBJECT_FG = 'spec:focus-ring.light.indicator';
const ROLE_SUBJECT_BG = 'semantic.surface.default';
// The scratch ruling's two numbers: what the light ring's indicator measures on
// white today, and a minimum it does not clear. Written out rather than derived,
// because the baseline test below holds them to what the gate measures — a ring
// that moves makes that test red, which is this file being re-stated rather
// than drifting.
const ROLE_SUBJECT_RATIO = 8.07;
const ROLE_SUBJECT_MIN = 9.0;

/**
 * Make the role-addressed ring row a failing, excused row inside `dir`: the
 * indicator measures 8.07:1 on white, so a minimum of 9 puts it below the bar
 * without touching a single colour. What the four mutations below then break
 * is the binding, not the measurement.
 */
function excuseRoleAddressedRow(dir) {
  const pair = readJson(dir, 'contrast-pairs.json').pairs.find((p) => p.id === ROLE_SUBJECT);
  assert.equal(
    pair?.fg,
    ROLE_SUBJECT_FG,
    `${ROLE_SUBJECT} must still be addressed by a spec: role for these tests to mean anything`,
  );
  assert.equal(pair?.bg, ROLE_SUBJECT_BG, `${ROLE_SUBJECT} must still be measured against ${ROLE_SUBJECT_BG}`);
  editPairs(dir, (pairs) => {
    pairs.find((p) => p.id === ROLE_SUBJECT).min = ROLE_SUBJECT_MIN;
  });
  editAllowlist(dir, (failures) => {
    failures.push({
      id: ROLE_SUBJECT,
      fg: ROLE_SUBJECT_FG,
      bg: ROLE_SUBJECT_BG,
      ratio: ROLE_SUBJECT_RATIO,
      min: ROLE_SUBJECT_MIN,
      reason: 'Scratch-only: the ring held to a minimum this copy invents for it.',
      decision: 'Scratch-only, and deleted with the scratch directory.',
    });
  });
}

/**
 * The colour `ROLE_SUBJECT_FG` composes to on `ROLE_SUBJECT_BG`, read through
 * the same role map the gate reads and composited the same way.
 *
 * Derived rather than typed. A hex typed here stops describing the role the
 * moment the palette moves, and the mutation below would then be re-pointing
 * the row at a colour the ring no longer paints while its own comment still
 * said the colour had not moved — a test passing on a premise that is false.
 */
function indicatorHex() {
  const index = indexTokens(loadTokens());
  const bg = parseColor(resolve(ROLE_SUBJECT_BG, index));
  return toHex(composite(SPEC_COLORS[ROLE_SUBJECT_FG](index), bg));
}

test('the role-addressed subject is green before anything is broken', () => {
  const dir = scratch();
  try {
    excuseRoleAddressedRow(dir);
    const { status, output } = runGate(dir);
    assert.equal(status, 0, `the subject itself fails the gate, so the mutations below prove nothing:\n${output}`);
    assert.match(output, new RegExp(`${rx(ROLE_SUBJECT)}.*ALLOWED`));
    // Not just green: green measuring what the scratch ruling says it measures.
    assert.match(output, measures(ROLE_SUBJECT, ROLE_SUBJECT_RATIO));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

assertFailsFor(
  'a role-addressed pair re-pointed at the literal that role paints today loses its excuse',
  (dir) => {
    excuseRoleAddressedRow(dir);
    // The colour does not move: the literal is read out of the role itself, so
    // the row still measures ROLE_SUBJECT_RATIO and the two ratio arms have
    // nothing to report. What changed is that the row no longer reads
    // scripts/lib/spec.mjs — a geometry change would leave it behind, which is
    // the lie the roles exist to stop — and only the `fg` binding can say so.
    //
    // That premise is asserted rather than stated: the second pattern below is
    // the gate's own measurement of the re-pointed row, so a palette that moved
    // out from under this test turns it red instead of letting it isolate the
    // `fg` binding by accident, with the colour moving alongside the reference.
    editPairs(dir, (pairs) => {
      pairs.find((p) => p.id === ROLE_SUBJECT).fg = indicatorHex();
    });
  },
  [
    new RegExp(
      `written for fg "${rx(ROLE_SUBJECT_FG)}" but the pair now measures fg "${rx(indicatorHex())}" ` +
        '— a different pair, not the one excused',
    ),
    measures(ROLE_SUBJECT, ROLE_SUBJECT_RATIO),
  ],
);

assertFailsFor(
  'a role-addressed pair re-pointed at another `spec:` role loses its excuse too',
  (dir) => {
    excuseRoleAddressedRow(dir);
    // The ring's other tone: still composed, still a real role, still not the
    // one the ruling was written about.
    editPairs(dir, (pairs) => {
      pairs.find((p) => p.id === ROLE_SUBJECT).fg = 'spec:focus-ring.light.outer';
    });
  },
  /written for fg "spec:focus-ring\.light\.indicator" but the pair now measures fg "spec:focus-ring\.light\.outer" — a different pair, not the one excused/,
);

assertFailsFor(
  'a colour the build composes, moved since the ruling, is not covered by the ruling',
  (dir) => {
    excuseRoleAddressedRow(dir);
    // The literal lands on the light ring's own source token — the role
    // SPEC.focusRing.variants names for a normal ground — not on the ramp step
    // it aliases, for the same reason as the token-path mutation above: moving
    // a shared primitive drags unrelated gated rows with it.
    //
    // The value it moves to is the cobalt the ring carried while it was
    // unthemed, so the mutation is the regression itself: the indicator goes
    // from 8.07 to 6.70 on white, and every other row that reads this token
    // stays above its own minimum, which keeps the gate red for one reason.
    const tokens = readJson(dir, 'tokens.json');
    tokens.semantic.theme.light['accent-ink'].$value = '#2B4BDB';
    writeJson(dir, 'tokens.json', tokens);
  },
  /measures 6\.70, worse than the 8\.07 the entry was written for/,
);

assertFailsFor(
  'a recorded ratio the composed colour has outgrown fails on a role-addressed row too',
  (dir) => {
    excuseRoleAddressedRow(dir);
    // The mirror of the token-path mutation of the same shape, on the half
    // where the colour is composed rather than resolved. Nothing moves but the
    // number the ruling records, and it moves the way that leaves the row still
    // failing: the measurement is now ABOVE the recorded ratio, which is the
    // arm that reads as harmless — the pair got better — and is the arm a gate
    // relaxed "because a composed colour cannot be held to a number" drops.
    editAllowlist(dir, (failures) => {
      failures.find((f) => f.id === ROLE_SUBJECT).ratio -= 1;
    });
  },
  new RegExp(
    `measures ${rx(ROLE_SUBJECT_RATIO.toFixed(2))}, not the ${rx((ROLE_SUBJECT_RATIO - 1).toFixed(2))} ` +
      'the entry was written for — the colour moved; re-read the ruling',
  ),
);

// --- A pair that has come to clear its minimum ------------------------------
//
// The `clears` branch of scripts/check-contrast.mjs is the one that refuses an
// entry without reading a single one of its fields: the pair passes, so there
// is nothing left to excuse and the entry is deleted rather than re-measured.
// Both routes into it are mutated below, because the second is an ordering
// claim as much as a verdict — a loosened minimum arrives here before the `min`
// binding can report it as a loosened bound, and the two notes contradict each
// other about the same row.
//
// The subject is an exempt row on purpose. Exempt is the half that reads as
// "excused anyway, so the entry does no harm", which is what an entry left
// standing under a row that passes always looks like from the inside.
const EXEMPT_SUBJECT = () => {
  const { pairs } = readJson(ROOT, 'contrast-pairs.json');
  const entry = readJson(ROOT, 'contrast-known-failures.json').failures.find(
    (f) => pairs.find((p) => p.id === f.id)?.exempt,
  );
  assert.ok(entry, 'these mutations need an allowlisted row that contrast-pairs.json marks exempt');
  return entry.id;
};

assertFailsFor(
  'an entry whose pair has started passing is deleted, not re-measured',
  (dir) => {
    const { pair } = excusedPair(dir, EXEMPT_SUBJECT());
    // Take the pair's foreground to the far end of the scale from its own
    // background, so the row clears by a distance no rounding argument reaches.
    // The literal lands on the ROW, not on a token: the subject's ink is shared
    // with other gated rows (the disabled-label entry reads action.onPrimary,
    // which the primary button's label rows read too), and moving the token
    // would fail those rows and keep the gate red whatever this branch did.
    const bg = parseColor(resolve(pair.bg, indexTokens(readJson(dir, 'tokens.json'))));
    editPairs(dir, (pairs) => {
      pairs.find((p) => p.id === pair.id).fg = luminance(bg) > 0.18 ? '#000000' : '#FFFFFF';
    });
  },
  [
    /listed in contrast-known-failures\.json but the pair passes now — delete the entry/,
    // Nothing else may be red, or the exit status proves nothing about this branch:
    // the summary must count exactly one problem, this one.
    /^1 contrast problem\(s\)/m,
  ],
);

assertFailsFor(
  'a minimum loosened far enough for the pair to clear is an entry to delete, not a loosened bound',
  (dir) => {
    const { pair } = excusedPair(dir, EXEMPT_SUBJECT());
    editPairs(dir, (pairs) => {
      // 1.0 is the floor of the ratio scale — identical colours — so the pair
      // clears whatever it happens to measure, and the loosening is the only
      // thing that put it there.
      pairs.find((p) => p.id === pair.id).min = 1.0;
    });
  },
  /listed in contrast-known-failures\.json but the pair passes now — delete the entry/,
  // Not "written for min X, the pair now requires Y". That note is the binding
  // check, and the binding check is never reached: the split is at the minimum,
  // so a pair that clears is a deletion and never also a loosened bound.
  /the pair now requires/,
);
