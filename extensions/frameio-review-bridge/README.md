# Frame.io Review Bridge

Status: Local connector implementation

The `/frameio-review` command accepts a public Frame.io review URL and is restricted
to the `post-production` and `dailies-rushes` channel bindings. Signed `asset.ready`
events target dailies; `comment.created` and `review.status_changed` target
post-production with an explicit role mention. Comments are bounded and stripped of
markup and uncontrolled mention syntax. Review state is either Approved or Needs Changes.

The shared SDK verifies the HMAC-SHA256 envelope, timestamp and replay cache before
invoking a handler. The operator must configure the shared signing secret at the
webhook ingress. The SDK canonical manifest vocabulary remains unchanged; provider
event names are listed in `providerEvents`. This adapter performs no outbound asset
fetch. Only HTTPS `app.frame.io`, `next.frame.io` and `api.frame.io` URLs are admitted.
The bound SMPTE notation assumes at most 30 frames per second.

Run `npm test` here. Tests cover delivery routing, signature tampering, replay,
comment bounds, status/timecode validation and URL refusal vectors.
