// Gradients: forbidden in a flat family, controlled in a glass one.
//
// "Givre & Nuit" decided there is no gradient (D-UI3): every gradient token is
// one colour. That stays exactly as strict for the givre family, and for every
// gradient that belongs to no theme. The ciel family paints a sky, so it may
// declare a real gradient — under a grammar narrow enough that the contrast
// gate can still say what is behind a surface:
//
//   bounded      at most MAX_GRADIENT_STOPS stops
//   named        every stop is a reference to an opaque colour primitive of the
//                same theme, never a raw colour: a stop is a ground text can
//                sit on, and a ground has a name and a row
//   anchored     positions rise strictly from 0 to 1, and the angle is declared
//   measured     every stop is a backdrop extreme of its theme — the contrast
//                gate holds that half (scripts/check-contrast.mjs)
//
// A gradient between stops is a convex blend of them, like a blur, so the
// stops and the bounds of their blends are what a surface over the gradient is
// measured against (docs/adr/0003).

import { aliasTarget, resolve, parseColor } from './tokens.mjs';
import { THEMES, themeInfo, familyRules } from './themes.mjs';

/** A sky needs a zenith, a horizon and at most two tones between them. */
export const MAX_GRADIENT_STOPS = 4;

const ANGLE = /^-?\d+(?:\.\d+)?deg$/;

/**
 * The theme a gradient token belongs to, read from where it lives:
 * `color.theme-<theme>.<name>` or `semantic.theme.<theme>.<name>`. Null for a
 * gradient that belongs to no theme.
 */
export function gradientOwner(path) {
  const seg = path.split('.');
  if (seg[0] === 'color' && seg[1]?.startsWith('theme-')) {
    const theme = seg[1].slice('theme-'.length);
    return THEMES.includes(theme) ? theme : null;
  }
  if (seg[0] === 'semantic' && seg[1] === 'theme' && THEMES.includes(seg[2])) return seg[2];
  return null;
}

/** The primitive a gradient token resolves to: itself, or the end of its alias chain. */
function primitiveOf(token, index) {
  let source = token;
  const seen = new Set();
  while (aliasTarget(source.value) !== null) {
    if (seen.has(source.path)) throw new Error(`reference cycle at ${source.path}`);
    seen.add(source.path);
    const next = index.get(aliasTarget(source.value));
    if (!next) throw new Error(`dangling reference: "${aliasTarget(source.value)}" resolves to no token`);
    source = next;
  }
  return source;
}

/**
 * A gradient as it is painted: its angle and its stops, each with the literal
 * colour it resolves to and the token it names, if it names one. Throws on a
 * gradient the grammar gate would refuse for its shape.
 */
export function resolveGradient(token, index) {
  const source = primitiveOf(token, index);
  const angle = source.node.$extensions?.['io.kodera.css-gradient']?.angle;
  if (typeof angle !== 'string' || !ANGLE.test(angle)) throw new Error(`${token.path}: missing or invalid gradient angle metadata`);
  const value = source.value;
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${token.path}: invalid gradient stop list`);
  const stops = value.map((stop) => {
    if (!stop || !Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) {
      throw new Error(`${token.path}: invalid gradient stop position`);
    }
    const ref = aliasTarget(stop.color);
    const color = ref === null ? stop.color : resolve(ref, index);
    parseColor(color);
    return { color, ref, position: stop.position };
  });
  return { path: source.path, angle, stops };
}

const distinct = (stops) => new Set(stops.map((stop) => stop.color.toUpperCase())).size;

/**
 * Every way a gradient token breaks the rule of the family it belongs to, one
 * sentence each. Empty when it does not.
 */
export function gradientProblems(token, index) {
  let source;
  try {
    source = primitiveOf(token, index);
  } catch (error) {
    return [error.message];
  }
  if (source.type !== 'gradient') return [`references "${source.path}", a ${source.type} token, not a gradient`];
  const value = source.value;
  if (!Array.isArray(value) || value.length < 2) return ['a gradient is a list of at least two stops'];

  const problems = [];
  const stops = [];
  value.forEach((stop, i) => {
    if (stop === null || typeof stop !== 'object' || Array.isArray(stop) || Object.keys(stop).sort().join(',') !== 'color,position') {
      problems.push(`stop ${i}: a stop is a color and a position, nothing else`);
      return;
    }
    if (!Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) {
      problems.push(`stop ${i}: position ${JSON.stringify(stop.position)} is not a number in [0, 1]`);
      return;
    }
    const ref = aliasTarget(stop.color);
    let literal = stop.color;
    if (ref !== null) {
      try {
        literal = resolve(ref, index);
      } catch (error) {
        problems.push(`stop ${i}: ${error.message}`);
        return;
      }
      if (index.get(ref).type !== 'color') {
        problems.push(`stop ${i}: "${ref}" is a ${index.get(ref).type} token, not a colour`);
        return;
      }
    }
    let color;
    try {
      color = parseColor(literal);
    } catch (error) {
      problems.push(`stop ${i}: ${error.message}`);
      return;
    }
    stops.push({ i, ref, literal, color, position: stop.position });
  });
  if (problems.length) return problems;

  const colours = distinct(stops.map((stop) => ({ color: stop.literal })));
  if (colours === 1) return [];

  // A real gradient. It is allowed in one place only, under one grammar.
  const owner = gradientOwner(token.path);
  if (owner === null) {
    return [`a gradient of ${colours} colours belongs to no theme; only a theme of a controlled-gradient family may declare one, as color.theme-<theme>.<name> (no gradient, D-UI3)`];
  }
  if (familyRules(owner).gradient !== 'controlled') {
    return [`a gradient of ${colours} colours in "${owner}": the ${themeInfo(owner).family} family paints no gradient, every stop is one colour (no gradient, D-UI3)`];
  }
  const home = `color.theme-${owner}.`;
  if (source.path !== token.path || !token.path.startsWith(home)) {
    // An alias: the name a consumer addresses. It may only name its own theme's gradient.
    return source.path.startsWith(home) ? [] : [`references "${source.path}"; a gradient role of "${owner}" names a gradient of its own theme`];
  }

  if (stops.length > MAX_GRADIENT_STOPS) {
    problems.push(`${stops.length} stops; a controlled gradient has at most ${MAX_GRADIENT_STOPS}`);
  }
  const angle = source.node.$extensions?.['io.kodera.css-gradient']?.angle;
  if (typeof angle !== 'string' || !ANGLE.test(angle)) problems.push('missing or invalid gradient angle metadata');
  for (const stop of stops) {
    if (stop.ref === null) {
      problems.push(`stop ${stop.i}: ${stop.literal} is a raw colour; every stop of a controlled gradient is a reference to a colour of its own theme`);
    } else if (!stop.ref.startsWith(home)) {
      problems.push(`stop ${stop.i}: "${stop.ref}" is not a colour of the "${owner}" theme (${home}*)`);
    } else if ((stop.color.a ?? 1) < 1) {
      problems.push(`stop ${stop.i}: "${stop.ref}" is translucent; a stop is a ground, and a ground is opaque`);
    }
  }
  if (stops[0].position !== 0 || stops.at(-1).position !== 1) {
    problems.push(`positions run from ${stops[0].position} to ${stops.at(-1).position}; a controlled gradient is anchored at 0 and at 1`);
  }
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i].position <= stops[i - 1].position) {
      problems.push(`stop ${stops[i].i}: position ${stops[i].position} does not rise above stop ${stops[i - 1].i} (${stops[i - 1].position})`);
    }
  }
  return problems;
}
