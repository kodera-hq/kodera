import { isMac, withdrawn } from '../workspace/ChannelSearch'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { ActionIcon, type ActionIconName } from '../../ui/icons/ActionIcons'
import { CloseIcon } from '../../ui/icons/Close'
import { Popover } from '../../ui/Popover/Popover'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { MentionInput, type MentionInputProps } from '../espace/MentionInput'
import { communitySupportPath } from '../command-palette/support'
import { composerCopy } from './composerMessages'
import { formatSelection, insertLink, safeLinkHref, stagedFiles, type Format } from './formatting'
import type { AttachmentQueue, QueuedFile } from './attachments/attachmentQueue'

const NO_QUEUE: readonly QueuedFile[] = []
const noSubscription = () => () => {}

/** An icon-only toolbar button: the name is its `aria-label` and its tooltip, never a word. */
export function IconTool({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  shortcut,
  tone = 'quiet',
}: {
  icon: ActionIconName | ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean | undefined
  pressed?: boolean
  shortcut?: string | undefined
  tone?: 'quiet' | 'danger'
}) {
  return (
    <Tooltip content={label} names>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        {...(shortcut === undefined ? {} : { 'aria-keyshortcuts': shortcut })}
        // The selection stays in the field while a tool is pressed.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={cx(ICON_TOOL, tone === 'danger' ? 'text-c-bad-ink' : 'text-c-ink-3')}
      >
        {typeof icon === 'string' ? <ActionIcon name={icon as ActionIconName} /> : icon}
      </button>
    </Tooltip>
  )
}

const ICON_TOOL = cx(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm',
  'hover:bg-c-sunken hover:text-c-ink aria-pressed:bg-c-accent-soft aria-pressed:text-c-accent-ink',
  'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
  'focus-visible:ring focus-visible:outline-hidden',
  TOUCH_TARGET
)

