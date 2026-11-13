# Native crypto and discovery v2

Status: Local cryptographic implementations and refusal proofs available. Native
application bindings, hardware/registration attestation, protected persistence,
live radio exchange and service/device acceptance remain pending.

## Features and supported toolchains

The default crate has no external dependencies and retains the workspace Rust
1.80 minimum. `openmls-engine`, `megolm-engine` and `passkey-bindings` opt into real
cryptographic libraries; `native-crypto` enables all three. OpenMLS 0.9.2 and its
0.6 providers require Rust 1.91. Vodozemac 0.11.2 requires Rust 1.89, and P-256
0.14 requires Rust 1.85. Default-core tests are qualified on Rust 1.80.1;
cryptographic feature tests are qualified on the installed Rust 1.94.1 toolchain.
The generated workspace lock remains version 3. No unsafe code is permitted in
the workspace crate; upstream cryptographic implementations supply primitives.

```bash
cargo +1.80.1 test -p kodera-rs --no-default-features --locked
cargo test --workspace --all-targets --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
node packages/kodera-rs/scripts/audit-beacon-v2.mjs
```

The existing `uniffi-bindings` and `ble-transport` switches do not register a
platform bridge or a radio. Enabling crypto changes available Rust APIs, not the
runtime policy or encryption status of an installed client.

## OpenMLS group operations

`OpenMlsMember` uses the real RustCrypto OpenMLS provider, Ed25519 software
credentials and HPKE key packages. The ciphersuite is
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. These keys are software generated,
not an OS-keyring or hardware-attestation implementation.

`create` binds the MLS group ID to a domain-separated canonical organisation and
room. `join` authenticates and processes a real Welcome and refuses a different
scope or a group containing a device outside the trusted roster. The native
adapter must obtain that roster and each expected key-package signing key from
the actual membership/device admission boundary. An editable label, local rank,
key package or BasicCredential identity is not a membership grant.

`add_member`, `rotate`, `remove_member` and `apply_commit` run actual MLS
operations. Epoch rotation generates and merges a real self-update commit and
fresh cryptographic group secrets. Membership removal excludes the removed
device from the fresh secrets. A revoked roster entry blocks sealing while its
leaf remains in the group, so a failed removal cannot silently keep encrypting
to that member. Clearing local authority fails closed, even if a caller ignores
the returned error.

Application messages authenticate their group context, scope AAD, epoch and
actual member signing key. Untrusted outer metadata cannot relabel the sender
or room. The historical `OpenMlsDraft` enum discriminant is retained for API
compatibility; this implementation uses RFC 9420, not a metadata-only draft.
Past epochs are not admitted by this strict current-epoch interface.

Every mutating or receiving operation stages a bounded copy of the in-memory
provider store and loads real MLS state from it. Only complete success publishes
the staged group and ratchets. Tampered ciphertext, outer sender metadata,
commits or membership checks therefore cannot consume a live message secret or
advance the live epoch. No test-only cloning or secret-debug feature is enabled.
The implementation bounds staged storage, handshake input, payload and roster
sizes. Those are security limits, not measured fleet or transport capacity.

The memory provider is not a production persistence or rollback-protection
solution. A trusted adapter must protect and transact stored state, fence current
Core authority, coordinate multi-device commits and end the session on scope or
account teardown. In-memory copies are not a physical zeroisation guarantee.

## Megolm key epochs and protected delivery

`MegolmEpochSender` uses Vodozemac's actual Megolm v1 group session, AES-256,
message authentication and Ed25519 signature verification. Each plaintext
contains the canonical organisation/room binding and epoch inside the signed
ciphertext. Rewrapping outer metadata or relabelling an exported key therefore
does not rebind a payload to another room.

`rotate` creates a fresh cryptographic session/key, not only a higher number.
`MegolmEpochReceiver` admits only the current epoch and expected session ID,
checks the authenticated inner context, and retains every accepted message
index for that key. Out-of-order unused indices remain usable; duplicates do
not. A fresh epoch clears message indices only after installing a different
authenticated session key. Old session IDs cannot be relabelled as new epochs.
Capacity refuses and requires rekeying instead of evicting replay history.

Sensitive `MegolmEpochKey` values have redacted diagnostics and no implicit
plaintext serialization. With both engines enabled, `seal_to_mls` encrypts key
delivery inside the same MLS room. `open_from_mls` requires the expected key
distributor's authenticated MLS device key before returning an opaque key.
The adapter owns the distributor policy and current trusted roster. Revoked
devices must be removed from MLS before distributing a replacement Megolm key.
No Matrix key-distribution service, session persistence or downgrade fallback is
automatically enabled.

## Scoped passkey assertions

