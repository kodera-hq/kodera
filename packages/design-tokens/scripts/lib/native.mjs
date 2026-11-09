// Native bindings deliberately depend on the source bytes alone.
import { createHash } from 'node:crypto';
import { indexTokens, resolve, aliasTarget, parseColor } from './tokens.mjs';

const THEMES = ['light', 'dark', 'black'];
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
  const roles = keys(group('semantic.theme.light'));
  for (const required of ['page', 'surface', 'ink', 'action']) if (!roles.includes(required)) fail(`theme roles: missing ${required}`);
  for (const theme of THEMES) {
    if (keys(group(`semantic.theme.${theme}`)).join(',') !== roles.join(',')) fail(`theme roles differ in ${theme}`);
    for (const role of roles) {
      const path = `semantic.theme.${theme}.${role}`;
      const type = index.get(path)?.type;
      if (type !== index.get(`semantic.theme.light.${role}`)?.type) fail(`theme roles: inconsistent type ${path}`);
      if (['page', 'surface', 'ink', 'action'].includes(role) && type !== 'color') fail(`type ${path}: expected color, got ${type}`);
      if (type === 'gradient') continue;
      const entry = take(path, `KoderaTokens.${theme}.${identifier(role)}`, 'color');
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
  const excluded = [...index.keys()].filter(path => !used.has(path)).map(path => ({
    path,
    reason: index.get(path).type === 'gradient' ? 'gradient: no native approximation' : path.startsWith('semantic.elevation.') || index.get(path).type === 'shadow' ? 'elevation: no native approximation' : 'outside the native format 1 surface',
  }));
  const manifest = {
    format: FORMAT,
    source: { path: 'tokens.json', sha256: createHash('sha256').update(sourceBytes).digest('hex') },
    mapping: {
      colors: 'sRGB normalized channels; alpha preserved without compositing',
      dimensions: 'px numeric magnitude maps to Swift points and Compose dp; font sizes map to points/sp',
      scaling: 'consumer applies native font scaling; family metadata does not install or select fonts',
      numericIdentifiers: 's prefix, including Space.s4 and FontSize.s2xl',
    },
    entries, excluded,
  };
  const header = `// GENERATED FILE — DO NOT EDIT. ${FORMAT}\n// Public source checksum (SHA-256)\n// ${manifest.source.sha256}\n// Source file: tokens.json\n`;
  const themed = theme => entries.filter(e => e.api.startsWith(`KoderaTokens.${theme}.`));
  const member = e => e.api.split('.').at(-1);
  const swColor = c => `Color(.sRGB, red: ${number(c.r / 255)}, green: ${number(c.g / 255)}, blue: ${number(c.b / 255)}, opacity: ${number(c.a)})`;
  const ktColor = c => `Color(red = ${number(c.r / 255)}f, green = ${number(c.g / 255)}f, blue = ${number(c.b / 255)}f, alpha = ${number(c.a)}f)`;
  const sw = [header, 'import SwiftUI\n', 'public enum KoderaTokens {', '    public struct Palette: Sendable {', ...themed('light').map(e => `        public let ${member(e)}: Color`), '    }'];
  const kt = [header, 'package io.kodera.tokens\n', 'import androidx.compose.ui.graphics.Color', 'import androidx.compose.ui.unit.dp', 'import androidx.compose.ui.unit.sp', 'import androidx.compose.ui.text.font.FontWeight as ComposeFontWeight\n', 'public object KoderaTokens {', '    public data class Palette(', ...themed('light').map(e => `        public val ${member(e)}: Color,`), '    )'];
  for (const theme of THEMES) {
    sw.push(`    public static let ${theme} = Palette(`, ...themed(theme).map((e, i, all) => `        ${member(e)}: ${swColor(e.value)}${i < all.length - 1 ? ',' : ''}`), '    )');
    kt.push(`    public val ${theme} = Palette(`, ...themed(theme).map(e => `        ${member(e)} = ${ktColor(e.value)},`), '    )');
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
