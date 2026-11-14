import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const values = Object.fromEntries(
  readFileSync(new URL("../vectors/proximity-beacon-v2.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      assert(index > 0, "vector line must have a key");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const key = Buffer.from(values.public_fixture_discovery_key, "hex");
const seed = Buffer.from(values.public_fixture_device_seed, "hex");
const domain = Buffer.from("kodera-proximity-beacon-v2:\0");
const hmac = (secret, input) => createHmac("sha256", secret).update(input).digest();
const context = (organisation, suffix) => Buffer.concat([domain, Buffer.from(organisation), suffix]);

function authenticated(packet, organisation = values.organisation) {
  if (packet.length !== 27 || !packet.subarray(0, 3).equals(Buffer.from([0x4b, 0x50, 2]))) return false;
  const expected = hmac(key, context(organisation, packet.subarray(0, 19))).subarray(0, 8);
  return timingSafeEqual(expected, packet.subarray(19));
}

let refused = 0;
for (const [name, sequence] of [["sequence_zero", 0], ["sequence_one", 1], ["next_window", 0]]) {
  assert.match(values[name], /^[0-9a-f]{54}$/, "packet must have exactly 27 canonical bytes");
  const packet = Buffer.from(values[name], "hex");
  assert(authenticated(packet), `${name}: MAC verifies with the independent runtime`);
  assert.equal(packet.readUInt32BE(15), sequence, `${name}: sequence binds to its expected position`);
  const pseudonym = hmac(seed, Buffer.concat([context(values.organisation, packet.subarray(3, 7)), key]));
  assert(packet.subarray(7, 15).equals(pseudonym.subarray(0, 8)), `${name}: rotating pseudonym matches`);
  for (let offset = 0; offset < packet.length; offset++) {
    for (let bit = 0; bit < 8; bit++) {
      const changed = Buffer.from(packet);
      changed[offset] ^= 1 << bit;
      assert(!authenticated(changed), `${name}: bit mutation must refuse`);
      refused++;
    }
  }
  assert(!authenticated(packet, "00000000-0000-4000-8000-000000000002"), "organisation retagging refuses");
  refused++;
}
assert.notEqual(values.sequence_zero.slice(14, 30), values.next_window.slice(14, 30), "pseudonym rotates");
console.log(`beacon v2 oracle passed: three public packets, ${refused} named scope/bit refusals`);
