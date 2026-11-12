# Proximity frame v1 interoperability and activation boundary

Status: Local codec and coordinator verification; production radio activation requires security review.

## Naming

The channel is `#proximity` (the French catalogues carry its translated label): an everyday presence channel inside one organisation, with a voluntary, pseudonymous check-in. It is not an emergency service and must not be presented as one. It was first named `#urgence`, and its frame "emergency frame v1". The name changed; the wire did not. This document and `vectors/emergency-v1-rules.txt` keep their paths because other checks read them.

The v1 wire format is frozen. Every byte a deployed peer puts on the wire or signs keeps its historical value, old word included:

- the two magic bytes `4b 45` (ASCII `KE`) and the version byte `01`;
- the signed label `kodera-emergency-v1:`;
- the organisation-bound signed label `kodera-emergency-org-v1:` used by `ProximityFrame::sign_for_organisation`;
- the field layout, the status values 0 to 3 and the hop bound.

Renaming any of them is a new protocol version, never a vocabulary change. [`vectors/proximity-frame-v1.txt`](../vectors/proximity-frame-v1.txt) pins the constants, five signed frames and seventeen refused frames; the Rust, Swift and Kotlin codecs read it and must agree byte for byte. The TypeScript codec (`apps/web/src/features/emergency/codec.ts`) is held to the first frame by its own tests.

## Sender labels

A frame carries its sender's device public half and no name. The label shown next to a check-in is a handle: one the member picked for this purpose (`dedicated`) or one every device of the organisation derives for the sender (`generated`, `ProximityHandle::generated`). A handle is 3 to 24 characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`. It is display metadata held beside the frame, never inside it.

A handle is a display label, never an identity and never an authorisation input. Identity stays the signing half of the device pair; the roster and the signature decide what is admitted, and nothing is granted, refused, deduplicated or looked up by handle.

- A generated handle is `<adjective>-<noun>-<9 characters>` from `HMAC-SHA256(organisation beacon salt, "kodera-proximity-handle-v1:" || sender bytes)`: five bits per word and 45 in the suffix, 55 in all. The 24-character bound and the longest word pair leave room for exactly nine suffix characters.
- The organisation's beacon salt keys the derivation. The same sender shows another handle in another organisation, so handles are not linkable across organisations, and a handle searched for in one organisation is worth nothing in another.
- Fifty-five bits make an accidental meeting inside a 4096-member roster negligible. They do not stop someone who can try device pairs until one matches and then have it provisioned. A matching handle gives its holder a label and nothing else.
- A roster view runs `label_observed_proximity_senders` with the whole provisioned roster. When distinct provisioned senders show the same handle, whatever its origin, each is shown as `handle [fingerprint]`, the fingerprint being a prefix of `SHA-256("kodera-proximity-fingerprint-v1:" || sender bytes)`: 8 hex characters, lengthened two at a time until the prefixes of that group differ.
- The groups are computed over every provisioned sender, never over those seen so far. A sender whose handle equals that of a member who has not checked in already shows its fingerprint, so it cannot pass for the absent member, and no label changes when that member appears.

[`vectors/proximity-handle-v1.txt`](../vectors/proximity-handle-v1.txt) states the grammar, the word lists, accepted and refused handles, each sender in two organisations and six roster cases, two of them with an absent member, for the three native implementations.

## Boundary

The v1 frame authenticates the sender and text. It does not encrypt text. Its signing transcript has no organisation identifier or organisation-key binding. The rotating beacon is discovery metadata, not proof that a frame belongs to an organisation: anyone who observes a beacon can repeat it. A device key shared by two organisation rosters can therefore produce a frame that both accept. Keep state in a separate node per provisioned organisation, discard that node when switching sessions or replacing the roster, and do not enable production transport until this cross-organisation case has a reviewed policy or a coordinated future protocol change. No v1 wire bytes are changed here.

