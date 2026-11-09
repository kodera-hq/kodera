// The current item's 3 px `c-action` bar at its start (tokens v0.5.0, DIRECTION.md §6), like the
// module rail's: the console sidebar and the workspace's channel list. Drawn as `::before`, so
// the item needs `relative` and adds no node; it sits inside the item's 1 px edge.
export const CURRENT_BAR =
  "before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-sm before:bg-c-action before:content-['']"

// The workspace's channel lists in the dark workspace reference (docs/specs/workspace-dark-roles.md):
// a 3 px bar in the row's own accent ink, inset 4 px and fully round, on a row with no edge, so the
// current channel is told apart by more than its colour. `ChannelRow` draws the same bar as a span.
export const CURRENT_BAR_ACCENT =
  "before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-c-accent-ink before:content-['']"
