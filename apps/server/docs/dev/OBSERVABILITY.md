# Observability conventions

**Status:** Proposed · **Owner:** API seat

One log format, one set of field names, one way to bind context, and a list of fields no log line may carry. An incident is diagnosed by joining a `request_id` across the API, the worker and the agent; that only works if every process spells it the same way.

## 1. Logging

- **Structured JSON on stdout**, one object per line, from `structlog` with the Django integration. Nothing formats a message with an f-string; the message is a short, stable, lower-case event name and everything else is a field.

```json
{"timestamp":"current baselineT08:14:22.481Z","level":"info","event":"job.step.succeeded",
 "logger":"worker.runner","service":"core-worker","env":"prod","version":"1.4.2",
 "request_id":"019467a3-0f9b-7cc3-98c2-1fa48f28f562","job_id":"019467a3…","job_kind":"upgrade",
 "step":"preflight","tenant_slug":"acme","organisation_slug":"acme-org","duration_ms":8421}
```

- The `event` value is a dotted, past-tense name, matching the audit action where one exists, so a log line and an audit row can be correlated by name as well as by identifier. It is never a sentence and never interpolated.

### Field names

These names are fixed. A pull request introducing a synonym is rejected.

| Field | Type | Always present | Meaning |
|---|---|---|---|
| `timestamp` | RFC 3339 UTC, milliseconds | yes | |
| `level` | `debug` … `critical` | yes | |
| `event` | string | yes | The event name |
| `logger` | string | yes | Module path |
| `service` | `core-api` \| `core-worker` \| `core-scheduler` | yes | |
| `env` | `dev` \| `test` \| `staging` \| `prod` | yes | |
| `version` | string | yes | Deployed revision |
| `request_id` | string | on any request-driven line | [`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §9 |
| `job_id`, `job_kind`, `step`, `attempt` | string, string, string, int | on job lines | |
| `tenant_slug` | string | when a tenant is in scope | Never a tenant UUIDv7 alone; the slug is what a human searches |
| `organisation_slug` | string | when an organisation is in scope | |
| `actor_type`, `actor_label` | string | on lines describing an action | Pseudonym, never an email address |
| `duration_ms` | int | on completion lines | |
| `outcome` | `succeeded` \| `failed` \| `rolled_back` \| `skipped` | on completion lines | |
| `error_code` | string | on failures | From the closed error enum |
| `http_method`, `http_path_template`, `http_status` | string, string, int | on API access lines | The **template**, never the resolved path |
| `problem_type` | string | on error responses | The registered problem type |

Forbidden as fields, anywhere: a full URL, a query string, a request or response body, a header, a token, a secret, an email address, a display name, a room name, a document title, a full IP address.

Required, not implemented yet: a log processor that drops any field on this list and counts the drop, with a mutation test that proves it. No such processor exists in the code today.

### Binding

Context is bound once, at the edge, and inherited by everything downstream:

| Process | Bound at | Fields |
|---|---|---|
| API | request middleware, before authentication | `request_id`, `http_method`, `http_path_template` |
| API | after authentication | `actor_type`, `actor_label`, `organisation_slug` |
| API | when a view resolves a tenant | `tenant_slug` |
| Worker | when a job is leased | `request_id` (copied from the job), `job_id`, `job_kind`, `tenant_slug`, `organisation_slug` |
| Worker | when a step starts | `step`, `attempt` |
| Scheduler | when a scheduled task starts | `request_id` (generated), the task name |

Binding is context-local and cleared at the end of the unit of work; a test asserts that no field leaks between two sequential requests on the same worker thread. Passing `request_id` by hand into a log call is a defect: if it is not bound, the binding is missing.

## 2. Tracing

OpenTelemetry, exported to the collector. Span names are **low cardinality**: no identifier, no slug, no path segment ever appears in a span name; identifiers are attributes.

| Span kind | Name | Key attributes |
|---|---|---|
| HTTP server | `HTTP {method} {route_template}` — `HTTP POST /api/v1/tenants/{slug}/actions/upgrade` | `http.request.method`, `http.route`, `http.response.status_code`, `kodera.request_id`, `kodera.organisation_slug` |
| Database | `postgres {operation} {table}` | `db.system`, `db.operation`, `db.sql.table` |
| Job | `job {kind}` | `kodera.job_id`, `kodera.job_kind`, `kodera.tenant_slug`, `kodera.attempt` |
| Job step | `job.step {name}` | `kodera.step`, `kodera.retry_class`, `kodera.timeout_s` |
| Subprocess | `exec {tool}` — `exec tofu`, `exec ansible-playbook` | `kodera.tool`, `kodera.tool_subcommand`, exit code |
| Outbound HTTP | `{peer} {operation}` — `keycloak realm.update`, `scaleway instance.create` | `peer.service`, `http.response.status_code` |
| Agent request | `agent {operation}` — `agent heartbeat` | `kodera.tenant_slug`, `kodera.agent_id` |

Rules: attribute keys we own are prefixed `kodera.`; the trace and span identifiers are added to every log line as `trace_id` and `span_id` so logs and traces join; the API's trace context propagates into the `Job` row so the worker's spans are children of the request that created them.

## 3. Metrics

Prometheus naming: `kodera_` prefix, base units, `_total` for counters, `_seconds` for histograms. Labels are bounded — never a tenant UUIDv7, never a slug on a high-cardinality series, never a full path.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `kodera_http_requests_total` | counter | `method`, `route`, `status`, `principal_type` | API traffic |
| `kodera_http_request_duration_seconds` | histogram | `method`, `route` | Latency |
| `kodera_problem_responses_total` | counter | `problem_type` | Error shape over time |
| `kodera_authz_denied_total` | counter | `reason`, `principal_type` | [`../api/AUTHZ.md`](../api/AUTHZ.md) §9 |
| `kodera_token_verification_failures_total` | counter | `reason`, `issuer_known` | Realm health |
| `kodera_jwks_cache_events_total` | counter | `result` (`hit`, `miss`, `refresh`, `error`) | Per-issuer cache behaviour |
| `kodera_idempotency_replays_total` | counter | `outcome` (`replayed`, `conflict`, `in_flight`) | |
| `kodera_rate_limited_total` | counter | `bucket` | |
| `kodera_jobs_total` | counter | `kind`, `outcome` | |
| `kodera_job_duration_seconds` | histogram | `kind` | |
| `kodera_job_step_duration_seconds` | histogram | `kind`, `step` | |
| `kodera_jobs_in_flight` | gauge | `kind` | |
| `kodera_job_queue_depth` | gauge | `kind`, `status` | Queue health |
| `kodera_job_lease_expirations_total` | counter | `kind` | Orphan pressure |
| `kodera_job_orphan_recoveries_total` | counter | `kind`, `outcome` | |
| `kodera_tenants` | gauge | `status`, `capacity_tier` | Fleet shape |
| `kodera_tenant_stale` | gauge | — | Count of tenants not reporting |
| `kodera_agent_heartbeats_total` | counter | `outcome` (`accepted`, `replayed`, `rejected`) | |
| `kodera_backup_age_seconds` | gauge | `tenant` | The one place a tenant label is allowed, bounded by the fleet ceiling |
| `kodera_certificate_expiry_seconds` | gauge | `tenant`, `role` | |
| `kodera_domain_verifications_total` | counter | `outcome`, `check` | |
| `kodera_invoices_issued_total` | counter | `vat_regime` | |
| `kodera_dunning_transitions_total` | counter | `from`, `to` | |
| `kodera_reconciliation_findings_total` | counter | `finding` | |
| `kodera_audit_events_written_total` | counter | `actor_type`, `retention_class` | |

The fleet is explicitly rated for a bounded number of tenants, which is what makes a `tenant` label acceptable on the few gauges that need it. A pull request adding a `tenant` label to a request-rate metric is rejected.

## 4. Error reporting

None. No external error-reporting service runs (decision O4). Application exceptions do not reach the host logs yet either: `config/` defines no `LOGGING` and `DEBUG` is `False`, so an unhandled exception that becomes a `500` writes nothing to stderr (reproduced: 0 bytes). Until Core configures logging, such an exception leaves no trace ([`../specs/OBSERVABILITY_STACK.md`](../specs/OBSERVABILITY_STACK.md) §4). The section keeps its number so the references to §5 and §6 hold.

## 5. Alerting hooks

Alerts are defined with the fleet's monitoring, not here, but core owns the signals they read: queue depth, lease expirations, orphan recoveries, token-verification failures per issuer, denial spikes per principal, agent staleness, backup age, certificate expiry, reconciliation findings, and dunning transitions. Alert payloads carry slugs and counters only — never a person, never a room, never a document — which is what makes sending them to an external chat acceptable.

## 6. What a reviewer checks

- [ ] New log lines use the fixed field names and a dotted event name; nothing is interpolated into the message.
- [ ] Context is bound at the edge, not passed by hand.
- [ ] No forbidden field is logged: no URL, no body, no header, no email address, no full IP address.
- [ ] Span names are low cardinality; identifiers are attributes prefixed `kodera.`.
- [ ] New metrics follow the naming and label-cardinality rules.

## Changelog

- First version. Fixes part of assessment item C7: fixed structured-log field names with edge binding of `request_id`, `job_id` and `tenant_slug`, low-cardinality span naming, the metric registry with label-cardinality rules, and the error-reporting scrubbing assertions with the self-test mutation that proves the hook.
- Removes the error-reporting client, its configuration and the six `tests/observability/` assertions after decision O4 (no such client or tests exist); §4 keeps its number. The log-field drop rule moves into §1, and the reviewer item on error-reporting assertions goes.
