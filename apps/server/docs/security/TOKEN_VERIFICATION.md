# Local access-token qualification

**Status:** Implemented for local qualification; independent review pending

This package qualifies a signed access-token profile against an explicitly admitted
issuer/public-key snapshot. Its only consumer is a disposable local identity-provider
acceptance harness. It does not authenticate a Core principal, resolve database
identity or membership, grant permission, or expose an HTTP endpoint.

## Contract

`verify_access_token(compact, *, admitted)` returns immutable signed evidence:
issuer, subject, audience tuple, integer times and optional assurance claims. No raw
token, role, organisation, authentication boolean or MFA decision is returned.
The snapshot is built from trusted configuration and public JWKS; no token can admit
an issuer or request a URL. The verifier performs zero network calls.

- RS256 with RSA >=2048 bits or ES256 with P-256 only. Strict compact JWS/JSON,
  maximum 16 KiB, exactly three nonempty base64url segments, duplicate keys refused.
- Exact admitted issuer, audience containing `kodera-server`, nonempty subject,
  signed payload `typ: Bearer`. An ID/refresh token is refused irrespective of
  JOSE header type or the OAuth response wrapper.
- Integer `iat` and `exp` required; `nbf` optional, integer if present. Booleans,
  strings and floats are not times. `exp > iat`, present `nbf < exp`. With 30 seconds
  leeway, `exp <= now - 30` expires and `iat/nbf > now + 30` is premature.
- Nonempty kid <=128 ASCII characters. Reject ambiguous keys, algorithm/key mismatch,
  private/symmetric/encryption keys, embedded keys, critical extensions and key URLs.
  JWKS <=256 KiB, <=32 keys. Missing optional JWK metadata must still leave an
  unambiguous permitted public verification key.
- Snapshot expiry is enforced without token skew; a kid miss or expired snapshot
  refuses. Refresh is explicit; no stale global key cache exists.
- Closed diagnostic categories never include tokens, subjects or provider exceptions.

## Acceptance before implementation

`tests/test_token_fixture.py` first specifies real PKCE fixture shape and bounded
loopback transport. `tests/test_access_tokens.py` specifies signed positive and
negative cases before the verifier is written. Initial missing-module failures
are recorded outside the repository. `python dev/accept_identity_tokens.py` owns a real local provider and PostgreSQL, obtain access and ID tokens using actual
authorization-code + S256 PKCE login, then consume the verifier. Password/direct
grants, service accounts and fabricated MFA mappers are not substitutes.

The harness uses its own unique resource labels, ephemeral loopback ports and a
temporary synthetic import readable by the local container user. It removes only matching owned resources. It does not
read external credentials, existing provider configuration, arbitrary URLs or token
arguments. Token responses remain in memory and are never saved or printed.
The local HTTP transport connects to numeric loopback only, rejects redirects except
explicit browser-flow same-origin transitions, ignores proxy environment, forwards
no external credentials, and bounds response bytes plus connect/read/overall time.
HTTP is a local fixture exception, not a production policy.

| Case | Given / When | Then |
|---|---|---|
| TV-01 | Real RSA/EC signatures, altered signature or unsupported algorithm | Valid RS256/ES256 pass; altered/none/HMAC/wrong keys refuse |
| TV-02 | Shared kid, wrong issuer or token key URL | No cross-issuer binding and no network access |
| TV-03 | Wrong/missing audience/type, actual ID token | Refusal; actual Core-audience access token passes |
| TV-04 | Clock boundaries and invalid time types | Exact skew predicates; optional absent nbf passes |
| TV-05 | Duplicate JSON/JWK IDs, oversized input or private key | Closed refusal without sensitive diagnostics |
| TV-06 | Expired snapshot or explicit key rotation | Miss refuses; refreshed snapshot permits new key only |
| TV-07 | Redirect, stalled or oversized local response | Refusal within measured deadline; no proxy or URL escape |
| TV-08 | Real code flow with missing/wrong S256 verifier | Token exchange refuses; valid PKCE yields access and ID tokens |
| TV-09 | Signed roles or absent MFA claims | Evidence grants no Core authority; no business endpoint added |

