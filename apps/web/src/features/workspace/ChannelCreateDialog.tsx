import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import type { WorkspaceCategory } from './workspace'
import { channelCreationMessages } from './channelCreationMessages'

export interface ChannelCreateOptions {
  topic: string
  access: 'members' | 'invite'
}

export function channelSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
    .replace(/-$/u, '')
}

export function ChannelCreateDialog({
  open,
  category,
  existingNames,
  onClose,
  onCreate,
}: {
  readonly open: boolean
  readonly category: WorkspaceCategory
  readonly existingNames: readonly string[]
  readonly onClose: () => void
  readonly onCreate: (name: string, kind: 'text' | 'audio', options: ChannelCreateOptions) => void
}) {
  const { i18n } = useTranslation()
  const copy = channelCreationMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const nameId = useId()
  const kindId = useId()
  const errorId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'audio'>('text')
  const [topic, setTopic] = useState('')
  const [access, setAccess] = useState<'members' | 'invite'>('members')
  const [invalid, setInvalid] = useState(false)
  const submit = () => {
    const trimmed = channelSlug(name)
    if (
      !trimmed ||
      trimmed.length > 80 ||
      [...trimmed].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      existingNames.some((entry) => channelSlug(entry) === trimmed)
    ) {
      setInvalid(true)
      return
    }
    onCreate(trimmed, kind, { topic: topic.trim(), access })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={`${copy.title} · ${category.name}`}
      closeLabel={copy.cancel}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {copy.cancel}
          </Button>
          <Button onClick={submit}>{copy.create}</Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label htmlFor={nameId} className="text-sm font-medium text-c-ink">
          {copy.name}
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setInvalid(false)
          }}
          maxLength={80}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink focus-visible:ring"
        />
        {channelSlug(name) ? <p className="text-xs text-c-ink-3">#{channelSlug(name)}</p> : null}
        <label htmlFor={kindId} className="text-sm font-medium text-c-ink">
          {copy.kind}
        </label>
        <select
          id={kindId}
          value={kind}
          onChange={(event) => setKind(event.target.value === 'audio' ? 'audio' : 'text')}
          className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink"
        >
          <option value="text"># {copy.text}</option>
          <option value="audio">{copy.audio}</option>
        </select>
        <label className="flex flex-col gap-2 text-sm font-medium text-c-ink">
          {copy.topic}
          <textarea
            value={topic}
            maxLength={500}
            onChange={(event) => setTopic(event.target.value)}
            className="rounded-md border border-c-border-input bg-c-surface p-3 text-c-ink focus-visible:ring"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium text-c-ink">
          {copy.access}
          <select
            value={access}
            onChange={(event) => setAccess(event.target.value === 'invite' ? 'invite' : 'members')}
            className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink"
          >
            <option value="members">{copy.members}</option>
            <option value="invite">{copy.invite}</option>
          </select>
        </label>
        {access === 'invite' ? <p className="text-xs text-c-ink-3">{copy.invitePreview}</p> : null}
        {invalid ? (
          <p id={errorId} role="alert" className="text-sm text-c-bad-ink">
            {copy.invalid}
          </p>
        ) : null}
        <p className="text-xs text-c-ink-3">{copy.local}</p>
      </form>
    </Dialog>
  )
}
