# RFC-0001: `#proximity` Local Proximity Channel (`BLE GATT` + `mDNS/QUIC`)

- **Status:** Draft specification. The frame v1 codec is implemented and tested in `packages/kodera-rs`; no radio adapter, check-in API or check-in screen ships.
- **Component:** `packages/kodera-rs`, `apps/desktop`, `apps/ios`, `apps/android`, `apps/web`
- **License Boundary:** The wire format, its verification and the client behaviour described here are open source (`Apache-2.0`).

> **`#proximity` is not an emergency service.** It does not reach emergency responders, it does not replace emergency numbers, and nobody should rely on it to ask for help. Delivery is best effort between nearby devices of one organisation.

## 0. Naming

This channel was first called `#urgence`. It is now **`proximity`** wherever a machine reads the name (slugs, template identifiers, channel names), displayed as **`#proximity`** in English and **`#proximité`** in French.

- The workspace template is `proximity`. Its earlier identifier, **`crisis-cell`, is a permanent alias**: it stays accepted wherever a template identifier is, and selects the same template.
- This file keeps its path, `RFC-0001-emergency-ble-channel.md`, because other documents and checks link to it.
- **The frame v1 wire format is frozen** (section 3). The bytes that carry the old name stay as they are: the magic `KE` and the signed label `kodera-emergency-v1:`. Renaming the channel changes no byte on the wire and invalidates no signature.

## 1. What it is for

`#proximity` is an everyday channel for the people of one organisation who are physically near each other: the same floor, the same building, the same site. It answers "who is around?" and carries short messages between nearby devices, including when the building's internet access is down, because it needs no server.

**Check-in is voluntary and pseudonymous.**

- A member checks in only by an explicit action. Nothing checks a member in automatically, and leaving is as easy as arriving.
- A check-in shows a pseudonymous handle, not a legal name or an account identifier.
- **Named zones first.** A check-in names a zone the organisation defined ("3rd floor", "workshop", "site B"). That is the default and is enough for most uses.
- **Coordinates are optional and short-lived.** A member may attach a more precise position; it is never required, it expires quickly, and it is not kept as a history of movements.

Status: Planned. The check-in model above is the agreed behaviour; no API operation and no client screen implements it yet.

### Explicit non-goals

- `#proximity` is **not** an emergency or alerting service (see the notice above), **not** a city-wide consumer mesh network and **not** an always-on background battery drain. Radios are active only while the member has the channel open.
- It is not a tracking tool: no continuous location, no location history, no check-in on someone else's behalf.
- It carries **compact text (`<= 138 UTF-8 bytes`) and a 1-byte status badge**, never voice, video or file attachments.

## 2. Threat model and privacy

1. **No pairing ceremony at the moment of use.** While online, each member's client caches the organisation's signed roster of member `Ed25519` device public keys (`32 B` each) and a rotating `32 B` organisation beacon salt.
2. **Rotating proximity beacon.** Clients advertise an `8 B` pseudonymous beacon derived as `HMAC-SHA256(org_beacon_salt, "kodera-beacon-v1" || floor(unix_secs / 300))[0..8]`. A Bluetooth scanner outside the organisation sees an identifier that changes every 5 minutes and cannot fingerprint the organisation or follow a person.
3. **Sender authenticity across hops.** Every frame is signed with the author's `Ed25519` device key over `"kodera-emergency-v1:" (20 B) || message_id (16 B) || sender_pk (32 B) || status (1 B) || text_len_u8 (1 B) || text`. `ttl_hops` is deliberately outside the signed transcript, so a relaying device can decrement it without forging or invalidating the author's signature.
4. **Broadcast-storm prevention.** Every node enforces `ttl_hops in 1..=6` and deduplicates frames by their `UuidV7` `message_id`.

## 3. Binary wire frame v1 (frozen, `<= 256` bytes)

Implemented and unit-tested in [`packages/kodera-rs/src/lib.rs`](../../packages/kodera-rs/src/lib.rs). **This layout is frozen:** a change to it is a new frame version, never an edit of v1.

| Byte Offset | Length | Field | Description |
| :--- | :--- | :--- | :--- |
| `0..2` | `2 B` | `magic` | ASCII `"KE"` (`0x4B 0x45`) |
| `2` | `1 B` | `version` | Protocol version (`0x01`) |
| `3..19` | `16 B` | `message_id` | Canonical RFC 9562 `UuidV7` (deduplication and causal ordering) |
| `19..51` | `32 B` | `sender_public_key` | Author's provisioned `Ed25519` device public key |
| `51` | `1 B` | `ttl_hops` | Remaining relay hops (`1..=6`; decremented per relay) |
| `52` | `1 B` | `status` | `0=MessageOnly`, `1=Safe`, `2=NeedAssistance`, `3=MusterPoint` |
| `53` | `1 B` | `text_len` | UTF-8 payload byte length (`0..=138`) |
| `54..54+N` | `N B` | `text` | UTF-8 message (`<= 138 B`, so that `118 + N <= 256 B`) |
| `54+N..118+N` | `64 B` | `signature` | `Ed25519` signature over the domain-separated transcript |

The fixed header and the signature take `118` bytes, which leaves `138` bytes of text inside the `256`-byte budget of a single BLE GATT write. The published v1 reference vector carries `11` bytes of text and is therefore a **`129`-byte frame**; `packages/kodera-rs` tests that exact length.

The four `status` values keep their v1 numbers and their historical names on the wire. How a client words them on screen is a display concern, and none of them summons help.

## 4. Local transports

Status: Planned. `packages/kodera-rs` holds the codec, the replay guard, the relay queue and the transport seam; the web client holds a matching codec and a same-browser cross-tab transport. No Bluetooth, mDNS or QUIC adapter exists in any client.

1. **Local Wi-Fi / LAN (`mDNS + QUIC`):** while access points are powered, devices on the same subnet discover each other and exchange frames directly.
2. **`BLE GATT`:** without Wi-Fi, laptops and phones advertise the `8 B` rotating beacon and exchange `<= 256 B` frames over Bluetooth Low Energy.
3. **Reconciliation:** when connectivity returns, clients may sync the frames they verified back to the workspace's `#proximity` channel, idempotently by `UuidV7`.
