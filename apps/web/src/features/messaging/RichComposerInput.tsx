import { withdrawn } from '../workspace/ChannelSearch'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MentionInput, type MentionInputProps } from '../espace/MentionInput'
import { communitySupportPath } from '../command-palette/support'
import { composerCopy } from './composerMessages'
import { formatSelection, stagedFiles, type Format } from './formatting'

const TOOL =
  'min-h-10 rounded-sm border border-c-border px-2 text-sm text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:text-c-on-disabled'
function FilePreview({ file }: { file: File }) {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    // No SVG/HTML embeds: only raster images get an in-memory preview URL.
    if (!/^image\/(png|jpeg|gif|webp)$/u.test(file.type)) return
    const objectUrl = URL.createObjectURL(file)
    if (image.current) image.current.src = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  return (
    <>
      {/^image\/(png|jpeg|gif|webp)$/u.test(file.type) ? (
        <img ref={image} alt="" className="h-12 w-12 rounded-sm object-contain" />
      ) : null}
      <span className="min-w-0 break-all">
        {file.name} ({Math.ceil(file.size / 1024)} KB)
      </span>
    </>
  )
}

/** The same live mention field, enhanced without changing how a message is sent. */
export function RichComposerInput({
  onStagingChange,
  scope = 'default',
  onInvite,
  onKeyDown,
  ...props
}: MentionInputProps & {
  onStagingChange: (staged: boolean) => void
  scope?: string
  onInvite?: (() => void) | undefined
}) {
  const surface = useRef<HTMLDivElement>(null)
  const { i18n } = useTranslation()
  const copy = composerCopy(i18n.resolvedLanguage)
  const [staging, setStaging] = useState<{ scope: string; files: File[] }>({ scope, files: [] })
  if (staging.scope !== scope) setStaging({ scope, files: [] })
  const files = staging.scope === scope ? staging.files : []
  const setFiles = (next: File[]) => setStaging({ scope, files: next })
  const [notice, setNotice] = useState('')
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const listId = useId()
  const noticeId = useId()
  const commands = [
    { name: '/code', hint: copy.codeHint, text: '```\n\n```', caret: 4 },
    {
      name: '/poll',
      hint: copy.pollHint,
      text: `${copy.question}\n- ${copy.option} 1\n- ${copy.option} 2`,
    },
    { name: '/shrug', hint: copy.shrug, text: '¯\\_(ツ)_/¯ ' },
    { name: '/topic', hint: copy.topicHint, text: copy.topicDraft },
    { name: '/support', hint: copy.support, text: '' },
    ...(onInvite ? [{ name: '/invite', hint: copy.invite, text: '' }] : []),
  ]
  const query = /^\/[a-z]*$/u.test(props.value) && dismissed !== props.value ? props.value : null
  const choices =
    query === null || props.readOnly
      ? []
      : commands.filter((command) => command.name.startsWith(query))
  const highlighted = Math.min(active, Math.max(0, choices.length - 1))
  function focus(start: number, end = start) {
    requestAnimationFrame(() => {
      const field = document.getElementById(props.id)
      if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
        field.focus()
        field.setSelectionRange(start, end)
      }
    })
  }
  function choose(command: (typeof commands)[number]) {
    if (props.readOnly) return
    setDismissed(null)
    props.onValueChange(command.text)
    focus(command.caret ?? command.text.length)
    if (command.name === '/invite') requestAnimationFrame(() => onInvite?.())
    if (command.name === '/support')
      void communitySupportPath()
        .then((path) => {
          if (!surface.current?.isConnected || withdrawn(surface.current)) return
          if (path) window.location.assign(path)
          else setNotice(copy.unavailable)
        })
        .catch(() => setNotice(copy.unavailable))
  }
  function format(kind: Format) {
    if (props.readOnly) return
    const field = document.getElementById(props.id)
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return
    const next = formatSelection(
      props.value,
      field.selectionStart ?? props.value.length,
      field.selectionEnd ?? props.value.length,
      kind
    )
    props.onValueChange(next.text)
    focus(next.start, next.end)
  }
  function stage(incoming: File[]) {
    if (props.readOnly) return
    const result = stagedFiles(files, incoming)
    setFiles(result.files)
    onStagingChange(result.files.length > 0)
    setNotice(result.rejected ? copy.rejected : '')
  }
  return (
    <div
      ref={surface}
      className="flex min-w-0 flex-1 flex-col gap-2 py-2"
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = props.readOnly ? 'none' : 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        stage(Array.from(event.dataTransfer.files))
      }}
    >
      <div role="toolbar" aria-label={copy.toolbar} className="flex flex-wrap gap-1">
        {(['bold', 'italic', 'code', 'fence'] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            disabled={props.readOnly}
            className={TOOL}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(kind)}
          >
            {copy[kind]}
          </button>
        ))}
        <button
          type="button"
          disabled={props.readOnly}
          className={TOOL}
          onClick={() => picker.current?.click()}
        >
          {copy.attach}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={copy.attach}
          onChange={(event) => {
            stage(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      <MentionInput
        {...props}
        multiline
        aria-describedby={
          [props['aria-describedby'], files.length ? noticeId : ''].filter(Boolean).join(' ') ||
          undefined
        }
        {...(choices.length
          ? {
              'aria-controls': listId,
              'aria-expanded': true,
              'aria-activedescendant': `${listId}-${highlighted}`,
            }
          : {})}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || props.readOnly) return
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ['b', 'i', 'e'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault()
            format(
              ({ b: 'bold', i: 'italic', e: 'code' } as const)[
                event.key.toLowerCase() as 'b' | 'i' | 'e'
              ]
            )
            return
          }
          if (choices.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(
                (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
                  choices.length
              )
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              choose(choices[highlighted]!)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDismissed(props.value)
              return
            }
          }
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault()
            if (!files.length) event.currentTarget.form?.requestSubmit()
            return
          }
          onKeyDown?.(event)
        }}
      />
      {choices.length ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={copy.commands}
          className="flex flex-col gap-1 rounded-md border border-c-border bg-c-elevated p-2"
        >
          {choices.map((command, index) => (
            // Keyboard is handled by the combobox; options retain its focus.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={command.name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(command)}
              className={`cursor-pointer rounded-sm p-2 text-sm ${index === highlighted ? 'bg-c-accent-soft text-c-accent-ink ring-1 ring-c-accent-ink' : 'text-c-ink'}`}
            >
              <span className="font-mono font-semibold">{command.name}</span> — {command.hint}
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <section
          aria-label={copy.files}
          className="flex flex-col gap-2 rounded-md border border-c-border p-2"
        >
          <p id={noticeId} className="text-sm text-c-ink-2">
            {copy.staged}
          </p>
          <ul>
            {files.map((file, index) => (
              <li
                key={`${file.name}:${file.lastModified}`}
                className="flex items-center gap-2 py-1 text-sm text-c-ink"
              >
                <FilePreview file={file} />
                <button
                  type="button"
                  className={TOOL}
                  aria-label={`${copy.remove} ${file.name}`}
                  onClick={() => {
                    const next = files.filter((_, at) => at !== index)
                    setFiles(next)
                    onStagingChange(next.length > 0)
                  }}
                >
                  {copy.remove}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p role="status" className="text-sm text-c-ink-2 empty:sr-only">
        {notice}
      </p>
    </div>
  )
}
