# Order plan heading outline

Status: Approved accessibility correction; existing Order behaviour and design remain authoritative.

## Outcome

The plan choices are radio controls with names containing their plan, price and capacity. Their visible titles are labels within those controls, not independent document sections. They must not introduce headings between the screen heading and the existing section headings. Standalone PlanCard usage retains its existing heading semantics.

## Acceptance

- PlanStep renders the same three named catalogue radio choices, with no heading nested inside a choice. Existing selection, arrow-key navigation, recommendation and pricing tests still pass.
- PlanCard retains its default level-three heading and supports a plain-text title for an enclosing control; typography and layout are identical in both modes.
- The Order visual checks run axe without the heading-order exception. Remove the exception field and disabling path now that no launch view needs them. Light, dark and black Order checks pass against the existing pinned-renderer snapshots, with no baseline or tolerance changes.
- Update the active shell and Appearance specifications to remove the obsolete exception. This changes no API, catalogue fixture, price, permission, visible copy or workflow.

## Runnable checks

`npx vitest run src/ui/PlanCard/PlanCard.test.tsx src/features/order/PlanStep.test.tsx`

`npm run test:visual -- --grep 'visual/order'`

The new PlanStep assertion must fail on the original heading markup before the fix. Final validation also includes the existing static checks and protected CI. New design deviations are outside this correction.
