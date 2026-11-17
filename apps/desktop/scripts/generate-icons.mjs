import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const iconsDir = join(root, 'apps/desktop/src-tauri/icons');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

// RFC 1950/1951 encoder with one fixed-Huffman block. Native zlib releases choose
// different matches, so using their output would make checked-in icon bytes drift by host.
function deterministicDeflate(raw) {
  const bytes = [];
  let pending = 0, count = 0;
  function bits(value, length) {
    pending |= value << count; count += length;
    while (count >= 8) { bytes.push(pending & 255); pending >>>= 8; count -= 8; }
  }
  function reversed(value, length) {
    let result = 0;
    for (let i = 0; i < length; i++) { result = (result << 1) | (value & 1); value >>>= 1; }
    return result;
  }
  function symbol(value) {
    const [code, width] = value <= 143 ? [48 + value, 8] : value <= 255 ? [400 + value - 144, 9] : value <= 279 ? [value - 256, 7] : [192 + value - 280, 8];
    bits(reversed(code, width), width);
  }
  const lengths = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const lengthExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const distances = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const distanceExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const previous = new Map();
  const keyAt = at => (raw[at] << 16) | (raw[at + 1] << 8) | raw[at + 2];
  bits(3, 3); // final block, fixed Huffman alphabet
  let at = 0;
  while (at < raw.length) {
    let length = 0, distance = 0;
    if (at + 2 < raw.length) {
      const before = previous.get(keyAt(at));
      if (before !== undefined && at - before <= 32768) {
        const max = Math.min(258, raw.length - at);
        while (length < max && raw[before + length] === raw[at + length]) length++;
        distance = at - before;
      }
    }
    const consumed = length >= 3 ? length : 1;
    if (length >= 3) {
      let l = lengths.length - 1, d = distances.length - 1;
      while (lengths[l] > length) l--;
      while (distances[d] > distance) d--;
      symbol(257 + l); bits(length - lengths[l], lengthExtra[l]);
      bits(reversed(d, 5), 5); bits(distance - distances[d], distanceExtra[d]);
    } else symbol(raw[at]);
    for (let i = 0; i < consumed && at + i + 2 < raw.length; i++) previous.set(keyAt(at + i), at + i);
    at += consumed;
  }
  symbol(256);
  if (count) bytes.push(pending & 255);
  let a = 1, b = 0;
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(((b << 16) | a) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from(bytes), checksum]);
}

// The seven official monogram paths are shared with the web mark. No fonts, resampling of
// small raster sources, third-party renderer or PNG metadata can enter a desktop icon.
function source() {
  const svg = readFileSync(join(root, 'apps/web/public/favicon.svg'), 'utf8');
  const paths = [...svg.matchAll(/<path d="([^"]+)"/gu)].map((m) => m[1]);
  const transform = svg.match(/<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/u);
  assert.equal(paths.length, 7, 'official mark must have seven paths');
  assert.ok(transform, 'official mark transform missing');
  const tokens = JSON.parse(readFileSync(join(root, 'packages/design-tokens/tokens.json'), 'utf8'));
  const colours = [tokens.color.cobalt['500'].$value, tokens.color.frost['100'].$value];
  return { paths, transform: transform.slice(1).map(Number), colours };
}

function polygon(path) {
  const parts = path.match(/[MLCZ]|-?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/gu);
  const points = [];
  let i = 0;
  const n = () => Number(parts[i++]);
  while (i < parts.length) {
    const cmd = parts[i++];
    if (cmd === 'M' || cmd === 'L') points.push([n(), n()]);
    else if (cmd === 'C') {
      const start = points.at(-1);
      const p1 = [n(), n()], p2 = [n(), n()], end = [n(), n()];
      for (let k = 1; k <= 32; k++) {
        const t = k / 32, u = 1 - t;
        points.push([0, 1].map((a) => u ** 3 * start[a] + 3 * u * u * t * p1[a] + 3 * u * t * t * p2[a] + t ** 3 * end[a]));
      }
    } else assert.equal(cmd, 'Z', 'unsupported official path command');
  }
  return points;
}

