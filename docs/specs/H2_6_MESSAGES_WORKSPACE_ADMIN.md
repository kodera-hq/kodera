# Messages and workspace identity

Status: Implemented; verified locally.

Messages uses a desktop master/detail layout and a mobile list with explicit back navigation.
Mode buttons are compact, labelled icons; the legacy `simple` preference resolves to `messages`.
The conversation list preserves confidential-preview boundaries and offers instant filtering.
Existing message, attachment, poll, voice, reaction and read-only controls remain authoritative.
Arrivals precedes all channels regardless of stored position, spelling or category.

Workspace profile writes retain administrator authorization, tenant scope and If-Match checks.
Optional display name, default mode, landing channel and member capabilities are additive.
Workspace invitation limits use Matrix power levels while preserving the bounded partner-room
policy shape, so disabling new invitations does not invalidate an existing bridge.
A bounded raster logo is uploaded through the existing profile PATCH as a validated data URL;
only PNG, JPEG and WebP signatures are admitted, with a decoded limit of 2 MiB. No external
logo URL is accepted. The logo is held on the workspace row, so there is no new media ACL or
expiring download ticket. Clearing it uses an empty string. Profile reads and bootstrap return
the same logo. The browser converts these raster bytes to a local blob for the existing image CSP. This intentionally bounded storage avoids cross-tenant attachment rebinding.

Acceptance: legacy preferences, keyboard mode selection, list filters, mobile back navigation,
confidential previews, outgoing bubbles, arrivals ordering, profile validation and stale-write
refusal are covered by tests. Socket initialization must preserve an actively listening socket
and retain private directory ownership and modes on repeated runs.
