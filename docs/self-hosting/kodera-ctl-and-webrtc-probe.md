# Self-hosting operations: `kodera-ctl` and WebRTC UDP probe

Status: Active

This guide documents the companion maintenance CLI ([`deploy/community/kodera-ctl`](../../deploy/community/kodera-ctl), backed by [`deploy/community/kodera_ctl.py`](../../deploy/community/kodera_ctl.py)) and the headless WebRTC STUN/TURN UDP diagnostic tool ([`deploy/community/webrtc_probe.py`](../../deploy/community/webrtc_probe.py)) for the single-node Community self-host profile described in [`deploy/community/README.md`](../../deploy/community/README.md).

Both tools run purely on the Python 3.12+ standard library with zero third-party packages, execute external commands exclusively as `shell=False` argument vectors, redact secret values across standard output, standard error, JSON reports, and exceptions, and refuse symbolic links across full non-root ancestor chains via `lstat` and `O_NOFOLLOW`.

## Maintenance upgrade model and operational invariants

Because `deploy/community` is a single-replica Docker Compose profile rather than a multi-replica cluster, `kodera-ctl upgrade` provides an **ordered, health-gated maintenance upgrade with pre-quiesce image staging, ingress-closed atomic PostgreSQL backups, and lossless pre-ingress automatic rollback**:

