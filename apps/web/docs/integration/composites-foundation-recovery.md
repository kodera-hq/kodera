# Continue composite components on the reviewed foundation

Status: Validated; pending independent review

## Scope

Continue existing PR34 at `6acb8e1` through a normal merge of feedback
`61120a3`. Preserve the existing QR panel, document viewer, progress list,
wizard, plan card and summary panel, including their keyboard and accessibility
corrections. Retain feedback/form/data corrections, stronger token guards and
token dependency `b7048b5`. No Core endpoint or fixture change is needed.

The app shell and later dialog-return-focus work remain their existing separate
PRs. No workflow, repository-rule, theme or design changes belong in this task.

## Acceptance before implementation

```sh
git diff --exit-code 61120a3 -- tests/unit/ui/spacing-guard.ts tests/unit/ui/fixtures src/ui/FileDrop src/ui/RadioGroup
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run format:check
npm run build-storybook
npm run build
```

The first preservation check must initially fail and then pass after the merge.
Existing guard refusal mutations and the generated five-pixel radio CSS test
must still pass. Existing composite files and their tests must remain unchanged
unless a reproduced integration error requires a separately explained correction.
Retain the single composite dependency, qrcode-generator at its existing pin;
do not update unrelated dependencies or regenerate the whole lockfile blindly.

Report the actual application-build outcome. A missing application entry is
not a passing build and component Storybook is not a working SaaS. Record
conflict choices, tests and limits before independent review and publication.

## Integration and validation evidence

The initial preservation check failed on the old composite branch. The ordinary
merge of feedback `61120a3` required no manual conflict resolution. The resulting
preservation check passes. All six original composite component trees and the
added Button acceptance remain byte-identical to `6acb8e1`.

Every inherited locked dependency entry is unchanged relative to feedback. The
only additional package entry is the original qrcode-generator 2.0.4. A clean
locked install succeeded without running dependency scripts.

All 743 tests in 61 files passed with two workers, including token refusal
mutations and generated radio CSS. Type checking, formatting and Storybook pass.
ESLint reports zero errors and one inherited unused-disable warning in
DocumentViewer; no lint rule or threshold was changed. The app build completes
type checking, then fails for absent index.html. This remains a component
foundation, with no runnable application or customer journey claimed.
