# Releasing

There is no registry and no `npm publish`: `package.json` is `private: true`, and a consumer installs this package as a git dependency. **The tag is the release** — pinning to a tag, rather than to a branch or to a bare commit SHA, is the packaging model, and README, "How a consumer takes it", is where it is written down.

The git-tag packaging model is already in use: `kodera-console` and `kodera-landing` declare `github:kodera-hq/kodera#v0.4.0` in `package.json` on `main`. The package remains private. `package.json` and `CHANGELOG.md` carry `0.5.0` from the pull request that prepared it; until the `v0.5.0` tag is cut and each consumer repins, those `#v0.4.0` pins deliver none of it. Future releases and consumer updates still follow the procedure below. `kodera-web` does not depend on the package at all yet; its README says the v2 repaint "waits on that package being published".

Everything below exists so that a tag is reproducible by whoever cuts one, and so that nothing reaches a consumer that was not proven on `main` first. Where a step says "since the previous tag", or says to repin, it describes the steady state that the first tag creates rather than one it inherits; each such step says what the first time through does instead.

## Before the tag

All of this is checked on `main`, at the commit that will carry the tag. A release branch is never tagged.

1. **`npm test` is green on `main`.** The `ci-ok` check on the merge commit, and a local run on a fresh checkout of that commit. Local matters because CI does not run `npm run build`: the drift gate asserts the committed `dist/` equals a fresh build, and building first would make that assertion vacuous.
2. **`dist/` is regenerated and drift-clean.** `npm run build && git status --porcelain` prints nothing. A tag whose `dist/` lags `tokens.json` installs the old palette in every repository that pins it, with no error anywhere.
3. **The contrast register has been read**, not just run. `npm run check:contrast` prints the table; every `ALLOWED` and `EXEMPT` row in `contrast-known-failures.json` carries a reason and the decision it records. A row still "awaiting" a decision is a reason not to tag, because the tag freezes it into what consumers ship.
4. **The decider is named.** Every pull request since the previous tag that changes what a consumer renders has the person who decided it named in the pull request's description or in the release's CHANGELOG entry. The trigger is the generated output, not the file edited: a value in `tokens.json`, and equally a design constant the build emits into `dist/`. Those constants live in `scripts/lib/spec.mjs`, in the exported `SPEC` object — two entries today, `pageGradient` and `focusRing`, the second emitted per ring variant as a two-tone `--focus-ring…` custom property and its indicator `--focus-ring…-color` companion, declared inside every theme block, and in the preset as `ringWidth.DEFAULT` and one `ringColor` key per variant. `scripts/build.mjs` imports `SPEC` and declares no design value of its own; what it does hold is naming and defaulting policy, which step 5 classes as a rename rather than a value change. **The two files to read are therefore `tokens.json` and `scripts/lib/spec.mjs`**, and `git log <previous tag>..main -- tokens.json scripts/lib/spec.mjs` is the list of pull requests this step is about — for the first tag, the whole history. Naming the two `SPEC` entries is an illustration and not a list: the rule is written against the output, so a constant added to `SPEC` is covered on the day it lands (ADR-0002, points 2 and 3, which also require every colour `SPEC` composes to carry a row in `contrast-pairs.json`). A token value change is a design decision (AGENTS.md, "The source of truth"), and a build constant that reaches `dist/` is one on the same footing: a consumer cannot tell which file a rendered value came from, and a tag that carries either unsigned ships a value nobody chose. No name, no tag.
5. **The version is right.** `package.json` `version` follows console ADR-0004 and DESIGN_HANDOFF F5, read against what the build emits rather than against `tokens.json` alone: renaming or removing a name a consumer can use — a token, a CSS variable, a preset key — is a **major**; a deprecation keeps the old name resolving for one minor; a value change alone, in `tokens.json` or in a design constant the build emits, is a minor. The `Unreleased` section of `CHANGELOG.md` becomes the heading for this version in the same pull request as the bump.

## The tag

Annotated, on `main`, pushed on its own:

```sh
git switch main && git pull --ff-only
npm test && npm run build && git status --porcelain   # green, and prints nothing
git tag -a vX.Y.Z -m "design-tokens vX.Y.Z"
git push origin vX.Y.Z
```

The tag name is `v` + the `package.json` version, exactly. A tag is never moved or deleted once pushed: a consumer pinned to it has already resolved it, and a moved tag is the drift ADR-0004 exists to prevent. A mistaken tag is followed by a corrected patch tag, and the changelog says so.

The person cutting the tag is one of the maintainers in `CODEOWNERS`.

## After the tag

The tag changes nothing until a consumer pins it. One pull request per consuming repository, opened by whoever cut the tag:

- Each repository that declares the dependency — `kodera-console` and `kodera-landing` — updates its existing `#v0.4.0` pin to the newly released `"@kodera/design-tokens": "github:kodera-hq/kodera#vX.Y.Z"` in `package.json` and refreshes its lockfile. Replacing a bare commit SHA describes first adoption only; these two consumers already use a tag. `kodera-web` is expected to join when its v2 repaint lands — its README says the repaint waits on this package being published — and it takes the same pull request on the day it declares the dependency; until then there is nothing in it to repin, so no pull request is opened against it.
- A consuming repository that uses the Tailwind preset runs the token-resolution guard against the new preset in its CI; a class that no longer resolves fails there, which is the point of pinning rather than tracking a branch. The console imports that guard from this package, as `@kodera/design-tokens/token-test`.
- The repin pull request pastes the `check:contrast` rows whose ratio moved since the previous pin — for the first tag, since the commit SHA the consumer pins now — so the reviewer sees what a value change does to the screens before the palette lands on them.
- The consumer's version-drift rule (README, "The version-drift rule for consumers") is what makes the repin happen once there is a run of tags to fall behind: a consumer more than one minor behind the newest tag fails its own CI. It has no baseline to measure against until a second tag exists, and no consumer implements the check today.
