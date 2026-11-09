// Collaborator cursor palette and non-status categorical tag palette.
//
// Why this file exists alongside test/theme-contract.selftest.mjs and
// scripts/check-contrast.mjs:
//
// 1. Collaborator cursors (`cursor-1`..`cursor-6` and `cursor-1-soft`..`cursor-6-soft`)
//    are consumed across real-time surfaces (collaborative canvas/board, presence
//    indicators, document carets and selection highlights). A solid cursor role
//    does three jobs at once — a 2 px caret or outline on `surface`, a 3 px pill
//    edge or presence ring on `sunken`, and the background of a floating name
//    flag carrying `on-inverse` text — so it has to clear 3:1 against both
//    `surface` and `sunken` AND 4.5:1 under `on-inverse` in light, dark and
//    black. Meanwhile its `-soft` companion has to clear 4.5:1 under `ink` and
//    3:1 under the focus ring, and all six collaborator slots must stay
//    perceptually distinct in hue and never fall back to `action` or `ink-4`.
//
// 2. Non-status categorical tags (`tag-1-bg`/`tag-1-fg`..`tag-6-bg`/`tag-6-fg`)
//    exist because `t1`..`t4` reuse the semantic status hues (`accent`, `ok`,
//    `warn`, `bad`), making a department or topic chip read like a validation
//    or an incident. Contrast alone cannot catch a categorical tag drifting back
//    into green, amber, red or cobalt: a green tag clears 4.5:1 and still means
//    "online". So this contract gates both the WCAG ratios and the hue separation
//    from all four semantic status bands, with a self-test mutation for every
//    clause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, indexTokens, resolve, parseColor, contrastRatio } from '../scripts/lib/tokens.mjs';
import { THEMES, focusRingRef } from '../scripts/lib/spec.mjs';
import preset from '../dist/tailwind.preset.js';

