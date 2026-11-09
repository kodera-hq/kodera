# Custom-domain state machine

**Status:** Proposed · **Owner:** Worker seat

How a customer host becomes a live, certificated name on a tenant. Bound by the rule from the strategy: **a host is never added to the certificate list before its ownership nonce has been verified.** An unverified name in the edge's host list is a way to make us issue a certificate for a name we do not control, and to make the edge answer for it.

Platform names (`{slug}.visio.kodera.io`, `{slug}.livekit.kodera.io`, `{slug}.docs.kodera.io`) are created by the `provision` job in our own zone and enter `live` directly; this document governs `Domain.kind = custom`.

## 1. The enum

```text
pending ──▶ nonce_issued ──▶ txt_verified ──▶ dns_pending ──▶ certificate_issued ──▶ live
                  │                │                │                   │              │
                  └────────────────┴────────────────┴───────────────────┴──────────────┴──▶ failed
```

| State | Meaning |
|---|---|
| `pending` | The row exists. Nothing has been asked of the customer yet |
| `nonce_issued` | A verification nonce exists and the console is showing the customer the exact record to publish. TTL running |
| `txt_verified` | The `_kodera-verify` TXT record was observed with the right nonce. Ownership is proven |
| `dns_pending` | The host's own record (CNAME or A) does not yet resolve to us; the certificate cannot be issued until it does |
| `certificate_issued` | The host is in the edge's certificate list and a certificate covering it exists |
| `live` | The host serves the tenant, is in the application's allowed hosts and redirect URIs, and — for a media host — the certificate is in place on the media service |
| `failed` | A check failed past its retry budget, or the nonce expired. Carries `last_check_error` |

`live` and `failed` are the only resting states. `failed` is recoverable: a re-verification restarts at `nonce_issued` with a fresh nonce.

## 2. Nonce

- Format: `kodera-verify=<48 base32 characters>`, from 30 bytes of a cryptographically secure random source, Crockford base-32, lower-case. The alphabet is `0123456789abcdefghjkmnpqrstvwxyz`: `i`, `l`, `o` and `u` are excluded, so a customer reading a record back over the phone cannot confuse them with `1` and `0`. Thirty bytes is 240 bits and base-32 carries five bits per character, which is where the 48 comes from — a value of any other length is not a nonce of ours.
- Example, deliberately non-random so a reader recognises it as an example and no scanner mistakes it for a live value: `kodera-verify=00000000000000000000000000000000000000000000fake`. A real one is 48 characters of that alphabet with no structure at all.
- Published at `_kodera-verify.<fqdn>` as a TXT record. For `meet.customer.org` that is `_kodera-verify.meet.customer.org`.
- One nonce per `Domain` row, stored in `Domain.verification_nonce`, replaced on every re-issue. A nonce is never reused across rows or across tenants; uniqueness is a database constraint.
- **TTL: 72 hours** from `nonce_issued_at`. On expiry the row moves to `failed` with `last_check_error = nonce_expired`. Re-issuing is a normal, unlimited operation for an `org_admin`.
- The nonce proves ownership at a point in time. It is **not** removed after verification: the record must stay published while the domain is `live`, and the recurring check in §5 re-reads it. A customer who removes it gets a warning, not an outage.
- Recommended TXT TTL for the customer's record is 300 seconds; we do not require it, we only tell them their first check may take as long as their existing TTL.

## 3. Checks

Each check is a named, independently retryable step. Every check resolves through **two resolvers on different networks** (the fleet resolver and the out-of-region probe host) and requires agreement; a disagreement is a retry, never a pass.

