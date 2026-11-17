# Confidential collaboration worker envelopes

Status: Implemented client capability; server session discovery and encrypted relay admission remain deferred.

## Contract

A dedicated worker owns each confidential collaboration epoch. Main-thread consumers receive
only `ConfidentialCollabCipher`: public context, active state, seal/open operations and close.
The worker receives its 32-byte epoch secret exclusively through a transferred `MessagePort`.
The worker-side session and port factories support deterministic protocol verification and future
room-session key-port provisioning. They are forbidden in document import graphs.

Yjs sync (0) and awareness (1) frames use HKDF-SHA-256 with a domain-separated, context-bound
subkey and AES-256-GCM with a random 96-bit nonce and 128-bit tag. The `KDE1` envelope contains
canonical authenticated metadata, nonce and ciphertext. AAD binds the protocol version, workspace
scope, document, epoch, frame kind, sender, monotonic sequence and ratchet index. Context strings
are bounded and byte inputs are copied before asynchronous work; shared, resizable and accessor
views are refused. Each sender has a strictly increasing receive sequence. Concurrent operations
are serialized so simultaneous duplicate opens cannot both succeed.

Confidential sessions disable plaintext IndexedDB and REST Markdown seeding. Socket authentication
remains a short-lived ticket control frame. Every Yjs data or awareness frame must pass the cipher;
plaintext, invalid authentication or revoked authority quarantines the session. Decrypted frames
and queued sends require live authority checks after asynchronous work. Worker-owned plaintext
and secret copies are erased on settle or retirement; nonextractable WebCrypto keys never leave
the worker.

## Evidence

`collab-crypto.worker.test.ts` covers sync/awareness round trips, ciphertext wire inspection,
caller mutation, context and tag tampering, replay races, unsafe storage, in-flight retirement,
worker-to-worker key ports, wrong-port context and document import refusal. Session integration
coverage lives with `collabSession`.

## Limits

This is a client cryptographic capability, not a Core MLS discovery endpoint or a claim of verified
human cross-signing. Existing ordinary collaboration server endpoints do not understand `KDE1`;
a confidential-capable relay and authenticated epoch source must explicitly provision the capability.
