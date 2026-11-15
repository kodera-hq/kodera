# Confidential envelope relay

Status: Partially implemented

This specification extends the primitives in SRV-ADR-0026. It does not qualify browser/native
interoperability or enable a confidential-room badge. The server relays opaque cryptographic
objects; clients retain responsibility for authenticating MLS/Megolm protocol messages and
verifying admitted device identities.

## Scope and authority

The `/api/v1/organisations/{organisation_id}/confidential/...` routes require a verified customer
token, an enabled persisted identity, an active accepted membership in the exact organisation,
and current workspace/channel authority. Staff and cross-organisation requests fail closed.
The customer route graph mounts the adapter. The operator gate defaults to disabled, and every
operation returns a service-unavailable response before authentication or effects while disabled.
No token-supplied role or caller-supplied membership identifier grants authority.

Self-retirement requires current room visibility and a valid device proof. It remains available
while publication is muted, denied or archived. Retiring another device also requires current
publication authority and an administrator role.

Devices belong to the resolved membership and hold an immutable Ed25519 signing public key.
Registration requires proof of possession over a versioned canonical organisation/member/device
transcript. KeyPackages are opaque, bounded, expiring, signed by that registered device, and
consumed once under a transactional claim. Clients must additionally validate the MLS package,
its protocol credential and its expected device key before admission. Server authentication or
proof of possession alone is not out-of-band identity verification or hardware attestation.

Permanent device revocation discards every remaining package payload, including claimed packages.
Immutable claim/reference metadata remains inventoried for account erasure and controller-owned
retention; account cleanup revokes devices and discards bytes, while organisation erasure removes
the metadata rows. Removing
bytes does not revive authority: the database permits only monotonic payload removal with all
claim/binding fields unchanged, without waiting on a foreign claimant's erasure fence after a
workspace lock. Expired packages are discarded on subsequent owned directory activity; room
admission also discards expired or superseded claimed payloads. There is no background TTL
worker in this increment, so inactive rooms still require the existing erasure/operator policy.

Claim and retirement requests carry a required signed current epoch. A proof captured for an
older epoch cannot execute again with a fresh Idempotency-Key. A retry using the original key
may replay its prior result after a later epoch only while current authority still permits it;
that replay does not repeat the effect. Each target/room/epoch accepts one claim, enforced by
both the serialized service and a database uniqueness constraint, including after payload
removal. Expired or discarded claim metadata cannot authorize an added device: advance the
room and make a fresh current-epoch claim before admission.

The relay binds an explicit room to one existing text channel; it never upgrades the channel's
ordinary Matrix room in place. Only an administrator with current channel visibility may create
that relay. It begins with the creator's admitted device. Membership admission uses current
Core channel visibility plus an explicit device roster; a roster itself is not an authority
grant. Removed or disabled devices cannot publish, claim, receive or replay disclosed state.

## Protocol state

Each room stores the selected algorithm, current epoch and admitted device roster. Bounded
Welcome, Commit and Application envelopes contain binary ciphertext plus explicit routing
metadata. Application storage stops at 4,096 total envelopes. A separate bounded reserve permits
Commit/Welcome control frames up to 4,225 total envelopes so reaching application capacity does
not immediately prevent eviction. The reserve is finite; reaching its hard ceiling refuses
further writes rather than allowing unbounded retention. There is no automatic log rollover.
There is no body, formatted body, decrypted text, searchable document, media key or
private device key column. Unknown JSON fields and duplicate JSON keys are refused before
service execution. Accepted envelopes never pass through the ordinary document/search pipeline.

Room state transitions and claims serialize against the workspace, organisation authority and
room fences. Busy privacy advisory fences and conflicting organisation-authority row locks
return a transient refusal rather than wait while holding locks needed by an erasure cutoff.
Application envelopes must name the current epoch and are refused while any
admitted group leaf has lost current Core visibility or device authority. Removal immediately
retires that admission and blocks application publication until a signed next-epoch Commit
records the reduced roster. The server cannot validate the opaque MLS commit internally;
every client must validate its cryptographic commit and compare the resulting leaf roster
against the trusted admission boundary before switching message/media keys. A malformed commit
cannot make a conforming client accept an unauthorised leaf or emit old media keys.

An atomic compare-and-swap on `(room, epoch)` prevents concurrent commits from both advancing
one epoch. Welcome delivery is recipient-device scoped; ordinary application delivery is
current-roster scoped. New members do not gain pre-admission ciphertext history merely because
they joined the channel. Pagination has explicit bounds and stable ordering. Capacity refusal
must not delete history implicitly.

## Persistence, privacy and operational boundaries

