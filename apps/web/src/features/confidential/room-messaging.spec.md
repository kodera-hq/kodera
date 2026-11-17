# Confidential room messaging boundary

Status: Partial implementation — plaintext refusal and honest unavailable-state UI are implemented; usable confidential room messaging is blocked on the durable native room bridge.

## Contract and product behavior

A room's immutable `m.room.create` content carries `io.kodera.room.confidential`
with `io.kodera.mls.v1` or `m.megolm.v1.aes-sha2`. Its creator and matching
`m.room.encryption` author must be the local `@kodera-agent` account. This is the
existing server policy marker, not a new client flag. It describes policy; it
cannot attest ciphertext, device admission, room membership, key possession or
successful authentication. No user-facing confidential-room creation control is
introduced. [SRV-ADR-0026](../../../../server/docs/adr/0026-immutable-confidential-room-boundaries.md)
remains proposed and its release boundary remains in force.

The production Espace store defaults every unknown or marked room to refusal.
It admits ordinary plaintext messaging only after creation state is available
and contains neither a confidential marker nor an encryption event. After this
session observes either protection indicator, removing it cannot enable a
plaintext fallback. Unsupported markers, mismatched algorithms, additional
encryption fields and foreign state authors quarantine the room.

Until a verified native room actor exists, marked rooms show keys unavailable.
Headers distinguish ordinary workspace messaging, public Community rooms and
unavailable confidential protection. A public Community label requires the
canonical `community.` homeserver and a public join rule; transport openness
alone is never labelled confidentiality. The client shows no verified lock or
end-to-end encryption success claim.

Message bodies, edits, thread replies, attachment references, reactions, failed
message resends and typing submissions refuse before SDK transport in a
protected or unknown room. The Matrix transport rechecks policy after SDK
encryption/scheduler awaits and before each actual fetch, including credential
refresh retries. Unauthenticated incoming plaintext and encrypted
envelopes render no messages or threads. Protected room views are never saved
to the plaintext timeline cache. Cached plaintext is withheld before fresh
creation-state classification; ordinary rooms resume their existing live-cache
writes after sync. Logout still wipes the cache.

Uploads require a live room authorization callback before file preflight and
again after asynchronous preparation. The upload path rechecks it before each
Core mutation invocation and immediately before dispatching storage bytes. Both
Core mutations also carry a final dispatch guard after asynchronous API middleware.
An upload begun in an unavailable protected room emits
neither ticket metadata nor plaintext bytes. Both the composer and workspace Files panel bind
the callback to their actual Espace store. An upload already dispatched for an
ordinary room cannot retract bytes; the server's immutable creation boundary
prevents converting an ordinary room into a confidential one. Confidential
upload wiring still requires ciphertext bytes and opaque metadata; dispatch
guards alone do not encrypt an ordinary attachment.

`attachment-crypto.worker.ts` separately implements genuine attachment AEAD.
Its ciphertext digest describes ciphertext bytes. The key, IV, context and
digest descriptor must be sealed within the authenticated room payload before
that primitive can be connected to uploads. It is deliberately not exposed by
the public upload transport or presented as a shipped room integration.

A narrow successful native channel join emits `channel_joined` with only
`kind: chat|voice`, using the existing event dispatcher. It carries no room,
member, workspace or content identifiers, and does not fire on room navigation.

## Concrete missing lifecycle

The checked-in generated module exposes `BrowserMlsDevice` and
`BrowserMlsHttpDevice` for persisted signer creation/restoration, device
registration and KeyPackage publication only. `browser_bindings.rs` explicitly
excludes room operations. The existing Rust MLS engine supplies authenticated
room operations and durable checkpoint primitives, but the browser binding does
not export the room actor or the atomic room-store CAS boundary. Matrix SDK
crypto is not initialized by Espace. Neither a state marker nor a successful
device-publication status supplies a room session.

The remaining integration must expose native create/join/open/seal/open-envelope
operations through the existing dedicated device worker, bind trusted current
rosters and authoritative Core room IDs to immutable Matrix rooms, validate
welcome/commit relay ordering and receipts, and atomically persist ratchet,
epoch and replay state before acknowledging or publishing output. It must
handle removal/rekey, conflicting writers, failed acknowledgements, restart,
auth retirement and replay without recreating keys or retry budgets. Attachment
secret descriptors must stay inside that worker and enter only an authenticated
room payload. Download authentication must precede Blob URLs and previews.
The current implementation intentionally has no test-key, shared-key or
main-thread native-import escape hatch.

## Acceptance evidence

`room-boundary.test.ts` exercises both algorithms, malformed markers, foreign
state authors, mismatched encryption, marker/encryption removal, unknown state
and independent room classification. The real Matrix SDK controlled-HTTP store
tests verify no message/thread rendering or message/edit/thread/reaction/resend
transport for protected rooms, unknown-room refusal, state-only quarantine
updates and a real SDK send held across a protection-state change. The final
Matrix fetch fence runs inside access-token refresh retries and after SDK
encryption/scheduler awaits. A refresh-retry adversarial test changes protection
while credential renewal is pending and checks that no second request leaves.
Protected audio is refused before the call controller can request a token or
start capture. Ordinary teardown grants one finite dispatch capability for an
already active typing notice: an exact PUT to the current member’s typing
endpoint with the body `{"typing":false}`. The final fence consumes it once,
requires an ordinary or Community boundary at dispatch, and refuses unknown,
protected, foreign-member, opaque-body and content-bearing requests. Sign-out
grants no cleanup capability and revokes any pending one. Other retired work
remains refused; protected notices expire at their existing server timeout. Queue and upload tests verify authorization changes across asynchronous
preflight and ticket issuance cannot dispatch plaintext storage uploads. Cache
tests verify no pre-classification plaintext restore and ordinary post-sync
writes. Attachment primitive tests cover AEAD tamper, wrong scope/epoch,
ciphertext digest and descriptor tamper separately.

Status: Deferred — usable multi-device room sessions, authenticated receive,
durable epoch/replay recovery, encrypted attachment upload/download wiring,
compiled-worker acceptance, real Core/Synapse interoperability and release
qualification. Unit fixtures cannot establish these properties or justify
turning the unavailable badge into a verified confidentiality claim.
