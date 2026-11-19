import type { ButtonHTMLAttributes } from 'react'
import { Tooltip } from './Tooltip/Tooltip'
import { KoderaIcon, type KoderaIconName } from './icons/KoderaIcons'
import { cx } from './cx'
export function IconButton({
  icon,
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: KoderaIconName; label: string }) {
  return (
    <Tooltip content={label} names>
      <button
        {...props}
        type="button"
        aria-label={label}
        className={cx(
          'tactile flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
          className
        )}
      >
        <KoderaIcon name={icon} className="icon-lift h-4 w-4" />
      </button>
    </Tooltip>
  )
}
