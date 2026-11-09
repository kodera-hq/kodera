/**
 * Whether a state the caller names in words is on. Espace's rows and messages
 * switch a state on by passing its label (`unread="non lu"`), so a state can
 * never be drawn without the words that say it. One predicate decides both the
 * look and the accessible name: an empty string is off in both, never drawn in
 * one and silent in the other.
 */
export function hasLabel(label: string | undefined): label is string {
  return label !== undefined && label !== ''
}