Signed negative cases and selected guard-weakening mutations qualify the stated
boundaries; the measured evidence record below identifies the exercised mutations. The existing local
runtime acceptance and infrastructure-configuration refusals must remain green.
Local provider qualification is a separate explicit acceptance command; ordinary
unit tests do not claim they ran a provider.

## Pins and limits

Select the current upstream patch and resolve its immutable image digest before
running the fixture. The [upstream release](https://www.keycloak.org/2026/08/keycloak-2673-released)
identifies 26.7.3. This is local protocol qualification, not production image admission.
Use [PyJWT 2.13.0](https://pypi.org/project/PyJWT/2.13.0/) and
[cryptography 50.0.1](https://pypi.org/project/cryptography/50.0.1/) with artifact
hashes in `uv.lock`. Explicit library algorithms supplement strict claim typing;
[PyJWT defaults](https://pyjwt.readthedocs.io/en/stable/api.html) do not supply the
project's issuer admission or shared JWKS cache.

Current password-only fixtures contain no proven MFA flow. This acceptance must not
claim MFA, verified contact, enrolled identity, current membership, staff authority,
production key refresh/revocation or customer release readiness. Shared JWKS
admission, refresh budgets and DRF authentication belong to a later real identity
consumer, not this snapshot-only package.

## Artifact boundary and measured acceptance

The verifier is consumed by the host-side local provider harness. The API image
continues to copy only its existing settings and health modules; this package is
not copied into that image. `dev/accept_runtime.py` runs host tests against its owned
PostgreSQL, then checks the health image separately. Passing those tests is not an
image-level authentication claim. Add the exact service files to the image only
when the real admitted identity consumer exists, with its own boundary acceptance.

The provider publishes signing and encryption keys in one public JWKS. This parser
excludes explicitly RSA-OAEP encryption-only keys; it refuses contradictory usage
metadata, private/symmetric material, duplicate identifiers and a set containing
no admitted signing keys. Selecting an excluded key ID refuses. RSA verification
keys are bounded to 2048–8192 bits.

Run `python dev/mutate_token_guards.py` for the selected weakening checks in owned
temporary source copies. It prints only mutation verdicts; it never persists raw
test output or bearer values. The negative PKCE exchanges require the specific
`invalid_grant` error and expected missing-verifier or code-mismatch reason, checked
in memory against the pinned provider profile, not merely any HTTP 400.

The import directory and file are temporarily readable to the container user
(mode 755/644); they contain only a fresh synthetic local password. They are not
private-permission storage and are removed with their owning temporary directory.
No bearer values are stored in that directory or in acceptance logs.

Measured local acceptance: 214 host tests passed, including the original 53 runtime
and configuration checks; Django checks, migration-drift check and strict service
typing passed. The owned API image retained its health/database-outage and build
sentinel behavior. The separate real provider run passed S256 missing/wrong verifier
refusals, actual access-token verification and actual ID/refresh/wrong-audience
refusals. Ordinary pytest does not report the provider run as a collected test.

All 16 selected weakenings were caught: issuer, audience, signature, duplicate JSON,
access type, integer times, snapshot expiry, duplicate key IDs, token/JWKS/key-count/
key-ID limits, encryption usage metadata, response size, deadline interruption and
PKCE error qualification. Duplicate-JSON probes carry valid signatures; response-size
probes use the written wire limit independently of the implementation constant.
The timer test exposed an ordering race, corrected by marking expiry before socket
shutdown and checking elapsed wall time independently after reading.

The lock adds only PyJWT, cryptography and their cffi/pycparser dependencies. All 44
listed new source/wheel hashes matched official release metadata; the owned image
build and host environment exercised Python 3.12 compatibility. These checks are
artifact consistency and local protocol evidence, not a complete dependency security
assessment or production provider admission.
