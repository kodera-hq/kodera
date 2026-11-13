# Workspace attachments and public URL previews

Status: Proposed

The Core 0.43 operations use current persisted organisation membership and workspace
authority before every effect or replay. Attachment keys contain only organisation
and attachment identifiers. Upload/completion actions and successful previews append
identifier-only audit events; URLs, filenames and extracted page content are omitted.

Uploads admit JPEG, PNG, WebP, GIF, PDF, plain text and generic binary files, from one
byte through 25 MiB. HTML and SVG are refused. A PUT signature binds MIME, length,
SHA-256 and attachment disposition. Completion checks the provider's actual length,
MIME and verified whole-object SHA-256; a missing checksum or multipart aggregate
fails closed. Every download forces `Content-Disposition: attachment`, including
images. Metadata becomes visible only after verification. Upload and download
signatures expire after 300 seconds; every new download ticket rechecks membership.

The API has no S3 credential. `KODERA_MEDIA_GATEWAY_SOCKET` selects a private Unix
socket owned by its separate signing worker. The worker reuses the deployed
infrastructure-environment refusals and loads a mounted Secret Manager credential
for the requested organisation on each operation. Its directory is mounted into
that worker alone; the API receives only the socket. A missing worker returns a
retryable service-unavailable problem and writes no upload/completion effect.
An actual object mismatch returns conflict.

The worker entry point is `python -m apps.media.storage_worker --socket
/run/kodera/media.sock --secret-directory /run/kodera/media-secrets`. Provision the
parent socket directory with the shared service owner's permissions. The worker
creates a mode-0600 socket, refuses an existing path, and removes only its own
socket inode on exit. Each credential file is named by the organisation UUID and
contains `endpoint`, `bucket`, `region`, `accessKey`, `secretKey` and optional
`sessionToken`. The endpoint is HTTPS and the bucket is private. Configure storage
CORS for the exact Console origin and the returned signed upload headers. The
browser derives `Content-Length` from the uploaded file; its length must match
the accepted descriptor. No live provider configuration is part of this change.

The unfurler resolves DNS once per redirect hop and validates every answer before
opening a numeric-address socket. TLS retains the original verified hostname and
uses only the deadline left after TCP connect. Loopback, private, link-local,
metadata, CGNAT, multicast/reserved and translated IPv6 addresses are refused.
Only HTTP(S) on ports 80/443 is admitted, with at most three redirects, a 256 KiB
HTML body and one absolute three-second deadline. Compressed bodies are refused.
Metadata is plain text. Canonical URLs retain the validated origin; preview images
are omitted until their bytes, MIME and dimensions are independently validated.

Tests use generated identities/credentials, fake DNS/providers and an owned private
socket. Signature compatibility is also checked against an independent S3 SDK in
an isolated temporary tool directory. No real provider request is required.
