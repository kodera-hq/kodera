import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Badge } from '../Badge/Badge'
import { Card, CardBody } from '../Card/Card'
import { cx } from '../cx'

type PlanCardRecommendedProps =
  | { recommended?: false; recommendedLabel?: undefined }
  | {
      recommended: true
      /** The pill's text, e.g. "Recommandé" — the caller's own string, a
       * primitive holds no copy of its own. Required together with
       * `recommended`, the same pairing `Banner`'s `dismissible` keeps with
       * `dismissLabel`. */
      recommendedLabel: string
    }

export type PlanCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> &
  PlanCardRecommendedProps & {
    title: string
    /** A whole-card control owns its label; standalone cards keep a heading. */
    titleAs?: 'h3' | 'span'
    /**
     * What the plan is for, from the catalogue's own `description`
     * (`design specification` `design/copy/`). Drawn under the features, not under
     * the title, so a longer text never pushes this card's price below its
     * neighbours'. Empty or absent draws nothing.
     */
    description?: string | null
    /**
     * An id for the description, so an enclosing control (PlanStep's radio,
     * whose children assistive technology does not read) can point
     * `aria-describedby` at it.
     */
    descriptionId?: string
    /** Usually a `PlanPrice`. */
    priceLine: ReactNode
    features: string[]
    /**
     * The select action. Standalone, a `Button`. Inside an enclosing control
     * (the radio PlanStep draws around each card) it must NOT be interactive —
     * a control inside a control is invalid and adds a tab stop — so pass a
     * presentational `aria-hidden` span that only looks like the action.
     */
    action: ReactNode
    /** The plan the customer has chosen: one accent ink edge, which replaces
     * the recommended edge on a card that is both (the pill stays). */
    chosen?: boolean
  }

/**
 * Layout (P01 reference look, `design specification` `design/reference/`): the
 * title, the price, a ruled list of features each with a check in
 * `c-accent-ink`, then the optional description, and the action at the foot of
 * an equal-height card, with the chosen plan's check mark beside it. With one-line titles, every card's price and feature
 * list start on the same line; the description sits below them so its length
 * cannot break that comparison.
 *
 * No keyboard map of its own: the only interactive thing here, when the card
 * is not itself inside a control, is `action`,
 * which carries its own. `recommended` is a 2 px cobalt border — the tokens
 * package extends no `borderWidth` scale, so `border-2` is Tailwind's own
 * default step standing in for a value the grid does not name, the same move
 * `Stepper`'s upcoming ring and `Button`'s destructive border make — plus a
 * `Badge` (`variant="accent"`) for the pill, the same cobalt-on-cobalt-tint
 * COMPONENTS.md's own "Recommandé" pill asks for. `chosen` is a 2 px
 * accent ink edge, and wins over `recommended`: a card that is both shows one
 * edge. The mock draws the chosen edge in `c-action`; `c-accent-ink` is an owner-
 * approved deviation (2026-09-23), taken when `action` was 2.88:1 against the
 * dark card, under WCAG 1.4.11's 3:1. Tokens v0.5.0 raise it to 3.54:1; the
 * ruling stands until the owner revisits it.
 *
 * The pill sits across the card's top border, out of the flow, where
 * COMPONENTS.md puts it ("top −10"). Beside the title it squeezed the title
 * and broke over three lines in the 169 px card a 1280 px screen draws; on a
 * row of its own it would push the recommended card's price below its
 * neighbours' and break the column-by-column comparison. Centred on the edge,
 * a one-line pill rises 10 px above it, and a label too long for a narrow
 * card wraps inside the pill instead of running past the card.
 */
export const PlanCard = forwardRef<HTMLDivElement, PlanCardProps>(function PlanCard(
  {
    title,
    titleAs: Title = 'h3',
    description,
    descriptionId,
    priceLine,
    features,
    action,
    recommended = false,
    recommendedLabel,
    chosen = false,
    className,
    ...rest
  },
  ref
) {
  return (
    <Card
      ref={ref}
      {...rest}
      edge={chosen ? 'accent' : recommended ? 'action' : 'default'}
      // `h-full` with the action pushed to the foot, so a row of cards ends on
      // one line whatever the length of each card's features and description.
      className={cx('relative h-full', className)}
    >
      <CardBody className="flex h-full flex-col gap-4">
        {recommended ? (
          <Badge variant="accent" className="absolute inset-x-[14px] top-0 w-fit -translate-y-1/2">
            {recommendedLabel}
          </Badge>
        ) : null}
        {/* The title has the card's whole width on every card. Any room kept
            beside it for the chosen mark made "Business Plus" wrap at 900 px
            while "Team" did not, which dropped that card's price a line below
            its neighbours'. */}
        <Title className="text-lg font-bold tracking-snug text-c-ink">{title}</Title>
        {priceLine}
        <ul className="flex flex-col gap-2 border-t border-c-border-soft pt-4">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm text-c-ink">
              {/* 2 px down so the 16 px glyph centres on the first 20 px line
                  of `text-sm`; not a design step, a one-off alignment. */}
              <span aria-hidden="true" className="mt-[2px] shrink-0 text-c-accent-ink">
                <CheckGlyph />
              </span>
              {feature}
            </li>
          ))}
        </ul>
        {description === undefined || description === null || description === '' ? null : (
          <p
            {...(descriptionId === undefined ? {} : { id: descriptionId })}
            className="text-sm text-c-ink-3"
          >
            {description}
          </p>
        )}
        {/* The foot is pinned to the bottom of an equal-height card, so the mark
            here moves nothing above it. The chosen plan says so with a mark as
            well as its edge, so the state does not rest on the edge colour
            alone. `c-surface` on `c-accent-ink` is the gated pair of
            `c-accent-ink` on `c-surface`, read the other way round. Decoration:
            the control carries the state. */}
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          {action}
          {chosen ? (
            <span
              aria-hidden="true"
              data-chosen-mark=""
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-c-accent-ink text-c-surface"
            >
              <CheckGlyph />
            </span>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
})

/** A 16 px check, stroked in `currentColor`. */
function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}
