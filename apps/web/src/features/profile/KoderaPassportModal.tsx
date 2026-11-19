// The first-run Kodera Passport: offered once to a member whose name is no name they chose (an
// empty one, a raw subject, a QA or e-mail localpart; `isPlaceholderName`). The Kodera monogram
// draws itself in (compositor-only `transform` and `opacity`, nothing under reduced motion), the
// member writes their name, picks a picture and a banner accent and says a word about themselves,
// and the card others will see is drawn beside the form as they type. Saving or « Plus tard » both
// mark it done (`onboarded`), so it is not offered again.

import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog/Dialog'
import { ActionIcon } from '../../ui/icons/ActionIcons'
import { KoderaMark } from '../../ui/icons/KoderaMark'
import { checkAvatarFile } from './avatarImage'
import {
  MAX_BIO,
  MAX_TAG,
  MAX_TAGS,
  PASSPORT_ACCENTS,
  passportOf,
  type Passport,
  type PassportAccent,
} from './passport'
import { ACCENT_BANNER, PassportCard } from './PassportCard'

export interface PassportDraft {
  displayName: string
  /** A new picture, when one was chosen; the current one stays otherwise. */
  avatar: File | null
  passport: Passport
}

export interface KoderaPassportModalProps {
  open: boolean
  userId: string
  /** The name the member has now: offered as the field's start only when it is a real one. */
  initialName: string
  initialPassport: Passport
  /** The member's current picture, a `blob:` address. */
  avatarSrc?: string | undefined
  /** Role pill of the preview (« Membre », « Admin »). */
  roleLabel?: string | undefined
  onSave: (draft: PassportDraft) => Promise<void>
  /** « Plus tard »: the passport is marked seen and not offered again. */
  onDismiss: () => void
}

const MAX_NAME = 80

/** The tags as the member writes them, comma-separated, cut to what a passport keeps. */
function tagsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim().slice(0, MAX_TAG))
        .filter(Boolean)
    ),
  ].slice(0, MAX_TAGS)
}

/** The monogram drawing itself in, stroke by stroke: decoration, hidden from assistive tech. */
export function MonogramReveal({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="passport-monogram"
      className={cx(
        'passport-monogram inline-flex h-[56px] w-[56px] items-center justify-center text-c-accent-ink',
        className
      )}
    >
      <KoderaMark className="h-[56px] w-auto" />
    </span>
  )
}