/** The files a live composer is sending, each with where it stands, and a retry when one failed. */
function UploadTray({
  files,
  onRemove,
  onRetry,
  hintId,
}: {
  files: readonly QueuedFile[]
  onRemove: (key: string) => void
  onRetry: (key: string) => void
  hintId: string
}) {
  const { t, i18n } = useTranslation()
  const copy = composerCopy(i18n.resolvedLanguage)
  return (
    <section
      aria-label={copy.uploads}
      className="flex flex-col gap-2 rounded-md border border-c-border p-2"
    >
      <p id={hintId} className="text-sm text-c-ink-2">
        {copy.uploadsHint}
      </p>
      <ul>
        {files.map((file) => (
          <li key={file.key} className="flex items-center gap-2 py-1 text-sm text-c-ink">
            <span className="min-w-0 flex-1 break-all">
              {file.filename} ({Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB)
            </span>
            <span
              className={
                file.status === 'refused' || file.status === 'failed'
                  ? 'text-c-bad-ink'
                  : 'text-c-ink-2'
              }
            >
              {file.status === 'uploading'
                ? copy.uploading
                : file.status === 'ready'
                  ? copy.uploaded
                  : file.status === 'failed'
                    ? t('console.workspace.composer.upload-failed')
                    : copy.refused[file.reason]}
            </span>
            {file.status === 'failed' ? (
              <IconTool
                icon="retry"
                label={t('console.workspace.composer.upload-retry', { name: file.filename })}
                onClick={() => onRetry(file.key)}
              />
            ) : null}
            <IconTool
              icon={<CloseIcon />}
              label={t('console.workspace.composer.upload-remove', { name: file.filename })}
              onClick={() => onRemove(file.key)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The formatting tools, in the order the toolbar draws them, with their shortcut keys. */
const FORMATS: readonly { format: Format; icon: ActionIconName; key?: string; shift?: true }[] = [
  { format: 'bold', icon: 'bold', key: 'b' },
  { format: 'italic', icon: 'italic', key: 'i' },
  { format: 'strike', icon: 'strike', key: 'x', shift: true },
  { format: 'code', icon: 'code', key: 'e' },
  { format: 'fence', icon: 'code-block', key: 'c', shift: true },
  { format: 'bullet', icon: 'bullet-list', key: '8', shift: true },
  { format: 'quote', icon: 'quote', key: '9', shift: true },
]

const FORMAT_LABEL = {
  bold: 'console.workspace.composer.format-bold',
  italic: 'console.workspace.composer.format-italic',
  strike: 'console.workspace.composer.format-strike',
  code: 'console.workspace.composer.format-code',
  fence: 'console.workspace.composer.format-code-block',
  bullet: 'console.workspace.composer.format-bullet',
  quote: 'console.workspace.composer.format-quote',
} as const satisfies Record<Format, string>

/** `Cmd+K`'s form: the words and the address of a link written over the selection. */
function LinkForm({
  initialText,
  onInsert,
}: {
  initialText: string
  onInsert: (label: string, href: string) => void
}) {
  const { t } = useTranslation()
  const textId = useId()
  const urlId = useId()
  const errorId = useId()
  const [label, setLabel] = useState(initialText)
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    const href = safeLinkHref(url)
    if (href === null) {
      setInvalid(true)
      return
    }
    onInsert(label, href)
  }
  const field =
    'h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden'
  return (
    <form onSubmit={submit} className="flex w-[256px] flex-col gap-2">
      <label htmlFor={textId} className="text-xs font-semibold text-c-ink-2">
        {t('console.workspace.composer.link-text')}
      </label>
      <input
        id={textId}
        value={label}
        maxLength={200}
        onChange={(event) => setLabel(event.target.value)}
        className={field}
      />
      <label htmlFor={urlId} className="text-xs font-semibold text-c-ink-2">
        {t('console.workspace.composer.link-url')}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={urlId}
          // Focus lands on the address: the words are usually the selection already.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          inputMode="url"
          value={url}
          maxLength={2048}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          placeholder="https://"
          onChange={(event) => {
            setUrl(event.target.value)
            setInvalid(false)
          }}
          className={cx(field, 'min-w-0 flex-1')}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<ActionIcon name="link" />}
          iconOnly
          aria-label={t('console.workspace.composer.link-insert')}
        />
      </div>
      {invalid ? (
        <p id={errorId} className="text-xs text-c-bad-ink">
          {t('console.workspace.composer.link-invalid')}
        </p>
      ) : null}
    </form>
  )
}

function FilePreview({ file }: { file: File }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    // Decode into pixels, never an HTML or URL sink. Unsupported/invalid images retain the filename.
    if (!/^image\/(png|jpeg|gif|webp)$/u.test(file.type) || typeof createImageBitmap !== 'function')
      return
    let retired = false
    void createImageBitmap(file, { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'low' })
      .then((bitmap) => {
        try {
          const target = canvas.current
          if (retired || !target) return
          const scale = Math.min(1, 256 / bitmap.width, 256 / bitmap.height)
          target.width = Math.max(1, Math.round(bitmap.width * scale))
          target.height = Math.max(1, Math.round(bitmap.height * scale))
          target.getContext('2d')?.drawImage(bitmap, 0, 0, target.width, target.height)
        } finally {
          bitmap.close()
        }
      })
      .catch(() => {
        /* The filename and removal action remain available when decoding fails. */
      })
    return () => {
      retired = true
    }
  }, [file])
  return (
    <>
      {/^image\/(png|jpeg|gif|webp)$/u.test(file.type) ? (
        <canvas ref={canvas} aria-hidden="true" className="h-12 w-12 rounded-sm object-contain" />
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
  uploads,
  trailing,
  ...props
}: MentionInputProps & {
  onStagingChange: (staged: boolean) => void
  scope?: string
  onInvite?: (() => void) | undefined
  /** A live workspace's uploads: dropped, pasted and chosen files are sent, not only shown. */
  uploads?: AttachmentQueue | null
  /** The caller's own icons at the end of the bottom bar: mention, emoji, send. */
  trailing?: ReactNode
}) {
  const surface = useRef<HTMLDivElement>(null)
  const { t, i18n } = useTranslation()
  const mac = isMac()
  const [linking, setLinking] = useState<{ start: number; end: number; text: string } | null>(null)
  const copy = composerCopy(i18n.resolvedLanguage)
  const [staging, setStaging] = useState<{ scope: string; files: File[] }>({ scope, files: [] })
  if (staging.scope !== scope) setStaging({ scope, files: [] })
  const files = staging.scope === scope ? staging.files : []
  const queued = useSyncExternalStore(
    uploads?.subscribe ?? noSubscription,
    () => uploads?.files(scope) ?? NO_QUEUE
  )
  const uploadHintId = useId()
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
  const pendingSelection = useRef<{
    value: string
    scope: string
    start: number
    end: number
  } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingSelection.current
    if (!pending) return
    pendingSelection.current = null
    if (pending.scope !== scope || pending.value !== props.value) return
    const field = document.getElementById(props.id)
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      field.focus()
      field.setSelectionRange(pending.start, pending.end)
    }
  }, [props.id, props.value, scope])
  function selectAfterCommit(value: string, start: number, end = start) {
    pendingSelection.current = { value, scope, start, end }
  }

  function choose(command: (typeof commands)[number]) {
    if (props.readOnly) return
    setDismissed(null)
    selectAfterCommit(command.text, command.caret ?? command.text.length)
    props.onValueChange(command.text)
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
    selectAfterCommit(next.text, next.start, next.end)
    props.onValueChange(next.text)
  }
  function selection(): { start: number; end: number } {
    const field = document.getElementById(props.id)
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement))
      return { start: props.value.length, end: props.value.length }
    return {
      start: field.selectionStart ?? props.value.length,
      end: field.selectionEnd ?? props.value.length,
    }
  }
  function openLink() {
    if (props.readOnly) return
    const { start, end } = selection()
    setLinking({ start, end, text: props.value.slice(start, end) })
  }
  function writeLink(label: string, href: string) {
    if (linking === null) return
    const next = insertLink(props.value, linking.start, linking.end, label, href)
    setLinking(null)
    selectAfterCommit(next.text, next.start, next.end)
    props.onValueChange(next.text)
  }
  function startCommand() {
    if (props.readOnly) return
    setDismissed(null)
    // A command is the whole message: « / » starts an empty composer, and is offered again on top
    // of a draft only once it is cleared.
    if (props.value === '' || props.value === '/') {
      selectAfterCommit('/', 1)
      props.onValueChange('/')
      return
    }
    selectAfterCommit(props.value, props.value.length)
    props.onValueChange(props.value)
  }
  function stage(incoming: File[]) {
    if (props.readOnly || incoming.length === 0) return
    if (uploads) {
      void uploads.add(scope, incoming)
      return
    }
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
      <div role="toolbar" aria-label={copy.toolbar} className="flex flex-wrap items-center gap-px">
        {FORMATS.map(({ format: kind, icon, key, shift }) => (
          <IconTool
            key={kind}
            icon={icon}
            label={t(FORMAT_LABEL[kind])}
            disabled={props.readOnly}
            shortcut={
              key === undefined
                ? undefined
                : `${mac ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key.toUpperCase()}`
            }
            onClick={() => format(kind)}
          />
        ))}
        <Popover
          open={linking !== null}
          onOpenChange={(open) => (open ? openLink() : setLinking(null))}
          label={t('console.workspace.composer.link-title')}
          side="top"
          align="start"
          trigger={
            <button
              type="button"
              aria-label={t('console.workspace.composer.format-link')}
              aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
              disabled={props.readOnly}
              onMouseDown={(event) => event.preventDefault()}
              title={t('console.workspace.composer.format-link')}
              className={cx(ICON_TOOL, 'text-c-ink-3')}
            >
              <ActionIcon name="link" />
            </button>
          }
        >
          {linking === null ? null : <LinkForm initialText={linking.text} onInsert={writeLink} />}
        </Popover>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={t('console.workspace.composer.action-attach')}
          onChange={(event) => {
            stage(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      <MentionInput
        {...props}
        multiline
        onPaste={(event) => {
          // A pasted screenshot or file is attached; pasted text stays the field's own.
          const pasted = Array.from(event.clipboardData.files)
          if (pasted.length === 0) return
          event.preventDefault()
          stage(pasted)
        }}
        aria-describedby={
          [
            props['aria-describedby'],
            files.length ? noticeId : '',
            queued.length ? uploadHintId : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined
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
          if ((event.metaKey || event.ctrlKey) && !event.altKey) {
            const key = event.key.toLowerCase()
            // `Cmd+K` writes a link over a selection; with none, it stays the workspace search.
            if (key === 'k' && !event.shiftKey) {
              const { start, end } = selection()
              if (start !== end) {
                event.preventDefault()
                openLink()
                return
              }
            }
            const tool = FORMATS.find(
              (candidate) => candidate.key === key && Boolean(candidate.shift) === event.shiftKey
            )
            if (tool !== undefined) {
              event.preventDefault()
              format(tool.format)
              return
            }
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
      <div className="flex items-center gap-px">
        <IconTool
          icon="plus"
          label={t('console.workspace.composer.action-attach')}
          disabled={props.readOnly}
          onClick={() => picker.current?.click()}
        />
        <IconTool
          icon="slash"
          label={t('console.workspace.composer.action-command')}
          disabled={props.readOnly}
          onClick={startCommand}
        />
        {trailing === undefined ? null : (
          <div className="ml-auto flex items-center gap-1">{trailing}</div>
        )}
      </div>
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
      {queued.length ? (
        <UploadTray
          files={queued}
          hintId={uploadHintId}
          onRemove={(key) => uploads?.remove(scope, key)}
          onRetry={(key) => void uploads?.retry(scope, key)}
        />
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
                <IconTool
                  icon={<CloseIcon />}
                  label={t('console.workspace.composer.upload-remove', { name: file.name })}
                  onClick={() => {
                    const next = files.filter((_, at) => at !== index)
                    setFiles(next)
                    onStagingChange(next.length > 0)
                  }}
                />
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
