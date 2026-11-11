import { caretInsideCode } from '../messaging/formatting'
// The composer's text field with its two lists (V1 bar M8, workspace audit item 4): typing « @ »
// opens the channel's members under the caret's word, and choosing one writes « @Name » into the
// text; typing « : » and two characters of a shortcode opens the matching emoji, and choosing one
// writes the emoji. A known « :nom: » becomes its emoji as its closing « : » is typed. The ARIA
// 1.2 combobox pattern, as `src/ui/Combobox` draws it: focus never leaves the field.
//
// Keyboard, while a list is open: `ArrowDown` / `ArrowUp` move the highlight, `Enter` or `Tab`
// chooses it, `Escape` closes the list until the next « @ » or « : ». Otherwise every key is the
// field's.

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, KeyboardEvent, Ref } from 'react'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { closeShortcode, insertAtCaret, insertEmoji, matchingEmoji, shortcodeAt } from './emoji'
import { insertMention, matchingMembers, mentionAt } from './mentions'
import type { MentionCandidate } from './mentions'

export interface MentionInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement>,
  'value' | 'onChange' | 'role'
> {
  multiline?: boolean
  id: string
  value: string
  onValueChange: (value: string) => void
  members: readonly MentionCandidate[]
  /** The member list's name, read by assistive technology, e.g. « Membres à mentionner ». */
  listLabel: string
  /** The emoji list's name, e.g. « Émojis correspondants ». */
  emojiListLabel: string
  /** Called once each time the member list opens: the caller loads the whole member list. */
  onMentionStart?: () => void
  /**
   * Filled with what « Mentionner » does: writes « @ » where the caret was (a space before it
   * when it would touch a word), puts the focus back in the field after it, and so opens the list.
   */
  mentionRef?: Ref<() => void>
  /**
   * Filled with what the emoji palette does: writes the given text where the caret was, over the
   * selection if there is one, and puts the focus back in the field just after it.
   */
  insertRef?: Ref<(text: string) => void>
}

/** One option of whichever list is open. */
type Option =
  | { kind: 'member'; key: string; member: MentionCandidate }
  | { kind: 'emoji'; key: string; emoji: string; name: string }

