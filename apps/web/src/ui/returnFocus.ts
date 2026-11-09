/**
 * Where a `Dialog`/`Drawer` sends focus when it closes, when its `trigger`
 * is not the answer. Read at close time — `.current`, not the element — so
 * one dialog opened from several controls returns to whichever opened it.
 * Structurally what `useRef<HTMLElement | null>()` returns.
 */
export interface FocusTarget {
  readonly current: HTMLElement | null
}

/**
 * The `onCloseAutoFocus` handler for a Radix `Dialog.Content`. Radix's own
 * handler (composed after this one, skipped once the event is default-
 * prevented) focuses its trigger ref — null for a dialog opened without a
 * `trigger`, which strands focus on `body`. With a target: prevent that and
 * focus the target ourselves. Without one, or with a ref still empty, leave
 * Radix's behaviour untouched.
 */
export function closeAutoFocusHandler(returnFocusTo: FocusTarget | undefined) {
  return (event: Event) => {
    const target = returnFocusTo?.current
    if (target === null || target === undefined) return
    event.preventDefault()
    target.focus()
  }
}
