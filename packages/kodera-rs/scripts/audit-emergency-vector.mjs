import assert from 'node:assert/strict';
import { createHmac, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Independent built-in cryptographic oracle for the public, shared v1 packet.
// Rust checks structure and injected-provider coordination; this check verifies
// the published Ed25519 signature without a private key or external crate.
const documentation = readFileSync(new URL('../docs/emergency-v1-vectors.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/lib.rs', import.meta.url), 'utf8');
const fence = String.fromCharCode(96).repeat(3);
const documented = [...documentation.matchAll(new RegExp(fence + 'text\\n([0-9a-f]+)\\n' + fence, 'gu'))];
const pinned = [...source.matchAll(/let wire_hex = "([0-9a-f]+)";/gu)];
assert.equal(documented.length, 1, 'documentation must contain one public packet fixture');
assert.equal(pinned.length, 1, 'Rust must pin one public packet fixture');
assert.equal(documented[0][1], pinned[0][1], 'Rust and documented packet bytes must agree');
const frame = Buffer.from(documented[0][1], 'hex');
assert.equal(frame.length, 129, 'public packet must be exactly 129 bytes');
assert.deepEqual(frame.subarray(0, 3), Buffer.from([0x4b, 0x45, 1]), 'v1 header must be exact');
assert.equal(frame[53], 11, 'public text length must be eleven UTF-8 bytes');
assert.equal(frame.length, 54 + frame[53] + 64, 'packet text/signature boundary must be exact');
assert.equal(frame[51], 3, 'public packet starts with three relay hops');

function transcript(packet) {
  return Buffer.concat([
    Buffer.from('kodera-emergency-v1:'),
    packet.subarray(3, 51),
    packet.subarray(52, packet.length - 64),
  ]);
}

const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    frame.subarray(19, 51),
  ]),
  format: 'der',
  type: 'spki',
});
const signed = transcript(frame);
const signature = frame.subarray(frame.length - 64);
assert.equal(verify(null, signed, publicKey, signature), true, 'public Ed25519 signature must verify');

let refused = 0;
// Every UUID/key/status/length/text byte belongs to the signed transcript.
for (const offset of [...Array(48).keys()].map((value) => value + 3)
  .concat([...Array(frame.length - 64 - 52).keys()].map((value) => value + 52))) {
  const changed = Buffer.from(frame);
  changed[offset] ^= 1;
  assert.equal(verify(null, transcript(changed), publicKey, signature), false,
    'signed packet byte ' + offset + ' mutation must fail authentication');
  refused++;
}
for (let offset = 0; offset < signature.length; offset++) {
  const changed = Buffer.from(signature);
  changed[offset] ^= 1;
  assert.equal(verify(null, signed, publicKey, changed), false,
    'signature byte ' + offset + ' mutation must fail authentication');
  refused++;
}

// TTL is deliberately unsigned so relaying preserves authentication.
// This proves no proximity or organisation binding; adapters must enforce both.
for (let ttl = 1; ttl <= 6; ttl++) {
  const relayed = Buffer.from(frame);
  relayed[51] = ttl;
  assert.deepEqual(transcript(relayed), signed);
  assert.equal(verify(null, transcript(relayed), publicKey, signature), true);
}

const bucket = BigInt(1762520100) / 300n;
const beaconMessage = Buffer.alloc(24);
Buffer.from('kodera-beacon-v1').copy(beaconMessage);
beaconMessage.writeBigUInt64BE(bucket, 16);
const beacon = createHmac('sha256', Buffer.alloc(32, 0x42)).update(beaconMessage).digest().subarray(0, 8);
assert.equal(beacon.toString('hex'), '1be3967637ebb0ea', 'independent rotating beacon fixture must match');
assert.ok(documentation.includes('1be3967637ebb0ea'), 'documented beacon must match the oracle');
console.log('OK — public v1 Ed25519 vector, ' + refused
  + ' signed-byte/signature mutations refused, six TTL variants and HMAC beacon verified.');