Database constraints reject cross-organisation/channel/device associations, malformed epochs
and unbounded binary values. API role grants remain table/column scoped. Organisation/account
erasure fences, inventory and purge paths must cover every new stored association before the
relay routes can be published. Audit records include identifiers and enumerated actions only;
neither ciphertext nor package material nor signatures enter request logs or audit metadata.
The account inventory's `directory_packages` counts all retained package metadata rows; the
`e2ee_directory_packages_discarded` purge count measures payloads actually removed. These are
different obligations, so an already discarded row remains inventoried with a zero payload-purge
count. Payload discard updates `updated_at` without rewriting immutable claim history.

Relay privacy hooks install after the Enterprise and proximity replacements of Core functions.
Downgrade checks retained relay rows and durable erasure inventory/count markers before removing
any protection. Existing obligations prevent that downgrade even after their payloads are purged.

Idempotent retries recheck current authority before replaying a stored response. Package claims
retain one logical result for the same authorised retry; a different claimant cannot consume
the same package. Raw request bodies are neither logged nor retained in the idempotency store.

The outer Ed25519 request proof authorizes a server mutation; it is not a delivery signature
and is intentionally absent from ciphertext reads. Recipients authenticate the inner MLS
message or Megolm ciphertext using their locally pinned protocol state and verified sender keys.
They must check the expected room, organisation, algorithm, epoch and admitted roster before
accepting content or a new media key. HTTP authentication, routing fields and a server-supplied
public key list cannot replace that protocol verification.

## Acceptance evidence required before publication

1. Real PostgreSQL tests exercise device ownership and proof-of-possession refusal, malformed
   package/signature bounds, single-use concurrent claims, foreign-tenant denial and revoked
   identity/membership/device denial.
2. Room tests exercise administrator creation, current channel visibility, explicit device
   admission, next-epoch compare-and-swap, Welcome recipient isolation, application epoch
   refusal, removal gating and current-authority checks before response replay.
3. A real encrypted sentinel payload is persisted and relayed unchanged; the plaintext sentinel
   is absent from every stored field, searchable index, audit row and idempotent response.
   Plaintext body/unknown fields are rejected and leave no envelope row behind.
4. Direct SQL mutations prove binary bounds and cross-tenant constraints; API-role tests prove
   exact privileges. Organisation and person erasure tests prove cutoff/purge coverage.
5. Dedicated OpenAPI operations, scope declarations, authz documentation, version policy,
   served-operation inventory and canonical contract copies agree at the exact PR head.

Status: Planned — real Synapse room provisioning, browser IndexedDB/WebCrypto persistence,
native device bridge, verified participant UX and LiveKit encoded-frame transforms remain
separate release gates. A passing relay suite cannot certify those integrations.

## Planned client and media integration

The Rust core provides protocol operations, a scoped media exporter and device seal/restore
primitives. Browser bindings expose a device actor with a generated-WASM component proof;
complete durable group coordinators,
generated Swift/Kotlin bindings and a connected LiveKit key provider remain planned.
The web dependency is pinned to `livekit-client` 2.24.0. Current upstream examples must be checked
against that exact SDK before choosing option names or rotation behavior.

The client coordinator must own one durable record per `(issuer, organisation, membership,
device, room, algorithm)`. A monotonic accepted epoch, processed relay sequence, pending signed
operation and OpenMLS storage transaction must move together. A timeout after an epoch commit
requires replay/reconciliation of that same operation before another commit; recreating a group
at epoch zero, reusing consumed packages or trusting a server epoch without processing the
authenticated protocol Commit is forbidden. Restart tests must demonstrate that rollback,
reordering and duplicate delivery cannot reset protocol replay protection.

| Coordinator state | Permitted behavior | Transition evidence |
|---|---|---|
| Locked | No text send, media capture publication or exported key | Local device unlock and current persisted Core authority |
| Joining | Claim or receive the intended device's Welcome; no media publication | Authenticated protocol Welcome, expected identity and exact admitted roster |
| Ready | Protocol-encrypted text and encrypted local media | Accepted persisted epoch, current roster and initialized media transform |
| Rekeying | Pause publication and refuse old exporter reuse | Authenticated next Commit and persisted new epoch before installing its media key |
| Revoked or failed | Unpublish/disconnect; clear pending key references; deny fallback | Explicit fresh authorized admission through a separate allowed transition |

Browser persistence needs a reviewed OpenMLS provider adapter and restart-safe storage, whether
implemented through a qualified Rust/Wasm boundary or another interoperable supported engine.
IndexedDB may hold encrypted protocol state. Its wrapping key should use the browser's
non-extractable WebCrypto key mechanism, with authenticated scope/version metadata. This protects
stored material at rest; code executing within the application origin can still invoke that key.
No claim of browser hardware binding or protection from an active origin compromise follows.
Do not serialize private state into localStorage, URLs, analytics or error reports.