const tree = JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
const register = JSON.parse(readFileSync(join(ROOT, 'contrast-pairs.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');

const SLOTS = [1, 2, 3, 4, 5, 6];

/** RGB (0..255) to HSL (h in 0..360, s and l in 0..100). */
function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

/** Shortest angular distance around the 360-degree hue circle. */
function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** sRGB channel (0..255) to linear light (0..1). */
function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB (0..255) to CIE L*a*b* under D65. */
function rgbToLab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / 1.0;
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 Euclidean distance in L*a*b*. */
function deltaE76(c1, c2) {
  const l1 = rgbToLab(c1);
  const l2 = rgbToLab(c2);
  return Math.hypot(l1.L - l2.L, l1.a - l2.a, l1.b - l2.b);
}

/**
 * Semantic status hue bands reserved for `bad` (red), `warn` (amber),
 * `ok` (emerald) and `accent` (cobalt). A non-status categorical tag that
 * enters one of these bands reintroduces the status ambiguity this palette
 * exists to eliminate.
 */
function statusHueBand(hue) {
  const h = ((hue % 360) + 360) % 360;
  if (h >= 345 || h <= 15) return 'bad (red, 345°–15°)';
  if (h > 15 && h <= 50) return 'warn (amber, 15°–50°)';
  if (h >= 120 && h <= 165) return 'ok (emerald, 120°–165°)';
  if (h >= 220 && h <= 240) return 'accent (cobalt, 220°–240°)';
  return null;
}

function themeBlock(styles, theme) {
  const selector = theme === 'light' ? ':root, \\[data-theme="light"\\]' : `\\[data-theme="${theme}"\\]`;
  return styles.match(new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`))?.[1];
}

function requireNormativeRow(pairs, id, expectedFg, expectedBg, expectedMin) {
  const found = pairs.find((r) => r.id === id);
  assert.ok(found, `${id}: missing normative contrast row`);
  assert.equal(found.fg, expectedFg, `${id}: unexpected fg`);
  assert.equal(found.bg, expectedBg, `${id}: unexpected bg`);
  assert.equal(found.min, expectedMin, `${id}: expected min ${expectedMin}`);
  assert.equal(found.exempt, undefined, `${id}: must not be exempt`);
  assert.equal(found.expect, undefined, `${id}: must not be inverted`);
}

function checkCollaboratorCursors(source, contrastRegister, styles, config) {
  const index = indexTokens(source);
  const { pairs } = contrastRegister;

  for (const theme of THEMES) {
    const roles = source.semantic.theme[theme];
    const block = themeBlock(styles, theme);
    assert.ok(block, `${theme}: CSS boundary missing`);

    const surface = parseColor(resolve(`semantic.theme.${theme}.surface`, index));
    const sunken = parseColor(resolve(`semantic.theme.${theme}.sunken`, index));
    const ink = parseColor(resolve(`semantic.theme.${theme}.ink`, index));
    const onInverse = parseColor(resolve(`semantic.theme.${theme}.on-inverse`, index));
    const actionColor = parseColor(resolve(`semantic.theme.${theme}.action`, index));
    const actionHoverColor = parseColor(resolve(`semantic.theme.${theme}.action-hover`, index));

    const forbiddenCursorValues = new Set(
      ['action', 'action-hover', 'ok', 'warn', 'bad', 'ink-4', 'accent-soft', 'ok-soft', 'warn-soft', 'bad-soft'].map(
        (r) => resolve(`semantic.theme.${theme}.${r}`, index).toUpperCase(),
      ),
    );

    const slotHues = [];

    for (const slot of SLOTS) {
      const solidRole = `cursor-${slot}`;
      const softRole = `cursor-${slot}-soft`;

      for (const role of [solidRole, softRole]) {
        const entry = roles[role];
        assert.ok(entry, `${theme}.${role}: missing collaborator cursor role`);
        assert.equal(entry.$value, `{color.theme-${theme}.${role}}`, `${theme}.${role}: must alias color.theme-${theme}.${role}`);
        assert.ok(entry.$description?.trim(), `${theme}.${role}: description required`);

        const hex = resolve(`semantic.theme.${theme}.${role}`, index);
        assert.ok(
          !forbiddenCursorValues.has(hex.toUpperCase()),
          `${theme}.${role}: ${hex} reuses an action, status or icon role value`,
        );
      }

      const solidHex = resolve(`semantic.theme.${theme}.${solidRole}`, index);
      const softHex = resolve(`semantic.theme.${theme}.${softRole}`, index);
      const solidColor = parseColor(solidHex);
      const softColor = parseColor(softHex);

      const dEAction = deltaE76(solidColor, actionColor);
      assert.ok(
        dEAction >= 10,
        `${theme}.${solidRole}: ΔE76 ${dEAction.toFixed(1)} against action is below 10 (too close to the primary action colour)`,
      );
      const dEActionHover = deltaE76(solidColor, actionHoverColor);
      assert.ok(
        dEActionHover >= 10,
        `${theme}.${solidRole}: ΔE76 ${dEActionHover.toFixed(1)} against action-hover is below 10 (too close to the primary action hover colour)`,
      );

      const onSurface = contrastRatio(solidColor, surface);
      assert.ok(
        onSurface >= 3.0,
        `${theme}.${solidRole}: ${onSurface.toFixed(2)}:1 on surface is below 3:1 (SC 1.4.11)`,
      );
      const onSunken = contrastRatio(solidColor, sunken);
      assert.ok(
        onSunken >= 3.0,
        `${theme}.${solidRole}: ${onSunken.toFixed(2)}:1 on sunken is below 3:1 (SC 1.4.11)`,
      );
      const flagLabel = contrastRatio(onInverse, solidColor);
      assert.ok(
        flagLabel >= 4.5,
        `${theme}.${solidRole}: on-inverse label ${flagLabel.toFixed(2)}:1 is below 4.5:1 (SC 1.4.3)`,
      );
      const selectionText = contrastRatio(ink, softColor);
      assert.ok(
        selectionText >= 4.5,
        `${theme}.${softRole}: ink text ${selectionText.toFixed(2)}:1 is below 4.5:1 (SC 1.4.3)`,
      );

      const { h } = rgbToHsl(solidColor);
      for (const prev of slotHues) {
        const dist = hueDistance(h, prev.h);
        assert.ok(
          dist >= 20,
          `${theme}: ${solidRole} (${Math.round(h)}°) and ${prev.role} (${Math.round(prev.h)}°) are only ${Math.round(dist)}° apart in hue (min 20°)`,
        );
      }
      slotHues.push({ role: solidRole, h });

      requireNormativeRow(
        pairs,
        `theme.${theme}/${solidRole}/surface`,
        `semantic.theme.${theme}.${solidRole}`,
        `semantic.theme.${theme}.surface`,
        3,
      );
      requireNormativeRow(
        pairs,
        `theme.${theme}/${solidRole}/sunken`,
        `semantic.theme.${theme}.${solidRole}`,
        `semantic.theme.${theme}.sunken`,
        3,
      );
      requireNormativeRow(
        pairs,
        `theme.${theme}/on-inverse/${solidRole}`,
        `semantic.theme.${theme}.on-inverse`,
        `semantic.theme.${theme}.${solidRole}`,
        4.5,
      );
      requireNormativeRow(
        pairs,
        `theme.${theme}/ink/${softRole}`,
        `semantic.theme.${theme}.ink`,
        `semantic.theme.${theme}.${softRole}`,
        4.5,
      );
      requireNormativeRow(
        pairs,
        `theme.${theme}/focus-ring/${softRole}`,
        focusRingRef('default', theme, 'indicator'),
        `semantic.theme.${theme}.${softRole}`,
        3,
      );

      for (const [role, hex] of [
        [solidRole, solidHex],
        [softRole, softHex],
      ]) {
        assert.ok(block.includes(`  --c-${role}: ${hex};`), `${theme}.${role}: scoped CSS declaration missing`);
        assert.equal(config.theme.extend.colors[`c-${role}`], `var(--c-${role})`, `${role}: dynamic preset required`);
      }
    }

    requireNormativeRow(
      pairs,
      `theme.${theme}/ok-ink/muted`,
      `semantic.theme.${theme}.ok-ink`,
      `semantic.theme.${theme}.muted`,
      4.5,
    );
    requireNormativeRow(
      pairs,
      `theme.${theme}/inverse/on-inverse`,
      `semantic.theme.${theme}.inverse`,
      `semantic.theme.${theme}.on-inverse`,
      4.5,
    );
    requireNormativeRow(
      pairs,
      `theme.${theme}/focus-ring-on-inverse/bad`,
      focusRingRef('on-inverse', theme, 'indicator'),
      `semantic.theme.${theme}.bad`,
      3,
    );
  }
}

function checkNonStatusTags(source, contrastRegister, styles, config) {
  const index = indexTokens(source);
  const { pairs } = contrastRegister;

  for (const theme of THEMES) {
    const roles = source.semantic.theme[theme];
    const block = themeBlock(styles, theme);
    assert.ok(block, `${theme}: CSS boundary missing`);

    const statusRoles = [
      'action', 'action-hover', 'accent-soft', 'accent-ink',
      'ok', 'ok-soft', 'ok-ink', 'ok-border', 'ok-on-dark',
      'warn', 'warn-soft', 'warn-ink',
      'bad', 'bad-soft', 'bad-ink', 'bad-on-dark',
      't1-bg', 't1-fg', 't2-bg', 't2-fg', 't3-bg', 't3-fg', 't4-bg', 't4-fg', 't5-bg', 't5-fg',
    ];
    const forbiddenTagValues = new Set(
      statusRoles.map((r) => resolve(`semantic.theme.${theme}.${r}`, index).toUpperCase()),
    );

    const fgHues = [];

    for (const slot of SLOTS) {
      const bgRole = `tag-${slot}-bg`;
      const fgRole = `tag-${slot}-fg`;

      for (const role of [bgRole, fgRole]) {
        const entry = roles[role];
        assert.ok(entry, `${theme}.${role}: missing non-status tag role`);
        assert.equal(entry.$value, `{color.theme-${theme}.${role}}`, `${theme}.${role}: must alias color.theme-${theme}.${role}`);
        assert.ok(entry.$description?.trim(), `${theme}.${role}: description required`);

        const hex = resolve(`semantic.theme.${theme}.${role}`, index);
        assert.ok(
          !forbiddenTagValues.has(hex.toUpperCase()),
          `${theme}.${role}: ${hex} reuses a status or avatar-tint value`,
        );

        const { h, s } = rgbToHsl(parseColor(hex));
        assert.ok(s >= 15, `${theme}.${role}: saturation ${Math.round(s)}% is too neutral for a categorical tag`);
        const band = statusHueBand(h);
        assert.equal(
          band,
          null,
          `${theme}.${role} (${hex}, hue ${Math.round(h)}°) falls inside semantic status hue band ${band}`,
        );
      }

      const bgHex = resolve(`semantic.theme.${theme}.${bgRole}`, index);
      const fgHex = resolve(`semantic.theme.${theme}.${fgRole}`, index);
      const bgColor = parseColor(bgHex);
      const fgColor = parseColor(fgHex);

      const ratio = contrastRatio(fgColor, bgColor);
      assert.ok(
        ratio >= 4.5,
        `${theme}.tag-${slot}: ${fgRole} on ${bgRole} measures ${ratio.toFixed(2)}:1, below 4.5:1 (SC 1.4.3)`,
      );

      const bgHsl = rgbToHsl(bgColor);
      const fgHsl = rgbToHsl(fgColor);
      const pairHueDrift = hueDistance(bgHsl.h, fgHsl.h);
      assert.ok(
        pairHueDrift <= 10,
        `${theme}.tag-${slot}: ${bgRole} (${Math.round(bgHsl.h)}°) and ${fgRole} (${Math.round(fgHsl.h)}°) drift by ${Math.round(pairHueDrift)}° (max 10°)`,
      );

      for (const prev of fgHues) {
        const dist = hueDistance(fgHsl.h, prev.h);
        assert.ok(
          dist >= 12,
          `${theme}: ${fgRole} (${Math.round(fgHsl.h)}°) and ${prev.role} (${Math.round(prev.h)}°) are only ${Math.round(dist)}° apart in hue (min 12°)`,
        );
      }
      fgHues.push({ role: fgRole, h: fgHsl.h });

      requireNormativeRow(
        pairs,
        `theme.${theme}/${fgRole}/${bgRole}`,
        `semantic.theme.${theme}.${fgRole}`,
        `semantic.theme.${theme}.${bgRole}`,
        4.5,
      );
      requireNormativeRow(
        pairs,
        `theme.${theme}/focus-ring/${bgRole}`,
        focusRingRef('default', theme, 'indicator'),
        `semantic.theme.${theme}.${bgRole}`,
        3,
      );

      for (const [role, hex] of [
        [bgRole, bgHex],
        [fgRole, fgHex],
      ]) {
        assert.ok(block.includes(`  --c-${role}: ${hex};`), `${theme}.${role}: scoped CSS declaration missing`);
        assert.equal(config.theme.extend.colors[`c-${role}`], `var(--c-${role})`, `${role}: dynamic preset required`);
      }
    }
  }
}

test('collaborator cursors: six distinct slots per theme, gated on surface, sunken, on-inverse, ink and focus-ring', () =>
  checkCollaboratorCursors(tree, register, css, preset));

test('non-status tags: six categorical pairs per theme, outside status hue bands and gated at 4.5:1 and 3:1', () =>
  checkNonStatusTags(tree, register, css, preset));

test('every collaborator cursor clause fails on its own mutation', () => {
  const mutateTree = (edit) => {
    const copy = structuredClone(tree);
    edit(copy);
    return copy;
  };
  const mutateRegister = (edit) => {
    const copy = structuredClone(register);
    edit(copy);
    return copy;
  };

  assert.throws(
    () => checkCollaboratorCursors(mutateTree((t) => delete t.semantic.theme.dark['cursor-6']), register, css, preset),
    /dark\.cursor-6: missing collaborator cursor role/,
  );

  assert.throws(
    () => checkCollaboratorCursors(mutateTree((t) => (t.semantic.theme.light['cursor-2'].$description = '   ')), register, css, preset),
    /light\.cursor-2: description required/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-light']['cursor-1'].$value = t.color['theme-light'].action.$value)),
        register,
        css,
        preset,
      ),
    /light\.cursor-1: #2B4BDB reuses an action, status or icon role value/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-light']['cursor-1'].$value = '#2647D4')),
        register,
        css,
        preset,
      ),
    /light\.cursor-1: ΔE76 2\.1 against action is below 10/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-dark']['cursor-1'].$value = '#2A46CC')),
        register,
        css,
        preset,
      ),
    /dark\.cursor-1: ΔE76 .* against action-hover is below 10/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-light']['cursor-2'].$value = '#0F62A5')),
        register,
        css,
        preset,
      ),
    /light: cursor-2 .* and cursor-1 .* are only \d+° apart in hue/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-dark']['cursor-3'].$value = '#0E484E')),
        register,
        css,
        preset,
      ),
    /dark\.cursor-3: .* on surface is below 3:1/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-light'].sunken.$value = t.color['theme-light']['cursor-1'].$value)),
        register,
        css,
        preset,
      ),
    /light\.cursor-1: .* on sunken is below 3:1/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-light']['cursor-5'].$value = '#D46A1E')),
        register,
        css,
        preset,
      ),
    /light\.cursor-5: on-inverse label .* is below 4\.5:1/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        mutateTree((t) => (t.color['theme-dark']['cursor-4-soft'].$value = '#A06080')),
        register,
        css,
        preset,
      ),
    /dark\.cursor-4-soft: ink text .* is below 4\.5:1/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        tree,
        mutateRegister((r) => (r.pairs = r.pairs.filter((p) => p.id !== 'theme.dark/cursor-3/sunken'))),
        css,
        preset,
      ),
    /theme\.dark\/cursor-3\/sunken: missing normative contrast row/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        tree,
        mutateRegister((r) => (r.pairs.find((p) => p.id === 'theme.black/on-inverse/cursor-2').min = 3)),
        css,
        preset,
      ),
    /theme\.black\/on-inverse\/cursor-2: expected min 4\.5/,
  );

  assert.throws(
    () => checkCollaboratorCursors(tree, register, css.replace('  --c-cursor-4: #A82468;\n', ''), preset),
    /light\.cursor-4: scoped CSS declaration missing/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        tree,
        mutateRegister((r) => (r.pairs = r.pairs.filter((p) => p.id !== 'theme.light/ok-ink/muted'))),
        css,
        preset,
      ),
    /theme\.light\/ok-ink\/muted: missing normative contrast row/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        tree,
        mutateRegister((r) => (r.pairs = r.pairs.filter((p) => p.id !== 'theme.dark/inverse/on-inverse'))),
        css,
        preset,
      ),
    /theme\.dark\/inverse\/on-inverse: missing normative contrast row/,
  );

  assert.throws(
    () =>
      checkCollaboratorCursors(
        tree,
        mutateRegister((r) => (r.pairs = r.pairs.filter((p) => p.id !== 'theme.black/focus-ring-on-inverse/bad'))),
        css,
        preset,
      ),
    /theme\.black\/focus-ring-on-inverse\/bad: missing normative contrast row/,
  );

  const frozenPreset = structuredClone(preset);
  frozenPreset.theme.extend.colors['c-cursor-1'] = '#0E60A3';
  assert.throws(
    () => checkCollaboratorCursors(tree, register, css, frozenPreset),
    /cursor-1: dynamic preset required/,
  );
});

test('every non-status tag clause fails on its own mutation', () => {
  const mutateTree = (edit) => {
    const copy = structuredClone(tree);
    edit(copy);
    return copy;
  };
  const mutateRegister = (edit) => {
    const copy = structuredClone(register);
    edit(copy);
    return copy;
  };

  assert.throws(
    () => checkNonStatusTags(mutateTree((t) => delete t.semantic.theme.light['tag-4-fg']), register, css, preset),
    /light\.tag-4-fg: missing non-status tag role/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-2-bg'].$value = t.color['theme-light']['ok-soft'].$value)),
        register,
        css,
        preset,
      ),
    /light\.tag-2-bg: #E3F3EA reuses a status or avatar-tint value/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-3-fg'].$value = '#555A60')),
        register,
        css,
        preset,
      ),
    /light\.tag-3-fg: saturation \d+% is too neutral for a categorical tag/,
  );

  // Status hue band refusals: emerald (ok), amber (warn), red (bad), cobalt (accent).
  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-6-fg'].$value = '#166838')),
        register,
        css,
        preset,
      ),
    /light\.tag-6-fg .* falls inside semantic status hue band ok \(emerald, 120°–165°\)/,
  );
  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-6-fg'].$value = '#8C520C')),
        register,
        css,
        preset,
      ),
    /light\.tag-6-fg .* falls inside semantic status hue band warn \(amber, 15°–50°\)/,
  );
  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-3-fg'].$value = '#A61E24')),
        register,
        css,
        preset,
      ),
    /light\.tag-3-fg .* falls inside semantic status hue band bad \(red, 345°–15°\)/,
  );
  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-1-fg'].$value = '#203BA8')),
        register,
        css,
        preset,
      ),
    /light\.tag-1-fg .* falls inside semantic status hue band accent \(cobalt, 220°–240°\)/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => {
          t.color['theme-dark']['tag-5-bg'].$value = '#241C3D';
          t.color['theme-dark']['tag-5-fg'].$value = '#D6C9FB';
        }),
        register,
        css,
        preset,
      ),
    /dark: tag-5-fg .* and tag-1-fg .* are only \d+° apart in hue/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-black']['tag-2-fg'].$value = '#DFD4FC')),
        register,
        css,
        preset,
      ),
    /black\.tag-2: tag-2-bg .* and tag-2-fg .* drift by \d+°/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        mutateTree((t) => (t.color['theme-light']['tag-1-fg'].$value = '#8B72D6')),
        register,
        css,
        preset,
      ),
    /light\.tag-1: tag-1-fg on tag-1-bg measures .* below 4\.5:1/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        tree,
        mutateRegister((r) => (r.pairs = r.pairs.filter((p) => p.id !== 'theme.black/tag-5-fg/tag-5-bg'))),
        css,
        preset,
      ),
    /theme\.black\/tag-5-fg\/tag-5-bg: missing normative contrast row/,
  );

  assert.throws(
    () =>
      checkNonStatusTags(
        tree,
        mutateRegister((r) => (r.pairs.find((p) => p.id === 'theme.light/tag-2-fg/tag-2-bg').min = 3)),
        css,
        preset,
      ),
    /theme\.light\/tag-2-fg\/tag-2-bg: expected min 4\.5/,
  );

  assert.throws(
    () => checkNonStatusTags(tree, register, css.replace('  --c-tag-3-fg: #8A2465;\n', ''), preset),
    /light\.tag-3-fg: scoped CSS declaration missing/,
  );

  const frozenPreset = structuredClone(preset);
  frozenPreset.theme.extend.colors['c-tag-1-bg'] = '#F1EEFC';
  assert.throws(
    () => checkNonStatusTags(tree, register, css, frozenPreset),
    /tag-1-bg: dynamic preset required/,
  );
});
