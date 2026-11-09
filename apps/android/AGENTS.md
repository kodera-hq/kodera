# Kodera for Android — Project instructions

Status: Native client development; read [README.md](README.md) for default-branch versus implementation status.

You are working on the Kotlin and Jetpack Compose client for Kodera. V1 targets text channels and audio/video; V2 adds Docs. Keep product goals separate from implemented capabilities.

## Critical Rules

1. **Read `AGENTS.md` and `docs/DEVELOPMENT.md`** for project context, stack and coding standards.
2. **Commits** are one concise line explaining why, without trailers or attribution. Never commit to `main` or `master`; use a feature branch and a pull request.
3. **Never access `.env`** — only `.env.example` is readable. Never expose secrets or change private signing/credential files.
4. **Native quality** — Kotlin and Jetpack Compose, explicit concurrency and cancellation, generated design tokens and French/English catalogues.
5. **Never install packages** without explicit approval.
6. **Update `CHANGELOG.md`** for every user-facing change.
7. **Security first** — no hardcoded secrets, parameterized SQL, safe errors and validated authority.
8. **Never name an AI assistant, its vendor, or a model** anywhere — not in a tracked file, a filename, a commit message, a PR title or body, a tag, or a release note. No vendor-named instruction file, no co-author attribution trailer, no "generated with" footer. Verify with `python3 ../../.github/scripts/check-vendor-attribution.py ../..`, not a grep.

## Working boundaries

Source checks and local builds do not prove authentication, membership, device UX or store readiness. CI activation, signing, deployment and distribution remain separate actions.

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for strict CI and review gates and [SECURITY.md](SECURITY.md) for vulnerability reports. Support and security contacts are support@kodera.io and support@kodera.io.
