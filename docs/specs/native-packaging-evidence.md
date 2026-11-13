# Native package evidence gate

Status: Offline verifier and reusable workflow prepared; real paired native builds,
authenticated builder provenance, device qualification and releases remain pending.

The desktop client remains a developer preview, and the mobile clients have no
store release. A passing synthetic self-test does not change those statuses.
The gate checks supplied unsigned package bytes and bound declarations. It does
not build a client, discover dependencies from compiled code, authenticate a
builder, sign, notarise, publish, deploy or approve a release.

## Acceptance boundary

Two distinct physical files must contain identical bytes. Hard links, symlinks,
empty files and oversized inputs are refused. Each package is read through an
open descriptor, CRC-checked without extraction or execution, and hashed again
before success to detect changes during verification. ZIP members cannot escape
their directory, collide by case, be encrypted or be symlinks. Bounded member
counts and expanded sizes limit archive processing.

The admitted targets are unsigned ZIP-compatible containers, including APK, AAB
and IPA. A paired build bundle uses this fixed layout:

```text
first/package.zip
second/package.zip
sbom.cdx.json
evidence.json
toolchain-lock.json
```

| Target | Required members |
| --- | --- |
| `android-apk` | `AndroidManifest.xml`, `classes.dex` with a DEX prefix |
| `android-aab` | `BundleConfig.pb`, `base/manifest/AndroidManifest.xml`, `base/dex/classes.dex` with a DEX prefix |
| `ios-ipa` | `Payload/Kodera.app/Info.plist`, `Payload/Kodera.app/Kodera` with a Mach-O prefix |
| `desktop-macos` | `Kodera.app/Contents/Info.plist`, `Kodera.app/Contents/MacOS/kodera` with a Mach-O prefix |
| `desktop-windows` | `kodera.exe` with a PE/DOS prefix |
| `desktop-linux` | `kodera` with an ELF prefix |

These checks establish structural membership, not a working native application,
binary architecture, embedded identity, entitlements or installed-device behavior.
Other installer formats and later signing or store transformations require their
own evidence; they are not silently normalised into reproducibility.

## Build and toolchain declarations

`evidence.json` accepts exactly these fields:

- `schema_version`: integer `1`.
- `revision`: the caller's exact full commit SHA; it must match `--revision`.
- `target`: the exact admitted `--target` value.
- `source_date_epoch`: a positive integer supplied identically to both builds.
- `toolchain_sha256`: SHA-256 of the actual `toolchain-lock.json` bytes.
- `sbom_sha256`: SHA-256 of the actual `sbom.cdx.json` bytes.
- `builds`: exactly two records, ordered as first and second candidates. Each has
  a distinct canonical non-nil UUID `invocation_id`, exact `artifact_sha256` and
  integer `artifact_size`.
- `inventory`: the component records described below, sorted by their `ref`.

`toolchain-lock.json` contains exactly `schema_version` (`1`),
`environment_sha256` (a full SHA-256) and a nonempty `tools` array. Each tool has
one unique lowercase `name` and an exact numeric `version`. Moving aliases such
as `stable`, `latest` and `main` are refused. Required tool names are:

- Android: `java`, `gradle`, `android-gradle-plugin`, `kotlin`.
- iOS: `xcode`, `swift`, `sdk`.
- Desktop: `rustc`, `cargo`, `tauri`.

The producing build must retain the environment and toolchain evidence behind
those declarations. Hash binding is a consistency check, not proof that a remote
builder used those tools or obeyed `SOURCE_DATE_EPOCH`. Distinct invocation IDs
are correlation identifiers, not independent-builder authentication. Two copied
files and fabricated declarations cannot establish independent builds. A trusted
build service and reviewer must establish that provenance separately.

## SBOM and licence policy