Native clients need a generated, versioned Rust bridge with bounded byte inputs and explicit
error results. Persist wrapped protocol state using the platform Keychain or Android Keystore
boundary, and bind restored state to the exact account/device scope. Desktop needs an equivalent
OS credential-store adapter before durable encryption is enabled. Logout, account removal,
device revocation and storage failure must invalidate restored admission and publication. Tests
must cover process termination between storage and relay acknowledgement on every platform.

LiveKit's [encryption guide](https://docs.livekit.io/transport/encryption/start/) describes a web
worker and a custom key provider for MLS/Megolm rotation. The proposed adapter installs only
`OpenMlsSession::export_media_key()` from an accepted current session into the media SDK's key
provider. It never sends that key to Core, the tenant agent, the SFU or a signaling token. The
frame format, key indices and decryption grace window must use the pinned SDK's supported
interoperable behavior, tested across clients; they must not introduce another cryptographic
format. A failed worker, unsupported encoded transforms, rejected Commit or key installation
error blocks publication. It must never turn encryption off while keeping tracks connected.

Each participant must enable the media transform. SDK capability alone does not prove all
participants are encrypted. The acceptance run must connect independently launched clients,
exchange encrypted audio/video, rotate after removal, prove the removed device cannot decrypt
new frames, and prove failure paths emit no clear media. Record media-frame observations at the
SFU boundary without retaining plaintext or keys. LiveKit's
[coverage documentation](https://docs.livekit.io/transport/encryption/) distinguishes encrypted
content from visible signaling/API metadata; that metadata boundary must be shown in user copy.

Device proof of possession and a Core roster authenticate transport authority. They cannot
establish that the server has supplied the intended human's key. A confidential-room status
requires a separate usable identity-verification flow, persistent verification fingerprints,
explicit changed-key handling and cross-client negative tests. No automatic verified badge or
fallback to ordinary Matrix/plaintext transport is part of this increment.

## Planned integration sequence and source boundaries

1. **Qualify the relay.** Keep ownership in `apps/server/apps/e2ee`, the canonical Core contract
   and generated API consumers. Run the real PostgreSQL HTTP, exact-role, concurrency and
   privacy suites, preserving proximity orgs0033, extensions0012 and the full legacy privacy suite.
   Canonical consumer generation and hosted qualification gate publication; the operator gate
   remains disabled by default.
2. **Make protocol state durable.** Extend `packages/kodera-rs/src/mls_engine.rs` and its provider
   boundary with atomic persistent storage, explicit transcript-signing support and bounded
   generated platform bindings. Restart and rollback tests must precede any UI integration.
   Keep `megolm_engine.rs` separate: authenticated pairwise session-key distribution must use
   a supported Matrix/Olm implementation; never relay a bare Megolm session key or invent a
   replacement key-wrapping protocol.
3. **Build the browser coordinator.** Add a crypto module under `apps/web/src/features/espace`
   that owns a qualified engine worker, wrapped IndexedDB state, replay reconciliation and
   account/room retirement. Route confidential text through that coordinator before connecting
   timeline or composer controls. Independently launched clients must exchange authenticated
   protocol messages and reject tampered, cross-room and stale-epoch messages after restart.
4. **Bind native coordinators.** Add client coordinators beside iOS `KoderaClient` and Android's
   existing session/client layers, backed by generated Rust bindings and platform credential
   stores. Test the same wire vectors, real process restart, logout, account switch and late
   completion after device revocation. Desktop additionally needs a running shell and an OS
   credential-store implementation; its existing preview seams do not supply them.
5. **Connect media and verification UX.** Integrate the accepted session exporter with the
   pinned LiveKit worker/key-provider boundary used by `VoiceCallDock` and native voice-call
   coordinators. Gate publication on confirmed encryption, accepted current epoch and verified
   participant identities. Run independent browser/native clients against a real SFU, observe
   encrypted frames, rotate on removal and prove no plaintext fallback. Only this evidence
   permits a user-facing confidential-room status. No earlier step qualifies that status.

## Core 0.47 source declaration

Status: Implemented behind an operator gate

The combined profile installs the model app and mounts the relay in the customer route graph.
The operator flag defaults false and refuses requests before authentication or effects while
disabled. This increment adds no verified-room discovery, client group coordinator or encrypted
media feature.

The Commit response names the actual Commit row as commitEnvelopeId and commitSequence;
headSequence can additionally include a recipient-private Welcome and must never be used
to infer the Commit marker. The UUID is canonical lowercase and non-nil, and the sequence is
a positive safe JSON integer. The no-Welcome example has head equal to Commit sequence; the
Welcome example has a later head. Current service and HTTP checks establish this relationship;
individual schema domains cannot compare two fields.
