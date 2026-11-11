// Native bindings deliberately depend on the source bytes alone, plus the theme
// registry every generator shares (./themes.mjs): this module keeps no theme
// list of its own.
import { createHash } from 'node:crypto';
import { indexTokens, resolve, aliasTarget, parseColor } from './tokens.mjs';
import { THEMES, THEME_REGISTRY, THEME_FAMILIES, DEFAULT_THEME } from './themes.mjs';
import { MATERIAL_LEVELS, materialRole, materialPrimitive, resolveMaterial } from './material.mjs';
import { springProfile } from './spring.mjs';

const FORMAT = 'kodera-native-tokens/1';
const GROUPS = [
  ['space', 'Space', 'dimension', 'dp'],
  ['radius', 'Radius', 'dimension', 'dp'],
  ['font.size', 'FontSize', 'dimension', 'sp'],
  ['font.weight', 'FontWeight', 'fontWeight'],
  ['font.family', 'FontFamily', 'fontFamily'],
];
const WEIGHTS = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' };
const RESERVED = new Set('class struct enum protocol extension import let var func static public private internal fileprivate open in is as try throw throws rethrows return break continue repeat while for if else switch case default defer do catch nil true false self Self super init deinit associatedtype typealias where guard object interface fun val when this null package typealias typeof operator constructor companion override sealed data inline crossinline noinline suspend'.split(' '));
const keys = node => Object.keys(node ?? {}).filter(k => !k.startsWith('$'));
const fail = message => { throw new Error(`native: ${message}`); };
const number = value => Number.isInteger(value) ? `${value}.0` : String(value);
// Kotlin interpolation and Swift interpolation must remain literal family data.
const swiftString = value => JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
const kotlinString = value => JSON.stringify(value).replace(/\$/g, '\\$');

function identifier(key) {
  let result = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (/^[0-9]/.test(result)) result = `s${result}`;
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(result) || RESERVED.has(result)) fail(`identifier ${key} is not supported`);
  return result;
}

function color(value, path) {
  // The shared web parser is permissive about numeric suffixes; native output
  // accepts only its documented, finite sRGB syntax and never clamps values.
  if (typeof value !== 'string') fail(`color syntax ${path}`);
  const hex = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i.test(value);
  const functional = /^(rgb|rgba)\((.*)\)$/i.exec(value);
  const parts = functional?.[2].split(',').map(v => v.trim());
  const rgb = functional && parts.length === (functional[1].toLowerCase() === 'rgba' ? 4 : 3)
    && parts.every(v => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v));
  if (!hex && !rgb) fail(`color syntax ${path}`);
  const c = parseColor(value);
  if (![c.r, c.g, c.b, c.a].every(Number.isFinite) || [c.r, c.g, c.b].some(v => v < 0 || v > 255) || c.a < 0 || c.a > 1) fail(`color range ${path}`);
  return c;
}

