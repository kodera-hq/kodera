import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const iconsDir = join(import.meta.dirname, '..', 'src-tauri', 'icons');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readValidatedPng(filename, expectedWidth, expectedHeight) {
  const fullPath = join(iconsDir, filename);
  assert.ok(existsSync(fullPath), `missing source PNG: ${filename}`);
  const bytes = readFileSync(fullPath);
  assert.ok(bytes.length >= 33, `PNG too small: ${filename}`);
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, `invalid PNG signature: ${filename}`);
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.subarray(12, 16).toString('ascii');
  assert.equal(ihdrLength, 13, `unexpected IHDR length in ${filename}`);
  assert.equal(ihdrType, 'IHDR', `missing IHDR chunk in ${filename}`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  assert.equal(width, expectedWidth, `${filename} width must be ${expectedWidth}`);
  assert.equal(height, expectedHeight, `${filename} height must be ${expectedHeight}`);
  assert.equal(bitDepth, 8, `${filename} bitDepth must be 8`);
  assert.equal(colorType, 6, `${filename} colorType must be RGBA (6)`);
  return bytes;
}

export function buildDeterministicIcns(png32, png128, png256) {
  const entries = [
    ['icp5', png32],
    ['ic07', png128],
    ['ic08', png256],
  ];
  const bodyLength = entries.reduce((sum, [, data]) => sum + 8 + data.length, 0);
  const totalLength = 8 + bodyLength;
  const out = Buffer.alloc(totalLength);
  out.write('icns', 0, 4, 'ascii');
  out.writeUInt32BE(totalLength, 4);
  let offset = 8;
  for (const [osType, payload] of entries) {
    out.write(osType, offset, 4, 'ascii');
    out.writeUInt32BE(8 + payload.length, offset + 4);
    payload.copy(out, offset + 8);
    offset += 8 + payload.length;
  }
  return out;
}

export function buildDeterministicIco(png32, png256) {
  const images = [
    { widthByte: 32, heightByte: 32, data: png32 },
    { widthByte: 0, heightByte: 0, data: png256 },
  ];
  const headerSize = 6;
  const dirEntrySize = 16;
  const dataOffsetStart = headerSize + dirEntrySize * images.length;
  const totalSize = dataOffsetStart + images.reduce((sum, img) => sum + img.data.length, 0);
  const out = Buffer.alloc(totalSize);

  // ICONDIR: reserved=0, type=1 (ICO), count=2
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);

  let currentDataOffset = dataOffsetStart;
  images.forEach((img, index) => {
    const entryOffset = headerSize + index * dirEntrySize;
    out[entryOffset] = img.widthByte;
    out[entryOffset + 1] = img.heightByte;
    out[entryOffset + 2] = 0; // palette count
    out[entryOffset + 3] = 0; // reserved
    out.writeUInt16LE(1, entryOffset + 4); // color planes
    out.writeUInt16LE(32, entryOffset + 6); // bits per pixel (RGBA)
    out.writeUInt32LE(img.data.length, entryOffset + 8);
    out.writeUInt32LE(currentDataOffset, entryOffset + 12);
    img.data.copy(out, currentDataOffset);
    currentDataOffset += img.data.length;
  });

  return out;
}

export function buildIconFiles() {
  const png32 = readValidatedPng('32x32.png', 32, 32);
  const png128 = readValidatedPng('128x128.png', 128, 128);
  const png128x2 = readValidatedPng('128x128@2x.png', 256, 256);
  const pngIcon = readValidatedPng('icon.png', 256, 256);
  assert.deepEqual(png128x2, pngIcon, '128x128@2x.png and icon.png must remain identical 256x256 RGBA assets');
  return {
    icns: buildDeterministicIcns(png32, png128, pngIcon),
    ico: buildDeterministicIco(png32, pngIcon),
  };
}

function runCli() {
  const mode = process.argv[2] ?? '--check';
  assert.ok(mode === '--check' || mode === '--write', 'usage: generate-icons.mjs [--check|--write]');

  const { icns: expectedIcns, ico: expectedIco } = buildIconFiles();

  const icnsPath = join(iconsDir, 'icon.icns');
  const icoPath = join(iconsDir, 'icon.ico');

  if (mode === '--write') {
    writeFileSync(icnsPath, expectedIcns);
    writeFileSync(icoPath, expectedIco);
    console.log(`OK — wrote deterministic icon.icns (${expectedIcns.length} B) and icon.ico (${expectedIco.length} B).`);
    return;
  }

  assert.ok(existsSync(icnsPath), 'icons/icon.icns is missing; run generate-icons.mjs --write');
  assert.ok(existsSync(icoPath), 'icons/icon.ico is missing; run generate-icons.mjs --write');
  assert.deepEqual(readFileSync(icnsPath), expectedIcns, 'icons/icon.icns drifted from deterministic PNG sources');
  assert.deepEqual(readFileSync(icoPath), expectedIco, 'icons/icon.ico drifted from deterministic PNG sources');
  console.log('OK — all PNG, ICNS, and ICO bundle icons verified deterministically.');
}

function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  return pathToFileURL(realpathSync(resolve(argv1))).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runCli();
}