`PasskeyBinding` takes an already trusted registration's credential ID and P-256
SEC1 public key, organisation, canonical RP ID and exact expected origin. It
verifies real ES256 signatures over authenticator data and the hash of the raw
client-data JSON, following the
[WebAuthn assertion verification boundary](https://www.w3.org/TR/webauthn-3/#verifying-assertion).

OS entropy supplies each one-use 256-bit challenge. The trusted adapter supplies
the clock. A challenge is scoped to one organisation and credential, expires
within a bounded lifetime, and is consumed only after complete verification.
The signed counter cannot decrease once nonzero; authenticators reporting zero
still require a fresh challenge for every assertion. Capacity refuses instead
of evicting outstanding one-use state. Observed clock rollback refuses.

The strict profile checks the registered credential, ceremony type, exact
challenge, canonical unpadded base64url, exact origin, RP ID hash and actual
signature. It requires UP and UV, and refuses backup eligibility/state,
attested-data flags, extensions, cross-origin assertions, unknown/duplicate JSON
fields and malformed signatures. It intentionally supports the bounded
37-byte authenticator-data profile; it is not a complete WebAuthn server or an
enrolment/attestation ceremony.

HTTPS origins must be canonical RP hosts or their explicit subdomains. Exact
Android public signing-certificate facets use
[`android:apk-key-hash:`](https://developer.android.com/identity/passkeys/create-passkeys).
No certificate, signing key or provider console is read. The supplied association
and credential must already have passed trusted registration, public-suffix and
platform checks. Signed UP/UV/backup flags do not certify secure-element
residency or a hardware manufacturer. This verifier does not issue a Core login
token or turn local editable state into account authority. Protected counter,
challenge and credential persistence and actual OS authenticator acceptance are
separate requirements.

## Proximity discovery advertisements v2

The separate `KP` version-2 discovery packet is 27 bytes:

| Bytes | Field |
| --- | --- |
| 0–1 | `KP` magic |
| 2 | version `2` |
| 3–6 | big-endian 300-second window number |
| 7–14 | rotating 64-bit pseudonym |
| 15–18 | big-endian per-window sequence |
| 19–26 | truncated 64-bit organisation-discovery HMAC-SHA256 tag |

The per-device seed, organisation discovery key and canonical organisation
context derive a different pseudonym for each window and organisation. No
persistent device identifier or public key reaches the packet. The tag covers
all preceding packet bytes and the domain-separated organisation context.
Thirty seconds of previous-window reception is allowed; future or expired
windows, backwards clocks, altered bytes and non-increasing sequences refuse.
The bounded receiver never evicts a live pseudonym's replay record to admit a
flood. Expired records retire only after authenticated current-time admission.

A service-data AD header and 16-bit service UUID consume the remaining four
bytes of a legacy 31-byte advertisement. No room remains in that same payload
for additional AD elements. The real platform adapter must qualify its chosen
advertising format, permissions, radio addresses and scheduling. No radio call
is made here.

This is shared-key discovery, not device identity, membership, proximity proof,
confidentiality or an access grant. Members knowing the discovery key can forge
discovery packets. A rotating application pseudonym does not conceal a stable
radio address, timing or other hardware observations. Persist replay state and
sender counters, or reprovision private beacon seeds at the trusted boundary;
restarts are not given a lifetime replay guarantee. Logical key-field teardown
does not promise physical memory zeroisation.

The signed plaintext v1 frame format and its historical public vectors remain
unchanged. There is no automatic downgrade or reinterpretation between the v1
message frame and the separate v2 discovery advertisement. Neither is an
emergency service, and radio delivery or a person's safety is never guaranteed.

Public synthetic [v2 vectors](../vectors/proximity-beacon-v2.txt) are independently
derived with standard HMAC-SHA256. Rust exercises every wire-bit mutation with
the expected refusal and a subsequent valid retry. The separate Node oracle
checks all three public packets and 651 bit/scope mutations with its own crypto
runtime. No deployment key or device credential appears in those fixtures.

## Evidence and release boundary

Tests use actual OpenMLS welcome/application/commit cryptography, real Megolm
ratchets and fresh keys, and real ES256 assertion signatures. They cover tamper,
replay, wrong scope/sender/origin/epoch, revoked membership, transactional retry,
strict JSON, signed flags, protected cross-engine key delivery and discovery
mutations. Synthetic test controls do not certify a published native build,
hardware key, platform association, secure storage or installed-device flow.

Primary implementation references are the [OpenMLS book](https://book.openmls.tech/),
the [Vodozemac Megolm API](https://docs.rs/vodozemac/0.11.2/vodozemac/megolm/),
WebAuthn and the Android passkey guidance linked above. No provider, deployment,
signing-key, live account or production operation is performed by these helpers.
