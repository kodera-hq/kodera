# Supply-chain policy

**Status:** Proposed · **Owner:** PLAT

Covers every artefact that reaches a tenant VM, the worker, the API, or CI: container images, Python and Node dependencies, OpenTofu providers, Ansible collections, and the upstream releases of La Suite Meet, Docs and LiveKit.

The rule: **nothing runs in the fleet that was not pinned by digest, mirrored, scanned, and reviewed.** A tenant profile is executable input; an image tag is executable input; a dependency is executable input.

## 1. Image pinning

| Rule | Detail |
|---|---|
| Digest only | Every image reference in a rendered compose file is `registry/image@sha256:…`. A tag alone is a build failure, not a warning |
| Enforcement | The deny-list schema rejects non-digest images; `conftest` runs on the **rendered** compose in CI, not on the template |
| Allow-list | `lasuite/*`, `livekit/*`, `postgres`, `redis`, `quay.io/keycloak/*`, `nginxproxy/*`. Anything else is a new-vendor security review (ST5 in `SECURE_SDLC.md`) |
| Mirror | Every allowed image is mirrored into the Scaleway container registry at mirror time; tenants pull from the mirror, never from Docker Hub. This removes the Docker Hub availability and rate-limit dependency and gives us a copy we control |
| No `latest`, no floating minor | Ever, anywhere, including local development compose files |
| Base images | The same rules apply to any image we build ourselves; we build as few as possible (no fork rule) |

## 2. `versions.lock.yaml`

One file per fleet repository, the single source of truth for what may run.

| Field | Meaning |
|---|---|
| `component` | `meet`, `docs`, `y-provider`, `livekit`, `keycloak`, `postgres`, `redis`, `nginx-proxy`, `acme-companion` |
| `version` | The upstream semantic version, human-readable |
| `image` | Registry path in **our mirror** |
| `digest` | `sha256:…`, the only field the renderer reads |
| `source_digest` | The digest observed upstream at mirror time, so a mirror can be re-verified |
| `mirrored_at` | Recorded for audit, not used for decisions |
| `scan` | Trivy result reference and the severity verdict at mirror time |
| `exception` | Reference into the exception register, when the gate was overridden |

`versions.yaml` (intent, human-edited) and `versions.lock.yaml` (resolved, machine-written) are separate. A pull request that changes the lock without changing the intent is a mirror refresh and is reviewed as one.

`canary.yaml` holds what the canary is currently soaking. Fleet CI refuses a tenant pin **newer than the canary** or **younger than 48 hours of soak**, and refuses a tenant-profile change not yet applied to the dogfood tenant.

## 3. Scanning at mirror time

| Step | Rule |
|---|---|
| When | At mirror time, before the digest may enter `versions.lock.yaml`; and again on a schedule over everything currently pinned, because advisories are published after mirroring |
| Tool | Trivy, image scan plus config scan, with the vulnerability database pinned to a known version in CI so a database change cannot silently flip a build |
| **Severity gate** | **CRITICAL: block.** **HIGH: block unless an exception is registered.** MEDIUM: recorded, triaged per `deployment operations/security/VULN_MANAGEMENT.md`. LOW and UNKNOWN: recorded only |
| Fixed versus unfixed | An unfixed CRITICAL still blocks; the exception path is the only way through, and it must state the compensating control |
| Re-scan | Weekly over every digest in `versions.lock.yaml`. A new CRITICAL on a pinned digest opens a vulnerability item with the SLA from `VULN_MANAGEMENT.md` |
| Evidence | The scan report reference is stored on the lock row; the report itself is retained with the release record |

### Exception register

An exception is the only way past a blocking severity. It is a row in the register held in `deployment operations/security/VULN_MANAGEMENT.md`, and it must carry:

| Field | Requirement |
|---|---|
| Finding | CVE or advisory identifier, component, digest |
| Why the gate is overridden | Not exploitable in our configuration, no fix available upstream, or the fix is worse than the risk — stated concretely |
| Compensating control | What actually reduces the risk (not reachable from the network, capability dropped, feature disabled) |
| Scope | Which digests and which tenants |
| Expiry | Every exception expires; an expired exception blocks again automatically |
| Approver | SEC, plus SO where a customer commitment is affected |

An exception with no expiry, no compensating control, or no named approver is invalid, and CI treats it as absent.

## 4. SBOM

| Rule | Detail |
|---|---|
| Generation | An SBOM in **CycloneDX** JSON is generated for every mirrored image at mirror time and for every artefact we build (API image, worker image, console bundle) |
| Storage | Stored alongside the release record and referenced from the `Release` row in core, so "what was running on tenant X on a given day" is answerable from the control plane |
| Use | When an advisory lands, the SBOM answers whether we are affected before anyone opens a shell |
| Distribution | Available to a customer on request under the DPA's assistance clause; not published by default |
| Diff | CI shows the SBOM diff on a version bump so a surprising new component is visible in review |

## 5. Signature verification

