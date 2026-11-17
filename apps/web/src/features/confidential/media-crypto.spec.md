# Confidential media worker transforms

Status: Implemented client capability; interoperable packetizer qualification and server epoch discovery remain deferred.

## Contract

A dedicated worker receives a 32-byte room epoch secret directly through a transferred
`MessagePort`. Main-thread code owns a capability with room/epoch metadata, worker handle,
active state, revocation subscription, pre-connect E2EE attachment and close. The LiveKit key
provider remains empty: no secret string, byte array or derived key enters its main-thread API.
The capability refuses creation when neither script transforms nor bidirectional encoded streams
are available.

Encoded audio and video payloads are fully encrypted with HKDF-SHA-256 and AES-256-GCM. The
SFrame-aligned `KSM1` authenticated header records epoch/key index, sender, track kind, monotonic
frame counter, ratchet index and random nonce. AAD and derivation bind the room and these fields.
This is a versioned application framing format, not an assertion of RFC wire compatibility.
Track attribution is checked against the decoder's participant identity. Per-sender/track-kind replay
state uses an authenticated 1024-frame window so independent camera/screen receiver scheduling
can reorder counters; duplicates and counters older than the window are refused. Replay updates
are serialized, bounded and committed only after successful authentication.

The worker supports LiveKit's `init`, `enable`, transferred encode/decode streams, and
`rtctransform` worker hooks. No frame passes through unchanged: missing keys, disabled encryption,
wrong sender, unauthenticated frames and cryptographic failures close the worker session. A
TransformStream encrypts/decrypts before enqueue and rechecks active authority after each await.
Media session retirement terminates the worker and causes subscribed call controllers to end
capture and disconnect. Main-thread key injection and SDK key-export ratchets are refused. Codec updates preserve the exact local sender binding;
receiver transceiver reuse explicitly rebinds the retained pipeline to the new participant/track.
Detached receiver pipelines discard frames until re-admitted. Each binding revision is checked
after asynchronous crypto, so an old in-flight frame cannot be applied after reassignment.
Retirement aborts every pipeline and replaced worker-owned frame storage is erased.

The worker-only `ratchetEpochKey` step derives a one-way successor secret and erases the prior
secret, counters and replay state. It does not retain old receive keys. Both peers must take the
same monotonic epoch step; fresh epoch bytes without the same ratchet history cannot decrypt
ratcheted frames. Production epoch replacement retires the previous call capability.

## Evidence

`media-crypto.worker.test.ts` covers audio/video round trips, cross-epoch ratchet isolation,
wrong-room/participant/track refusal, tag tampering, replay races, mutation/retirement, unsafe
buffers, direct key ports, TransformStream processing, downgrade/key-injection refusal,
transform feature detection and document-context import refusal.

## Limits

Full-payload encryption needs browser and codec packetizer qualification before a deployment
can admit a protected media session. Local browser qualification is outside this lane's resource
allowance. Existing Core endpoints provide no MLS room-session discovery and this capability
claims no verified human cross-signing. Ordinary room behavior remains unchanged; protected
rooms without an explicitly active compatible capability remain unavailable before token/capture.
