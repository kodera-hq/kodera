# Working in this repository

These rules apply to humans and to coding agents alike.

## Language and style
- English for code, comments, docs, commits, PRs, and chat. French only for user-facing product copy.
- Commit message: one line, on the *why*. No trailers, no co-authors, no generator tags.

## Assistant attribution — hard rule
- Never name an AI assistant, its vendor, or a model anywhere in this repository: not in a tracked file, a filename, a commit message, a PR title or body, a branch name, a tag, or a release note. No vendor-named instruction file — conventions live in `AGENTS.md` — no co-author attribution trailer, no "generated with" footer or badge, no link to a vendor's site.
- **It covers binary and encoded content too.** Attribution has reached these repositories inside PNG text chunks and base64-encoded provenance manifests, where a recursive grep cannot see it: `grep -ri` skips binaries, and an encoded name is not text at all. A grep is not sufficient evidence.
- **Verify before pushing:** run `python3 .github/scripts/check-vendor-attribution.py .` from the monorepo root.
- Naming a *third-party* tool is fine: a competitor in a pricing benchmark, or an editor a template supports. What is forbidden is attribution of the assistant used to produce the work.
- This is a hard rule, not a style preference. It is not waivable in review, and it holds on every branch and in every repository in this org.

## Git
- Never commit to `main`. Feature branch (`feat/`, `fix/`, `chore/`, `docs/`) + pull request. CI green before review.
- One PR per task. A PR that touches `.github/workflows/` needs the product owner's explicit OK in chat, an adversarial agent review at the exact head, and green CI. A PR that touches `iam/`, security groups or `AGENTS.md` needs a second human reviewer.

## Security
- The API process never holds an infrastructure credential. If a change needs one, it belongs in the worker and is loaded per job from Scaleway Secret Manager.
- Never log, fixture, or test with real customer data. Never commit a secret; gitleaks runs on every push.
- Tenant profiles are executable input: vendor by commit SHA, render in a sandboxed Jinja environment, validate against the deny-list schema.
- Every preflight-style check ships with a self-test mutation that proves it can fail.

## Agents specifically
- Agents build; humans specify and review. Every task has a written spec and an acceptance test before code.
- Agents hold no deploy credential and never run `tofu apply` or Ansible against a real tenant. `staging` and `lab` are the only non-production test targets; production operations remain strictly human-operated.
- Do not modify `AGENTS.md`, CI workflows, or IAM definitions without an explicit human instruction in the task.

## Decisions
- Architecture decisions are recorded in `docs/adr/`. A change that contradicts an accepted ADR must first supersede it with a new ADR.
