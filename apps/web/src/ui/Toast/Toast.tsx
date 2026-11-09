import * as RadixToast from '@radix-ui/react-toast'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { TOUCH_TARGET } from '../touchTarget'
import { CloseIcon } from '../icons/Close'

export type ToastKind = 'success' | 'error'

/**
 * `success` is `type="background"` (`aria-live="polite"`, COMPONENTS.md's
 * "Success toast" row: dark surface, white text). `error` is
 * `type="foreground"` (`aria-live="assertive"`) — the one kind here worth
 * interrupting for, the same split `Banner` and `InlineAlert` make with
 * `role="alert"`.
 */
const KIND: Record<ToastKind, { className: string; type: 'foreground' | 'background' }> = {
  // `focus-ground-*` (`src/index.css`): the close control draws the
  // on-inverse ring on the toast's own fill.
  success: { className: 'focus-ground-inverse bg-c-inverse text-c-on-inverse', type: 'background' },
  error: { className: 'focus-ground-bad bg-c-bad text-c-on-inverse', type: 'foreground' },
}

export interface ToastOptions {
  kind: ToastKind
  title: string
  description?: string
  /** Overrides `ToastProvider`'s own default (Radix's default is 5000 ms). */
  duration?: number
}

interface QueuedToast extends ToastOptions {
  id: number
}

type Notify = (options: ToastOptions) => void

const ToastDispatchContext = createContext<Notify | null>(null)

export interface ToastProviderProps {
  children: ReactNode
  /** Radix's own author-localized label for the interruption a screen reader
   * hears before a toast's content — no default text lives here. */
  label: string
  /** The toast region's landmark label. */
  viewportLabel: string
  /** What every toast's close control is called. */
  closeLabel: string
  /** Milliseconds a toast stays up before it dismisses itself, absent a
   * per-call `duration`. Radix's own default is 5000 ms if this is omitted. */
  duration?: number
}

/**
 * Mounted once, near the application root. `useToast()` is how the rest of
 * the tree reaches it — nothing below needs to know where the viewport lives.
 *
 * Keyboard: `F8` (Radix's own hotkey) moves focus into the toast region;
 * `Tab` then reaches each toast's close control. Auto-dismiss pauses while a
 * toast has hover or focus (Radix Primitives, built in) and under
 * `prefers-reduced-motion` the entrance/exit is instant rather than sliding
 * (`src/index.css` collapses every animation duration globally).
 */
export function ToastProvider({
  children,
  label,
  viewportLabel,
  closeLabel,
  duration,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<QueuedToast[]>([])
  const nextId = useRef(0)

  const notify = useCallback<Notify>((options) => {
    nextId.current += 1
    const id = nextId.current
    setToasts((current) => [...current, { ...options, id }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  return (
    <ToastDispatchContext.Provider value={notify}>
      <RadixToast.Provider
        label={label}
        swipeDirection="right"
        {...(duration === undefined ? {} : { duration })}
      >
        {children}
        {toasts.map((toast) => {
          const kind = KIND[toast.kind]
          return (
            <RadixToast.Root
              key={toast.id}
              type={kind.type}
              {...(toast.duration === undefined ? {} : { duration: toast.duration })}
              onOpenChange={(open) => {
                if (!open) {
                  dismiss(toast.id)
                }
              }}
              className={cx(
                'flex items-start gap-3 rounded-md p-4 shadow-pop shadow-c-shadow-2',
                'data-[state=closed]:animate-none data-[state=open]:animate-none',
                kind.className
              )}
            >
              <div className="flex-1">
                <RadixToast.Title className="text-sm font-semibold">{toast.title}</RadixToast.Title>
                {toast.description === undefined ? null : (
                  <RadixToast.Description className="mt-1 text-sm opacity-90">
                    {toast.description}
                  </RadixToast.Description>
                )}
              </div>
              <RadixToast.Close
                aria-label={closeLabel}
                className={cx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-sm opacity-70',
                  TOUCH_TARGET,
                  'hover:opacity-100 focus-visible:opacity-100',
                  'focus-visible:ring focus-visible:outline-hidden'
                )}
              >
                <CloseIcon />
              </RadixToast.Close>
            </RadixToast.Root>
          )
        })}
        <RadixToast.Viewport
          label={viewportLabel}
          className={cx(
            // `toast-edges` (src/index.css): bottom-right, lifted above the
            // narrow layout's tab bar and clear of a phone's safe areas.
            'toast-edges fixed z-50 flex max-w-full flex-col gap-3 p-6',
            // 384 px is not on the tokens package's spacing grid (`h-1`…`h-12`
            // only, `src/ui/README.md`) and COMPONENTS.md gives the toast
            // region no width of its own — a layout container size, like
            // `Dialog`'s 420 px confirm variant, until the design workstream
            // does.
            'w-[384px]'
          )}
        />
      </RadixToast.Provider>
    </ToastDispatchContext.Provider>
  )
}

/**
 * Returns the function that queues a toast — `notify({ kind, title })`.
 * Throws, rather than returning a no-op, when no `ToastProvider` is mounted
 * above the caller: a screen that calls this without one would otherwise
 * queue toasts nobody ever renders, and find out only by a customer report.
 */
export function useToast(): Notify {
  const notify = useContext(ToastDispatchContext)
  if (notify === null) {
    throw new Error('useToast must be called within a ToastProvider')
  }
  return notify
}
