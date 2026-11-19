import * as Menu from '@radix-ui/react-dropdown-menu'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cssProperty } from '../../../ui/cssom'
import { cx } from '../../../ui/cx'
import { Button } from '../../../ui/Button/Button'
import { ConfirmDestructive } from '../../../ui/ConfirmDestructive/ConfirmDestructive'
import { Tooltip } from '../../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import { ApiProblem } from '../../../api/client'
import { isForbidden, isIamUnsupported, isStale, type WorkspaceRole } from '../iamApi'
import { adminCopy, type AdminCopy } from './adminMessages'

export function useAdminCopy(): AdminCopy {
  const { i18n } = useTranslation()
  return adminCopy(i18n.resolvedLanguage)
}

export const PANEL = 'flex flex-col gap-4 rounded-lg border border-c-border p-5'

export function Panel({
  title,
  hint,
  actions,
  children,
}: {
  title: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={PANEL} aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {hint === undefined ? null : <p className="text-sm text-c-ink-2">{hint}</p>}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * A role's colour, set through the CSSOM (`style-src-attr 'none'` forbids a style attribute).
 * The colour is decoration: the role's name always travels beside it.
 */
export function RoleDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      ref={cssProperty('background-color', color === '' ? undefined : color)}
      className={cx(
        'inline-block h-3 w-3 shrink-0 rounded-full border border-c-border bg-c-ink-4',
        className
      )}
    />
  )
}

export function RolePill({
  role,
  children,
}: {
  role: Pick<WorkspaceRole, 'name' | 'color' | 'icon'>
  children?: ReactNode
}) {
  return (
    <span
      ref={cssProperty('border-color', role.color === '' ? undefined : role.color)}
      className="inline-flex max-w-full items-center gap-1 rounded-full border bg-c-sunken py-[2px] pr-1 pl-2 text-xs font-medium text-c-ink"
    >
      <RoleDot color={role.color} className="h-2 w-2" />
      {role.icon === '' ? null : <span aria-hidden="true">{role.icon}</span>}
      <span className="truncate">{role.name}</span>
      {children}
    </span>
  )
}

export function Notice({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'bad' }) {
  return (
    <p
      role="status"
      className={cx('text-sm empty:sr-only', tone === 'bad' ? 'text-c-bad-ink' : 'text-c-ink-2')}
    >
      {text}
    </p>
  )
}

/** The plain-language reason a governance call did not go through. Never a status code. */
export function problemText(error: unknown, copy: AdminCopy): string {
  if (isIamUnsupported(error)) return copy.unsupported
  if (isStale(error)) return copy.problemStale
  if (isForbidden(error)) return copy.problemForbidden
  if (error instanceof ApiProblem && error.status === 409) return copy.problemConflict
  if (error instanceof ApiProblem && error.status === 422) return copy.problemInvalid
  return copy.problemGeneric
}

/** Shown in place of a panel when the organisation's server predates workspace governance. */
export function Unsupported() {
  const copy = useAdminCopy()
  return (
    <p className="rounded-md bg-c-sunken p-4 text-sm text-c-ink-2" role="note">
      {copy.unsupported}
    </p>
  )
}

export function Loading() {
  const copy = useAdminCopy()
  return (
    <p className="text-sm text-c-ink-3" aria-busy="true">
      {copy.loading}
    </p>
  )
}

export function useDateTime() {
  const { i18n } = useTranslation()
  return (iso: string, withTime = false) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
    }).format(date)
  }
}

/**
 * An icon-only destructive control and its confirmation. The dialog opens on its own state (a
 * tooltip-wrapped icon button is not a dialog trigger) and gives focus back to the icon.
 */
export function ConfirmIconAction({
  icon,
  label,
  title,
  consequence,
  confirmLabel,
  busy = false,
  disabled = false,
  onConfirm,
}: {
  icon: ReactNode
  label: string
  title: string
  consequence: string
  confirmLabel: string
  busy?: boolean
  disabled?: boolean
  onConfirm: () => void
}) {
  const copy = useAdminCopy()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button
        ref={trigger}
        variant="tertiary"
        size="sm"
        iconOnly
        icon={icon}
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <ConfirmDestructive
          defaultOpen
          initialFocus="title"
          returnFocusTo={trigger}
          onOpenChange={(next) => (next ? undefined : setOpen(false))}
          title={title}
          consequence={consequence}
          cancelLabel={copy.cancel}
          confirmLabel={confirmLabel}
          closeLabel={copy.close}
          loading={busy}
          onConfirm={() => {
            setOpen(false)
            onConfirm()
          }}
        />
      ) : null}
    </>
  )
}

export interface MenuEntry {
  key: string
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

const MENU_ITEM =
  'flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-hidden data-[disabled]:cursor-default data-[disabled]:text-c-ink-4 data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink'

/**
 * A compact menu: the trigger is named by `label` (and shows it as a tooltip), and draws either
 * an icon or a short visible value such as the member's current role.
 */
export function MenuButton({
  label,
  content,
  items,
  disabled = false,
}: {
  label: string
  content: ReactNode
  items: readonly MenuEntry[]
  disabled?: boolean
}) {
  return (
    <Menu.Root>
      <Tooltip content={label} names>
        <Menu.Trigger asChild disabled={disabled || items.length === 0}>
          <button
            type="button"
            aria-label={label}
            className={cx(
              'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-c-ink-2',
              TOUCH_TARGET,
              'hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden disabled:cursor-default disabled:opacity-60'
            )}
          >
            {content}
          </button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          aria-label={label}
          align="end"
          sideOffset={4}
          className="z-50 max-h-[320px] min-w-[192px] overflow-y-auto rounded-lg border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2"
        >
          {items.map((item) => (
            <Menu.Item
              key={item.key}
              disabled={item.disabled === true}
              onSelect={item.onSelect}
              className={cx(MENU_ITEM, item.destructive === true ? 'text-c-bad-ink' : 'text-c-ink')}
            >
              {item.label}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

/**
 * A local edit of a value read from Core. The edit is kept only while the value it started from is
 * the one on screen: once Core's value changes (a save, a refetch), the draft starts over from it.
 */
export function useDraft<T>(source: T | undefined): [T | undefined, (next: T) => void] {
  const [edit, setEdit] = useState<{ source: T; value: T } | null>(null)
  const draft = source === undefined ? undefined : edit?.source === source ? edit.value : source
  const set = (next: T) => {
    if (source !== undefined) setEdit({ source, value: next })
  }
  return [draft, set]
}
