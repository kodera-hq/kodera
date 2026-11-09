# Continue the forms foundation on merged main

Status: Ready for independent review

## Scope and sources

Continue PR 31's existing forms lineage (`705ad4c`) onto merged main
(`e253389`). Reuse the held guard reconciliation (`6e00db0`) after inspecting
its changes; do not recreate the forms or rewrite their history. This work has
no backend interactions and requires no additional Core API fixture.

Preserve the existing form validation, keyboard behaviour, accessible errors,
file rejection announcements and focus management. Preserve main's colour and
spacing guards, their failure mutations, data display accessibility fixes and
dependency updates. Do not edit workflows or repository instructions.

The selected radio halo must remain five pixels wide. Replace its arbitrary
utility only with a shared semantic `ring-control-selection` token representing
that same width. Do not change the default focus ring or disable any guard.

## Acceptance, written before resolution

Run from the repository root:

```sh
git diff --exit-code e253389 -- tests/unit/ui/tokens.test.ts tests/unit/ui/spacing-guard.ts tests/unit/ui/spacing-guard.test.ts tests/unit/ui/fixtures
npm test -- tests/unit/ui/tokens.test.ts tests/unit/ui/spacing-guard.test.ts src/ui/RadioGroup/RadioGroup.styles.test.tsx
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build-storybook
```

The first command must initially fail on the existing forms branch: it still
contains older guards. After integration it must pass. Existing guard tests
include deliberate rejected fixtures, proving the checks can fail. The current
arbitrary radio ring must fail the merged token guard before tokenization;
that failure must disappear through the semantic token without modifying the
guard. Test the generated CSS for the checked radio utility at five pixels.

Run `npm run build` to establish its actual status; if the foundation has no
application entry, report that limitation instead of claiming an app build or
browser journey passes. Storybook builds exercise the component entry points.

## Review boundaries

Keep this as an append to PR 31, with ordinary merge ancestry. No push or remote
merge before independent review. The token dependency must reference a reviewed,
remotely retrievable commit before the lockfile can be release-ready.

## Conflict decisions

- Reused the existing held merge `6e00db0` by fast-forward, preserving its normal
  merge from main `608d087` into the original PR 31 branch.
- Merged current main `e253389` normally. Its nine conflicting data-display
  component, test and story files replace older copies from the original forms
  stack: Breadcrumb retains valid list children; CopyableCode and Table retain
  named, keyboard-reachable scroll regions; DataTable retains the resulting tab
  order; Table retains its token-backed letter-spacing check.
- Preserved every existing forms dependency and main's updated dependency
  versions. Applied main's exact js-yaml lock changes, including ESLint's nested
  older version; a clean locked installation succeeded. The token update changed
  exactly one installed package.
- Preserved main's token and spacing guards and fixtures byte for byte. The
  selected radio now consumes the reviewed token commit
  `b7048b5cc269d1fd341cff0985f696cee25e3119` from design-tokens PR 17. This dependency
  is remotely available and remains subject to its own merge review.

## Failure evidence

Before reconciliation, the guard preservation command failed against `705ad4c`.
After reconciliation, 21 of 22 guard tests passed: the colour-utility guard
reported the existing arbitrary radio ring. The new CSS acceptance first failed
on the old utility, then failed again with the new semantic utility against the
old installed preset, which emitted no matching CSS. Installing the reviewed
preset made all 23 targeted tests pass, including the generated checked-state
rule with the original five-pixel width. No guard exemption was added.

## Final validation

- The clean locked install (`npm ci --ignore-scripts --no-audit --no-fund`)
  succeeded; the subsequent exact token pin installed one changed package.
- All 517 tests in 41 files passed, including the existing interactive story
  accessibility gate and the new generated-CSS acceptance.
- Type checking, ESLint, Prettier and `git diff --check` passed. The JSX CSS
  acceptance lives with the component tests, under the browser TypeScript
  configuration; no compiler configuration was broadened for it.
- Storybook built successfully. Its output is a component inventory, not a
  customer application. Bundle-size and plugin-timing warnings remain advisory.
- `npm run build` passed its type-check phase, then failed because `index.html`
  does not exist in this foundation branch. No application build or end-to-end
  customer journey is claimed here.
- Main's guard files, guard fixtures, nine reconciled data-display files,
  repository instructions and `.github` files remain unchanged relative to
  `e253389`. The sole production forms edit is the semantic radio ring utility.
