# Trusted edge: the client's address and the caller's request id

**Status:** Proposed · **Owner:** API seat

The server runs behind a reverse proxy at the network edge. Two values a request carries
can be written by anyone on the internet: `X-Forwarded-For` and `X-Request-Id`. This spec says when
the server believes the first and how it keeps the second apart from its own ids. The code is
`core/api/edge.py`; the acceptance is `tests/test_trusted_edge.py` and the trusted-edge cases of
`tests/test_discovery_http.py`.

## 1. Why

Without explicit proxy trust, Gunicorn trusts no forwarded header (`config/gunicorn.py`), and realm
discovery keys its per-client quota on `REMOTE_ADDR`. Behind a single reverse proxy, every external
client would otherwise share one discovery bucket of 30 requests per minute. Separately, echoing a
caller's raw `X-Request-Id` would let an unauthenticated caller make a request look like a
server-generated identifier in logs or audit events.

## 2. The client address

- Setting: `KODERA_TRUSTED_EDGE_ADDRESSES`, read by the deployed API profile
  (`config/settings/deploy.py`) into `KODERA_TRUSTED_EDGE`. A comma-separated list of at most 8
  addresses or networks, each no wider than an IPv4 `/24` or an IPv6 `/120`, with no host bits set,
  no IPv4-mapped IPv6 network and no duplicate. Unset or empty: no edge is trusted (fail-safe
  default). Anything else stops the process at start, with a message that carries no value.
- Rule (`client_address`):
  1. The direct peer (`REMOTE_ADDR`, IPv4-mapped IPv6 read as IPv4) is not a trusted edge: the
     client is the peer. A forged `X-Forwarded-For` from anywhere else is never read.
  2. The peer is a trusted edge: read `X-Forwarded-For` from the right, at most 16 hops. A hop that
     is itself a trusted edge is skipped; the first other hop is the client (rightmost untrusted).
  3. An absent header, a malformed hop met before the client, a chain of trusted hops only, or more
     than 16 hops to read: the client is the peer. The request then shares the edge's bucket. This
     costs availability, never lets a caller choose an address.
- Nothing but `client_address` reads `X-Forwarded-For` (`docs/api/CONVENTIONS.md` §11), and
  `tests/test_trusted_edge.py` fails on any other reader. Today its one consumer is
  `discoverRealm`'s peer quota, whose IPv6 `/64` bucketing applies to the result.
- Gunicorn's own forwarding trust stays empty: it would only rewrite the scheme, which the server
  never infers from a header (`SECURE_PROXY_SSL_HEADER = None`).

## 3. The caller's request id

- `CallerRequestIdMiddleware`, first in `MIDDLEWARE`, rewrites `X-Request-Id` before any view reads
  it. A caller's value matching `^[A-Za-z0-9_-]{8,62}$` becomes `c-` and the value; any other value
  is removed, and the view generates a UUIDv7 as before. `c-` plus 62 characters is the contract's
  64-character maximum.
- A UUIDv7 never starts with `c-`, so a caller can never send an id that passes for one the server
  generated. The `c-` id is echoed on the response, in every problem body, log line and audit
  event, preserving caller correlation while keeping server-generated ids unambiguous.
- Views keep their own `[A-Za-z0-9_-]{8,64}` check and UUIDv7 fallback for direct `RequestFactory`
  calls in tests.

## 4. Reverse-proxy deployment

Trusting an address trusts **every process that can send from it** on that container network.

**Deployment checklist:**

1. Allocate the reverse proxy a static address outside the container network's dynamic DHCP pool
   (for example RFC 5737 documentation network `198.51.100.0/24` with proxy pinned at
   `198.51.100.2`), or place the reverse proxy and API server alone on a dedicated internal network.
2. Ensure the reverse proxy and API server share one internal network so the API always observes the
   proxy's pinned source address.
3. Configure `KODERA_TRUSTED_EDGE_ADDRESSES=198.51.100.2` in the API container environment and
   recreate the container so the updated environment is loaded.
4. Verify that two `POST /api/v1/auth/discover` requests from distinct client networks each observe
   independent `RateLimit-Remaining` counters, and that IPv6 clients are bucketed per `/64`.

## 5. Acceptance

- `tests/test_trusted_edge.py`: one case per rule above, each mutation of `core/api/edge.py` caught
  by the case named for it; the setting's admitted and refused values; the deployed profile reads
  the setting and installs the middleware first.
- `tests/test_discovery_http.py`: behind a trusted edge each forwarded client has its own bucket; a
  forwarded header from an untrusted peer is ignored; hops written left of the edge do not choose
  the bucket; a malformed hop keeps the edge's bucket; a caller's id is answered under `c-`.
