#!/usr/bin/env node
// Contrast gate — WCAG 2.1 relative luminance, the same maths as
// kodera-visio/scripts/check-contrast.py, run over contrast-pairs.json.
//
// The six ways a contrast suite lies, and what stops each here:
//
//   A translucent surface is measured as its tint.  A background that is not
//     opaque is refused outright: what is painted there depends on what lies
//     behind it, and a row that named only the tint would be measured against
//     a ground no user ever sees. The one way through is to say what can lie
//     behind — an explicit, non-empty `backdropSet` of OPAQUE extremes, with
//     any translucent `layers` stacked in between — and the row is then
//     measured over every extreme and over the bounds of every blend of them,
//     and held to the MINIMUM. scripts/lib/backdrop.mjs holds the maths and
//     docs/adr/0003 the argument, including what it does not cover. A gradient
//     is the same case without a surface on top: a row whose `bg` is a gradient
//     is measured over its stops and the bounds of every blend between them,
//     and every stop of a controlled gradient has to be one of the backdrop
//     extremes its theme declares, or the glass over that end is unmeasured.
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
import { worstCaseContrast } from './lib/backdrop.mjs';
import { materialAddress, resolveMaterial } from './lib/material.mjs';
import { resolveGradient, gradientOwner } from './lib/gradient.mjs';
import { THEMES, familyRules } from './lib/themes.mjs';

const tree = loadTokens();
const index = indexTokens(tree);

const register = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
const { pairs } = register;

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

const isOpaque = (color) => (color.a ?? 1) >= 1;

/**
 * The members of a backdrop set, resolved: `[{ ref, color }]`, every one opaque.
 * Throws a phrase that completes "… is translucent and …", so each refusal
 * reads as one sentence about the row it stopped.
 */
function backdropMembers(members, what) {
  if (!Array.isArray(members)) throw new Error(`${what} must be the name of a declared set or a list of opaque colours`);
  if (members.length === 0) throw new Error(`${what} is empty: with no extreme there is nothing to measure against`);
  return members.map((ref) => {
    let color;
    try {
      color = colorOf(ref);
    } catch (error) {
      throw new Error(`${what} member ${JSON.stringify(ref)} does not resolve: ${error.message}`);
    }
    if (!isOpaque(color)) {
      throw new Error(`${what} member ${JSON.stringify(ref)} is not opaque: an extreme is a colour that is actually painted`);
    }
    return { ref, color };
  });
}

// The named sets, resolved once. A set that is malformed is a problem of its
// own, whether or not a row binds it, and a set no row binds is stale: both are
// reported below the table, like an orphaned allowlist entry.
const declaredSets = register.backdropSets ?? {};
const backdropSets = new Map();
const setProblems = [];
for (const [name, set] of Object.entries(declaredSets)) {
  const entry = { backdrops: null, error: null, used: false, theme: set?.theme ?? null };
  try {
    if (set === null || typeof set !== 'object' || Array.isArray(set)) throw new Error('must be an object with a `purpose` and `members`');
    if (typeof set.purpose !== 'string' || !set.purpose.trim()) throw new Error('has no purpose: say what the extremes are the extremes of');
    entry.backdrops = backdropMembers(set.members, 'the set');
  } catch (error) {
    entry.error = error.message;
    setProblems.push(`backdropSets.${name}: ${error.message}`);
  }
  backdropSets.set(name, entry);
}

/** What the row says can lie behind its translucent background `ground`. */
function backdropsOf(pair, ground) {
  const binding = pair.backdropSet;
  if (binding === undefined) {
    // The refusal this gate has always made, with the way out named.
    throw new Error(
      `background "${pair.bg}" is translucent; a row measures against what is actually painted there — ` +
        'bind a backdropSet of opaque extremes to measure the worst case over',
    );
  }
  const refuse = (reason) => new Error(`background "${pair.bg}" is translucent and ${reason}`);
  if (typeof binding === 'string') {
    const entry = backdropSets.get(binding);
    if (!entry) {
      const names = [...backdropSets.keys()];
      throw refuse(`backdropSet ${JSON.stringify(binding)} is not declared; contrast-pairs.json declares ${names.length ? names.join(', ') : 'no set'}`);
    }
    entry.used = true;
    if (entry.error) throw refuse(`backdropSet ${JSON.stringify(binding)} is not a usable set: ${entry.error}`);
    // A set declared for one theme holds that theme's extremes. A material of
    // another theme measured over it would pass against a sky it is never on.
    if (entry.theme !== null && ground.theme !== null && entry.theme !== ground.theme) {
      throw refuse(`backdropSet ${JSON.stringify(binding)} holds the extremes of the "${entry.theme}" theme, not of "${ground.theme}"`);
    }
    return { backdrops: entry.backdrops, name: `"${binding}"` };
  }
  try {
    return { backdrops: backdropMembers(binding, 'its backdropSet'), name: 'its own set' };
  } catch (error) {
    throw refuse(error.message);
  }
}