export function KoderaPassportModal({
  open,
  userId,
  initialName,
  initialPassport,
  avatarSrc,
  roleLabel,
  onSave,
  onDismiss,
}: KoderaPassportModalProps) {
  const { t } = useTranslation()
  const nameId = useId()
  const nameErrorId = useId()
  const bioId = useId()
  const tagsId = useId()
  const avatarId = useId()
  const accentLabelId = useId()
  const [name, setName] = useState(initialName)
  const [bio, setBio] = useState(initialPassport.bio)
  const [tags, setTags] = useState(initialPassport.tags.join(', '))
  const [accent, setAccent] = useState<PassportAccent>(initialPassport.accent)
  const [avatar, setAvatar] = useState<{ file: File; previewUrl: string | undefined } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [problem, setProblem] = useState<'name' | 'avatar' | 'save' | null>(null)
  const [saving, setSaving] = useState(false)
  const chosenUrl = avatar?.previewUrl
  useEffect(() => {
    return () => {
      if (chosenUrl !== undefined) URL.revokeObjectURL(chosenUrl)
    }
  }, [chosenUrl])
  const previewSrc = chosenUrl ?? avatarSrc
  const shownName = name.trim() === '' ? t('console.workspace.passport.preview-name') : name.trim()

  function pick(file: File | undefined) {
    if (file === undefined) return
    if (checkAvatarFile(file) !== null) {
      setProblem('avatar')
      return
    }
    setProblem(null)
    const previewUrl =
      typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined
    setAvatar({ file, previewUrl })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const displayName = name.trim().slice(0, MAX_NAME)
    if (displayName === '') {
      setProblem('name')
      return
    }
    setSaving(true)
    setProblem(null)
    const passport = passportOf({ accent, bio, tags: tagsOf(tags), onboarded: true })
    onSave({ displayName, avatar: avatar?.file ?? null, passport }).then(
      () => setSaving(false),
      () => {
        setSaving(false)
        setProblem('save')
      }
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
      title={t('console.workspace.passport.onboarding-title')}
      description={t('console.workspace.passport.onboarding-description')}
      closeLabel={t('console.workspace.passport.action-later')}
      size="lg"
    >
      <form
        onSubmit={submit}
        className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] narrow:grid-cols-1"
        noValidate
      >
        <div className="flex flex-col gap-4">
          <MonogramReveal />
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-sm font-semibold text-c-ink">
              {t('console.workspace.passport.field-name')}
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={MAX_NAME}
              autoComplete="name"
              aria-invalid={problem === 'name' || undefined}
              aria-describedby={problem === 'name' ? nameErrorId : undefined}
              onChange={(event) => {
                setName(event.target.value)
                if (problem === 'name') setProblem(null)
              }}
              className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-md text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
            {problem === 'name' ? (
              <p id={nameErrorId} className="text-xs text-c-bad-ink">
                {t('console.workspace.passport.error-name')}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-c-ink">
              {t('console.workspace.passport.field-avatar')}
            </span>
            <label
              htmlFor={avatarId}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                pick(event.dataTransfer.files[0])
              }}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-md border border-dashed p-3 text-sm text-c-ink-2',
                'focus-within:ring hover:bg-c-muted',
                dragging ? 'border-c-accent-ink bg-c-accent-soft' : 'border-c-border-strong'
              )}
            >
              <ActionIcon name="upload" />
              <span>{avatar?.file.name ?? t('console.workspace.passport.avatar-drop')}</span>
              <input
                id={avatarId}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(event) => {
                  pick(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </label>
            {problem === 'avatar' ? (
              <p role="alert" className="text-xs text-c-bad-ink">
                {t('console.workspace.passport.error-avatar')}
              </p>
            ) : null}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend id={accentLabelId} className="mb-1 text-sm font-semibold text-c-ink">
              {t('console.workspace.passport.field-accent')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {PASSPORT_ACCENTS.map((candidate, index) => (
                <label
                  key={candidate}
                  className={cx(
                    'relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full',
                    'ring-offset-2 ring-offset-c-elevated focus-within:ring',
                    ACCENT_BANNER[candidate],
                    accent === candidate ? 'ring-2 ring-c-ink' : ''
                  )}
                >
                  <input
                    type="radio"
                    name="passport-accent"
                    value={candidate}
                    checked={accent === candidate}
                    onChange={() => setAccent(candidate)}
                    className="sr-only"
                    aria-label={t('console.workspace.passport.accent-option', {
                      number: index + 1,
                    })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1">
            <label htmlFor={bioId} className="text-sm font-semibold text-c-ink">
              {t('console.workspace.passport.field-bio')}
            </label>
            <textarea
              id={bioId}
              value={bio}
              maxLength={MAX_BIO}
              rows={2}
              onChange={(event) => setBio(event.target.value)}
              className="resize-none rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={tagsId} className="text-sm font-semibold text-c-ink">
              {t('console.workspace.passport.field-tags')}
            </label>
            <input
              id={tagsId}
              value={tags}
              maxLength={(MAX_TAG + 2) * MAX_TAGS}
              onChange={(event) => setTags(event.target.value)}
              className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>
          {problem === 'save' ? (
            <p role="alert" className="text-sm text-c-bad-ink">
              {t('console.workspace.passport.error-save')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="tertiary" onClick={onDismiss} disabled={saving}>
              {t('console.workspace.passport.action-later')}
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {t('console.workspace.passport.action-save')}
            </Button>
          </div>
        </div>
        <section
          aria-label={t('console.workspace.passport.preview-label')}
          className="passport-preview self-start overflow-hidden rounded-xl border border-c-border bg-c-elevated shadow-pop shadow-c-shadow-2"
        >
          <PassportCard
            name={shownName}
            userId={userId}
            avatarSrc={previewSrc}
            accent={accent}
            role={roleLabel}
            tags={tagsOf(tags)}
            bio={bio.trim()}
          />
        </section>
      </form>
    </Dialog>
  )
}
