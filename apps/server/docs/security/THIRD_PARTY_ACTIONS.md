# Third-party GitHub Actions review

**Status:** Proposed · **Owner:** SEC

The section 8 review record for every third-party GitHub Action — any action whose owner is not `actions` — used in a `uses:` line on `main` in any kodera-hq repository. Inventoried by reading each repository's `.github/workflows/ci.yml` at `origin/main`: every organisation repository has exactly one workflow file, so that is the complete surface, not a sample of it.

## 1. Rules

`SUPPLY_CHAIN_POLICY.md` §8 also covers registry push rights, CI runner credentials, and unpinned build scripts; only its GitHub Actions bullet is restated here:

- **GitHub Actions are pinned by commit SHA.** A tag or branch reference is a build failure, not a warning — `actions/*` included, not only third-party.
- **A third-party action needs a security review before its first use.** "Third-party" means any action whose owner is not `actions`.
- **A new third-party action is a row in this document before it is a `uses:` line.** Propose the row, get it reviewed, land the review here, and only then add the pinned `uses:` line to a workflow. Adopt first, review later is not a review.

## 2. Index

| Action | Used in | Pinned to | Verdict |
|---|---|---|---|
| `astral-sh/setup-uv` | kodera-server | `d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86` — v5.4.2 | Accepted |
| `raven-actions/actionlint` | deployment operations | `3d39aea434753780c3b3d4a1a31c854b4dbf49d7` — v2.2.0 | Accepted with a condition |

No other repository's `.github/workflows/ci.yml` on `main` — kodera-web, kodera-design-tokens, kodera-web, kodera-visio, deployment operations — carries a `uses:` line outside `actions/*`.

Aside, not in scope of this review but worth recording: deployment operations's `ci.yml` pins `actions/checkout` to the tag `v4` rather than a commit SHA. `actions/*` is not third-party, so it falls outside this document, but it is a section 8 SHA-pin gap in its own right — a separate, smaller fix than anything below.

## 3. `astral-sh/setup-uv`

| Field | Detail |
|---|---|
| Maintainer / organisation | `astral-sh` — a GitHub Organization, publisher of `uv` and `ruff`; this action is maintained in the same organisation as the tool it installs. Not archived. MIT licensed. 856 stars |
| Release cadence | Active: five releases (v8.3.1 through v10.0.1) in the five weeks before this review. The pinned v5.4.2 is several majors behind current — a currency note, not a security finding; the pin is what is reviewed, not the latest tag |
| Permissions requested | None declared in `action.yml` — it runs `using: node20`, not a reusable workflow, so it has no `permissions:` block of its own. It accepts a `github-token` input, defaulted to `${{ github.token }}`, used only to raise the GitHub API rate limit when resolving a version and downloading a release asset. Both call sites in `kodera-server/ci.yml` run under the workflow's top-level `permissions: contents: read` and pass no elevated token |
| What it fetches / executes | Read directly from the pinned SHA's `dist/setup/index.js` — the compiled code that actually runs, not the README. It resolves a uv version (explicit `version` input; else a version read from `pyproject.toml`/`uv.toml` in the working directory — kodera-server has a root `pyproject.toml`, so this path is taken, not "latest"; else the latest tag via the GitHub API), then downloads `https://github.com/astral-sh/uv/releases/download/<version>/uv-<arch>-<platform>.tar.gz` (`.zip` on Windows) through `@actions/tool-cache`'s `downloadTool()`, and extracts and caches it |
| Verified before use? | Yes — confirmed in the same file. `downloadVersion()` calls `validateChecksum()` immediately after `downloadTool()` and before extraction. It checks the artifact's SHA-256 against either a caller-supplied `checksum` input (not set here) or a `KNOWN_CHECKSUMS` table baked into the action's own bundle for that exact arch/platform/version; a mismatch throws and fails the step. Gap, confirmed by reading the same function: if the resolved version is absent from the bundled table, validation is silently skipped with only a debug log line. Not exploitable today — our jobs resolve whatever version `pyproject.toml` pins, not an arbitrary or newer one — but a real limitation, not a hardening suggestion |
| Pinned SHA / version | `d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86` — v5.4.2. Four call sites in `kodera-server/.github/workflows/ci.yml`, each with `python-version: ${{ env.PYTHON_VERSION }}` and `enable-cache: true`, no `version` or `checksum` override |
| Verdict | **Accepted.** Organisation-maintained by the tool's own publisher, MIT, not archived, actively released. Runs with no more than the job's default read-only token. The only network fetch is the pinned upstream project's own GitHub Releases, and the downloaded artifact is checksummed before it is extracted — verified by reading the code that runs, not assumed from the description |