/**
 * One layer of a row's stack as it is painted: its colour at its own alpha, and
 * the saturation its backdrop filter applies to what lies behind it.
 *
 * A material is read through scripts/lib/material.mjs, the reader the build
 * uses, so the gate measures the surface the stylesheet declares. A translucent
 * material also brings its opaque fallback — the colour it shows when the glass
 * is off — as a ground of its own: the reader who asked for less transparency
 * gets that colour, and it is held to the same minimum.
 */
function paintOf(ref) {
  const token = typeof ref === 'string' ? index.get(ref) : undefined;
  if (token?.type === 'gradient') {
    // Opaque, and not one colour: measured as a ground only, over its own stops.
    return { ref, theme: gradientOwner(ref), gradient: resolveGradient(token, index), color: null, saturation: 1, extras: [] };
  }
  if (token?.type === 'material') {
    const address = materialAddress(ref);
    if (!address) throw new Error(`"${ref}" is a material outside the material tier`);
    const material = resolveMaterial(address.theme, address.level, index);
    return {
      ref,
      theme: address.theme,
      color: material.paint,
      saturation: material.saturation,
      extras: material.alpha < 1 ? [{ ref: `its opaque fallback over ${material.canvas.ref}`, color: material.fallback }] : [],
    };
  }
  return { ref, theme: null, color: colorOf(ref), saturation: 1, extras: [] };
}

/** The translucent layers a row stacks between the backdrop and its background, bottom first. */
function layersOf(pair) {
  if (pair.layers === undefined) return [];
  if (!Array.isArray(pair.layers) || pair.layers.length === 0) {
    throw new Error('`layers` must be a non-empty list of translucent colours, bottom first; leave it out when nothing is stacked');
  }
  return pair.layers.map((ref) => {
    const paint = paintOf(ref);
    if (paint.gradient || isOpaque(paint.color)) {
      throw new Error(`layer "${ref}" is opaque: it hides the backdrop, so bind it as the backdrop instead of stacking it`);
    }
    return paint;
  });
}

/** A layer that paints nothing: what lies on a gradient that is measured bare. */
const NOTHING_ON_TOP = { color: { r: 0, g: 0, b: 0, a: 0 }, saturation: 1 };

// Every stop of a gradient a glass theme paints is a backdrop extreme of that
// theme. The stops are where the gradient is lightest and darkest; a set that
// leaves one out measures the materials over a sky that is narrower than the
// one on screen.
for (const theme of THEMES) {
  if (familyRules(theme).gradient !== 'controlled') continue;
  const sets = [...backdropSets].filter(([, entry]) => entry.theme === theme);
  for (const token of index.values()) {
    if (token.type !== 'gradient' || !token.path.startsWith(`semantic.theme.${theme}.`)) continue;
    let stops;
    try {
      ({ stops } = resolveGradient(token, index));
    } catch (error) {
      setProblems.push(`${token.path}: ${error.message}`);
      continue;
    }
    const painted = stops.map((stop) => ({ name: stop.ref ?? stop.color, hex: toHex(parseColor(stop.color)) }));
    if (!sets.length) {
      if (new Set(painted.map((stop) => stop.hex)).size > 1) {
        setProblems.push(`${token.path}: "${theme}" paints a gradient and declares no backdrop set, so nothing is measured over it`);
      }
      continue;
    }
    for (const [name, entry] of sets) {
      if (entry.error) continue;
      const extremes = new Set(entry.backdrops.map((backdrop) => toHex(backdrop.color)));
      for (const stop of painted) {
        if (!extremes.has(stop.hex)) {
          setProblems.push(
            `${token.path}: its stop ${stop.name} (${stop.hex}) is not an extreme of backdropSets.${name} — ` +
              'a material over that end of the gradient is unmeasured',
          );
        }
      }
    }
  }
}

const rows = [];
let hardFailures = 0;

