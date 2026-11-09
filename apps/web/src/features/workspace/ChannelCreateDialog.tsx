import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import type { WorkspaceCategory } from './workspace'
import { channelCreationMessages } from './channelCreationMessages'

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
  readonly onCreate: (name: string, kind: 'text' | 'audio') => void
}) {
  const { i18n } = useTranslation()
  const copy = channelCreationMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const nameId = useId()
  const kindId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'audio'>('text')
  const [invalid, setInvalid] = useState(false)
  const submit = () => {
    const trimmed = name.trim()
    if (
      !trimmed ||
      trimmed.length > 80 ||
      [...trimmed].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      existingNames.some((entry) => entry.toLocaleLowerCase() === trimmed.toLocaleLowerCase())
    ) {
      setInvalid(true)
      return
    }
    onCreate(trimmed, kind)
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
          className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink focus-visible:ring"
        />
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
        {invalid ? (
          <p role="alert" className="text-sm text-c-bad-ink">
            {copy.invalid}
          </p>
        ) : null}
        <p className="text-xs text-c-ink-3">{copy.local}</p>
      </form>
    </Dialog>
  )
}
