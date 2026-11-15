# OpenMLS crypto-provider generation backport

Status: Source and lock implementation. Native and browser compilation, cross-generation state compatibility and advisory qualification are Planned. This document does not certify an advisory fix or release.

The two MIT providers retain their published package identity `0.6.0` and implement the published `openmls_traits =0.6.0` interface. They are explicit local path patches, not registry releases. OpenMLS itself stays at `0.9.2`, memory storage at `0.6.0`, and TLS codec at `0.5.0`. Each provider retains its MIT notice.

## Provenance

The published baseline archives are:

| Package | Archive SHA-256 |
| --- | --- |
| `openmls_basic_credential 0.6.0` | `dbd3f0c3422e7c7a8496f042b547b0c28d0793f8ba97feb401966e58196a1e40` |
| `openmls_rust_crypto 0.6.0` | `36bf3fe824ead6e81d22f49a9cd7feffca3494979fac14c1248e19516e3625f1` |

Both baseline VCS records identify OpenMLS commit `3a3e35de3feeca8f6605143c464d5452ae584d43`. The modern implementation basis is immutable upstream commit [`6100df3fb1d8c3eeab53e349fcbd621f98c44fe2`](https://github.com/openmls/openmls/tree/6100df3fb1d8c3eeab53e349fcbd621f98c44fe2).

Imported implementation changes are checked ECDSA private-key conversion, modern ECDSA/Ed25519 generation, modern RNG initialization, checked AEAD nonce conversion and SEC1 verification. The optional obsolete RNG shim is removed because the provider now uses `rand_core 0.10` directly. The key-pair private/public/scheme layout, bare-byte serde compatibility, TLS encoding, redacted debug output, storage identifiers and original test modules remain unchanged. The published optional `hpke_seal_psk_resolved_aad` callback and feature tables remain; no newer upstream trait method is substituted.

## Dependency and runtime boundary

Both provider manifests require Rust `1.94.0`. This raises only the opt-in crypto configuration's declared minimum; the dependency-free workspace default retains Rust `1.80`.

The coordinated generation uses `p256`/`p384 0.14.0`, `ed25519-dalek 3.0.0`, `rand_core 0.10.1`, `rand_chacha 0.10.0`, `getrandom 0.4.3` with `sys_rng`, `aes-gcm 0.11.1` and `chacha20poly1305 0.11.0`. The unmodified published `hpke-rs`, `hpke-rs-crypto` and `hpke-rs-rust-crypto` packages are pinned to `0.8.0`; the latter updates its `k256` backend as well. No local HPKE fork is included.

Upstream entropy initialization uses `UnwrapErr(SysRng)`: `Default` can panic on entropy failure. There is no deterministic or weak fallback and no new browser recovery guarantee. Browser builds must separately enable the appropriate `getrandom` JavaScript feature and qualify actual worker behavior.

The local RNG output refinement differs from the upstream buffer-fill implementation: bytes are appended directly from fallible ChaCha20 random words in explicit little-endian order. Both public RNG methods retain the write lock and typed error handling; no constant-byte fallback or unsafe initialization is used. Array requests allocate a temporary vector of the same requested length, transfer its ownership to the existing zeroizing `SecretVLBytes` wrapper, copy the exact-length result to the array, and wipe that heap buffer on drop. Temporary words are ordinary stack values, so this is not a universal erasure claim. Partial words may be discarded, changing stream consumption without changing the CSPRNG or serialized key formats. Compilation, boundary/error controls and fresh CodeQL results must qualify this refinement.

## Required qualification

The old normal graph contains `crypto-bigint 0.5.5` through all three legacy curve roots. RUSTSEC-2026-0387 remains open until actual replacement graphs and applicable tests qualify this backport. Adding a new bigint version alone does not remove an old path. No scanner suppression or synthetic package version is used.

Qualification must cover the actual native and browser normal/build feature closures, all newly selected checksums/advisories/licences/MSRVs and host build scripts or procedural macros. It must prove that old `p256`/`p384`/`k256 0.13` paths no longer select `elliptic-curve 0.13` and `crypto-bigint 0.5`. The MPL distribution policy for the HPKE layer remains a separate release gate.

Use fresh temporary generated keys for signature DER/SEC1, three-curve KEM/HPKE/exporter and AEAD interoperability and malformed-input controls. Preserve the restored-signer scheme/public binding before any private possession operation. Test old-to-new and supported reverse key/provider/room checkpoint restoration with real Welcome/Commit/application exchanges, unchanged storage/TLS/serde frames and all existing device/session refusal controls. No source comparison replaces these runtime checks.

The core adds 18 generated-key primitive qualification tests for signatures, AEAD and X25519/P256/P384 HPKE/exporters. The provider adds five PSK callback tests under its existing `targeted-messages-draft` feature; dependency tests require a separate reviewed package context. These are source additions with runtime qualification Planned. They add no public key-export API, production feature forwarding or deterministic valid private-key fixtures.

Classical HPKE private-key inputs are checked against RFC 9180 `Nsk` lengths before backend conversion for open, receiver/exporter setup and PSK open. This rejects shorter general scalar encodings while preserving each operation's typed error. Draft/PQ validation remains with the backend. Exporter refusal tests include fixed public stage labels; they never print private material.