| Phase / Guarantee | Enforcement mechanism |
| :--- | :--- |
| 1. Guardrail and live `404` preflight | Validates `docker-compose.yml`, `Caddyfile` (and split overrides; see [Topologies](../../deploy/community/README.md#topologies)), and `.env` through [`scripts/ci/check-community-deploy.py`](../../scripts/ci/check-community-deploy.py) and [`deploy/community/kodera_deploy.py`](../../deploy/community/kodera_deploy.py), refuses `KODERA_FEDERATION_MODE=open` (see [Federation](../../deploy/community/README.md#federation)), and verifies live HTTP `404` on `/agent/v1/commands`, `/staff/`, `/_synapse/admin/v1/server_version`, and `/_matrix/federation/v1/version` (whenever the public `Caddyfile` blocks `/_matrix/federation*`) on derived `https://` origins unless `--skip-preflight-http` is passed for a stopped stack (see [What the internet can reach](../../deploy/community/README.md#what-the-internet-can-reach)). |
| 2. Complete `sha256:` inventory and pre-quiesce staging | Captures a complete, locally verified immutable `sha256:` `image_id` inventory for every socket-init and runtime service in the active topology, then runs `docker compose pull --ignore-buildable` and `docker compose build` while all running containers continue serving. Any pull or build error aborts immediately with zero service interruption. |
| 3. Ingress close, write quiesce, and ACL-preserving snapshot | Stops `caddy` first, then stops all backend write services while keeping `db` and `synapse-db` healthy so zero public requests enter; streams `pg_dump -Fc --no-owner` (preserving PostgreSQL `GRANT`/`REVOKE` security ACLs) into `.kodera-backups/.staging-<id>-<pid>/` (`0700` dir, `0600` files, SHA-256 digests, `fsync`), and atomically renames the completed snapshot to `.kodera-backups/<utc-ts>-<id>/`. |
| 4. Pre-ingress rollout, internal readiness, and WebRTC gate | While `caddy` remains stopped, runs socket-init containers, `migrate`, and backend runtime services (`--no-deps --wait`), verifies internal `server` (`/health/live`, `/health/ready`) and `synapse` (`/_matrix/client/versions`) readiness plus TURN/STUN-aware WebRTC UDP probing. Any failure before `caddy` opens triggers `--auto-rollback` with zero accepted public writes lost. |
| 5. Fail-closed `caddy` reopen & `--no-deps` rollback | Once all pre-ingress checks pass, automatic DB-snapshot rollback eligibility closes and `caddy` starts last; if post-`caddy` public `404` verification fails, `kodera-ctl` stops `caddy` and checks its exit code before reporting ingress closure (emitting `CRITICAL: failed to stop caddy ...` if `stop caddy` fails), without overwriting post-open writes. On rollback, `kodera-ctl` verifies `manifest.json` digests and the complete local `sha256:` inventory, terminates DB backends and resets `public` (`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` — preserving database `LC_COLLATE`/`LC_CTYPE` such as `'C'` on Synapse), runs `pg_restore --clean --if-exists --no-owner --single-transaction` (restoring snapshot ACLs), writes `0600` `rollback.override.yml` (`pull_policy: never`, pinning `migrate` to a no-op entrypoint while keeping Compose dependencies valid), starts backend services with `--no-build --no-deps --wait`, verifies internal readiness and WebRTC UDP before starting `caddy` last, and verifies public HTTP `404` isolation. |

## Headless WebRTC STUN and TURN UDP probe

Idle LiveKit ephemeral media ports (`50000-50200/udp`) only respond to ICE Binding requests during active calls, whereas standalone STUN or RFC 5766 TURN UDP listeners (`3478/udp` by default) answer unauthenticated STUN Binding and `401` TURN challenges at all times. [`deploy/community/webrtc_probe.py`](../../deploy/community/webrtc_probe.py) completes within a strict `< 2.5 s` wall-clock budget (`2.0 s` default, reserving cleanup time for `Refresh(0)`):

1. **RFC 5389 STUN Binding (`0x0001` / `0x0101`):** Applies RFC 4013 Unicode 3.2 `SASLprep` (`unicodedata.ucd_3_2_0` NFKC) credential normalization, bounded DNS resolution, and RFC 5389 RTO retransmission; validates `MESSAGE-INTEGRITY` (ignoring any post-`MESSAGE-INTEGRITY` attributes except `FINGERPRINT` per RFC 5389 Section 15.4) and `FINGERPRINT`; and decodes IPv4/IPv6 `XOR-MAPPED-ADDRESS` (`0x0020`).
2. **RFC 5766 TURN UDP allocation and loopback relay:** Executes unauthenticated `Allocate` (`0x0003`, `REQUESTED-TRANSPORT = UDP 17`) -> parses `401` `REALM` + `NONCE` -> long-term `MD5(SASLprep(user):realm:SASLprep(pass))` authenticated `Allocate` -> verifies `XOR-RELAYED-ADDRESS` + `XOR-MAPPED-ADDRESS` -> `CreatePermission` (`0x0008`) -> `Send` Indication (`0x0016`) carrying a 16-byte random loopback token -> verifies matching `Data` Indication (`0x0017`) -> bounded-RTO `Refresh(lifetime=0)` (`0x0004`) deallocation (verifying `LIFETIME == 0`, retrying once on `438 Stale Nonce`, and accepting `437 Allocation Mismatch` only when `MESSAGE-INTEGRITY` authenticates under the active key per RFC 5389 Section 10.2.3).

### Diagnostic classifications

| `status` | Exit code | Meaning and operator action |
| :--- | :---: | :--- |
| `ok` | `0` | Direct RFC 5389 STUN UDP Binding succeeded and returned a valid reflexive `XOR-MAPPED-ADDRESS`. |
| `turn_relay_verified` | `0` | Full RFC 5766 TURN UDP allocation, permission grant, 16-byte token relay loopback, and `Refresh(0)` deallocation succeeded. |
| `hairpin_nat_blocked` | `1` | Direct UDP STUN to the public domain IP failed while a local or control listener responded and verified reflexive `XOR-MAPPED-ADDRESS` matched `KODERA_DOMAIN` from a distinct local address (shared NAT). Enable NAT reflection on the gateway, configure split-horizon LAN DNS, or configure a TURN relay. |
| `relay_loopback_blocked` | `1` | TURN UDP control allocation and permission succeeded (or direct public STUN succeeded), while relayed `Send`/`Data` loopback packets were blocked. Open the TURN relay ephemeral UDP port range (for example `49152-65535/udp`). |
| `udp_unreachable_or_filtered` | `1` | UDP STUN/TURN packets timed out or were rejected without shared-NAT hairpin evidence. Open the target UDP port (`3478/udp` for STUN/TURN; `50000-50200/udp` and `7881/tcp` for LiveKit media) and verify the listener is running. |

### Probe CLI usage

Run the built-in real-socket protocol self-test:

```bash
python3 deploy/community/webrtc_probe.py --selftest
```

Probe a configured STUN/TURN listener (`3478/udp` default, reading `TURN_*` or `KODERA_TURN_*` from `.env`) and emit JSON:

```bash
./deploy/community/kodera-ctl probe-webrtc --env-file deploy/community/.env --json
```

Probe explicit UDP ports or ranges with bounded timeout:

```bash
python3 deploy/community/webrtc_probe.py \
  --domain chat.example.org \
  --stun-host chat.example.org \
  --ports 3478,5349 \
  --timeout 2.0 \
  --json
```

Verify end-to-end RFC 5766 TURN UDP allocation and 16-byte loopback relay (reading the credential from an environment variable rather than process arguments):

```bash
export KODERA_TURN_PASSWORD='replace-with-turn-credential'
./deploy/community/kodera-ctl probe-webrtc \
  --domain chat.example.org \
  --turn-url 'turn:turn.example.org:3478?transport=udp' \
  --turn-username kodera-turn \
  --turn-password-env KODERA_TURN_PASSWORD \
  --timeout 2.0 \
  --json
```

## Maintenance upgrades, rollbacks, and status (`kodera-ctl`)

When `TURN_DOMAIN` / `TURN_UDP_PORT` / `TURN_USERNAME` / `TURN_PASSWORD` (or `KODERA_TURN_*`) is set in `.env`, or `--webrtc-port` is passed, `kodera-ctl` runs the live UDP probe before reopening `caddy`. On default Community stacks with no standalone STUN/TURN listener configured, the WebRTC check records `skipped_no_stun_turn_listener` rather than probing idle LiveKit ephemeral media ports.

### Inspect rollout order without mutating services (`--dry-run`)

```bash
./deploy/community/kodera-ctl upgrade \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --skip-preflight-http \
  --dry-run \
  --json
```

### Execute a health-gated maintenance upgrade

```bash
./deploy/community/kodera-ctl upgrade \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --auto-rollback \
  --json
```

To start or upgrade a currently stopped stack (skipping pre-upgrade HTTP ingress checks while keeping full internal, WebRTC, and post-`caddy` verification) or retain a failed upgrade state for manual inspection:

```bash
./deploy/community/kodera-ctl upgrade \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --skip-preflight-http \
  --no-auto-rollback
```

### Execute a one-command rollback

```bash
./deploy/community/kodera-ctl rollback \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --backup latest \
  --json
```

Roll back a stopped or degraded stack to a specific snapshot identifier:

```bash
./deploy/community/kodera-ctl rollback \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --skip-preflight-http \
  --backup 20261123T003000Z-a1b2c3d4
```

### Check stack status and available backups

```bash
./deploy/community/kodera-ctl status \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --json
```

### Execute an isolated backup/restore rehearsal

`kodera-ctl rehearse-restore` stages each input once from a single retained-`dir_fd` `O_NOFOLLOW` descriptor while verifying its SHA-256 digest, brings up a disposable Compose project (`-p kodera-rehearsal-<id>`) bound exclusively to `internal: true` bridge networks with zero host-bound public ports and outbound provider kill-switches (`KODERA_REHEARSAL_NO_EGRESS=1`), provisions restricted `kodera_api` and `kodera_collab` rehearsal roles with ephemeral random credentials before running `pg_restore`, streams any guard inputs into an ephemeral `10001:10001` `0400` volume, runs `manage.py rehearse_restore_guards --disarm-outbound` inside the pinned `migrate` operator image (neutralizing webhooks, coexistence bridges, WebPush, support GitHub triage, billing payment-link withdrawals, and mail outbox rows, replaying any post-backup GDPR Art. 17 erasure ledger across all local PII domains, and failing closed on missing, mismatched, unclassified, or unpurged S3 objects), probes internal readiness, tears down the rehearsal stack unconditionally, and writes a `0600` JSON receipt recording `rpo_seconds` and `rto_seconds`:

```bash
./deploy/community/kodera-ctl rehearse-restore \
  --env-file deploy/community/.env \
  --stack-dir deploy/community \
  --backup latest \
  --json
```

### Run operational guardrail self-tests

```bash
./deploy/community/kodera-ctl --selftest
```
