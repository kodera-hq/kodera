# Privacy-first EU telemetry

Status: Implemented

## Consent and deployment

`VITE_POSTHOG_KEY` is unset by default. A literal build gate removes the lazy bootstrap and
capture transport when unset. `VITE_POSTHOG_HOST` accepts only `https://eu.i.posthog.com`.
Configured builds still collect nothing until the current person explicitly enables optional
diagnostics for the current workspace in workspace privacy settings. Consent is a browser-local
choice keyed by account and workspace, not an organisation-wide administrator setting.
Switching account, workspace or losing session authority stops the prior sink. No earlier events
are buffered or replayed. Storage failure refuses opt-in and cannot prevent immediate opt-out.
Cross-tab withdrawal stops collection too. An explicit static-server `--telemetry-host` flag
admits only the EU `/i/v0/e/` endpoint; unconfigured Community deployments have no such CSP origin.

## Privacy boundary

The capture API adapter sends a fresh memory-only random identifier, a fixed event name and a
new object constructed from per-event property allowlists. Unknown events and properties are
dropped. Strings are closed enums. Counts, timing values and booleans are bounded primitives.
Delivery is capped at 60 events per minute per diagnostic session; excess events are dropped without a queue.
Raw errors, messages, filenames, document bodies, Yjs updates, emails, tokens, encryption keys,
account/workspace IDs, URLs and referrers never enter payloads. Error stacks contain only the
static `bundle` code plus line/column numbers from same-origin compiled asset locations; raw
messages, asset names and function names are discarded. This is less precise than full stacks
and intentionally cannot identify a document or dynamic component.

`maskAllInputs: true` and `[data-ph-no-capture], .ph-no-capture` are mandatory privacy policy
settings. The current implementation installs no DOM capture mechanism at all. The protected
workspace ancestor, document editor, timeline messages and privacy panel are marked as capture
exclusions for future adapters. Replay and autocapture stay disabled. A future SDK integration
must preserve these rules and prove that it cannot enrich events with content or identifiers.

## Signals

The existing `track()` API feeds the optional sink. Navigation reports a closed route area and
elapsed duration, never a path. Onboarding reports actual completion and a closed hosting mode;
channel opening derives chat/voice from the selected channel, and chat/docs/files canvas changes report actual applied transitions with elapsed duration. Error boundaries, uncaught errors and promise
rejections report only an allowlisted class, source, component code and sanitized code locations.
Performance observers collect LCP candidates, CLS session-window maxima and interaction latency after consent,
and classify resource latency into fixed chat, document and file operation names without sending
resource URLs. Interaction latency is not labelled as INP. Browser timing support varies. No observer backfills activity before consent.
Explicit document operation measurements report completion/failure without including operation inputs.
The `channel_joined` signal uses the existing event dispatcher; its producer, which verifies actual
joined membership, is supplied by the independent companion room-privacy change. This change
itself reports selected-channel opening and does not infer membership from navigation.

## Capture API mock and acceptance

The transport mock intercepts `POST https://eu.i.posthog.com/i/v0/e/` and inspects only the JSON
body, request credentials, referrer, redirect policy and abort signal. It has no Core API response
or new backend business endpoint. Properties include `$process_person_profile: false` and
`$geoip_disable: true`; no identification or feature-flag requests occur.

Targeted acceptance tests prove disabled and opted-out zero delivery, every non-EU host refusal,
malicious token/email/message stripping, safe error locations, malformed-event isolation,
revocation including failed storage, scoped consent, no backfill, consent races and pending-request
abortion. UI tests exercise the privacy switch and its local wipe. The production bundle scanner
rejects transport markers in unconfigured builds. Serving tests prove default CSP exclusion and
EU-only opt-in admission. Already delivered events require the operator's retention/erasure
process; the privacy switch clears local diagnostic state only.
