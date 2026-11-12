// The material tier: what a surface is made of, per theme and per level.
//
// A material is a composite, not a colour: a tint at an alpha, the blur and the
// saturation boost of its backdrop filter, a specular border, a shadow, and the
// canvas it is declared over. The four levels are fixed — `bar`, `panel`,
// `popover`, `dialog` — and every theme declares all four, so a component can
// ask for "the popover material" without knowing which family is on screen. A
// flat family declares them with alpha 1, no blur and no boost: the same roles,
// opaque (docs/specs/ethereal-sky-glass.md).
//
// Three readers share this module, which is why it is one: the grammar gate
// (is this token a material?), the build (what does it emit?) and the contrast
// gate (what does it paint, and over what?). A shape one of them accepted and
// another could not read would ship as a surface nobody measured.

import { aliasTarget, resolve, parseColor } from './tokens.mjs';
import { THEMES, themeInfo, familyRules } from './themes.mjs';

/** The levels, lowest first: the order every theme declares them in. */
export const MATERIAL_LEVELS = Object.freeze(['bar', 'panel', 'popover', 'dialog']);

/** The fields of the composite, in the order tokens.json writes them. */
export const MATERIAL_FIELDS = Object.freeze(['tint', 'alpha', 'blur', 'saturation', 'border', 'shadow', 'canvas']);

/** The fields that are references, and the type each must land on. */
const REFERENCE_FIELDS = Object.freeze({ tint: 'color', border: 'color', shadow: 'shadow', canvas: 'color' });

/** A blur wider than this is a frame-rate cost no level needs. */
export const MAX_BLUR_PX = 64;
/** `saturate()` beyond this posterises a photograph behind the surface. */
export const MAX_SATURATION = 2;

const BLUR = /^(?:0|[1-9]\d*)(?:\.\d+)?px$/;

/**
 * Where a material lives. `material.theme-<theme>.<level>` holds the composite;
 * `semantic.material.<theme>.<level>` is the name a consumer addresses, and is
 * an alias of it. Returns `{ tier, theme, level }`, or null for any other path.
 */
export function materialAddress(path) {
  const seg = path.split('.');
  if (seg.length === 3 && seg[0] === 'material' && seg[1].startsWith('theme-')) {
    return { tier: 'primitive', theme: seg[1].slice('theme-'.length), level: seg[2] };
  }
  if (seg.length === 4 && seg[0] === 'semantic' && seg[1] === 'material') {
    return { tier: 'semantic', theme: seg[2], level: seg[3] };
  }
  return null;
}

/** The primitive a theme's level is declared at. */
export const materialPrimitive = (theme, level) => `material.theme-${theme}.${level}`;
/** The name a consumer addresses a theme's level by. */
export const materialRole = (theme, level) => `semantic.material.${theme}.${level}`;

/** True for a token that is, or sits where, a material is. */
export function isMaterialToken(token) {
  return token.type === 'material' || token.segments[0] === 'material' || token.path.startsWith('semantic.material.');
}

/**
 * Every way `token` is not a well-formed material, one sentence each. Empty
 * when it is one. The grammar gate prints these; nothing else decides.
 */
