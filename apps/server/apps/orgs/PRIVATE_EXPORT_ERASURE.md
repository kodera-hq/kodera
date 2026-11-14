# Private export volume erasure

Status: Concrete workspace adapter qualified with PostgreSQL, filesystem and restricted-login tests;
production provider configuration and deployment qualification remain held.

`PrivateExportErasureAdapter` connects the durable workspace cutoff to an explicitly configured
`PrivateVolume`. It uses only the exact export UUIDs and original immutable expiry timestamps
captured in the approved erasure inventory. It never scans other requests, infers a deadline
from a revoked SQL row, or obtains a default volume or credential. The processing role needs
its existing erasure-journal permissions; it receives no global export-table access.

The recovery deadline and every original export lifetime must pass according to both the
database and volume clocks. The request-directory lock waits for an admitted nested writer;
a queued writer rechecks its immutable expiry under that same lock. The adapter collects a
bounded page of expired payloads, including orphan bodies and staging files, and requires
fresh complete absence for every inventoried request before issuing a receipt. A partial
page advances physical cleanup and returns an explicit hold. Empty structural directories
may remain; they contain no archive, source, staging or manifest payloads.
One scope admits at most 10000 request IDs; one collection call inspects at most 1000 payloads.
An oversized scope refuses explicitly rather than issuing a partial receipt.

A configured volume alone cannot certify the absence of snapshots or backups. A trusted,
bounded `ReplicaAbsenceVerifier` is mandatory and must freshly cover every replica for the
same scope and request inventory, returning a stable evidence digest. There is no implicit
success for an installation believed to have no replicas. The receipt binds that digest;
verification checks it again and repeats the physical absence checks. Missing volume,
deadline inventory, completeness evidence, original lifetime or current authority refuses.

The SQL admission captures the original expiry before revoking resumability. Malformed
legacy request snapshots require explicit qualification rather than a guessed new lifetime.
All archive writers must use the configured volume and the original immutable `Request`
expiry. Out-of-protocol filesystem writers and replica providers remain outside the local
storage implementation's trust boundary.

This adapter supplies only the workspace `private_exports` domain. Matrix accounts/rooms,
tenant objects, identity-provider data and extension receivers still require their own
actual absence adapters. The separate account-erasure protocol is not completed by this
workspace receipt. No HTTP endpoint, provider integration or production deployment is
activated here.

Twenty-two actual PostgreSQL/filesystem controls include independent processing-role login,
receipt persistence without export-table access, original lifetime and lagging-clock holds,
bounded cleanup resumption, malformed inventory, changed replica evidence, residual payloads
and missing root refusals. Explicit replica controls qualify only the isolated test world.
