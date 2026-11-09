# Working in this repository

These rules apply to humans and to coding agents alike.

## Language and style
- English for code, comments, docs, commits, PRs, and chat. French only for user-facing product copy, which lives in message catalogues.
- Commit message: one line, on the *why*. No trailers, no co-authors, no generator tags.

## Assistant attribution — hard rule
- Never name an AI assistant, its vendor, or a model anywhere in this repository: not in a tracked file, a filename, a commit message, a PR title or body, a branch name, a tag, or a release note. No vendor-named instruction file — conventions live in `AGENTS.md` — no co-author attribution trailer, no "generated with" footer or badge, no link to a vendor's site.
- **It covers binary and encoded content too.** Attribution has reached these repositories inside PNG text chunks and base64-encoded provenance manifests, where a recursive grep cannot see it: `grep -ri` skips binaries, and an encoded name is not text at all. A grep is not sufficient evidence.
- **Verify before pushing:** run `python3 .github/scripts/check-vendor-attribution.py .` from the monorepo root.
- Naming a *third-party* tool is fine: a competitor in a pricing benchmark, or an editor a template supports. What is forbidden is attribution of the assistant used to produce the work.
- This is a hard rule, not a style preference. It is not waivable in review, and it holds on every branch and in every repository in this org.

## Git
- Never commit to `main`. Feature branch (`feat/`, `fix/`, `chore/`, `docs/`) + pull request. CI green before review.
- One PR per task. A PR that touches `.github/workflows/` needs the product owner's explicit OK in chat, an adversarial agent review at the exact head, and green CI. A PR that touches `AGENTS.md` needs a second human reviewer.

## Product and design
- The buyer is non-technical. Every screen is judged by "can the CEO of a 120-person construction company do this alone?".
- Use the shared design tokens; never inline a colour or a font. A token test guards this.
- Accessibility (WCAG AA) and keyboard navigation are gates, not polish.

## Boundaries
- The console talks only to the Core API. Never add a direct call to Keycloak, Scaleway, Stripe, Qonto, or a tenant.
- No secrets, no business rules, no customer personal data in logs or error reports.

## Agents specifically
- Agents build; humans specify and review. Every task has a written spec, a mock of the Core API responses it needs, and an acceptance test before code.
- Do not modify `AGENTS.md` or CI workflows without an explicit human instruction in the task.

## Decisions
- Architecture decisions are recorded in `docs/adr/`. A change that contradicts an accepted ADR must first supersede it with a new ADR.
