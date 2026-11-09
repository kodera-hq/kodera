# RFC-0001: `#urgence` Offline Building Proximity Channel (`BLE GATT` + `mDNS/QUIC`)

- **Status:** Draft Specification (Reference Codec Implemented in `packages/kodera-rs`)
- **Component:** `packages/kodera-rs`, `apps/desktop`, `apps/ios`, `apps/android`
- **License Boundary:** Wire protocol, cryptographic verification, and 1-hop/multi-hop client lifeline are **Open Source (`Apache-2.0`)**; multi-site crisis dashboards and compliance drill exports belong to `ee/`.

## 1. Motivation & Operational Scope

During a cyber-incident, power outage, natural disaster, or fiber cut affecting an office building, cloud-hosted collaboration tools (Slack, Teams, and standard cloud chat) become unreachable just when on-site employees and safety wardens need coordination most.

`#urgence` provides an **automatic, zero-configuration intra-organisation lifeline** for colleagues physically present inside the same floor or building (`15m–60m` per hop, up to `6` store-and-forward hops) without requiring internet, cellular data, or external servers.

### Explicit Non-Goals

- `#urgence` is **not** a city-wide consumer mesh network and **not** an always-on background battery drain. Radios activate **only** when the user opens `#urgence` during a connectivity loss or scheduled safety drill.
- `#urgence` carries **compact text (`<= 138 UTF-8 bytes`) and 1-byte safety check-in badges** (`Safe`, `NeedAssistance`, `MusterPoint`), never voice/video streams or file attachments over BLE.

## 2. Threat Model & Privacy Guarantees

1. **Zero Pre-Outage Pairing Ceremony:** While online, each workspace member's client caches the organisation's signed roster of member `Ed25519` device public keys (`32 B` each) and a rotating `32 B` organisation beacon salt.
2. **Anti-Tracking Rotating Proximity Beacon:** Clients advertise an `8 B` pseudonymous beacon derived via `HMAC-SHA256(org_beacon_salt, "kodera-beacon-v1" || floor(unix_secs / 300))[0..8]`. External Bluetooth scanners observe a random-looking identifier rotating every 5 minutes and cannot fingerprint the organisation or track individuals.
3. **End-to-End Sender Authenticity Across Hops:** Every `#urgence` frame is signed with the author's `Ed25519` device key over `"kodera-emergency-v1:" (20 B) || message_id (16 B) || sender_pk (32 B) || status (1 B) || text_len_u8 (1 B) || text`. `ttl_hops` is intentionally excluded from the signature transcript so intermediate colleagues can decrement `ttl_hops` during store-and-forward relaying without forging or invalidating the author's signature.
4. **Broadcast-Storm Prevention:** Every node enforces `ttl_hops in 1..=6` and deduplicates frames by `UuidV7` `message_id` via `EmergencyReplayGuard`.

## 3. Binary Wire Frame (`<= 256 Bytes`)

Implemented and unit-tested in [`packages/kodera-rs/src/lib.rs`](../../packages/kodera-rs/src/lib.rs):

| Byte Offset | Length | Field | Description |
| :--- | :--- | :--- | :--- |
| `0..2` | `2 B` | `magic` | ASCII `"KE"` (`0x4B 0x45`) |
| `2` | `1 B` | `version` | Protocol version (`0x01`) |
| `3..19` | `16 B` | `message_id` | Canonical RFC 9562 `UuidV7` (deduplication + causal ordering) |
| `19..51` | `32 B` | `sender_public_key` | Author's provisioned `Ed25519` device public key |
| `51` | `1 B` | `ttl_hops` | Remaining relay hops (`1..=6`; decremented per relay) |
| `52` | `1 B` | `status` | `0=MessageOnly`, `1=Safe`, `2=NeedAssistance`, `3=MusterPoint` |
| `53` | `1 B` | `text_len` | UTF-8 payload byte length (`0..=138`) |
| `54..54+N` | `N B` | `text` | UTF-8 emergency message (`<= 138 B`, guaranteeing `118 + N <= 256 B` wire budget) |
| `54+N..118+N` | `64 B` | `signature` | `Ed25519` signature over domain-separated transcript |

*(Fixed header + signature overhead is `118 bytes`, leaving exactly `138 bytes` inside the strict `256-byte` single-write BLE GATT budget.)*

## 4. Dual Local Transport Strategy

1. **Fast Path — Local Wi-Fi / LAN (`mDNS + QUIC`):** Whenever building Wi-Fi access points remain powered despite WAN/ISP failure, Desktop and Mobile nodes discover peers on the local subnet and exchange frames at sub-10ms latency.
2. **Total Blackout Fallback — `BLE GATT`:** When building power and Wi-Fi APs are completely down, battery-powered laptops and phones advertise the `8 B` rotating beacon and exchange `<= 256 B` frames over Bluetooth Low Energy GATT characteristics.
3. **Post-Outage Reconciliation:** Once WAN connectivity returns, authenticated clients optionally sync verified `#urgence` timelines (`UuidV7` idempotent upsert) back to the workspace's `#urgence` audit log.