| Rule | Detail |
|---|---|
| Where available | Verify with `cosign` at mirror time — keyless verification against the expected OIDC issuer and identity for projects that publish it, or the project's published key. Verification failure blocks the mirror |
| Where not available | Record `signature: none` on the lock row with the upstream digest and the source URL observed at mirror time. This is honest, and it is a residual risk (RR5 in `THREAT_MODEL.md`), not a silent pass |
| Our own artefacts | Everything we build and push is signed and verified before deployment |
| Provenance | Where a project publishes SLSA provenance, record and verify it; where it does not, do not pretend |
| Ratchet | The set of components requiring a valid signature only grows. Adding a component to the signed set is a one-way change; removing one needs an exception |

## 6. Language dependencies

| Ecosystem | Rules |
|---|---|
| Python | `uv` with a committed `uv.lock`; hashes required; production installs are `--frozen`, never resolving at build time. `mypy --strict` on `services/` and `jobs/`. Direct dependencies pinned to a minor where the project's stability warrants it (Procrastinate is pinned to the minor) |
| Node | `package-lock.json` committed; `npm ci` only, never `npm install`, in CI and in images. No `postinstall` script from a dependency runs in CI without review |
| OpenTofu | Provider versions pinned with `.terraform.lock.hcl` committed, including checksums for every platform CI and the worker use |
| Ansible | Collections pinned by version in `requirements.yml`; installed from the pinned file, never latest |
| Vendoring | Tenant profiles are vendored by **commit SHA**, never by branch or tag |

### Dependabot cadence

| Repository / ecosystem | Cadence | Grouping | Auto-merge |
|---|---|---|---|
| Security updates, all repos and ecosystems | Immediate | Ungrouped | Never automatic; triaged per `VULN_MANAGEMENT.md` |
| Python (`uv`/pip), core and worker | Weekly, Monday | Grouped by minor/patch, dev dependencies separate | No |
| Node, console and hub | Weekly, Monday | Grouped by minor/patch | No |
| GitHub Actions | Weekly, pinned by **commit SHA**, not by tag | Grouped | No |
| Docker base images in our own builds | Weekly | Individual | No |
| Major version bumps | Never automatic; arrive as a pull request, never merged as opened. The migration lands as its own reviewed change before or with the bump | — | No |

No dependency update merges without CI green, the same as any other change, and one that touches a path the repository's `AGENTS.md` (or its contributing guide where it has none) names takes that file's extra gates too (in `kodera-core`, a `.github/workflows/` change needs the product owner's explicit OK in chat and an adversarial agent review at its exact head). A dependency bump touching the worker or an authentication path carries a security-review trigger.

## 7. Upstream watch

| Upstream | What we watch | How | Who |
|---|---|---|---|
| `suitenumerique/meet` (La Suite Meet) | Releases and tags, security advisories, breaking configuration changes | Release watch to the team channel; `check-upstream-contract.sh <tag>` must pass before a bump pull request may merge | PLAT |
| `suitenumerique/docs` and `y-provider` | Same, plus migration reversibility | Same | PLAT |
| `livekit/livekit`, egress, SIP | Releases, and the security advisories that matter most because media is internet-facing on both IPs | Release watch; capacity ledger re-measured when the SFU minor changes | SRE |
| Keycloak | Releases and advisories; we require ≥ 26.8 | Release watch; realm template re-validated | SEC |
| Postgres, Redis, nginx-proxy, acme-companion | Patch releases and advisories | Dependabot on the mirror plus the weekly re-scan | PLAT |
| Debian (host baseline) | Security announcements | Unattended security upgrades on the hosts, plus the announcement list | SRE |

**Bump procedure.** Upstream tag observed → contract gate `check-upstream-contract.sh <tag>` green → mirror by digest with Trivy and cosign at mirror time → SBOM generated and diffed → `versions.yaml` intent pull request merged → canary (`visio.kodera.io`) → **48 hours of soak** → dogfood tenant → fleet waves `serial: [1, 3, 5]` with `any_errors_fatal: true` → red gate stops the wave. Minors are stepped one at a time; a batch is a decision, not a shortcut.

**A security release is still a release.** It moves faster through the queue, not around it: the soak may be shortened by SEC with a written reason recorded on the release, and it is never skipped for a component that terminates untrusted input.

## 8. Registry and build integrity

- The mirror registry is private, in our Scaleway project; push rights belong to CI and the worker, not to laptops.
- CI runners do not hold registry push credentials on pull-request workflows from any source other than the repository itself.
- Build steps do not fetch unpinned scripts over the network — no `curl … | sh` in an image, in CI, or in an Ansible role.
- GitHub Actions are pinned by commit SHA; third-party actions need a security review before first use.

## Changelog

| Version | Change |
|---|---|
| 0.1 | First draft: digest pinning and allow-list, `versions.lock.yaml` fields, mirror-time Trivy with severity gate and exception register, CycloneDX SBOM, cosign verification with an honest fallback, Python and Node lockfile rules, Dependabot cadence, upstream watch and bump procedure |
| 0.2 | Drops the two-reviewer and human-reviewer rules nothing enforces: a dependency update merges on green CI plus the extra gates its repository's `AGENTS.md` or contributing guide names, and the bump procedure no longer puts the `versions.yaml` intent pull request behind two reviewers |