| Check | Runs in | What it asserts | Failure code |
|---|---|---|---|
| `syntax` | `pending` | The name is a valid, IDNA-encoded FQDN, at most 253 octets, not a public suffix, not one of our own zones, not already claimed by another tenant | `invalid_fqdn`, `reserved_name`, `already_claimed` |
| `nonce_txt` | `nonce_issued` | `_kodera-verify.<fqdn>` TXT contains exactly this row's nonce string | `txt_absent`, `txt_mismatch`, `nxdomain`, `servfail` |
| `caa` | `txt_verified` | Any CAA record on the name or its ancestors permits our ACME issuer; absence of CAA is a pass | `caa_forbids_issuance` |
| `target` | `dns_pending` | The name resolves to this tenant: a `CNAME` to the platform name for the role, or an `A` to the tenant's retained address for the role. No other target passes | `target_mismatch`, `unresolved`, `cname_chain_too_long` |
| `reachability` | `dns_pending` | An HTTP request to the name on port 80 reaches this tenant's edge (the ACME HTTP-01 path must work before issuance is attempted) | `edge_unreachable`, `wrong_edge` |
| `certificate` | `certificate_issued` | A certificate covering the name exists, is not expired, and its chain validates from a clean trust store | `no_certificate`, `chain_invalid`, `expiring` |
| `media_sync` | `certificate_issued` (media role only) | The certificate file the media service reads matches the issued one, and the service reloaded | `media_cert_stale`, `media_reload_failed` |
| `application` | `certificate_issued` | The host is in the application's allowed hosts and in the realm client's redirect URIs; requesting it returns the tenant, not a default vhost | `not_in_allowed_hosts`, `not_in_redirect_uris`, `default_vhost` |

Cadence: `nonce_txt` and `target` are polled every 60 seconds for the first 15 minutes after the customer says they have published the record, then every 10 minutes until the nonce TTL expires. Polling stops on the first pass, on `failed`, or on the TTL. A manual "check now" is available to the customer and is rate-limited to 6 per hour per domain.

## 4. Transitions

| # | From | To | Trigger | Job kind | Notes |
|---|---|---|---|---|---|
| D1 | — | `pending` | `POST /api/v1/tenants/{slug}/domains` | none | `syntax` runs synchronously; a failure is `422`, not a `failed` row |
| D2 | `pending` | `nonce_issued` | `POST .../domains/{id}/actions/verify` | `add_domain` (step 1) | Nonce generated, TTL starts, console shows the record |
| D3 | `nonce_issued` | `txt_verified` | `nonce_txt` passed on both resolvers | `add_domain` | `verified_at` set |
| D4 | `nonce_issued` | `failed` | TTL expired, or `caa` forbids issuance | `add_domain` | Re-verification allowed |
| D5 | `txt_verified` | `dns_pending` | automatic | `add_domain` | `caa` passed |
| D6 | `dns_pending` | `certificate_issued` | `target` and `reachability` passed, then the host is added to the edge's certificate list and issuance succeeded | `add_domain` | **The only point at which the name enters the certificate list** |
| D7 | `dns_pending` | `failed` | `target` still failing at the TTL | `add_domain` | Most common real failure; the message names the exact expected record |
| D8 | `certificate_issued` | `live` | `application` passed, and `media_sync` for a media host | `add_domain` | Canonical-host switch, if requested, happens here |
| D9 | `certificate_issued` | `failed` | Issuance succeeded but the application or media step failed | `add_domain` | Compensation removes the name from the certificate list |
| D10 | `live` | `failed` | A recurring check (§5) failed past its budget | `drift_check` | The host keeps serving while a certificate is still valid; the row records the problem |
| D11 | `failed` | `nonce_issued` | Customer or operator re-verifies | `add_domain` | Fresh nonce, fresh TTL |
| D12 | any | *row deleted* | `DELETE .../domains/{id}` | `remove_domain` | Removes the host from the certificate list, allowed hosts and redirect URIs, then soft-deletes |

Guards that apply to every transition:

- The tenant must be `active`, `ready` or `maintenance`. Adding a domain to a `suspended` or `decommissioning` tenant is `409 invalid-state-transition`.
- `add_domain` and `remove_domain` take the tenant lock and put the tenant in `maintenance` for the edge-reload step only ([`TENANT_STATE_MACHINE.md`](TENANT_STATE_MACHINE.md) T11).
- A name may be `live` on exactly one tenant. The `already_claimed` check is a unique constraint, not a query.
- Switching `is_canonical` to a new host is a separate `PATCH`, allowed only when the target is `live`, and it changes invitation links, `MEET_BASE_URL` and the realm client's default redirect. The previous canonical host stays `live`.

## 5. Staying live

