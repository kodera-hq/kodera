// The ground a focus ring's offset gap is painted in, for a subtree drawn on
// `elevated` (Dialog, Drawer, Popover). `focus-offset` (`src/index.css`) paints
// the gap in `--focus-ring-ground`, which defaults to `surface`; inside an
// overlay the control sits on `elevated`, so the gap takes that instead.
//
// One constant, not six copies of the class: a misspelt custom property here
// would resolve to nothing and the gap would fall back to white with every
// guard green. `focusGround.test.ts` checks that the property it names is
// declared in every theme block of the tokens package.
export const FOCUS_GROUND_ELEVATED = '[--focus-ring-ground:var(--c-elevated)]'
