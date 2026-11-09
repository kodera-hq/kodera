# Order feedback heading and keyboard accessibility

Status: Local implementation under review; supplements the existing Order contract.

The valid-empty catalogue feedback belongs directly below the existing plan h1 and therefore uses h2. EmptyState preserves h3 by default and existing explicit h1 callers; h2 is an explicit caller choice. Existing token classes, copy and geometry remain unchanged. Loading remains distinct from successful emptiness and failed discovery. Only failure offers Retry; valid-empty never adds Retry or Continue. No new purchase, support or recovery policy is introduced.

Acceptance renders the actual PlanStep with existing mock catalogue overlays. A held response proves loading precedes successful emptiness; failure followed by a deliberate retry can resolve empty. An isolated removal of the Order h2 opt-in must fail the hierarchy assertion, with exact source restoration afterward. Primitive tests retain h3/h1 and qualify h2 with unchanged classes.

Browser acceptance uses the mock identity provider and existing registered Order routes in both themes. Touch-capable portrait390×844 and landscape844×390 contexts must exhibit the narrow media query, coarse pointer and visible tab navigation. Doubled computed text sizes in main and extended existing feedback wording are controlled test fixtures. Informational feedback is checked for horizontal text-range bounds and final-line vertical reachability through scrolling; this does not establish complete ancestor/overlay clipping or line-overlap coverage for that text.

Actual Tab traversal reaches the existing Retry and Aide controls. Focus qualification requires focus-visible state, readable label ranges within viewport/bar/ancestor clips, uncovered label samples, and an uncovered portion of a nontransparent focus-specific token ring or solid outline. The ground-colored offset is excluded from ring paint. Witnesses lie strictly inside the exposed token-colored shadow band after accounting for the offset and earlier painted shadow layers; outline witnesses lie beyond their offset inside their painted width. Shadow qualification is bounded to the existing zero-offset, zero-blur token geometry, with earlier painted layers conservatively treated as coverage. It does not require the entire control box or ring inside the viewport. No programmatic focus or scrolling rescues a focused control. Enter retries a catalogue read or navigates to Aide. The address within catalogue feedback remains plain text. Tests send no email or order and add no action to successful emptiness.

Separate helper controls retain keyboard focus while deliberately obscuring the target, removing the indicator, making it transparent and clipping an ancestor. Additional ring-only controls preserve the offset and readable label while making only the colored layer transparent or covering only its exposed band; these must fail the paint and visibility predicates respectively. The old helper is first shown falsely accepting the transparent colored layer before the correction. Each must fail its intended predicate; exact fixture restoration must recover the positive result. Geometry and computed styles are retained as evidence before the finite scenario matrix. The original desktop-pointer landscape run remains separate diagnostic evidence and is not narrow-layout qualification.

The extended-content and text-enlargement fixtures do not promise browser zoom or assistive-technology qualification. No baseline or comparison threshold is changed. Future integration must retain the existing screen gates and add this spec to the named-test allowlist after all declared scenarios pass on that integration base.

## 12. Acceptance tests

`order/feedback: empty catalogue remains readable in portrait`
`order/feedback: failed catalogue retains keyboard actions in portrait`
`order/feedback: empty catalogue remains readable in landscape`
`order/feedback: failed catalogue retains keyboard actions in landscape`
`order/feedback: empty catalogue remains readable with enlarged text`
`order/feedback: failed catalogue retains keyboard actions with enlarged text`
`order/feedback: empty catalogue remains readable with long content`
`order/feedback: failed catalogue retains keyboard actions with long content`