`live` is not permanent by assumption. The nightly `drift_check` job re-runs `nonce_txt`, `target`, `certificate` and, for media hosts, `media_sync`:

| Observation | Consequence |
|---|---|
| Certificate expires in ≤ 14 days and renewal has not happened | Alert; `Probe(kind=cert_expiry)` degrades the tenant's `web` or `calls` component |
| `target` no longer resolves to us | Alert; after 3 consecutive nights, `live → failed`, and the console tells the customer their DNS changed |
| `nonce_txt` absent | Warning to the customer, no state change. Ownership was proven; the record is a re-verification convenience |
| `media_sync` stale | Alert at critical: the media service is serving a certificate the edge has already replaced. A `rotate` command re-syncs and reloads |

## 6. The media host

The media host is different from the web host in three ways, and each is a reason it has its own role, its own address and its own checks.

1. **It is not behind the HTTP edge.** LiveKit terminates TLS itself for TURN/TLS on 443 on the tenant's dedicated media address. The edge issues the certificate; the media service consumes a **file**. So a media host is only `live` after `media_sync` proves the file on disk matches the issued certificate and the service reloaded. A web host has no equivalent step.
2. **Its DNS target is the media address, not the web address.** For a custom media host the accepted targets are a `CNAME` to `{slug}.livekit.kodera.io` or an `A` record to the tenant's retained `Ip(role=media)`. Pointing a media host at the web address passes `reachability` and breaks calls; the `target` check therefore compares against the role's address, not against "any address of this tenant".
3. **Renewal is a two-stage event.** Issuance renews on the edge's schedule; the sync hook must then copy and reload. `certificate_expires_at` on the row is the *issued* certificate's expiry, and `media_sync` is what proves the running service agrees. A tenant with `turn_tls_second_ip` disabled has no custom media host and skips this entirely.

A custom login host (`id.customer.org`) is **not** offered: Keycloak serves one hostname per server, so there is no state for it here. Requests are `422 validation-error` with `code: login_host_not_supported`.

## 7. What the console shows

| State | Message key | What the customer is given |
|---|---|---|
| `pending` | `domain.pending` | The form; nothing to publish yet |
| `nonce_issued` | `domain.nonce_issued` | The exact TXT record name and value, copyable, plus the expiry of the nonce and a "check now" button |
| `txt_verified` | `domain.txt_verified` | Ownership confirmed; the exact CNAME or A record to publish next, per role |
| `dns_pending` | `domain.dns_pending` | What we currently observe versus what we expect, on both resolvers |
| `certificate_issued` | `domain.certificate_issued` | A short wait message; no action |
| `live` | `domain.live` | The host, its certificate expiry, and the option to make it canonical |
| `failed` | `domain.failed.<code>` | The failing check, the observed value, the expected value, and a re-verify button |

Every failure message names the check, the expected value and the observed value. "Verification failed" without those three is a defect.

## 8. Invariants a test must prove

1. A name enters the edge's certificate list only on transition D6, and a mutation test that removes the `txt_verified` guard makes a test fail.
2. A nonce is unique across all rows and never reused after expiry.
3. A media host cannot reach `live` while `media_sync` fails.
4. A custom host pointed at the wrong role's address fails `target`.
5. `already_claimed` is enforced by a unique index, proven by a concurrent-insert test.
6. `remove_domain` leaves no residue: the host is absent from the certificate list, the allowed hosts and the redirect URIs, asserted by reading back all three.
7. Every `failed` row carries a `last_check_error` from the closed code list in §3.

## Changelog

- First version. Defines the custom-domain verification states, the `_kodera-verify` nonce format and its 72-hour TTL, the eight named checks with two-resolver agreement, the transition table with the rule that certificate issuance follows ownership proof, the recurring checks that keep a host live, and the media-host case with its certificate-file sync.
- Corrects the nonce example, which was 44 characters where the format fixes 48 and contained an `l`, a character Crockford base-32 excludes — an example that does not satisfy the rule beside it teaches the rule wrong. Names the alphabet, shows the arithmetic that produces 48, and makes the value deliberately non-random for the reason given in the contract's reconciliation §6.1.