for (const pair of pairs) {
  const row = { ...pair, ratio: null, verdict: null, note: '' };

  try {
    const ground = paintOf(pair.bg);
    if (ground.gradient) {
      // A gradient paints every blend of its stops somewhere along its length,
      // so the row is held to the worst of them: the same bound as a surface
      // over a backdrop, with nothing laid on top.
      if (pair.backdropSet !== undefined || pair.layers !== undefined) {
        throw new Error(`background "${pair.bg}" is a gradient, measured over its own stops — remove the ${pair.backdropSet !== undefined ? 'backdropSet' : 'layers'}`);
      }
      const backdrops = backdropMembers(
        ground.gradient.stops.map((stop) => stop.ref ?? stop.color),
        `the gradient "${pair.bg}"`,
      );
      const foreground = colorOf(pair.fg);
      if (!isOpaque(foreground)) {
        throw new Error(`foreground "${pair.fg}" is translucent on the gradient "${pair.bg}": the stops do not bound a colour that moves with the ground under it — measure an opaque foreground`);
      }
      const worst = worstCaseContrast({ foreground, layers: [NOTHING_ON_TOP], backdrops });
      row.fgHex = toHex(foreground);
      row.bgHex = toHex(worst.background);
      row.ratio = worst.ratio;
      row.measuredOver = `minimum of ${worst.measured} backgrounds over the stops of ${ground.gradient.path}; worst: ${worst.worst}`;
    } else if (isOpaque(ground.color)) {
      // Nothing shows through an opaque ground, so a binding here would claim
      // a worst case that was never measured.
      if (pair.backdropSet !== undefined || pair.layers !== undefined) {
        throw new Error(
          `background "${pair.bg}" is opaque, so its ${pair.backdropSet !== undefined ? 'backdropSet' : 'layers'} ` +
            'would measure nothing — remove the binding',
        );
      }
      const bg = ground.color;
      // Unconditional. A row cannot opt out of compositing, because the one that
      // did is how a 1.78:1 focus ring passed at 6.70:1.
      const fg = composite(colorOf(pair.fg), bg);
      row.fgHex = toHex(fg);
      row.bgHex = toHex(bg);
      row.ratio = contrastRatio(fg, bg);
    } else {
      // A translucent background would be measured as the colour behind it and
      // nothing would say so — the same silence this gate exists to break. It
      // is measured only over a declared set of what can lie behind it, and
      // held to the worst case.
      const { backdrops, name } = backdropsOf(pair, ground);
      const foreground = colorOf(pair.fg);
      if (!isOpaque(foreground)) {
        throw new Error(
          `foreground "${pair.fg}" is translucent on the translucent background "${pair.bg}": the extremes do not ` +
            'bound a colour that moves with the ground under it — measure an opaque foreground',
        );
      }
      const worst = worstCaseContrast({
        foreground,
        layers: [...layersOf(pair), ground],
        backdrops,
        extras: ground.extras,
      });
      row.fgHex = toHex(foreground);
      row.bgHex = toHex(worst.background);
      row.ratio = worst.ratio;
      row.measuredOver = `minimum of ${worst.measured} backgrounds over ${name}; worst: ${worst.worst}`;
    }
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

// A backdrop set no row binds is the same kind of leftover: extremes declared
// for a surface that is no longer measured over them.
for (const [name, entry] of backdropSets) {
  if (!entry.used && !entry.error) setProblems.push(`backdropSets.${name}: declared, but no row binds it — delete the set or measure something over it`);
}

// --- Report -----------------------------------------------------------------
const w = (s, n) => String(s).padEnd(n);
const COL = { id: 44, fg: 9, bg: 9, ratio: 7, min: 5, verdict: 10 };

console.log('Contrast gate — WCAG 2.1, contrast-pairs.json over tokens.json');
console.log('='.repeat(120));
console.log(
  `${w('pair', COL.id)}${w('fg', COL.fg)}${w('bg', COL.bg)}${w('ratio', COL.ratio)}${w('min', COL.min)}${w('verdict', COL.verdict)}label`,
);
console.log('-'.repeat(120));

for (const row of rows) {
  const ratio = row.ratio === null ? '—' : row.ratio.toFixed(2);
  console.log(
    `${w(row.id, COL.id)}${w(row.fgHex ?? '—', COL.fg)}${w(row.bgHex ?? '—', COL.bg)}` +
      `${w(ratio, COL.ratio)}${w(row.min.toFixed(1), COL.min)}${w(row.verdict, COL.verdict)}${row.label}`,
  );
  if (row.measuredOver) console.log(`${' '.repeat(COL.id)}↳ ${row.measuredOver}`);
  if (row.note && row.verdict !== 'FORBIDDEN') console.log(`${' '.repeat(COL.id)}↳ ${row.note}`);
}

const tally = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
console.log('='.repeat(120));
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

// The verdict is set on `process.exitCode` and the process is left to end on
// its own. `process.exit()` does not wait for a pipe: on a platform where pipe
// writes are asynchronous it cuts a table longer than the pipe buffer, and the
// rows a reader — or a self-test — most needs are the ones at the end.
if (setProblems.length) {
  console.error('\nBackdrop sets in contrast-pairs.json that do not hold what they claim:');
  for (const problem of setProblems) console.error(`  FAIL  ${problem}`);
}

if (hardFailures || orphans.length || setProblems.length) {
  console.error(
    `\n${hardFailures + orphans.length + setProblems.length} contrast problem(s). Fix the token, or add the pair to ` +
      'contrast-known-failures.json with a reason. Nothing here passes by being quiet.',
  );
  process.exitCode = 1;
} else {
  console.log('\nOK — every pair either clears its minimum or carries a written reason.');
}
