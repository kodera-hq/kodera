# Worker cross-signing and security codes

Status: Implemented as a local, session-scoped verification flow; server trust publication and persistent endorsement keys are deferred.

The dedicated worker owns one non-extractable ECDSA P-256 private key per organisation/account/device session. Only its raw public key, SHA-256 key identifier, canonical endorsement statements and signatures leave it. Closing, sign-out and accepted erasure retire the worker. A session key is never represented as an admitted messaging device or durable account trust root.

Statements are canonical JSON arrays: `["kodera-device-endorsement",1,organisationId,accountId,endorserKeyId,targetDeviceId,targetPublicKeyBase64,issuedAtEpochMs]`. Verification pins the expected endorser public key, target and principal, rejects self-loops, unknown fields, future issuance, age beyond ten minutes, noncanonical encoding and tampering. ECDSA uses SHA-256 and a fixed P-256 suite; there is no algorithm negotiation or weaker retry.

SAS uses HKDF-SHA-256 over a canonical, lexicographically device-ID-ordered transcript including organisation, account, both IDs/public keys and a 32-byte session nonce. Independent domain-separated decimal and vocabulary derivations yield eight unbiased four-digit groups (about 106.3 comparison bits) and seven entries from a fixed 64-word vocabulary (42 comparison bits). The short tuple alone is weaker; users compare every decimal group over an independent trusted channel. Identical IDs/keys, malformed public keys and nonce fail closed. Local calculations do not prove remote possession or network provenance.

No network API or mock response is used: all inputs are explicit public peer descriptors. Acceptance tests cover canonical ordering, context/nonce sensitivity, key non-extractability, signature/target/principal/time binding, self-loop rejection, malformed data, document-context refusal, worker RPC shape, retirement and local UI comparison.