export function materialProblems(token, index) {
  const address = materialAddress(token.path);
  if (!address) return ['a material lives at material.theme-<theme>.<level> or semantic.material.<theme>.<level>'];
  if (!THEMES.includes(address.theme)) {
    return [`"${address.theme}" is not a registered theme; the themes are ${THEMES.join(', ')}`];
  }
  if (!MATERIAL_LEVELS.includes(address.level)) {
    return [`"${address.level}" is not a material level; the levels are ${MATERIAL_LEVELS.join(', ')}`];
  }
  if (token.type !== 'material') return [`$type is ${JSON.stringify(token.type ?? null)}; a token here is a material`];

  const target = aliasTarget(token.value);
  if (address.tier === 'semantic') {
    const own = materialPrimitive(address.theme, address.level);
    return target === own ? [] : [`must reference {${own}}, its own theme's level, and nothing else`];
  }
  if (target !== null) return ['a material primitive holds the composite itself, not a reference to another material'];

  const value = token.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`a material is a composite of ${MATERIAL_FIELDS.join(', ')}`];
  }

  const problems = [];
  for (const field of MATERIAL_FIELDS) {
    if (!Object.hasOwn(value, field)) problems.push(`missing field "${field}"`);
  }
  for (const field of Object.keys(value)) {
    if (!MATERIAL_FIELDS.includes(field)) problems.push(`unknown field "${field}"; a material is ${MATERIAL_FIELDS.join(', ')}`);
  }

  for (const [field, expected] of Object.entries(REFERENCE_FIELDS)) {
    if (!Object.hasOwn(value, field)) continue;
    const reference = aliasTarget(value[field]);
    if (reference === null) {
      problems.push(`${field}: must be a reference to a ${expected} token, so the value it paints has a name and a row`);
      continue;
    }
    let literal;
    try {
      literal = resolve(reference, index);
    } catch (error) {
      problems.push(`${field}: ${error.message}`);
      continue;
    }
    const type = index.get(reference).type;
    if (type !== expected) {
      problems.push(`${field}: "${reference}" is a ${type} token, not a ${expected}`);
      continue;
    }
    if (field === 'tint' || field === 'canvas') {
      let color;
      try {
        color = parseColor(literal);
      } catch (error) {
        problems.push(`${field}: ${error.message}`);
        continue;
      }
      if ((color.a ?? 1) < 1) {
        problems.push(
          field === 'tint'
            ? `tint: "${reference}" is translucent; the tint is opaque and the material's alpha is its only alpha`
            : `canvas: "${reference}" is translucent; the canvas is what the opaque fallback is composited over`,
        );
      }
    }
  }

  const { alpha, blur, saturation } = value;
  if (Object.hasOwn(value, 'alpha') && !(typeof alpha === 'number' && Number.isFinite(alpha) && alpha > 0 && alpha <= 1)) {
    problems.push(`alpha: ${JSON.stringify(alpha)} is not a number in (0, 1]`);
  }
  if (Object.hasOwn(value, 'blur')) {
    if (typeof blur !== 'string' || !BLUR.test(blur)) problems.push(`blur: ${JSON.stringify(blur)} is not a pixel length such as "24px"`);
    else if (Number.parseFloat(blur) > MAX_BLUR_PX) problems.push(`blur: ${blur} is wider than the ${MAX_BLUR_PX}px a material may ask a compositor for`);
  }
  if (
    Object.hasOwn(value, 'saturation') &&
    !(typeof saturation === 'number' && Number.isFinite(saturation) && saturation >= 1 && saturation <= MAX_SATURATION)
  ) {
    problems.push(`saturation: ${JSON.stringify(saturation)} is not a number in [1, ${MAX_SATURATION}]`);
  }

  if (!problems.length && familyRules(address.theme).material === 'flat' && (alpha !== 1 || Number.parseFloat(blur) !== 0 || saturation !== 1)) {
    problems.push(
      `the ${themeInfo(address.theme).family} family is flat: a material in "${address.theme}" has alpha 1, blur 0px and saturation 1, ` +
        `not alpha ${alpha}, blur ${blur} and saturation ${saturation}`,
    );
  }
  return problems;
}

/**
 * One theme's level, resolved to what it paints. Throws on a material the
 * grammar gate would refuse: a generator must never emit one it cannot read.
 *
 *   tint, canvas   opaque `{r, g, b, a: 1}`
 *   paint          the tint at the material's alpha — the translucent ground
 *   fallback       the paint composited over the canvas: the opaque colour the
 *                  surface shows when the glass is off
 *   glass          whether anything behind the surface is visible or filtered
 */
export function resolveMaterial(theme, level, index) {
  const path = materialPrimitive(theme, level);
  const token = index.get(path);
  if (!token) throw new Error(`material: "${path}" is not declared`);
  const problems = materialProblems(token, index);
  if (problems.length) throw new Error(`material: ${path}: ${problems[0]}`);

  const value = token.value;
  const tint = parseColor(resolve(aliasTarget(value.tint), index));
  const canvas = parseColor(resolve(aliasTarget(value.canvas), index));
  const blur = Number.parseFloat(value.blur);
  const mix = (channel) => Math.round(tint[channel] * value.alpha + canvas[channel] * (1 - value.alpha));
  return {
    path,
    theme,
    level,
    tint,
    alpha: value.alpha,
    paint: { r: tint.r, g: tint.g, b: tint.b, a: value.alpha },
    blur,
    saturation: value.saturation,
    border: resolve(aliasTarget(value.border), index),
    shadow: { path: aliasTarget(value.shadow), value: resolve(aliasTarget(value.shadow), index) },
    canvas: { ref: aliasTarget(value.canvas), color: canvas },
    fallback: { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 },
    glass: value.alpha < 1 || blur > 0 || value.saturation !== 1,
  };
}
