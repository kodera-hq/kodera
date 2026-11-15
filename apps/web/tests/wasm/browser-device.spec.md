# Generated worker device proof

Status: Source implementation; all new cases unrun.

The focused gate uses the actual same-job wasm-bindgen output and generated declarations, the reviewed real local-state module from main, a dedicated HTTP-served module Worker and managed Chromium fixtures. The test never substitutes a native class or a declaration. The production graph does not import it.

Acceptance requires a healthy real Rust/IndexedDB create and same-signer restart, first-create commit-before-ACK recovery through actual unique-context discovery, independent WebCrypto registration verification and tamper refusal. Every malformed-input, Promise, acknowledgement, lifecycle, storage and CSP case must have a healthy control. The full frozen implementation will list exact actual test names before publication. A compiler check alone is insufficient.

The host can acknowledge only after strict transaction completion and a current read. Its synchronous fence compares accepted immutable test context, active operation and latest independently obtained storage generation. It is not a Core authority ticket. Close/unknown storage outcome retires the actor; restart reads authoritative durable state and never implicitly creates a signer. Registration is a public possession proof, not Core admission.

KWE1 is device-only: magic4, key ID16, seed32, big-endian length4 and exactly sealed KDV1. Total is at most17MiB. All seed and native-vault buffers stay worker-local; no logs, screenshots, traces or raw failure snapshots retain them. KDA1 is192 bytes binding owner/org/member/public key/generations and digest of exact sealed KDV1, not the outer KWE1.