export function buildNative(sourceBytes) {
  const tree = JSON.parse(sourceBytes.toString());
  const index = indexTokens(tree);
  // Broken aliases are a source error even outside this first native surface.
  for (const path of index.keys()) resolve(path, index);
  const entries = [];
  const used = new Set();
  const apiNames = new Map();
  const group = path => {
    const node = path.split('.').reduce((n, k) => n?.[k], tree);
    if (!node || typeof node !== 'object' || !keys(node).length) fail(`missing group ${path}`);
    return node;
  };
  const take = (path, api, type) => {
    if (apiNames.has(api)) fail(`identifier collision ${api}: ${apiNames.get(api)} and ${path}`);
    apiNames.set(api, path);
    const aliases = [];
    let cursor = path;
    while (cursor !== null) {
      const token = index.get(cursor);
      if (!token) fail(`missing token ${cursor}`);
      if (token.type !== type) fail(`type ${cursor}: expected ${type}, got ${token.type}`);
      aliases.push(cursor);
      cursor = aliasTarget(token.value);
    }
    const value = resolve(path, index);
    used.add(path);
    const entry = { path, aliases, api, type, value };
    entries.push(entry);
    return entry;
  };
  const themes = group('semantic.theme');
  if (keys(themes).join(',') !== THEMES.join(',')) fail(`themes must be ${THEMES.join(', ')}`);
  const roles = keys(group(`semantic.theme.${DEFAULT_THEME}`));
  for (const required of ['page', 'surface', 'ink', 'action']) if (!roles.includes(required)) fail(`theme roles: missing ${required}`);
  for (const theme of THEMES) {
    if (keys(group(`semantic.theme.${theme}`)).join(',') !== roles.join(',')) fail(`theme roles differ in ${theme}`);
    for (const role of roles) {
      const path = `semantic.theme.${theme}.${role}`;
      const type = index.get(path)?.type;
      if (type !== index.get(`semantic.theme.${DEFAULT_THEME}.${role}`)?.type) fail(`theme roles: inconsistent type ${path}`);
      if (['page', 'surface', 'ink', 'action'].includes(role) && type !== 'color') fail(`type ${path}: expected color, got ${type}`);
      if (type === 'gradient') continue;
      const entry = take(path, `KoderaTokens.${identifier(theme)}.${identifier(role)}`, 'color');
      entry.value = color(entry.value, path);
      entry.colorSpace = 'sRGB';
    }
  }
  for (const [path, name, type, unit] of GROUPS) {
    for (const key of keys(group(path))) {
      const entry = take(`${path}.${key}`, `KoderaTokens.${name}.${identifier(key)}`, type);
      if (type === 'dimension') {
        if (typeof entry.value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?px$/.test(entry.value)) fail(`px dimension ${entry.path}`);
        entry.value = Number(entry.value.slice(0, -2));
        if (!Number.isFinite(entry.value)) fail(`px dimension ${entry.path}`);
        entry.units = { source: 'px', swift: 'pt', compose: unit };
      } else if (type === 'fontWeight') {
        if (!Number.isInteger(entry.value) || !Object.hasOwn(WEIGHTS, entry.value)) fail(`font weight ${entry.path}`);
      } else {
        if (!Array.isArray(entry.value) || !entry.value.length || entry.value.some(v => typeof v !== 'string' || !v.trim() || /[\u0000-\u001f\u007f]/.test(v))) fail(`font family ${entry.path}`);
        entry.value = { primary: entry.value[0], fallbacks: entry.value.slice(1) };
      }
    }
  }
  // --- Additive surface: materials and springs --------------------------------
  // Format 1 is extended, never changed: everything above is emitted as it was,
  // and what follows is new members beside it. A theme's materials are present
  // only when the source declares the material tier, and its springs only when
  // it declares `motion.spring`, so a source without them builds as before.
  const opaque = c => ({ r: c.r, g: c.g, b: c.b, a: 1 });
  const materialEntries = [];
  if (tree.semantic?.material || tree.material) {
    if (keys(group('semantic.material')).join(',') !== THEMES.join(',')) fail(`materials must be declared for ${THEMES.join(', ')}`);
    for (const theme of THEMES) {
      if (keys(group(`semantic.material.${theme}`)).join(',') !== MATERIAL_LEVELS.join(',')) fail(`material levels differ in ${theme}`);
      for (const level of MATERIAL_LEVELS) {
        const path = materialRole(theme, level);
        const api = `KoderaTokens.MaterialSet.${identifier(theme)}.${identifier(level)}`;
        if (apiNames.has(api)) fail(`identifier collision ${api}: ${apiNames.get(api)} and ${path}`);
        apiNames.set(api, path);
        let material;
        try {
          material = resolveMaterial(theme, level, index);
        } catch (error) {
          fail(error.message);
        }
        if (aliasTarget(index.get(path)?.value) !== materialPrimitive(theme, level)) fail(`material ${path} must reference ${materialPrimitive(theme, level)}`);
        used.add(path);
        used.add(material.path);
        const entry = {
          path,
          aliases: [path, material.path],
          api,
          type: 'material',
          value: {
            tint: opaque(material.tint),
            alpha: material.alpha,
            blur: material.blur,
            saturation: material.saturation,
            border: color(material.border, `${material.path}.border`),
            fallback: opaque(material.fallback),
          },
          colorSpace: 'sRGB',
          units: { blur: { source: 'px', swift: 'pt', compose: 'dp' } },
        };
        entries.push(entry);
        materialEntries.push({ theme, level, ...entry });
      }
    }
  }
  const springEntries = [];
  for (const name of keys(tree.motion?.spring)) {
    const path = `motion.spring.${name}`;
    const token = index.get(path);
    if (token?.type !== 'spring') fail(`type ${path}: expected spring, got ${token?.type}`);
    const api = `KoderaTokens.Motion.${identifier(name)}`;
    if (apiNames.has(api)) fail(`identifier collision ${api}: ${apiNames.get(api)} and ${path}`);
    apiNames.set(api, path);
    const { stiffness, damping, mass } = token.value ?? {};
    if (![stiffness, damping, mass].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) fail(`spring ${path}`);
    const profile = springProfile({ stiffness, damping, mass });
    used.add(path);
    const entry = {
      path,
      aliases: [path],
      api,
      type: 'spring',
      value: { stiffness, damping, mass, dampingRatio: profile.dampingRatio, response: profile.response, settlingMs: profile.durationMs },
      units: { response: 'seconds', settlingMs: 'milliseconds' },
    };
    entries.push(entry);
    springEntries.push({ name, ...entry });
  }

  const excluded = [...index.keys()].filter(path => !used.has(path)).map(path => ({
    path,
    reason: index.get(path).type === 'gradient' ? 'gradient: no native approximation' : path.startsWith('semantic.elevation.') || index.get(path).type === 'shadow' ? 'elevation: no native approximation' : 'outside the native format 1 surface',
  }));
  const manifest = {
    format: FORMAT,
    source: { path: 'tokens.json', sha256: createHash('sha256').update(sourceBytes).digest('hex') },
    // The theme registry (scripts/lib/themes.mjs), as every generator reads it.
    themes: THEME_REGISTRY.map(theme => ({ id: theme.id, api: `KoderaTokens.Theme.${identifier(theme.id)}`, family: theme.family, mode: theme.mode, scheme: theme.scheme, default: theme.default })),
    mapping: {
      colors: 'sRGB normalized channels; alpha preserved without compositing',
      dimensions: 'px numeric magnitude maps to Swift points and Compose dp; font sizes map to points/sp',
      scaling: 'consumer applies native font scaling; family metadata does not install or select fonts',
      numericIdentifiers: 's prefix, including Space.s4 and FontSize.s2xl',
      themes: 'Theme lists the registry; identifiers are camel-cased ids (ciel-nuit is cielNuit), the raw value is the id',
      materials: 'tint is opaque and alpha is the material alpha; blur maps to points and dp; fallback is the tint at alpha over the canvas, for reduced transparency and increased contrast; the shadow has no native approximation',
      springs: 'stiffness, damping and mass are the source; dampingRatio and response (seconds) follow from them, settlingMs is when the curve stays within 0.2 % of its target',
    },
    entries, excluded,
  };
  const header = `// GENERATED FILE — DO NOT EDIT. ${FORMAT}\n// Public source checksum (SHA-256)\n// ${manifest.source.sha256}\n// Source file: tokens.json\n`;
  const themed = theme => entries.filter(e => e.api.startsWith(`KoderaTokens.${identifier(theme)}.`));
  const member = e => e.api.split('.').at(-1);
  const swColor = c => `Color(.sRGB, red: ${number(c.r / 255)}, green: ${number(c.g / 255)}, blue: ${number(c.b / 255)}, opacity: ${number(c.a)})`;
  const ktColor = c => `Color(red = ${number(c.r / 255)}f, green = ${number(c.g / 255)}f, blue = ${number(c.b / 255)}f, alpha = ${number(c.a)}f)`;
  const sw = [header, 'import SwiftUI\n', 'public enum KoderaTokens {', '    public struct Palette: Sendable {', ...themed(DEFAULT_THEME).map(e => `        public let ${member(e)}: Color`), '    }'];
  const kt = [header, 'package io.kodera.tokens\n', 'import androidx.compose.ui.graphics.Color', 'import androidx.compose.ui.unit.dp', 'import androidx.compose.ui.unit.sp', 'import androidx.compose.ui.text.font.FontWeight as ComposeFontWeight\n', 'public object KoderaTokens {', '    public data class Palette(', ...themed(DEFAULT_THEME).map(e => `        public val ${member(e)}: Color,`), '    )'];
  for (const theme of THEMES) {
    sw.push(`    public static let ${identifier(theme)} = Palette(`, ...themed(theme).map((e, i, all) => `        ${member(e)}: ${swColor(e.value)}${i < all.length - 1 ? ',' : ''}`), '    )');
    kt.push(`    public val ${identifier(theme)} = Palette(`, ...themed(theme).map(e => `        ${member(e)} = ${ktColor(e.value)},`), '    )');
  }
  // --- Additive members: the registry, materials, springs ----------------------
  const upper = id => { const n = identifier(id); return n[0].toUpperCase() + n.slice(1); };
  const families = Object.keys(THEME_FAMILIES);
  const modes = [...new Set(THEME_REGISTRY.map(t => t.mode))];
  sw.push(
    `    public enum ThemeFamily: String, CaseIterable, Sendable { ${families.map(f => `case ${identifier(f)} = ${swiftString(f)}`).join('; ')} }`,
    `    public enum ThemeMode: String, CaseIterable, Sendable { ${modes.map(m => `case ${identifier(m)} = ${swiftString(m)}`).join('; ')} }`,
    '    public enum Theme: String, CaseIterable, Sendable {',
    ...THEME_REGISTRY.map(t => `        case ${identifier(t.id)} = ${swiftString(t.id)}`),
    `        public static let defaultTheme: Theme = .${identifier(DEFAULT_THEME)}`,
    '        public var family: ThemeFamily {',
    '            switch self {',
    ...THEME_REGISTRY.map(t => `            case .${identifier(t.id)}: return .${identifier(t.family)}`),
    '            }',
    '        }',
    '        public var mode: ThemeMode {',
    '            switch self {',
    ...THEME_REGISTRY.map(t => `            case .${identifier(t.id)}: return .${identifier(t.mode)}`),
    '            }',
    '        }',
    '        public var isDark: Bool {',
    '            switch self {',
    ...THEME_REGISTRY.map(t => `            case .${identifier(t.id)}: return ${t.scheme === 'dark'}`),
    '            }',
    '        }',
    '        public var palette: Palette {',
    '            switch self {',
    ...THEME_REGISTRY.map(t => `            case .${identifier(t.id)}: return KoderaTokens.${identifier(t.id)}`),
    '            }',
    '        }',
    ...(materialEntries.length ? [
      '        public var materials: Materials {',
      '            switch self {',
      ...THEME_REGISTRY.map(t => `            case .${identifier(t.id)}: return MaterialSet.${identifier(t.id)}`),
      '            }',
      '        }',
    ] : []),
    '    }',
  );
  kt.push(
    `    public enum class ThemeFamily(public val id: String) { ${families.map(f => `${upper(f)}(${kotlinString(f)})`).join(', ')} }`,
    `    public enum class ThemeMode(public val id: String) { ${modes.map(m => `${upper(m)}(${kotlinString(m)})`).join(', ')} }`,
    '    public enum class Theme(public val id: String, public val family: ThemeFamily, public val mode: ThemeMode, public val isDark: Boolean, public val isDefault: Boolean) {',
    ...THEME_REGISTRY.map((t, i, all) => `        ${upper(t.id)}(${kotlinString(t.id)}, ThemeFamily.${upper(t.family)}, ThemeMode.${upper(t.mode)}, ${t.scheme === 'dark'}, ${t.default})${i < all.length - 1 ? ',' : ';'}`),
    '        public val palette: Palette',
    '            get() = when (this) {',
    ...THEME_REGISTRY.map(t => `                ${upper(t.id)} -> KoderaTokens.${identifier(t.id)}`),
    '            }',
    ...(materialEntries.length ? [
      '        public val materials: Materials',
      '            get() = when (this) {',
      ...THEME_REGISTRY.map(t => `                ${upper(t.id)} -> MaterialSet.${identifier(t.id)}`),
      '            }',
    ] : []),
    '    }',
  );
  if (materialEntries.length) {
    const levels = MATERIAL_LEVELS.map(identifier);
    sw.push(
      '    public struct Material: Sendable {',
      '        public let tint: Color', '        public let alpha: Double', '        public let blur: CGFloat', '        public let saturation: Double', '        public let border: Color', '        public let fallback: Color',
      '    }',
      '    public struct Materials: Sendable {',
      ...levels.map(level => `        public let ${level}: Material`),
      '    }',
      '    public enum MaterialSet {',
    );
    kt.push(
      '    public data class Material(public val tint: Color, public val alpha: Float, public val blur: androidx.compose.ui.unit.Dp, public val saturation: Float, public val border: Color, public val fallback: Color)',
      `    public data class Materials(${levels.map(level => `public val ${level}: Material`).join(', ')})`,
      '    public object MaterialSet {',
    );
    for (const theme of THEMES) {
      const own = materialEntries.filter(e => e.theme === theme);
      sw.push(`        public static let ${identifier(theme)} = Materials(`, ...own.map((e, i) => `            ${identifier(e.level)}: Material(tint: ${swColor(e.value.tint)}, alpha: ${number(e.value.alpha)}, blur: ${number(e.value.blur)}, saturation: ${number(e.value.saturation)}, border: ${swColor(e.value.border)}, fallback: ${swColor(e.value.fallback)})${i < own.length - 1 ? ',' : ''}`), '        )');
      kt.push(`        public val ${identifier(theme)} = Materials(`, ...own.map(e => `            ${identifier(e.level)} = Material(tint = ${ktColor(e.value.tint)}, alpha = ${number(e.value.alpha)}f, blur = ${e.value.blur}.dp, saturation = ${number(e.value.saturation)}f, border = ${ktColor(e.value.border)}, fallback = ${ktColor(e.value.fallback)}),`), '        )');
    }
    sw.push('    }');
    kt.push('    }');
  }
  if (springEntries.length) {
    sw.push(
      '    public struct Spring: Sendable {',
      '        public let stiffness: Double', '        public let damping: Double', '        public let mass: Double', '        public let dampingRatio: Double', '        public let response: Double', '        public let settlingDuration: Double',
      '    }',
      '    public enum Motion {',
      ...springEntries.map(e => `        public static let ${identifier(e.name)} = Spring(stiffness: ${number(e.value.stiffness)}, damping: ${number(e.value.damping)}, mass: ${number(e.value.mass)}, dampingRatio: ${number(e.value.dampingRatio)}, response: ${number(e.value.response)}, settlingDuration: ${number(e.value.settlingMs / 1000)})`),
      '    }',
    );
    kt.push(
      '    public data class Spring(public val stiffness: Float, public val damping: Float, public val mass: Float, public val dampingRatio: Float, public val response: Float, public val settlingMillis: Int)',
      '    public object Motion {',
      ...springEntries.map(e => `        public val ${identifier(e.name)} = Spring(stiffness = ${number(e.value.stiffness)}f, damping = ${number(e.value.damping)}f, mass = ${number(e.value.mass)}f, dampingRatio = ${number(e.value.dampingRatio)}f, response = ${number(e.value.response)}f, settlingMillis = ${e.value.settlingMs})`),
      '    }',
    );
  }
  sw.push('    public struct Family: Sendable {', '        public let primary: String', '        public let fallbacks: [String]', '    }');
  kt.push('    public data class Family(public val primary: String, public val fallbacks: List<String>)');
  for (const [, name, type, unit] of GROUPS) {
    sw.push(`    public enum ${name} {`);
    kt.push(`    public object ${name} {`);
    for (const e of entries.filter(e => e.api.startsWith(`KoderaTokens.${name}.`))) {
      const n = member(e);
      if (type === 'dimension') {
        sw.push(`        public static let ${n}: CGFloat = ${number(e.value)}`);
        kt.push(`        public val ${n} = ${e.value}.${unit}`);
      } else if (type === 'fontWeight') {
        sw.push(`        public static let ${n}: Font.Weight = .${WEIGHTS[e.value]}`);
        kt.push(`        public val ${n} = ComposeFontWeight(${e.value})`);
      } else {
        sw.push(`        public static let ${n} = Family(primary: ${swiftString(e.value.primary)}, fallbacks: [${e.value.fallbacks.map(swiftString).join(', ')}])`);
        kt.push(`        public val ${n} = Family(primary = ${kotlinString(e.value.primary)}, fallbacks = listOf(${e.value.fallbacks.map(kotlinString).join(', ')}))`);
      }
    }
    sw.push('    }');
    kt.push('    }');
  }
  sw.push('}', '');
  kt.push('}', '');
  return {
    'native/KoderaTokens.swift': sw.join('\n'),
    'native/KoderaTokens.kt': kt.join('\n'),
    'native/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
}
