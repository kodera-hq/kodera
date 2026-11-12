// Spring motion: a mass on a damped spring, released from rest towards 1.
//
// A token holds the PHYSICS — stiffness, damping, mass — because that is what
// every platform can consume: SwiftUI takes the response and damping fraction
// that follow from them, Compose takes the stiffness and the damping ratio. CSS
// has no spring, so the build solves the same equation once and emits what the
// curve looks like: a `linear()` easing and the duration it settles in. A
// consumer animates `transform` or `opacity` with the two, without a script.
//
// The numbers here are a pure function of the three parameters. There is no
// tuning constant per spring and no sampling of a clock.

/** The fields of the composite, in the order tokens.json writes them. */
export const SPRING_FIELDS = Object.freeze(['stiffness', 'damping', 'mass']);

/** The curve is settled once it stays within this distance of its target. */
const SETTLED = 0.002;
/** How finely the settling time is searched, and how far. */
const STEP_MS = 1;
const SEARCH_MS = 4000;
/** A spring that takes longer than this is not interface choreography. */
export const MAX_SPRING_DURATION_MS = 1500;
/** Overshoot past the target, as a fraction of the travel. */
export const MAX_SPRING_OVERSHOOT = 0.25;
/** The number of segments of the emitted `linear()` curve. */
const SEGMENTS = 32;

/** Where a spring lives: `motion.spring.<name>`. */
export const isSpringToken = (token) => token.type === 'spring' || token.path.startsWith('motion.spring.');

/** Position at `t` seconds of a unit step, from rest. */
function position({ stiffness, damping, mass }, t) {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const [slow, fast] = [-zeta * omega + root, -zeta * omega - root];
  return 1 - (fast * Math.exp(slow * t) - slow * Math.exp(fast * t)) / (fast - slow);
}

/** Every way `token` is not a usable spring, one sentence each. */
export function springProblems(token) {
  const seg = token.segments;
  if (!(seg.length === 3 && seg[0] === 'motion' && seg[1] === 'spring')) return ['a spring lives at motion.spring.<name>'];
  if (token.type !== 'spring') return [`$type is ${JSON.stringify(token.type ?? null)}; a token here is a spring`];
  const value = token.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`a spring is a composite of ${SPRING_FIELDS.join(', ')}`];
  }
  const problems = [];
  for (const field of SPRING_FIELDS) {
    if (!Object.hasOwn(value, field)) problems.push(`missing field "${field}"`);
    else if (!(typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] > 0)) {
      problems.push(`${field}: ${JSON.stringify(value[field])} is not a positive number`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!SPRING_FIELDS.includes(field)) problems.push(`unknown field "${field}"; a spring is ${SPRING_FIELDS.join(', ')}`);
  }
  if (problems.length) return problems;

  const profile = measure(value);
  if (profile.durationMs === null || profile.durationMs > MAX_SPRING_DURATION_MS) {
    problems.push(`does not settle within ${MAX_SPRING_DURATION_MS}ms; stiffen it or damp it`);
  }
  if (profile.overshoot > MAX_SPRING_OVERSHOOT) {
    problems.push(
      `overshoots its target by ${(profile.overshoot * 100).toFixed(1)} %, past the ${MAX_SPRING_OVERSHOOT * 100} % a spring here may; damp it`,
    );
  }
  return problems;
}

/** The settling time and the overshoot, searched on a fixed grid. */
function measure(spring) {
  let lastOutside = -1;
  let peak = 1;
  for (let ms = 0; ms <= SEARCH_MS; ms += STEP_MS) {
    const x = position(spring, ms / 1000);
    if (Math.abs(x - 1) > SETTLED) lastOutside = ms;
    if (x > peak) peak = x;
  }
  const settled = lastOutside + STEP_MS;
  return {
    durationMs: settled > SEARCH_MS ? null : Math.ceil(settled / 10) * 10,
    overshoot: peak - 1,
  };
}

const trim = (x, digits) => String(Number(x.toFixed(digits)));

/**
 * A spring as each platform consumes it.
 *
 *   dampingRatio  1 is critically damped; below it the spring overshoots
 *   response      seconds: the period of the undamped spring, `2π / √(k / m)`
 *   durationMs    when the curve has settled, rounded up to 10 ms
 *   easing        the CSS `linear()` curve over that duration, ending on 1
 */
export function springProfile(spring) {
  const { stiffness, damping, mass } = spring;
  const { durationMs, overshoot } = measure(spring);
  if (durationMs === null) throw new Error(`spring does not settle within ${SEARCH_MS}ms`);
  const samples = [];
  for (let i = 0; i <= SEGMENTS; i += 1) {
    samples.push(i === SEGMENTS ? '1' : trim(position(spring, (durationMs / 1000) * (i / SEGMENTS)), 4));
  }
  return {
    stiffness,
    damping,
    mass,
    dampingRatio: Number((damping / (2 * Math.sqrt(stiffness * mass))).toFixed(4)),
    response: Number(((2 * Math.PI) / Math.sqrt(stiffness / mass)).toFixed(4)),
    durationMs,
    overshoot: Number(overshoot.toFixed(4)),
    easing: `linear(${samples.join(', ')})`,
  };
}