function renderPng(size, spec, rgbaOnly = false) {
  const factor = 4;
  const side = size * factor;
  const coverage = new Uint8Array(side * side);
  const [dx, dy, scale] = spec.transform;
  for (const path of spec.paths) {
    const pts = polygon(path).map(([x, y]) => [(dx + x * scale) * side / 512, (dy + y * scale) * side / 512]);
    for (let y = 0; y < side; y++) {
      const cross = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y + .5 && b[1] > y + .5) || (b[1] <= y + .5 && a[1] > y + .5))
          cross.push(a[0] + (y + .5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      cross.sort((a, b) => a - b);
      for (let i = 0; i + 1 < cross.length; i += 2)
        coverage.fill(1, y * side + Math.max(0, Math.ceil(cross[i] - .5)), y * side + Math.min(side, Math.ceil(cross[i + 1] - .5)));
    }
  }
  const rgb = spec.colours.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let count = 0;
    for (let yy = 0; yy < factor; yy++) for (let xx = 0; xx < factor; xx++) count += coverage[(y * factor + yy) * side + x * factor + xx];
    const at = y * (size * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 3; c++) raw[at + c] = Math.round(rgb[0][c] + (rgb[1][c] - rgb[0][c]) * count / (factor * factor));
    raw[at + 3] = 255;
  }
  if (rgbaOnly) {
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) raw.copy(rgba, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
    return rgba;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deterministicDeflate(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function buildDeterministicIcns(png32, png128, png256, extras = {}) {
  const entries = [['icp4', extras[16]], ['icp5', png32], ['icp6', extras[64]], ['ic07', png128], ['ic08', png256], ['ic09', extras[512]], ['ic10', extras[1024]]].filter(([, data]) => data);
  const out = Buffer.alloc(8 + entries.reduce((sum, [, data]) => sum + 8 + data.length, 0));
  out.write('icns'); out.writeUInt32BE(out.length, 4);
  let at = 8;
  for (const [type, data] of entries) { out.write(type, at); out.writeUInt32BE(data.length + 8, at + 4); data.copy(out, at + 8); at += data.length + 8; }
  return out;
}

export function buildDeterministicIco(png32, png256, extras = {}) {
  const entries = [[16, extras[16]], [32, png32], [48, extras[48]], [64, extras[64]], [128, extras[128]], [256, png256]].filter(([, data]) => data);
  const out = Buffer.alloc(6 + 16 * entries.length + entries.reduce((sum, [, data]) => sum + data.length, 0));
  out.writeUInt16LE(1, 2); out.writeUInt16LE(entries.length, 4);
  let at = 6 + 16 * entries.length;
  entries.forEach(([size, data], i) => {
    const pos = 6 + 16 * i; out[pos] = size % 256; out[pos + 1] = size % 256;
    out.writeUInt16LE(1, pos + 4); out.writeUInt16LE(32, pos + 6); out.writeUInt32LE(data.length, pos + 8); out.writeUInt32LE(at, pos + 12);
    data.copy(out, at); at += data.length;
  });
  return out;
}

export function buildIconFiles() {
  const spec = source();
  const pngs = Object.fromEntries(sizes.map((size) => [size, renderPng(size, spec)]));
  const files = Object.fromEntries(sizes.map((size) => [`${size}x${size}.png`, pngs[size]]));
  files['128x128@2x.png'] = pngs[256]; files['icon.png'] = pngs[256];
  files['window-icon.rgba'] = renderPng(256, spec, true);
  return { ...files, icns: buildDeterministicIcns(pngs[32], pngs[128], pngs[256], pngs), ico: buildDeterministicIco(pngs[32], pngs[256], pngs) };
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  const mode = process.argv[2] ?? '--check';
  assert.ok(['--write', '--check'].includes(mode), 'usage: generate-icons.mjs [--write|--check]');
  for (const [key, bytes] of Object.entries(buildIconFiles())) {
    const name = key === 'icns' || key === 'ico' ? `icon.${key}` : key;
    const path = join(iconsDir, name);
    if (mode === '--write') writeFileSync(path, bytes);
    else assert.deepEqual(readFileSync(path), bytes, `${name} differs from the official monogram and design tokens`);
  }
  console.log('OK: official Cobalt and Givre monogram, PNG sizes 16–1024, ICNS and ICO verified.');
}
