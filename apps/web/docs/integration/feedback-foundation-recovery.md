# Continue feedback components on the reviewed forms foundation

Status: Ready for independent review

## Scope and dependencies

Continue existing PR 33, source `d59f2f3`, by normally merging the reviewed PR 31
forms head `15a9d3d`. Preserve original feedback components, their tests and
stories. Keep merged data-display accessibility corrections, FileDrop rejection
focus/announcements, token guard mutations and the exact reviewed token dependency
`b7048b5` (design-tokens PR 17). No Core API contract changes are involved.

PR 48 (`31ef321`) adds return-focus support to Dialog, Drawer and
ConfirmDestructive later in the existing stack. It is a separate dependency;
do not duplicate it here or merge its whole later shell lineage into PR 33.
The present integration must leave those feedback component files intact.

## Runnable acceptance written before resolving conflicts

```sh
git diff --exit-code 15a9d3d -- tests/unit/ui/spacing-guard.ts tests/unit/ui/fixtures
npm test -- tests/unit/ui/tokens.test.ts tests/unit/ui/spacing-guard.test.ts src/ui/portal-containment.test.tsx src/ui/RadioGroup/RadioGroup.styles.test.tsx src/ui/FileDrop/FileDrop.test.tsx
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run format:check
npm run build-storybook
npm run build
```

The first command must fail on the old feedback source and pass after merging
forms. Preserve the stronger merged guard implementations and their intentional
failure fixtures. Preserve feedback's higher vacuity floors (106 files, 256
colour matches, 268 spacing matches, 33 story files), since accepting the older
smaller inventory thresholds would weaken the existing feedback acceptance.
Review any guard-test diff against PR 31 to ensure only these floors and their
explanations differ.

Component and interactive-story tests must continue to exercise keyboard use,
portal containment, dismiss behaviour and accessible feedback. The forms CSS
acceptance must still emit the five-pixel selected radio halo. No inline value
substitution or new guard exception is authorized.

Report a missing application entry honestly; a Storybook build alone does not
prove a running customer app. No workflows or repository-instruction edits,
rebase, force push, remote merge or push before independent review.

## Resolution evidence

The initial scanner/fixture preservation command failed on `d59f2f3`, as
expected. The normal merge from `15a9d3d` produced exactly four conflicts:
`package.json`, its lockfile and the two guard-test files.

Dependency resolution keeps all four feedback additions (Radix Dialog,
DropdownMenu, Toast and Tooltip), every forms dependency, the newer foundation
versions and the exact token PR 17 pin. Overlapping lock entries changed only
for the inherited i18next, js-yaml, React DOM types, PostCSS and token updates;
ESLint retains its required nested js-yaml version. A fresh locked installation
succeeded with 652 packages and no dependency scripts enabled.

The guard tests retain the reviewed implementations and mutation cases, with
only feedback's larger inventory thresholds and explanatory comments differing
from PR 31. Scanner and fixture files match PR 31 exactly. All original feedback
component, story, test and portal-containment files match `d59f2f3` exactly.
FileDrop, data-display corrections and radio styles/tests match PR 31 exactly.
Repository instructions and `.github` also match PR 31 without new edits.

PR 48 remains the later return-focus change; none of its implementation or
later shell ancestry was imported here. This merge is an append to existing
PR 33, not a replacement implementation.

## Validation

- All 46 focused tests in five files passed, including guard failure mutations,
  portal containment, FileDrop rejection and generated radio CSS.
- All 668 tests in 55 files passed with two workers, including interactive story
  accessibility checks.
- Type checking, ESLint, Prettier and `git diff --check` passed.
- Storybook built successfully; its bundle-size warning remains advisory.
- The application build passed type checking and then failed because this
  foundation branch has no `index.html`. No application build or customer
  browser journey is claimed by this component integration.
