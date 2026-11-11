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
function assertFailsFor(name, mutate, expected, absent = [], options = {}) {
  test(name, options, () => {
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

// --- A translucent background -----------------------------------------------
//
// The gate measures a foreground against what is painted behind it. A
// translucent background is not what is painted there: the colour a user sees
// depends on whatever lies underneath, and a row that named only the tint would
// be measured against a ground that never exists. So the row is refused — and
// it stays refused unless it says what can lie underneath, by naming a
// `backdropSet` of opaque extremes the gate then measures the worst case over.
//
// The refusals come first and are held on their own: no set at all, and each
// way a set can fail to be one — empty, a member that is itself translucent, a
// member that names no token, a name no set carries. Every one of them is the
// same row, a real ink on a 72 % white glass, so the only thing that differs
// between two cases is the binding under test.
const GLASS = 'rgba(255, 255, 255, 0.72)';
const GLASS_SUBJECT = 'scratch/ink/glass';
const glassRow = (extra = {}) => ({
  id: GLASS_SUBJECT,
  fg: 'semantic.theme.light.ink',
  bg: GLASS,
  label: 'scratch: ink on a translucent ground',
  min: 4.5,
  ...extra,
});
const addGlassRow = (extra) => (dir) => editPairs(dir, (pairs) => pairs.push(glassRow(extra)));
const editRegister = (dir, edit) => {
  const data = readJson(dir, 'contrast-pairs.json');
  edit(data);
  writeJson(dir, 'contrast-pairs.json', data);
};
/** Declare `backdropSets.scratch` beside the shipped sets. */
const declareSet = (set) => (dir) =>
  editRegister(dir, (data) => {
    data.backdropSets = { ...(data.backdropSets ?? {}), scratch: set };
  });
/** A set of the light theme: the page and its darkest tint, unless `members` says otherwise. */
const scratchSetOf = (members = ['semantic.theme.light.page', 'semantic.theme.light.muted-2'], extra = {}) => ({
  theme: 'light',
  purpose: 'Scratch-only: what this copy says can lie behind the scratch row.',
  members,
  ...extra,
});
/** The scratch row over a named scratch set of `members`: the one way a row says what lies behind it. */
const over = (members, row = {}, set = {}) => (dir) => {
  declareSet(scratchSetOf(members, set))(dir);
  addGlassRow({ backdropSet: 'scratch', ...row })(dir);
};
/** The scratch row's own report line, unmeasured and red, saying its ground is translucent. */
const UNMEASURED = new RegExp(`^${rx(GLASS_SUBJECT)}\\s+—\\s+—\\s+—\\s+4\\.5\\s+FAIL\\s`, 'm');
const REFUSED_AS_TRANSLUCENT = [UNMEASURED, new RegExp(`background "${rx(GLASS)}" is translucent`)];
const ONE_PROBLEM = /^1 contrast problem\(s\)/m;

assertFailsFor('a translucent background with no backdrop set is refused', addGlassRow(), [
  ...REFUSED_AS_TRANSLUCENT,
  /is translucent; a row measures against what is actually painted there — bind a backdropSet of opaque extremes/,
  ONE_PROBLEM,
]);

// A set that is not a set is a problem of its own, and the row bound to it is
// refused for the same reason: two lines, one cause.
assertFailsFor('a translucent background over an empty backdrop set is refused', over([]), [
  ...REFUSED_AS_TRANSLUCENT,
  /backdropSets\.scratch: the set is empty: with no extreme there is nothing to measure against/,
  /is translucent and backdropSet "scratch" is not a usable set: the set is empty/,
]);

assertFailsFor(
  'a translucent background over a backdrop that is itself translucent is refused',
  over(['semantic.theme.light.page', 'rgba(17, 24, 39, 0.5)']),
  [
    ...REFUSED_AS_TRANSLUCENT,
    /backdropSets\.scratch: the set member "rgba\(17, 24, 39, 0\.5\)" is not opaque: an extreme is a colour that is actually painted/,
    /is translucent and backdropSet "scratch" is not a usable set: the set member "rgba\(17, 24, 39, 0\.5\)" is not opaque/,
  ],
);

assertFailsFor(
  'a translucent background over a backdrop that names no token is refused',
  over(['semantic.theme.light.page', 'color.sky.nowhere']),
  [
    ...REFUSED_AS_TRANSLUCENT,
    /backdropSets\.scratch: the set member "color\.sky\.nowhere" does not resolve: dangling reference: "color\.sky\.nowhere" resolves to no token/,
    /is translucent and backdropSet "scratch" is not a usable set: the set member "color\.sky\.nowhere" does not resolve/,
  ],
);

assertFailsFor(
  'a translucent background bound to a backdrop set nobody declared is refused',
  addGlassRow({ backdropSet: 'nowhere' }),
  [
    ...REFUSED_AS_TRANSLUCENT,
    /is translucent and backdropSet "nowhere" is not declared; contrast-pairs\.json declares (no set|[a-z-]+(, [a-z-]+)*)$/m,
    ONE_PROBLEM,
  ],
);

assertFailsFor(
  'a backdrop set that is not a name is refused',
  addGlassRow({ backdropSet: { members: ['semantic.theme.light.page'] } }),
  [...REFUSED_AS_TRANSLUCENT, /is translucent and its backdropSet must be the name of a set declared under backdropSets/, ONE_PROBLEM],
);

// --- A translucent background over a declared backdrop set -------------------
//
// The way through. The numbers are written out, and scripts/lib/backdrop.mjs is
// held to them a second time in test/backdrop-contrast.selftest.mjs, without the
// gate around it: 72 % white over white is white, over muted-2 (#DCE6F0) it is
// #F5F8FA, and the ink measures 13.86:1 on the darker of the two.

/** Add rows (and optionally named sets), run the gate, and hand back what it printed. */
function gateWith(mutate) {
  const dir = scratch();
  try {
    mutate(dir);
    return runGate(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The scratch row's report line, measured and with this verdict. */
const glassVerdict = (ratio, verdict) =>
  new RegExp(`^${rx(GLASS_SUBJECT)}\\s+#[0-9A-F]{6}\\s+#[0-9A-F]{6}\\s+${rx(ratio.toFixed(2))}\\s+4\\.5\\s+${verdict}\\s`, 'm');

test('a translucent background is measured over the backdrop set it names, and held to the minimum', () => {
  const { status, output } = gateWith(over(['semantic.theme.light.page', 'semantic.theme.light.muted-2']));
  assert.equal(status, 0, output);
  assert.match(output, glassVerdict(13.86, 'PASS'));
  assert.match(output, /↳ minimum of 4 backgrounds over "scratch"; worst: the darkest any blend of the backdrops can be/);
  // One row more than the register holds, and it is counted as a pass.
  const shipped = readJson(ROOT, 'contrast-pairs.json').pairs.length;
  assert.match(output, new RegExp(`^${shipped + 1} pairs — \\d+ pass, 0 allowed, \\d+ exempt, \\d+ forbidden, 0 fail$`, 'm'));
});

// The extreme is the only thing that changes between these two runs. Tertiary
// ink on the same glass clears 4.5:1 while only the white page can lie behind
// it; say that the near-black rail can pass under it too, and the minimum
// becomes what it measures there.
const tertiaryOnGlass = (members) => over(members, { fg: 'semantic.theme.light.ink-3' });

test('the same row passes while only a light backdrop can lie behind it', () => {
  const { status, output } = gateWith(tertiaryOnGlass(['semantic.theme.light.page']));
  assert.equal(status, 0, output);
  assert.match(output, glassVerdict(5.7, 'PASS'));
});

assertFailsFor(
  'a backdrop extreme that pushes the minimum under the threshold fails the row',
  tertiaryOnGlass(['semantic.theme.light.page', 'semantic.theme.light.inverse']),
  [
    glassVerdict(3.06, 'FAIL'),
    /↳ minimum of 4 backgrounds over "scratch"; worst: the darkest any blend of the backdrops can be/,
    /↳ below the minimum and not in contrast-known-failures\.json/,
    ONE_PROBLEM,
  ],
);

assertFailsFor(
  'a foreground whose luminance lies between the backdrops has no minimum: a blend can match it',
  over(['#000000', '#FFFFFF'], { fg: '#777777', bg: 'rgba(255, 255, 255, 0.2)' }),
  [glassVerdict(1, 'FAIL'), /worst: a blend of the backdrops that matches the foreground/, ONE_PROBLEM],
);

assertFailsFor(
  'a translucent foreground on a translucent background is refused: the extremes do not bound it',
  over(['semantic.theme.light.page'], { fg: 'spec:focus-ring.light.outer' }),
  [/foreground "spec:focus-ring\.light\.outer" is translucent on the translucent background "rgba\(255, 255, 255, 0\.72\)"/, ONE_PROBLEM],
);

assertFailsFor(
  'a backdrop set bound under an opaque background measures nothing, and is refused',
  over(['semantic.theme.light.page'], { bg: 'semantic.theme.light.surface' }),
  [
    /background "semantic\.theme\.light\.surface" is opaque, so its backdropSet would measure nothing — remove the binding/,
    // The set is left unbound by the refusal, which is the second thing wrong with this register.
    /backdropSets\.scratch: declared, but no row binds it/,
  ],
);

// --- Stacked layers ----------------------------------------------------------
test('translucent layers stacked under the background are composited bottom first', () => {
  // A 90 % white sheet over the light scrim over the page or the rail: the
  // scrim darkens both ends before the sheet lightens them again.
  const { status, output } = gateWith(
    over(['semantic.theme.light.page', 'semantic.theme.light.inverse'], { bg: 'rgba(255, 255, 255, 0.9)', layers: ['semantic.theme.light.scrim'] }),
  );
  assert.equal(status, 0, output);
  assert.match(output, glassVerdict(12.17, 'PASS'));
});

assertFailsFor(
  'an opaque layer hides the backdrop, so it is refused as a layer',
  over(['semantic.theme.light.page'], { layers: ['semantic.theme.light.surface'] }),
  [/layer "semantic\.theme\.light\.surface" is opaque: it hides the backdrop, so bind it as the backdrop instead of stacking it/],
);

assertFailsFor(
  'an empty layer list is refused rather than read as no layers',
  over(['semantic.theme.light.page'], { layers: [] }),
  [/`layers` must be a non-empty list of translucent colours, bottom first/],
);

assertFailsFor(
  'layers declared under an opaque background are refused',
  addGlassRow({ bg: 'semantic.theme.light.surface', layers: ['semantic.theme.light.scrim'] }),
  [/background "semantic\.theme\.light\.surface" is opaque, so its layers would measure nothing — remove the binding/, ONE_PROBLEM],
);

// --- Named backdrop sets -----------------------------------------------------
const SCRATCH_SET = scratchSetOf();

assertFailsFor(
  'a named backdrop set no row binds is stale, and fails',
  declareSet(SCRATCH_SET),
  [/backdropSets\.scratch: declared, but no row binds it — delete the set or measure something over it/, ONE_PROBLEM],
);

assertFailsFor(
  'a named backdrop set with no purpose is not a set',
  over(undefined, {}, { purpose: ' ' }),
  [
    /backdropSets\.scratch: has no purpose: say what the extremes are the extremes of/,
    /is translucent and backdropSet "scratch" is not a usable set: has no purpose/,
    UNMEASURED,
  ],
);

assertFailsFor(
  'a named backdrop set that is not an object is not a set',
  (dir) => {
    declareSet(['semantic.theme.light.page'])(dir);
    addGlassRow({ backdropSet: 'scratch' })(dir);
  },
  [/backdropSets\.scratch: must be an object with a `theme`, a `purpose` and `members`/, UNMEASURED],
);

assertFailsFor(
  'a named backdrop set with no list of members is not a set',
  over(undefined, {}, { members: 'semantic.theme.light.page' }),
  [/backdropSets\.scratch: the set has no list of members/, UNMEASURED],
);

// --- Materials ---------------------------------------------------------------
//
// A material is the surface the stylesheet declares, read through the same
// module the build reads it with. Three things are specific to it, and each is
// broken once below: it is refused without a backdrop set like any other
// translucent ground; the set it binds must be its own theme's; and the opaque
// fallback it paints when the glass is off is a ground of its own, held to the
// same minimum.
const MATERIAL = 'semantic.material.ciel.bar';
const materialRow = (extra = {}) => glassRow({ bg: MATERIAL, ...extra });
/**
 * The register reduced to the scratch row: nothing else can be red, no set is
 * left unbound, no excuse is left orphaned. A theme whose set goes loses its
 * sky as well — flattened to its page — because a sky with no set is a refusal
 * of its own, and not the one under test.
 */
const onlyRow = (row, keepSets = []) => (dir) => {
  editRegister(dir, (data) => {
    data.pairs = [row];
    data.backdropSets = Object.fromEntries(Object.entries(data.backdropSets ?? {}).filter(([name]) => keepSets.includes(name)));
  });
  editAllowlist(dir, (failures) => failures.splice(0));
  const tokens = readJson(dir, 'tokens.json');
  for (const theme of Object.keys(tokens.semantic.theme)) {
    if (keepSets.includes(theme)) continue;
    const primitives = tokens.color[`theme-${theme}`];
    for (const stop of primitives['page-grad'].$value) stop.color = primitives.page.$value;
  }
  writeJson(dir, 'tokens.json', tokens);
};

assertFailsFor(
  'a translucent material with no backdrop set is refused, like any translucent ground',
  onlyRow(materialRow()),
  [
    new RegExp(`background "${rx(MATERIAL)}" is translucent; a row measures against what is actually painted there`),
    /^1 contrast problem\(s\)/m,
  ],
);

assertFailsFor(
  'a material measured over another theme\'s extremes is refused',
  onlyRow(materialRow({ fg: 'semantic.theme.ciel.ink', backdropSet: 'ciel-nuit' }), ['ciel-nuit']),
  [
    new RegExp(`background "${rx(MATERIAL)}" is translucent and backdropSet "ciel-nuit" holds the extremes of the "ciel-nuit" theme, not of "ciel"`),
    /^1 contrast problem\(s\)/m,
  ],
);

test('a material is measured over its own theme\'s set, and its opaque fallback is one of the grounds', () => {
  const { status, output } = gateWith(onlyRow(materialRow({ fg: 'semantic.theme.ciel.ink', backdropSet: 'ciel' }), ['ciel']));
  assert.equal(status, 0, output);
  // Every extreme of the set, the darkest and the lightest blend, and the fallback.
  const extremes = readJson(ROOT, 'contrast-pairs.json').backdropSets.ciel.members.length;
  assert.match(output, new RegExp(`↳ minimum of ${extremes + 3} backgrounds over "ciel"; worst: `));
  assert.match(output, /^1 pairs — 1 pass/m);
});

assertFailsFor(
  'a material whose opaque fallback fails is refused even when the glass passes',
  (dir) => {
    // A thin glass declared over the near-black rail, measured over white
    // alone. Lit from behind it is almost white and the ink is plain on it;
    // with the glass off it is the tint laid over the rail, a dark grey the ink
    // disappears into. Only the fallback can be the ground that fails.
    const tokens = readJson(dir, 'tokens.json');
    Object.assign(tokens.material['theme-ciel'].bar.$value, { alpha: 0.3, saturation: 1, canvas: '{color.theme-ciel.inverse}' });
    writeJson(dir, 'tokens.json', tokens);
    declareSet(scratchSetOf(['semantic.theme.ciel.page', 'semantic.theme.ciel.surface'], { theme: 'ciel' }))(dir);
    onlyRow(materialRow({ fg: 'semantic.theme.ciel.ink', backdropSet: 'scratch' }), ['scratch'])(dir);
  },
  [
    /worst: its opaque fallback over color\.theme-ciel\.inverse/,
    /↳ below the minimum and not in contrast-known-failures\.json/,
    /^1 contrast problem\(s\)/m,
  ],
);

// --- Gradients ---------------------------------------------------------------
//
// A gradient is opaque and is not one colour. As a ground it is measured over
// its stops and the bounds of every blend between them; and every stop a glass
// theme paints has to be a backdrop extreme of that theme, or the materials are
// measured over a sky narrower than the one on screen. The sky is built in the
// scratch copy, so these hold whatever the shipped palette becomes.
const SKY_GRADIENT = 'semantic.theme.ciel.page-grad';
/** Give ciel a real three-stop sky; `declare` adds its two ends to the theme's backdrop set. */
const withSky = ({ zenith = '#D7E8FA', declare = true } = {}) => (dir) => {
  const tokens = readJson(dir, 'tokens.json');
  const ciel = tokens.color['theme-ciel'];
  ciel['sky-zenith'] = { $value: zenith };
  ciel['sky-horizon'] = { $value: '#F8FBFE' };
  ciel['page-grad'].$value = [
    { color: '{color.theme-ciel.sky-zenith}', position: 0 },
    { color: '{color.theme-ciel.page}', position: 0.5 },
    { color: '{color.theme-ciel.sky-horizon}', position: 1 },
  ];
  writeJson(dir, 'tokens.json', tokens);
  // `declare: null` leaves the register alone, for a copy that has no ciel set at all.
  if (declare === null) return;
  editRegister(dir, (data) => {
    const wanted = ['color.theme-ciel.sky-zenith', 'color.theme-ciel.sky-horizon'];
    data.backdropSets.ciel.members = [...data.backdropSets.ciel.members.filter((member) => !wanted.includes(member)), ...(declare ? wanted : [])];
  });
};
const skyRow = (extra = {}) => glassRow({ fg: 'semantic.theme.ciel.ink-3', bg: SKY_GRADIENT, ...extra });

test('a gradient ground is measured over its stops, and held to the minimum', () => {
  const { status, output } = gateWith((dir) => {
    withSky()(dir);
    editPairs(dir, (pairs) => pairs.push(skyRow()));
  });
  assert.equal(status, 0, output);
  // Tertiary ink on the zenith, the darkest stop: #5C6874 on #D7E8FA. Three
  // stops, the darkest blend and the lightest blend are measured.
  assert.match(output, glassVerdict(4.56, 'PASS'));
  assert.match(output, /↳ minimum of 5 backgrounds over the stops of color\.theme-ciel\.page-grad; worst: color\.theme-ciel\.sky-zenith$/m);
});

assertFailsFor(
  'a darker stop pushes text on the gradient under its minimum',
  (dir) => {
    // The register reduced to this row, and one that keeps the theme's set
    // bound: the shipped materials over the same sky are not what is under test.
    onlyRow(skyRow(), ['ciel'])(dir);
    withSky({ zenith: '#B9D3EE' })(dir);
    editPairs(dir, (pairs) => pairs.push(glassRow({ id: 'scratch/keeps-the-set-bound', fg: 'semantic.theme.ciel.ink', backdropSet: 'ciel' })));
  },
  [
    glassVerdict(3.69, 'FAIL'),
    /worst: color\.theme-ciel\.sky-zenith$/m,
    /↳ below the minimum and not in contrast-known-failures\.json/,
    /^1 contrast problem\(s\)/m,
  ],
);

assertFailsFor(
  'a gradient stop that is not a backdrop extreme of its theme fails the gate',
  withSky({ declare: false }),
  [
    /semantic\.theme\.ciel\.page-grad: its stop color\.theme-ciel\.sky-zenith \(#D7E8FA\) is not an extreme of backdropSets\.ciel — a material over that end of the gradient is unmeasured/,
    /semantic\.theme\.ciel\.page-grad: its stop color\.theme-ciel\.sky-horizon \(#F8FBFE\) is not an extreme of backdropSets\.ciel/,
    /^2 contrast problem\(s\)/m,
  ],
);

assertFailsFor(
  'a glass theme that paints a gradient and declares no backdrop set fails the gate',
  (dir) => {
    // The register is reduced first, which flattens every sky; then ciel gets one back.
    onlyRow(glassRow({ bg: 'semantic.theme.ciel.surface', fg: 'semantic.theme.ciel.ink' }))(dir);
    withSky({ declare: null })(dir);
  },
  [/semantic\.theme\.ciel\.page-grad: "ciel" paints a gradient and declares no backdrop set, so nothing is measured over it/, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a backdrop set bound under a gradient ground is refused: a gradient is measured over its own stops',
  (dir) => {
    withSky()(dir);
    editPairs(dir, (pairs) => pairs.push(skyRow({ backdropSet: 'ciel' })));
  },
  [/background "semantic\.theme\.ciel\.page-grad" is a gradient, measured over its own stops — remove the backdropSet/, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a translucent foreground on a gradient ground is refused',
  (dir) => {
    withSky()(dir);
    editPairs(dir, (pairs) => pairs.push(skyRow({ fg: 'spec:focus-ring.ciel.outer' })));
  },
  [/foreground "spec:focus-ring\.ciel\.outer" is translucent on the gradient "semantic\.theme\.ciel\.page-grad"/, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a gradient stacked as a layer is refused',
  (dir) => {
    withSky()(dir);
    editPairs(dir, (pairs) => pairs.push(glassRow({ layers: [SKY_GRADIENT], backdropSet: 'ciel' })));
  },
  [/layer "semantic\.theme\.ciel\.page-grad" is opaque: it hides the backdrop/, /^1 contrast problem\(s\)/m],
);

// --- Whose extremes a set holds ------------------------------------------------
//
// A backdrop set is a claim about one theme: these are the lightest and darkest
// things THIS theme paints behind a surface. So the binding is a property of the
// ground, not of how the row happens to spell it. A translucent ground that
// belongs to a theme — a material, a theme role such as the scrim, a theme
// primitive — is measured over a set declared by name for that same theme, and
// over nothing else: not over another theme's set, not over a set that names no
// theme or a theme the registry does not hold, and not over a list written into
// the row, which would let any row pick the friendlier extremes it passes on.
//
// One refusal per route. They were written before the gate refused them, and
// were marked as known gaps until it did.
const SCRIM = 'semantic.theme.light.scrim';
const LIGHT_EXTREMES = ['semantic.theme.light.page', 'semantic.theme.light.inverse'];
/** Declare `backdropSets.scratch` exactly as given — `theme` included or not — and add the scratch row. */
const scratchSet = (set, row) => (dir) => {
  declareSet({ purpose: 'Scratch-only.', members: LIGHT_EXTREMES, ...set })(dir);
  addGlassRow(row)(dir);
};
const A_LIST = /is translucent and its backdropSet is a list: a backdrop set is declared once, by name, under backdropSets, for the theme whose extremes it holds/;

assertFailsFor(
  'a material bound to a list of colours written into the row is refused',
  addGlassRow({ bg: MATERIAL, fg: 'semantic.theme.ciel.ink', backdropSet: ['semantic.theme.ciel.surface'] }),
  [new RegExp(`background "${rx(MATERIAL)}" `), A_LIST, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a material primitive bound to a list written into the row is refused',
  addGlassRow({ bg: 'material.theme-ciel.bar', fg: 'semantic.theme.ciel.ink', backdropSet: ['semantic.theme.ciel.surface'] }),
  [/background "material\.theme-ciel\.bar" /, A_LIST, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a translucent theme role that is not a material, bound to a list written into the row, is refused',
  addGlassRow({ bg: SCRIM, fg: 'semantic.theme.light.on-inverse', backdropSet: ['semantic.theme.light.inverse'] }),
  [new RegExp(`background "${rx(SCRIM)}" `), A_LIST, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a list written into the row is refused on a ground that belongs to no theme as well',
  addGlassRow({ backdropSet: LIGHT_EXTREMES }),
  [new RegExp(`background "${rx(GLASS)}" `), A_LIST, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a set that names no theme is not a set, and a themed ground bound to it is refused',
  scratchSet({}, { bg: SCRIM, fg: 'semantic.theme.light.on-inverse', backdropSet: 'scratch' }),
  [
    /backdropSets\.scratch: names no theme: a set holds the extremes of one registered theme \(light, dark, black, ciel, ciel-nuit\)/,
    new RegExp(`background "${rx(SCRIM)}" is translucent and backdropSet "scratch" is not a usable set: names no theme`),
  ],
);

assertFailsFor(
  'a set that names a theme the registry does not hold is not a set',
  scratchSet({ theme: 'sepia' }, { bg: SCRIM, fg: 'semantic.theme.light.on-inverse', backdropSet: 'scratch' }),
  [
    /backdropSets\.scratch: names the theme "sepia", which the registry does not hold \(light, dark, black, ciel, ciel-nuit\)/,
    new RegExp(`background "${rx(SCRIM)}" is translucent and backdropSet "scratch" is not a usable set: names the theme "sepia"`),
  ],
);

assertFailsFor(
  'a translucent theme role bound to another theme\'s set is refused',
  addGlassRow({ bg: SCRIM, fg: 'semantic.theme.light.on-inverse', backdropSet: 'ciel' }),
  [
    new RegExp(`background "${rx(SCRIM)}" is translucent and backdropSet "ciel" holds the extremes of the "ciel" theme, not of "light"`),
    /^1 contrast problem\(s\)/m,
  ],
);

assertFailsFor(
  'a material primitive bound to another theme\'s set is refused',
  addGlassRow({ bg: 'material.theme-ciel.bar', fg: 'semantic.theme.ciel.ink', backdropSet: 'ciel-nuit' }),
  [/background "material\.theme-ciel\.bar" is translucent and backdropSet "ciel-nuit" holds the extremes of the "ciel-nuit" theme, not of "ciel"/, /^1 contrast problem\(s\)/m],
);

assertFailsFor(
  'a layer of another theme under a material is refused: a row is measured in one theme',
  addGlassRow({ bg: MATERIAL, fg: 'semantic.theme.ciel.ink', layers: ['semantic.theme.ciel-nuit.scrim'], backdropSet: 'ciel' }),
  [new RegExp(`background "${rx(MATERIAL)}" is stacked over "semantic\\.theme\\.ciel-nuit\\.scrim", a surface of the "ciel-nuit" theme, not of "ciel"`), /^1 contrast problem\(s\)/m],
);

test('a translucent theme role is measured over its own theme\'s named set', () => {
  const { status, output } = gateWith(
    scratchSet({ theme: 'light' }, { bg: SCRIM, fg: 'semantic.theme.light.on-inverse', backdropSet: 'scratch', min: 3 }),
  );
  assert.equal(status, 0, output);
  assert.match(output, /↳ minimum of 4 backgrounds over "scratch"; worst: /);
});

assertFailsFor(
  'a ground shaped like a theme\'s, for a theme the registry does not hold, is refused rather than read as unthemed',
  (dir) => {
    const tokens = readJson(dir, 'tokens.json');
    tokens.color['theme-sepia'] = { veil: { $value: 'rgba(60, 40, 20, 0.5)' } };
    writeJson(dir, 'tokens.json', tokens);
    over(LIGHT_EXTREMES, { bg: 'color.theme-sepia.veil', fg: 'semantic.theme.light.on-inverse' })(dir);
  },
  [/"color\.theme-sepia\.veil" names the theme "sepia", which the registry does not hold \(light, dark, black, ciel, ciel-nuit\)/],
);
