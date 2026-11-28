import { useMatches } from '@tanstack/react-router'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { TOUCH_TARGET } from '../touchTarget'

const ORG_ROUTE_ID = '/$org'
const STAGE_ACT_BASE = `relative inline-flex h-10 items-center justify-center rounded-md px-4 text-md font-semibold whitespace-nowrap transition-colors duration-fast ease-out focus-offset focus-visible:outline-hidden focus-visible:ring focus-visible:ring-offset-2 ${TOUCH_TARGET}`
const STAGE_SECONDARY = `${STAGE_ACT_BASE} border border-c-border-input bg-c-surface text-c-ink hover:bg-c-muted`

export function useInOrgShell(): boolean {
  return useMatches({
    select: (matches) =>
      matches.some((match) => match.routeId === ORG_ROUTE_ID && match.status === 'success'),
  })
}

export function KoderaStageEmblem({ animated }: { animated?: boolean }) {
  return (
    <span
      className={
        animated
          ? 'stage-reticle stage-emblem-box stage-emblem-on'
          : 'stage-reticle stage-emblem-box'
      }
      aria-hidden="true"
    />
  )
}

export function StageButton({
  variant = 'primary',
  disabled,
  loading,
  onClick,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
  loading?: boolean
}) {
  const off = disabled === true
  const busy = loading === true
  const inactive = off || busy
  const tone = inactive
    ? `${STAGE_ACT_BASE} cursor-not-allowed ${variant === 'secondary' ? 'border border-transparent ' : ''}bg-c-disabled text-c-on-disabled`
    : variant === 'secondary'
      ? STAGE_SECONDARY
      : `${STAGE_ACT_BASE} bg-c-action text-c-on-inverse hover:bg-c-action-hover`
  return (
    <button
      {...rest}
      type={type}
      disabled={off}
      aria-disabled={busy ? true : undefined}
      aria-busy={busy ? true : undefined}
      data-disabled={off ? '' : undefined}
      data-loading={busy ? '' : undefined}
      onClick={
        busy
          ? (event) => {
              event.preventDefault()
              event.stopPropagation()
            }
          : onClick
      }
      className={className ? `${tone} ${className}` : tone}
    >
      {children}
    </button>
  )
}

export function StageSecondaryLink({
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} className={className ? `${STAGE_SECONDARY} ${className}` : STAGE_SECONDARY}>
      {children}
    </a>
  )
}

export function StageContainer({ inShell, children }: { inShell?: boolean; children: ReactNode }) {
  const Frame = inShell ? 'div' : 'main'
  return (
    <Frame className={`kodera-stage kodera-stage-${inShell ? 'pane' : 'screen'}`}>
      <KoderaStageEmblem />
      {children}
    </Frame>
  )
}
