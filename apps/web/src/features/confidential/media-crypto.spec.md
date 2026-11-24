# Confidential media worker transforms

Status: Implemented client capability (`KSM1` and RFC 9605-aligned `SFrame` v1 with OpenMLS epoch binding).

## Contract

A dedicated worker receives a 32-byte room epoch secret directly through a transferred
`MessagePort`. Main-thread code owns a capability with room/epoch metadata, worker handle,
active state, revocation subscription, pre-connect E2EE attachment and close. The LiveKit key
provider remains empty: no secret string, byte array or derived key enters its main-thread API.
The capability refuses creation when neither script transforms nor bidirectional encoded streams
are available.

Two versioned wire profiles are supported inside the worker:
- `ksm1` (default legacy envelope): full-payload AES-256-GCM encryption with the `KSM1` metadata header.
- `sframe-v1` (RFC 9605-aligned media framing): two-stage `HKDF-SHA-256` (`kodera-sframe-media-v1`)
  binding `room_id`, `epoch` (`u64` BE), `sender_device_id`, `track_kind`, and `ratchet_step` (`u16` BE);
  canonical minimal RFC 9605 header (`config_byte || key_id || counter`); deterministic per-sender
  `base_salt XOR counter` AES-256-GCM nonces; and a codec-packetizer-safe cleartext prefix (`0` bytes for
  Opus audio; configurable `<= 64` bytes for VP8/H.264/AV1 payload descriptors) authenticated in AAD
  alongside every header byte.

Track attribution is checked against the decoder's participant identity. Per-sender/track-kind replay
state uses an authenticated 1024-frame sliding window so independent camera/screen receiver scheduling
can reorder counters; duplicates and counters older than the window are refused. Replay updates
are serialized, bounded and committed only after successful authentication.

The worker supports LiveKit's `init`, `enable`, transferred encode/decode streams, and
`rtctransform` worker hooks. No frame passes through unchanged: missing keys, disabled encryption,
wrong sender, unauthenticated frames and cryptographic failures close the worker session. A
TransformStream encrypts/decrypts before enqueue and rechecks active authority after each await.
Media session retirement terminates the worker and causes subscribed call controllers to end
capture and disconnect. Main-thread key injection and SDK key-export ratchets are refused.

Live epoch rotation (`rotateEpochKey` / `rotate-epoch-key` over the worker-owned `epochPort`)
immediately zeroizes and retires prior send keys, retains at most one immediately preceding receive
epoch for a bounded 2-second (`2000 ms`) grace window for in-flight SFU packets, and enforces strict
immediate purge (`0 ms` grace) when `memberRemoved: true`.

## Evidence

`media-crypto.worker.test.ts` covers audio/video round trips, `packages/kodera-rs/vectors/sframe-media-v1.json`
byte-for-byte golden vector parity between Rust and WebCrypto, VP8/H.264/AV1 unencrypted prefix AAD tamper
refusal, live `rotateEpochKey` 2-second grace window and immediate `memberRemoved: true` purge, cross-epoch
ratchet isolation, wrong-room/participant/track refusal, tag tampering, replay races, mutation/retirement,
unsafe buffers, direct key ports, TransformStream processing, downgrade/key-injection refusal, transform
feature detection and document-context import refusal.