The restricted `kodera-native-inventory-v1` policy profile consumes [CycloneDX JSON 1.6](https://cyclonedx.org/docs/1.6/json/).
This verifier checks the fields it consumes; it does not claim complete schema
validation of every optional CycloneDX feature.

The SBOM has positive integer `version`, `bomFormat: CycloneDX` and
`specVersion: "1.6"`. `metadata.component` identifies the Kodera application,
declares `Apache-2.0`, has a unique `bom-ref` and contains one unambiguous
`SHA-256` hash matching the package bytes. Its `properties` include unique
`kodera:source-revision` and `kodera:target` values matching the caller.

Every declared dependency, including nested components and components marked
excluded, is checked. Each needs a unique `bom-ref`, name, version, supported
component type, full SHA-256 and one explicit SPDX licence choice. Freeform
licence names, ambiguous choices and undeclared licences refuse. The accepted
forms are `{"license":{"id":"MIT"}}` or an `expression` using SPDX identifiers,
parentheses, `AND` and `OR`. `AND` requires both branches; `OR` permits selection
of an admitted branch. Exceptions using `WITH` require a separate review and are
currently refused.

The explicit permissive identifier set is `Apache-2.0`, `MIT`, `BSD-2-Clause`,
`BSD-3-Clause`, `ISC`, `0BSD`, `Zlib`, `BSL-1.0`, `CC0-1.0` and `Unlicense`.
All expression identifiers must belong to the explicitly recognised policy subset.
Unknown identifiers and unreviewed LicenseRef branches refuse even beside an
admitted OR alternative. Recognised GPL/LGPL/AGPL alternatives can participate in
an explicit OR selection, but copyleft-only choices refuse rather than being inferred
permissive from the absence of a deny-list match. Adding a licence is a reviewed
policy change with an accepting case and a named refusing mutation.

The dependency graph covers every declared component, has no unknown or duplicate
references, and connects every component to the application. Each build-inventory
record contains exactly `ref`, `name`, `version`, `sha256` and `license`, with
values identical to the bound SBOM. This detects disagreement and omissions
between supplied inventories. It does not independently prove that the producing
scanner discovered every embedded library or that upstream licence declarations
are accurate. Retain scanner inputs, upstream licence evidence and notices for
review. The existing repository dependency policy continues to apply.

## Run and integrate

```bash
python3 scripts/ci/check-native-packaging.py \
  --first candidate/first/package.zip --second candidate/second/package.zip \
  --sbom candidate/sbom.cdx.json --evidence candidate/evidence.json \
  --toolchain candidate/toolchain-lock.json \
  --revision FULL_EXPECTED_COMMIT_SHA --target android-apk
python3 scripts/ci/check-native-packaging.selftest.py
python3 scripts/ci/check-native-packaging-workflow.py --selftest
python3 scripts/ci/check-native-packaging-workflow.py
```

Success prints bound hashes and counts, `reproducible_bytes: true` and
`distinct_declared_builds: true`. `validation_profile` is `kodera-native-inventory-v1` and
`cyclonedx_full_schema_validated` is false. `builder_authenticity_verified` and
`release_approved` remain false. A refusal exits `1`, names the violated boundary
on stderr and prints no successful report. JSON rejects duplicate keys and
nonfinite numbers. Verification runs on POSIX descriptors, as in the Ubuntu
workflow; no candidate is executed.

The reusable `.github/workflows/native-package-gate.yml` downloads exactly one
artifact from its own run, reads fixed evidence paths, checks out `github.sha`
without persistent credentials and passes the same trusted SHA to the verifier.
Inputs enter the shell through quoted environment variables. Permissions are
read-only; there is no cross-run fallback, inherited secret or release step.
Future producing jobs must call it with `bundle-name` and `target` after both
real builds and evidence assembly. Those producing jobs are not implemented by
this change, so current CI makes no native release certification claim.

The mandatory CI plan runs the synthetic artifact proofs and the workflow policy
guard with named refusal mutations. The aggregate guard refuses missing, skipped
or masked proofs. Independent exact-head workflow review, successful actual
candidate verification, authenticated build provenance and the applicable human
release gates remain necessary before publication.
