# ADR-0001: This package is the single source of design values, and its build output is committed

**Status:** Proposed
**Amended by:** [ADR-0002](0002-decided-values-move-and-spec-constants-are-measured.md) — points 1 and 2; points 3, 4 and 5 stand
**Deciders:** the crew

## Context

Console ADR-0004 decided that the design tokens are a shared package rather than a file copied into two repositories, and named this repository as the package. What it did not settle is how the package is built and shipped, and that question has one awkward constraint: **there is no private registry yet.**

Until GitHub Packages is configured for the organisation, consumers install this package as a **git dependency**. npm does not run an install or a build step for a git dependency. Whatever is in the repository at the pinned ref is what lands in `node_modules`, unchanged.

That constraint decides more than it looks like it does:

- If `dist/` is gitignored, the package installs with an empty `dist/`. The `exports` entries resolve to nothing, the Tailwind preset import fails or — worse, under a bundler that tolerates it — resolves to an empty object, and every colour class silently emits no CSS. This is the same failure ADR-0004 exists to prevent, reintroduced by the packaging.
- If the build needs `npm install` first, the same thing happens for a different reason.
- If `dist/` is committed, it is a copy of `tokens.json` in another format — and ADR-0004's entire argument is that copies drift silently.

Separately: `tokens.json` was delivered by the design workstream and carries values that were reasoned about against contrast ratios, a brand direction and a set of prototypes. Nine of its declared pairs do not clear their WCAG minimum today. Those are open design questions, and a build repository is not where they get answered.

## Decision

**This package is the single source of design values for both front-ends, and its generated output is committed and proven to be generated.**

1. **`tokens.json` is carried verbatim** from the design workstream's delivery. This repository generates from it and measures it. It never edits a value. A value change is a design PR here, not a build fix.
2. **The build is dependency-free plain Node** and a pure function of `tokens.json`: same input, byte-identical output, no clock, no environment, no network.
3. **`dist/` is committed**, so a git-dependency install is a complete install — and a **drift gate** asserts on every PR that `dist/` is byte-identical to a fresh build. This is what separates "committed build output" from "a second copy of the values". The copy is allowed to exist precisely because a check re-derives it.
4. **Generated variable names reproduce the design drop's `tokens.css` names.** The delivered HTML prototypes and the component spec tables address `--surface`, `--text-primary`, `--sp-4`, `--r-md` by name. Renaming them fails nothing at build time — the browser drops an unknown `var()` and the element falls back to its inherited value — so the names are frozen by a parity test rather than by convention. Additional names the drop happened to omit are emitted too; a token that generates no output is a token a consumer cannot use.
5. **Every gate fails loudly or not at all.** A failing contrast pair must be listed in `contrast-known-failures.json` with a written reason; an entry whose pair starts passing fails the gate; an unresolvable pair is a hard failure rather than a skipped row. A naming deviation is handled the same way in `token-grammar-exceptions.json`.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: commit `dist/`, guard it with a drift gate** | The only shape that survives a git-dependency install and still cannot drift. Costs one committed artefact per PR that touches tokens. |
| Gitignore `dist/`, build on install | `prepare` runs for a git dependency only when devDependencies are installable, which for a git repository in CI they frequently are not. The failure is an empty package, with no error. |
| Gitignore `dist/`, publish to a registry now | The right end state, and this ADR does not block it. It is not available today, and the console cannot style anything until the package exists. |
| Style Dictionary as the generator | A capable tool, and a dependency, an install step and a config language for an output this small. The generator here is under 300 lines and the whole package installs with zero dependencies — which is what makes the git-dependency path safe. Revisit when the token count or the number of output formats grows. |
| Edit `tokens.json` to fix the failing contrast pairs | Those are design decisions with visual consequences — a darker tertiary ink changes every help line in the console. Deciding them in a build PR is how a design system acquires values nobody chose. |

## Consequences

- Every PR that changes a token also changes `dist/`. The diff is larger and it is the point: a reviewer sees the CSS a value change produces.
- The drift gate makes `npm run build` a required step, not a convenience. Forgetting it is a red CI, which is the intended cost.
- The allowlists are the accessibility and naming debt of the system, in one place, each with the decision it is waiting on. They are meant to shrink. An entry that has been there a long time is a finding, not a fact.
- Moving to a private registry later changes the consumers' `package.json` and nothing else here. `dist/` stays committed until git-dependency installs are gone, then this ADR is revisited.
- The hub cannot adopt the semantic tier until a dark set exists (DESIGN_HANDOFF A4). It can adopt the primitive tier and the preset immediately.
