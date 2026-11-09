import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardBody } from '../ui/Card/Card'
import { Combobox } from '../ui/Combobox/Combobox'

/** `alt=""`: the organisation's name is the very next thing in the reading
 * order, so naming the image too would announce the organisation twice. */
function OrganisationMark({ mark }: { mark: string | undefined }) {
  if (mark === undefined) return null
  return <img src={mark} alt="" className="h-8 w-8 shrink-0 rounded-md" />
}

export interface OrgSwitcherOrganisation {
  readonly name: string
  readonly slug: string
}

/** One row of the switcher's menu (§4.6): the slug stands in for the domain
 * — see `src/features/login/OrganisationChoice.tsx`'s own note on the same
 * gap in `OrganisationSummary`. */
export interface OrgSwitcherMembership {
  readonly slug: string
  readonly name: string
  readonly current: boolean
}

export interface OrgSwitcherProps {
  organisation: OrgSwitcherOrganisation
  /** Every organisation the signed-in identity belongs to, from `GET /me`.
   * Omitted or a single entry: static text. Two or more: a real `Combobox`
   * menu. Desktop integrates the frame; narrow surfaces keep the card. */
  memberships?: readonly OrgSwitcherMembership[]
  /** Called with the chosen slug. The caller (`src/app/org-route.tsx`'s
   * `OrgLayout`) owns the navigation and, through the route guard already
   * there, the re-authentication a different realm needs. */
  onSwitch?: (slug: string) => void
  /** The organisation's own mark, drawn beside its name — the tenant's
   * branding, as opposed to the maker's mark in the module rail, which is the
   * same for every customer.
   *
   * DEMO-ONLY, and it has to be: no field of `Organisation` or
   * `OrganisationSummary` carries branding of any kind, so nothing the Core
   * API returns can ever fill this in. `src/app/demoBranding.ts` is the whole
   * story and the reason this prop is optional rather than part of
   * `OrgSwitcherOrganisation` — putting it on that type would read as though
   * the contract had a field for it. */
  mark?: string
  /** Integrated into the desktop sidebar; narrow surfaces keep their card. */
  embedded?: boolean
}

/**
 * The organisation switcher (docs/specs/00-shell-and-login.md §4.6): the
 * organisation area at the top of the sidebar. `Combobox` over a plain popover
 * menu because §4.6 names it directly ("filter appears above five
 * entries"), which is exactly `Combobox`'s own behaviour — its options are
 * flat strings, though, so "current" is read out by appending the
 * `a11y-current` label to that one option's text rather than a separate
 * checkmark glyph nothing else here composes into a string option.
 *
 * Keyboard: `Combobox`'s own map (`src/ui/Combobox/Combobox.tsx`) — `Enter`
 * chooses the highlighted organisation, `Escape` closes without switching.
 */
export function OrgSwitcher({
  organisation,
  memberships,
  onSwitch,
  mark,
  embedded = false,
}: OrgSwitcherProps) {
  const { t } = useTranslation()

  if (memberships === undefined || memberships.length <= 1) {
    return (
      <SwitcherFrame embedded={embedded}>
        <CardBody className="flex items-center gap-2 p-3">
          <OrganisationMark mark={mark} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-c-ink">{organisation.name}</p>
            <p className="truncate text-xs text-c-ink-3">{organisation.slug}</p>
          </div>
        </CardBody>
      </SwitcherFrame>
    )
  }

  const current = memberships.find((entry) => entry.current)

  return (
    <SwitcherFrame embedded={embedded}>
      <CardBody className="flex flex-col gap-2 p-3">
        {current === undefined ? null : (
          <div className="flex items-center gap-2">
            <OrganisationMark mark={mark} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-c-ink">{current.name}</p>
              <p className="truncate text-xs text-c-ink-3">{current.slug}</p>
            </div>
          </div>
        )}
        <Combobox
          label={t('console.shell.switcher.label')}
          placeholder={t('console.shell.switcher.placeholder-search')}
          emptyText={t('console.login.organisation.error-load-failed')}
          // Deliberately uncontrolled (no `value`): `Combobox` pre-fills its
          // own query state from a controlled `value`'s label and filters
          // by it, which is right for a form field remembering a prior
          // choice but wrong here — the switcher must show every
          // organisation the moment it opens, current one included, not
          // just the one that already matches what would be pre-filled.
          options={memberships.map((entry) => ({
            value: entry.slug,
            label: entry.current
              ? `${entry.name} · ${entry.slug} — ${t('console.shell.switcher.a11y-current')}`
              : `${entry.name} · ${entry.slug}`,
          }))}
          onValueChange={(slug) => {
            if (slug !== undefined && slug !== current?.slug) onSwitch?.(slug)
          }}
        />
      </CardBody>
    </SwitcherFrame>
  )
}

function SwitcherFrame({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return embedded ? <div>{children}</div> : <Card>{children}</Card>
}
