// A support action rendered as a link to the Aide page: a router link, so
// reaching help never reloads the console and restores the session, with the
// look of a `LinkButton`. Its context is typed (`HelpSearch`); the URL is
// the one `helpHref` writes.

import { Link } from '@tanstack/react-router'
import type { MouseEventHandler, ReactNode } from 'react'
import type { ButtonSize, ButtonVariant } from '../../ui/Button/Button'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { helpSearchParams } from './helpHref'
import type { HelpSearch } from './helpTopic'

export interface HelpLinkProps {
  org: string
  search?: HelpSearch
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  children: ReactNode
}

export function HelpLink({
  org,
  search = {},
  variant = 'secondary',
  size,
  className,
  onClick,
  children,
}: HelpLinkProps) {
  return (
    <LinkButton
      variant={variant}
      {...(size === undefined ? {} : { size })}
      {...(className === undefined ? {} : { className })}
      asChild
    >
      <Link
        to="/$org/help"
        params={{ org }}
        search={Object.fromEntries(helpSearchParams(search)) as HelpSearch}
        {...(onClick === undefined ? {} : { onClick })}
      >
        {children}
      </Link>
    </LinkButton>
  )
}
