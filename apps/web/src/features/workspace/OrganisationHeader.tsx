import { useTranslation } from 'react-i18next'
import { useOrganisationSwitch } from '../../app/organisationSwitch'
import { initialsOf } from '../../ui/Avatar/Avatar'
import { cx } from '../../ui/cx'
import { WorkspaceMenu } from './WorkspaceMenu'

const FRAME = 'flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left'

export interface OrganisationHeaderProps {
  name: string
  slug: string
}

function Identity({ name, slug }: OrganisationHeaderProps) {
  return (
    <>
      {/* The initials repeat the name beside them: hidden from the reading order. */}
      <span
        aria-hidden="true"
        className="logo-tile-black flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-bold"
      >
        {initialsOf(name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-md font-semibold text-c-ink">{name}</span>
        {slug === 'community' ? (
          <span className="truncate text-xs text-c-ink-3">community.kodera.io</span>
        ) : null}
      </span>
    </>
  )
}

export function OrganisationHeader({ name, slug }: OrganisationHeaderProps) {
  const { t } = useTranslation()
  const organisationSwitch = useOrganisationSwitch()

  if (organisationSwitch === undefined) {
    return (
      <div className={FRAME}>
        <Identity name={name} slug={slug} />
      </div>
    )
  }

  return (
    <WorkspaceMenu
      name={name}
      slug={slug}
      trigger={
        <button
          type="button"
          aria-label={t('console.workspace.sidebar.action-switch-organisation', { name })}
          className={cx(
            FRAME,
            'transition-colors duration-fast hover:bg-c-muted',
            'focus-visible:ring focus-visible:outline-hidden'
          )}
        >
          <Identity name={name} slug={slug} />
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4 shrink-0 text-c-ink-3"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      }
    />
  )
}