## 4. `raven-actions/actionlint`

| Field | Detail |
|---|---|
| Maintainer / organisation | `raven-actions` — a GitHub Organization; `action.yml`'s `author:` field names an individual maintainer. Not archived. MIT licensed. 51 stars — a materially smaller project than setup-uv |
| Release cadence | Five releases (v2.0.2 through v2.2.0 inclusive) across roughly seven months — slower than setup-uv, but regular, no long gap |
| Permissions requested | None declared in `action.yml` — a composite action, no `permissions:` block. It accepts `github-token`/`token` inputs, defaulted to `${{ github.token }}`, used for its own GitHub API calls and passed to embedded `actions/github-script` steps. The `deployment operations/ci.yml` call site runs under the workflow's top-level `permissions: contents: read`, passes only `fail-on-error: true`, and sets no elevated token |
| What it fetches / executes | Read directly from `action.yml` at the pinned SHA — a composite action has no compiled bundle; the YAML is the source that runs. It is a wrapper, not actionlint itself: an embedded `actions/github-script` step computes a download URL on the **separate, upstream** `rhysd/actionlint` repository's GitHub Releases — `https://github.com/rhysd/actionlint/releases/download/<tag>/actionlint_<version>_<os>_<arch>.tar.gz` — where `<tag>` is our `version` input if set. We do not set one, so it resolves whatever tag `rhysd/actionlint` currently has marked "latest" (discovered via an unauthenticated redirect request, falling back to one GitHub API call), plus a matcher JSON from `raw.githubusercontent.com`. A further step runs `npm install --prefix … --no-save --no-package-lock --no-audit --no-fund --ignore-scripts --legacy-peer-deps @actions/tool-cache@4.0.0`, fetching that package from the npm registry at run time — pinned to an exact version, not to a hash recorded in the action. The next step then uses that freshly installed `@actions/tool-cache` to download and extract the `rhysd/actionlint` tarball and the matcher file |
| Verified before use? | No. Reading the full "Set tool environment" and "Download tool" script bodies at the pinned SHA: neither the `rhysd/actionlint` binary tarball nor the matcher JSON is checksummed, signed, or otherwise verified before extraction and execution — there is no `crypto`, `sha256`, or `checksum` reference anywhere in the composite action. The SHA we pin covers the wrapper only; the binary that actually runs on the runner is selected by upstream "latest" at job time and executed unverified |
| Pinned SHA / version | `3d39aea434753780c3b3d4a1a31c854b4dbf49d7` — v2.2.0. One call site, `deployment operations/.github/workflows/ci.yml`, `with: fail-on-error: true` only — no `files`, `flags`, or `github-server-url` override, so no workflow input reaches this action beyond a static boolean |
| Verdict | **Accepted with a condition.** Organisation-maintained, MIT, not archived, regularly released, and it runs with nothing beyond the job's default read-only token — no secret or elevated scope is exposed to it, and its only input is a static `fail-on-error: true`, so there is no untrusted-input path into what it does. Set against that: it resolves and downloads an **upstream-latest, unpinned-by-us** `rhysd/actionlint` release with **no checksum or signature verification**, and installs an npm package at run time rather than vendoring it. None of that is itself a `uses:` line, so section 8's SHA-pin rule does not literally reach it — but our pinned SHA does not pin what code ends up executing on the runner. Condition: the next time this row is touched, pin an explicit `version` input to a specific `rhysd/actionlint` release instead of leaving it to resolve "latest" — that alone does not add verification, but it makes the executed binary reproducible and diffable in review. Revisit the verdict if `raven-actions/actionlint` starts supporting checksum verification of the upstream binary and this pin does not adopt it |

## Changelog

| Version | Change |
|---|---|
| 0.1 | First review: `astral-sh/setup-uv` (kodera-server, accepted) and `raven-actions/actionlint` (deployment operations, accepted with a condition) |
