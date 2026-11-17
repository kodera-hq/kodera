# Confidential Pages collaboration

Status: Implemented optional client capability and simulated relay evidence; Core encrypted document discovery and browser qualification remain deferred.

A caller explicitly supplies `{ required: true, epoch, cipher }` with a worker-backed cipher bound
to the same workspace scope, document and epoch. The policy is optional: existing workspace and
Community Yjs wire behavior remains unchanged when absent. A missing, inactive or mismatched
cipher refuses before the collaboration ticket request. Server errors in required mode cannot
select local Markdown fallback.

Required sessions never instantiate `IndexeddbPersistence`, even when offline buffering was
requested. `maySeedFromMarkdown` refuses both local and remote Markdown seeding under that
policy. `WorkspaceCollaborativeDocs` forwards the policy to its session and seeding/save gates,
so document body changes cannot fall back to plaintext REST Markdown writes.

The first socket frame remains the short-lived authentication ticket. Every subsequent sync or
awareness frame is sealed in the worker. Ordered send and receive queues preserve per-sender
sequence authority across asynchronous operations. Both paths recheck the current socket,
controller lifetime and live cipher scope/epoch authority after completion. Pending results from
a closed, replaced or revoked session are discarded. Owned plaintext copies are erased after
send encryption or after applying an authenticated update.

A required session accepts only the `KDE1` envelope prefix. Incoming plaintext sync or awareness,
failed authentication, wrong context/epoch or replay closes and quarantines the socket with
`forbidden` status, cancels reconnect work and retires its cipher. No plaintext resync is emitted
from a protected path. The ordinary sync protocol still controls viewer/editor write behavior.

`collabSession.confidential.test.ts` verifies two peers against actual WebCrypto through an
in-memory opaque relay, encrypted awareness, absence of document substrings on observed binary
frames, zero IndexedDB opens, missing-key admission, plaintext downgrade quarantine,
wrong-context/epoch/tag refusal, replay refusal and authority loss during seal/open. Existing
`collabSession.test.ts` and `collabWire.crossstack.test.ts` retain ordinary protocol evidence.

An explicitly provisioned worker epoch port is a prerequisite, not server discovery or proof of
human identity. The existing server collaboration protocol does not discover this capability or
provide an encrypted-document relay contract. This slice does not enable confidential Pages by
default, advertise human cross-signing or assert browser/server interoperability qualification.