The desktop adversarial regression `v1_public_beacon_retagging_exposes_shared_signing_key_org_boundary` makes this concrete: a signed check-in from organisation A is refused with A’s beacon by B, but is admitted unchanged when wrapped with B’s publicly observable beacon if both rosters contain the same signing key. The normal organisation argument fence still works, and a disjoint B roster refuses the retagged frame. Distinct beacon salts alone therefore do not establish cryptographic organisation isolation. Before live transport activation, provision distinct signing keys for each organisation or coordinate a reviewed protocol version that signs the organisation binding; do not treat this regression’s expected acceptance as a security clearance.

The author signs `kodera-emergency-v1:` followed by UUID (16 bytes), public key (32 bytes), status (1 byte), UTF-8 length (1 byte), and UTF-8 text. Hop TTL is deliberately unsigned. It cannot prove distance or proximity and must not be treated as safety authority. Status timestamps describe historical check-ins, not current safety guarantees.

`VerifiedProximityFrame` is created only after structural, roster and injected signature-provider verification. Queue and roster APIs consume its immutable view. The production verifier must implement Ed25519; test keyed-MAC signers exercise the trait boundary only. The crate does not supply hardware key storage, a native verifier or a BLE driver.

## Shared signed vector

The signature below was generated locally using the published RFC 8032 test 1 key and independently matched using the OpenSSL CLI and Node crypto. Only the public key and signature are stored here.

- Salt: 32 bytes of `42`.
- Unix seconds: `1762520100`; bucket: `5875067` (`000000000059a57b`).
- HMAC input: `6b6f646572612d626561636f6e2d7631000000000059a57b`.
- HMAC-SHA256: `1be3967637ebb0eadac797b834f8a85755faebc9ee7a2b1217ed418a2754ad0b`.
- Beacon: `1be3967637ebb0ea`.
- UUIDv7: `019a5e626ca073038303030303030303` (milliseconds `1762520100000`, constructor randomness `[3; 10]`).
- Public key: `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`.
- TTL: `3`; status: `1` (`Safe`).
- Text: `À l’abri`; UTF-8: `c380206ce2809961627269` (11 bytes).
- Signing transcript: `6b6f646572612d656d657267656e63792d76313a019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a010bc380206ce2809961627269`.
- Signature: `de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005`.

The complete 129-byte frame is:

```text
4b4501019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a03010bc380206ce2809961627269de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005
```

Decrementing TTL changes only byte 51 and preserves the transcript/signature. Rust tests pin the exact codec/transcript bytes. Native platform tests must verify the actual Ed25519 signature as well as rejecting payload/signature mutation and off-roster keys.

## Bounded scheduling

The outbox accepts capacities 1–128. Need-assistance frames precede muster-point, safe and message-only frames; newer complete UUIDv7 values break equal-priority ties. At capacity a better frame evicts the lowest-priority/oldest pending frame; lower-priority input is refused without consuming its replay ID, so a later retry is possible. Receiving a relay decrements TTL; receiving TTL 1 still updates the roster but does not relay. Local origin frames retain their initial hop budget.

Replay history is bounded (at most 4096 IDs), and roster tracking is bounded (at most 4096 provisioned device keys). Old replay entries are eventually evicted. Pending outbox IDs are checked separately, so an evicted replay ID cannot duplicate a still-pending frame. A node also suppresses older/equal check-ins from each member. These bounds are not an infinite replay archive.

These bounds, the outbox's 128 and the clock rule below are stated once in [`vectors/emergency-v1-rules.txt`](../vectors/emergency-v1-rules.txt). The Rust, Swift (`apps/ios/packages/KoderaDomain`) and Kotlin (`apps/android/domain`) tests read it and agree with every line, and so do the Web tests (`apps/web/tests/unit/emergency/shared-rules.test.ts`).

A frame whose UUIDv7 time is more than 5 minutes ahead of the verifier's clock is refused (`ProximityFrame::verified_at`, `CoreError::FutureFrame`); one exactly 5 minutes ahead is accepted. Kept, a frame from a device whose clock runs ahead would outrank that member's later real check-ins in the roster. `ProximityFrame::verified` reads no clock: a path receiving frames from other devices uses `verified_at`.

`compute_relay_backoff_ms` hashes `kodera-relay-v1`, message UUID and relaying device key, producing 25–275 ms. The future transport adapter must schedule that delay and apply platform permissions and rate controls; this library never accesses a radio itself.
