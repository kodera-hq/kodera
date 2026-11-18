# The pinned Core API contract

`core-api.openapi.yaml` is a **verbatim copy** of `packages/api-contract/core-api.openapi.yaml`
in `kodera-hq/kodera`. Change that canonical source and synchronize its server and web copies.

`contract.lock.json` records where the copy came from (`repository`, `ref`, `path`), its immutable
Git `blob` object ID, the contract's `info.version`, and the `sha256` of the file.
The ref is `blob:<object ID>` so the canonical source and consumer can ship in one commit without
a reference to an intermediate commit that disappears when squashed. The blob is retained by
the committed canonical file, including in a shallow checkout. `npm run api:generate` verifies
SHA256 before it generates anything, so a copy edited in place fails loudly instead of producing
a client nobody asked for.

To bump: synchronize the canonical file, compute its Git blob ID with `git hash-object`, update
`ref`, `blob`, `version` and `sha256`, then run `npm run api:generate` and commit the regenerated
output with it. Consumer alignment checks compare the exact lock fields, version and SHA256,
and read the pinned Git blob offline to verify its version and bytes. Contract parity checks
hold all copies to the canonical source.
