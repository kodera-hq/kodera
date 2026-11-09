# The pinned Core API contract

`core-api.openapi.yaml` is a **verbatim copy** of `kodera-hq/kodera` at the commit named in
`contract.lock.json`. It is never edited here: a field the console needs is a change to the contract in
`kodera-core`, and a local edit would be silently overwritten by the next `npm run api:generate`.

`contract.lock.json` records where the copy came from (`repository`, `ref`, `path`), the contract's
`info.version`, and the `sha256` of the file. `npm run api:generate` verifies that hash before it
generates anything, so a copy edited in place fails loudly instead of producing a client nobody asked for.

To bump: copy the file from the new `kodera-core` revision, update `ref`, `commit`, `version` and
`sha256`, then run `npm run api:generate` and commit the regenerated output with it. A bump moves
`ref` to the contract's tag (`contracts/vX.Y.Z`), with `commit` recording the SHA the tag points at
(peeled: Core's contract tags are annotated, so the tag object's own SHA is not the commit). Before
committing, check that the file at the tag hashes to the `sha256` recorded here — the tag, not a
branch, is what the copy has to match.