export function MentionInput({
  id,
  multiline = false,
  value,
  onValueChange,
  members,
  listLabel,
  emojiListLabel,
  onMentionStart,
  mentionRef,
  insertRef,
  onKeyDown,
  className,
  ...rest
}: MentionInputProps) {
  const listId = useId()
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  /**
   * The « @ » or « : » whose list `Escape` closed, by its place and its character: it stays closed
   * until another one is typed there or elsewhere.
   */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const placeCaret = useRef<number | null>(null)

  const mention = caret === null ? null : mentionAt(value, caret)
  const shortcode = caret === null || mention !== null ? null : shortcodeAt(value, caret)
  const trigger = mention ?? shortcode
  const options: Option[] =
    mention !== null
      ? matchingMembers(members, mention.query).map((member) => ({
          kind: 'member',
          key: member.userId,
          member,
        }))
      : shortcode !== null
        ? matchingEmoji(shortcode.query).map(({ emoji, name }) => ({
            kind: 'emoji',
            key: name,
            emoji,
            name,
          }))
        : []
  const typing = trigger !== null && `${trigger.start}${value[trigger.start]}` !== dismissed
  const open = typing && options.length > 0
  const highlighted = Math.min(active, Math.max(0, options.length - 1))
  const typingMention = typing && mention !== null

  useEffect(() => {
    if (typingMention) onMentionStart?.()
    // Once per opening, not on every member list or callback the caller passes again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingMention, mention?.start])

  useLayoutEffect(() => {
    const at = placeCaret.current
    if (at === null || input.current === null) return
    placeCaret.current = null
    input.current.setSelectionRange(at, at)
  }, [value])

  function follow(element: HTMLInputElement | HTMLTextAreaElement) {
    setCaret(element.selectionStart === element.selectionEnd ? element.selectionStart : null)
  }

  /** Writes the text and puts the caret at `next`, in this very render. */
  function write(text: string, next: number) {
    placeCaret.current = next
    setCaret(next)
    setActive(0)
    onValueChange(text)
  }

  // A field keeps its selection when the focus leaves it, so the caret's place is still there to
  // read once the button has the focus.
  useImperativeHandle(mentionRef, () => () => {
    const at = Math.min(input.current?.selectionEnd ?? value.length, value.length)
    const before = value.slice(0, at)
    const space = before === '' || /\s$/u.test(before) ? '' : ' '
    // The list opens in this very render, not when the browser next reports the selection.
    setDismissed(null)
    input.current?.focus()
    write(`${before}${space}@${value.slice(at)}`, at + space.length + 1)
  })

  useImperativeHandle(insertRef, () => (text: string) => {
    const end = Math.min(input.current?.selectionEnd ?? value.length, value.length)
    const start = Math.min(input.current?.selectionStart ?? end, end)
    const next = insertAtCaret(value, { start, end }, text)
    input.current?.focus()
    write(next.text, next.caret)
  })

  function choose(option: Option) {
    if (trigger === null || caret === null) return
    const next =
      option.kind === 'member'
        ? insertMention(value, trigger, caret, option.member.label)
        : insertEmoji(value, trigger, caret, option.emoji)
    write(next.text, next.caret)
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((highlighted + step + options.length) % options.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(options[highlighted]!)
        return
      }
      if (event.key === 'Escape') {
        // The list closes, and nothing behind it (a thread panel, a dialog) does.
        event.preventDefault()
        event.stopPropagation()
        setDismissed(`${trigger.start}${value[trigger.start]}`)
        return
      }
    }
    onKeyDown?.(event)
  }

  const optionId = (index: number) => `${listId}-${index}`

  const Field = multiline ? 'textarea' : 'input'
  return (
    <div className="relative min-w-0 flex-1">
      <Field
        {...rest}
        ref={(element: HTMLInputElement | HTMLTextAreaElement | null) => {
          input.current = element
        }}
        id={id}
        {...(multiline ? { rows: 3 } : { type: 'text' })}
        role={multiline ? 'textbox' : 'combobox'}
        aria-autocomplete="list"
        aria-expanded={multiline ? undefined : open || rest['aria-expanded'] || false}
        aria-haspopup={multiline ? 'listbox' : undefined}
        aria-controls={open ? listId : rest['aria-controls']}
        {...(open ? { 'aria-activedescendant': optionId(highlighted) } : {})}
        value={value}
        onChange={(event) => {
          const text = event.target.value
          const at = event.target.selectionStart ?? text.length
          // A closed list stays closed while its « @ » or « : » is being typed; it reopens on
          // the next one.
          if (mentionAt(text, at) === null && shortcodeAt(text, at) === null) setDismissed(null)
          // Mid-composition, the input method owns the text: writing it now would double it.
          const composing = (event.nativeEvent as InputEvent).isComposing === true
          const closed =
            composing || (multiline && caretInsideCode(text, at)) ? null : closeShortcode(text, at)
          if (closed !== null) {
            write(closed.text, closed.caret)
            return
          }
          follow(event.target)
          setActive(0)
          onValueChange(text)
        }}
        onSelect={(event) => follow(event.currentTarget)}
        onBlur={() => setCaret(null)}
        onKeyDown={keyDown}
        className={cx('w-full', className)}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={mention !== null ? listLabel : emojiListLabel}
          className="absolute bottom-full left-0 z-50 mb-1 w-full max-w-[320px] overflow-auto rounded-sm border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2"
        >
          {options.map((option, index) => (
            // The keyboard path is on the field (`keyDown`); this is the pointer's way to the
            // same `choose`, and `onMouseDown` keeps focus on the field.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={option.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              data-highlighted={index === highlighted ? '' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              className={cx(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2',
                TOUCH_TARGET_HEIGHT,
                'text-md text-c-ink outline-hidden',
                'data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink',
                'data-[highlighted]:ring-1 data-[highlighted]:ring-c-accent-ink data-[highlighted]:ring-inset'
              )}
            >
              {option.kind === 'member' ? (
                option.member.label
              ) : (
                <>
                  <span className="text-lg">{option.emoji}</span>
                  <span className="font-mono text-sm">:{option.name}:</span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
