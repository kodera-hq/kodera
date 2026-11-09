import { forwardRef, useCallback, useId, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, RefCallback } from 'react'
import { cx } from '../cx'
import { FieldError } from '../FieldError/FieldError'

export interface FileDropProps {
  label: string
  help?: string
  error?: string
  /** MIME types or extensions, comma-separated — passed straight to the
   * native `accept` attribute AND used to reject a mismatched file. */
  accept?: string
  /** In bytes. */
  maxSize?: number
  /** What to say when a file is rejected, one reason at a time — the caller's
   * message-catalogue string, e.g. `(reason) => reason === 'size' ? …`. */
  rejectionMessage: (reason: 'type' | 'size') => string
  onFileChange?: (file: File | null) => void
  disabled?: boolean
  id?: string
  className?: string
  /** Accessible name for the action that clears the chosen file. */
  removeLabel: string
}

function accepts(file: File, accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true
  const patterns = accept
    .split(',')
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern !== '')
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()

  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern)
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1))
    return type === pattern
  })
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * A drop zone plus a hidden native input, so a keyboard or a screen-reader
 * user gets the platform's own file picker rather than a re-implementation of
 * one. `role="button"` because it is one, semantically — `Enter` and `Space`
 * both open the picker, same as a real `<button>`, spelled out by hand because
 * a `<div>` gives neither for free.
 *
 * Keyboard: `Tab` reaches the drop zone (or, once a file is chosen, the remove
 * action in its place); `Enter` and `Space` open the file picker; a chosen
 * file's remove action is a plain button, reached and activated the usual way,
 * and returns focus to the drop zone it puts back — the control that was
 * pressed unmounts itself, so something has to claim focus or it falls to
 * `<body>`.
 *
 * Rejection — wrong type or over `maxSize` — never silently drops the file:
 * `rejectionMessage(reason)` renders as a `FieldError` and the input is left
 * exactly as it was, so a person who dropped the wrong thing sees why. It is
 * in the zone's `aria-describedby` for as long as it stands, so it is still
 * there for someone who tabs back rather than only at the moment it appears.
 */
export const FileDrop = forwardRef<HTMLDivElement, FileDropProps>(function FileDrop(
  {
    label,
    help,
    error,
    accept,
    maxSize,
    rejectionMessage,
    onFileChange,
    disabled = false,
    id,
    className,
    removeLabel,
  },
  ref
) {
  const generatedId = useId()
  const dropId = id ?? generatedId
  const labelId = `${dropId}-label`
  const helpId = `${dropId}-help`
  const errorId = `${dropId}-error`

  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [rejection, setRejection] = useState<'type' | 'size' | null>(null)
  const [dragging, setDragging] = useState(false)

  // `errorId` names whichever of the two error sources is rendering below, so
  // both have to be described here. Leaving `rejection` out made a rejected
  // file a one-shot announcement: the `role="alert"` fires once, and after
  // that the message is reachable only by sight, because nothing points at
  // it. Coming back to the zone would then say the label and stop, and the
  // red border would be the only lasting signal.
  const describedBy = cx(
    help === undefined ? undefined : helpId,
    error === undefined && rejection === null ? undefined : errorId
  )

  /**
   * Set by `removeFile`, read by the drop zone's ref callback on the render
   * that puts the zone back. Same class of gap as a dialog closing with no
   * trigger to return to, and the same answer: name the target and claim
   * focus at the moment of the transition, rather than leaving it to fall
   * where it may.
   */
  const pendingZoneFocus = useRef(false)

  /**
   * The caller's forwarded ref and this component's own claim on the zone node
   * both have to reach it, and neither may replace the other — the same merge
   * `Form/FormField.tsx` makes between `register`'s ref and the caller's.
   */
  const zoneRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      if (typeof ref === 'function') ref(node)
      else if (ref !== null) ref.current = node

      if (node !== null && pendingZoneFocus.current) {
        pendingZoneFocus.current = false
        node.focus()
      }
    },
    [ref]
  )

  function accept_(candidate: File) {
    if (maxSize !== undefined && candidate.size > maxSize) {
      setRejection('size')
      return
    }
    if (!accepts(candidate, accept)) {
      setRejection('type')
      return
    }
    setRejection(null)
    setFile(candidate)
    onFileChange?.(candidate)
  }

  function openPicker() {
    if (disabled) return
    inputRef.current?.click()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openPicker()
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (disabled) return
    setDragging(true)
  }

  function handleDragLeave() {
    setDragging(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = event.dataTransfer.files[0]
    if (dropped !== undefined) accept_(dropped)
  }

  function handleInputChange() {
    const selected = inputRef.current?.files?.[0]
    if (selected !== undefined) accept_(selected)
    if (inputRef.current !== null) inputRef.current.value = ''
  }

  function removeFile() {
    // The control being activated is about to unmount, replaced by the drop
    // zone. Without this the keyboard user who pressed it lands on `<body>`
    // and has to tab back from the top of the document (WCAG 2.4.3).
    pendingZoneFocus.current = true
    setFile(null)
    setRejection(null)
    onFileChange?.(null)
  }

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <span id={labelId} className="text-sm font-medium text-c-ink">
        {label}
      </span>

      {file === null ? (
        <div
          ref={zoneRef}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={labelId}
          aria-disabled={disabled ? true : undefined}
          // `role="button"` does not support `aria-invalid` (ARIA does not
          // define it for that role): the red border is decoration a sighted
          // person sees, and `aria-describedby` below is what actually reaches
          // the error text — the same message either way.
          aria-describedby={describedBy === '' ? undefined : describedBy}
          data-dragging={dragging ? '' : undefined}
          onClick={openPicker}
          onKeyDown={handleKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cx(
            'flex flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-4 py-6',
            'text-center outline-hidden transition-colors duration-fast ease-out',
            'focus-visible:ring',
            disabled ? 'cursor-not-allowed' : 'cursor-pointer',
            // One edge colour at a time. `cx` does not merge, and two
            // unprefixed border colour classes are decided by stylesheet order,
            // which put `ink-4` over both the drag and the error edge.
            // Unavailable wins over an error, as in every field: the `disabled`
            // pair with the decorative edge, still dashed so it reads as a drop zone.
            disabled
              ? 'border-c-border bg-c-disabled'
              : dragging
                ? 'border-c-accent-ink bg-c-accent-soft'
                : error !== undefined || rejection !== null
                  ? 'border-c-bad-ink'
                  : 'border-c-border-input hover:border-c-accent-ink'
          )}
        >
          <span className={cx('text-sm', disabled ? 'text-c-on-disabled' : 'text-c-ink')}>
            {label}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-sm border border-c-border-input bg-c-surface px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-c-ink">{file.name}</span>
          <button
            type="button"
            onClick={removeFile}
            aria-label={removeLabel}
            className={cx(
              'shrink-0 rounded-sm text-c-ink-3 outline-hidden transition-colors duration-fast ease-out',
              'hover:text-c-ink focus-visible:ring'
            )}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Opened only programmatically, from the drop zone's `role="button"`
          above, which already carries the accessible name (`aria-labelledby`).
          `aria-hidden` takes it out of the accessibility tree entirely — left
          in, it is a second, unlabelled form control axe rightly flags. */}
      <input
        ref={inputRef}
        id={dropId}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={handleInputChange}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />

      {help === undefined ? null : (
        <p id={helpId} className="text-xs text-c-ink-3">
          {help}
        </p>
      )}
      {rejection !== null ? (
        <FieldError id={errorId}>{rejectionMessage(rejection)}</FieldError>
      ) : error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </div>
  )
})
