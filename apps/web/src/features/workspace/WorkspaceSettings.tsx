import * as Modal from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { Link } from '@tanstack/react-router'
import { isStubArea } from '../../app/stubAreas'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { CloseIcon } from '../../ui/icons/Close'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { TextField } from '../../ui/TextField/TextField'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { appliedTheme, THEME_PREFERENCES } from '../../theme/theme'
import { useThemePreference } from '../../theme/useThemePreference'
import { ThemeStudioModal } from '../appearance/ThemeStudioModal'
import { THEME_COPY, THEME_PREVIEW } from '../../theme/themeChoices'
import { applyCustomTokensToDocument } from '../appearance/themeOverrides'
import { AudioSettings, type AudioSettingsCall } from '../espace/AudioSettings'
import { readDeviceChoice, saveDeviceChoice } from '../espace/audio/devices'
import { safeDisplayName } from '../espace/liveViewModel'
import { isMatrixUserId } from '../espace/roomInvitations'
import { ExtensionsCatalogPanel } from '../extensions/ExtensionsCatalogPanel'
import { useLocalProfile, type LocalProfile } from '../profile/localProfile'
import { AvatarRefused, AVATAR_TYPES, squareAvatarPng } from '../profile/avatarImage'
import { HostingOfferPanel } from './HostingOfferPanel'
import { ModerationPanel } from './moderation/ModerationPanel'
import { WorkspacePrivacyPanel } from './WorkspacePrivacyPanel'
import { WorkspaceQuotasPanel } from './WorkspaceQuotasPanel'
import { useWorkspaceTenantQuery } from './queries'
import { useActiveThemeShare } from './themeSharing'
import {
  useWorkspaceSettingsRuntime,
  type WorkspaceSettingsProfile,
  type WorkspaceSettingsRuntime,
} from './settingsRuntime'
import { settingsCopy } from './settingsMessages'
import type { WorkspaceSettingsProps } from './WorkspaceSettingsHost'
import type { MessageKey } from '../../i18n'

export type Section =
  | 'profile'
  | 'appearance'
  | 'audio'
  | 'members'
  | 'moderation'
  | 'extensions'
  | 'quotas'
  | 'privacy'
  | 'hosting'
const PERSONAL: Section[] = ['profile', 'appearance', 'audio']
const WORKSPACE: Section[] = ['members', 'moderation', 'extensions', 'quotas', 'privacy', 'hosting']
const LINK =
  'rounded-md border border-c-border px-4 py-3 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'

function useOwnAvatarSrc(profile: WorkspaceSettingsProfile | undefined): {
  src: string | null
  clearSrc: () => void
} {
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  const fetchAvatar = profile?.fetchAvatar
  const avatarKey = profile?.avatarKey
  useEffect(() => {
    if (fetchAvatar === undefined || avatarKey === undefined) return
    let url: string | null = null
    let live = true
    void fetchAvatar(96).then(
      (blob) => {
        if (!live || blob === null) return
        url = URL.createObjectURL(blob)
        setLoaded({ key: avatarKey, url })
      },
      () => undefined
    )
    return () => {
      live = false
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [fetchAvatar, avatarKey])
  const src = avatarKey !== undefined && loaded?.key === avatarKey ? loaded.url : null
  return { src, clearSrc: () => setLoaded(null) }
}

/**
 * The member's own picture controls: replace or remove the avatar drawn in the summary card.
 * A picture chosen here is reduced to a square PNG in this browser before it leaves, and goes
 * to the member's own homeserver — nowhere else.
 */
function AvatarActions({
  profile,
  hasAvatar,
  onClearOptimistic,
  onSaved,
}: {
  profile: WorkspaceSettingsProfile
  hasAvatar: boolean
  onClearOptimistic: () => void
  onSaved: (state: SaveState) => void
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function choose(file: File | undefined) {
    if (file === undefined || busy) return
    setBusy(true)
    onSaved('saving')
    try {
      const square = await squareAvatarPng(file)
      await profile.setAvatar(square, 'avatar.png')
      onSaved('saved')
    } catch (error) {
      onSaved(
        error instanceof AvatarRefused
          ? error.reason === 'size'
            ? 'avatar-size'
            : 'avatar-type'
          : 'problem'
      )
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={AVATAR_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {t(
            !hasAvatar
              ? 'console.workspace.profile.action-choose-avatar'
              : 'console.workspace.profile.action-change-avatar'
          )}
        </Button>
        {!hasAvatar ? null : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (busy) return
              setBusy(true)
              onSaved('saving')
              void profile
                .clearAvatar()
                .then(
                  () => {
                    onClearOptimistic()
                    onSaved('saved')
                  },
                  () => onSaved('problem')
                )
                .finally(() => setBusy(false))
            }}
          >
            {t('console.workspace.profile.action-remove-avatar')}
          </Button>
        )}
      </div>
      <p className="text-xs text-c-ink-3">{t('console.workspace.profile.hint-avatar')}</p>
    </div>
  )
}

type SaveState = 'idle' | 'saving' | 'saved' | 'problem' | 'avatar-type' | 'avatar-size'

const SAVE_MESSAGE: Record<Exclude<SaveState, 'idle'>, MessageKey> = {
  saving: 'console.workspace.profile.state-saving',
  saved: 'console.workspace.profile.state-saved-server',
  problem: 'console.workspace.profile.problem-save',
  'avatar-type': 'console.workspace.profile.problem-avatar-type',
  'avatar-size': 'console.workspace.profile.problem-avatar-size',
}

function Profile({ runtime, name }: { runtime: WorkspaceSettingsRuntime; name: string }) {
  const { t, i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const { profile, updateProfile } = useLocalProfile(runtime.userId)
  // The name to start from: what this browser holds, else what the homeserver holds, else the
  // name the console's own account carries. Never the account's id dressed up as a name.
  const [draftName, setDraftName] = useState(
    profile.displayName || runtime.profile?.matrixDisplayName || runtime.accountName || name
  )
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const [save, setSave] = useState<SaveState>('idle')
  // Whether the member has written in the field themselves. The field is seeded from the closest
  // name at hand — which may be the local part of their email address — and the name saved here
  // is published to every server they share a room with. A seeded value is a suggestion, never
  // something one click can publish on their behalf.
  const [touched, setTouched] = useState(false)
  const displayName =
    profile.displayName || runtime.profile?.matrixDisplayName || runtime.displayName || name
  const serverProfile = runtime.profile
  const { src: avatarSrc, clearSrc } = useOwnAvatarSrc(serverProfile)
  const nameChanged =
    touched && draftName.trim() !== '' && draftName.trim() !== serverProfile?.matrixDisplayName
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-lg border border-c-border bg-c-sunken p-5">
        <div className="flex items-center gap-4">
          <Avatar
            name={displayName}
            identity={runtime.userId}
            size="lg"
            {...(avatarSrc === null ? {} : { src: avatarSrc })}
          />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{displayName}</p>
            <p className="text-sm text-c-ink-2">
              {copy[profile.presence]}
              {profile.status ? ` · ${profile.status}` : ''}
            </p>
          </div>
        </div>
        {serverProfile ? (
          <AvatarActions
            profile={serverProfile}
            hasAvatar={avatarSrc !== null}
            onClearOptimistic={clearSrc}
            onSaved={setSave}
          />
        ) : null}
      </div>
      <TextField
        label={copy.displayName}
        value={draftName}
        maxLength={80}
        onChange={(event) => {
          setTouched(true)
          setDraftName(event.target.value)
          updateProfile({ displayName: event.target.value })
          setSave('idle')
        }}
      />
      {serverProfile ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!nameChanged || save === 'saving'}
            onClick={() => {
              setSave('saving')
              void serverProfile.setDisplayName(draftName).then(
                () => setSave('saved'),
                () => setSave('problem')
              )
            }}
          >
            {t('console.workspace.profile.action-save-name')}
          </Button>
          <p className="mt-2 text-xs text-c-ink-3">
            {t('console.workspace.profile.hint-published')}
          </p>
        </div>
      ) : null}
      <p
        role="status"
        className={
          save === 'problem' || save === 'avatar-type' || save === 'avatar-size'
            ? 'text-sm text-c-bad-ink empty:sr-only'
            : 'text-sm text-c-ink-2 empty:sr-only'
        }
      >
        {save === 'idle' ? '' : t(SAVE_MESSAGE[save])}
      </p>
      <CopyableField
        label={copy.matrixId}
        value={runtime.userId}
        layout="stacked"
        status={copied ? 'copied' : 'idle'}
        copyLabel={copy.copy}
        copiedLabel={copy.copied}
        onCopy={() => {
          if (!navigator.clipboard?.writeText) {
            setError(true)
            return
          }
          void navigator.clipboard.writeText(runtime.userId).then(
            () => {
              setCopied(true)
              setError(false)
            },
            () => setError(true)
          )
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-c-bad-ink">
          {copy.copyError}
        </p>
      ) : null}
      <RadioGroup
        label={copy.presence}
        value={profile.presence}
        options={(['online', 'focused', 'dnd', 'offline'] as const).map((value) => ({
          value,
          label: copy[value],
        }))}
        onValueChange={(value) => updateProfile({ presence: value as LocalProfile['presence'] })}
      />
      <TextField
        label={copy.status}
        value={profile.status}
        maxLength={160}
        onChange={(event) => updateProfile({ status: event.target.value })}
      />
      <p className="text-xs text-c-ink-3">
        {t(
          runtime.profile
            ? 'console.workspace.profile.state-saved-server'
            : 'console.workspace.profile.state-saved-local'
        )}
      </p>
    </div>
  )
}

function Voice({ runtime }: { runtime: WorkspaceSettingsRuntime | undefined }) {
  const meter = useRef<HTMLSpanElement>(null)
  const fallback = useMemo<AudioSettingsCall>(
    () => ({
      getDeviceChoice: readDeviceChoice,
      chooseInput: async (input) => {
        saveDeviceChoice({ ...readDeviceChoice(), input })
      },
      chooseOutput: async (output) => {
        saveDeviceChoice({ ...readDeviceChoice(), output })
      },
    }),
    []
  )
  return (
    <AudioSettings
      embedded
      call={runtime?.call ?? fallback}
      inputMissing={false}
      meterRef={meter}
    />
  )
}

function Members({
  runtime,
  org,
  role,
  onClose,
}: {
  onClose: () => void
  runtime: WorkspaceSettingsRuntime | undefined
  org: string
  role: WorkspaceSettingsProps['role']
}) {
  const { t, i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const unnamed = t('console.workspace.members.unnamed')
  const [inviteId, setInviteId] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<'invited' | 'inviteInvalid' | 'inviteError' | null>(null)
  const canManage = role === 'org_owner' || role === 'org_admin'
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-c-ink-2">{copy.membersHint}</p>
      {runtime ? (
        <ul className="divide-y divide-c-border-soft">
          {runtime.members.map((member) => {
            const memberName = safeDisplayName(member.name, member.userId, unnamed)
            const memberRole = runtime.memberRole(member.userId)
            const external =
              member.userId.split(':').slice(1).join(':') !==
              runtime.userId.split(':').slice(1).join(':')
            const label = external
              ? copy.external
              : memberRole === 'admin'
                ? copy.admin
                : memberRole === 'owner'
                  ? copy.owner
                  : copy.member
            return (
              <li key={member.userId} className="flex items-center gap-3 py-3">
                <Avatar name={memberName} identity={member.userId} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{memberName}</p>
                  <p className="truncate text-xs text-c-ink-3">
                    <bdi dir="ltr">{member.userId}</bdi>
                  </p>
                </div>
                <span className="text-xs text-c-ink-2">{label}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-sm text-c-ink-2">{copy.unavailable}</p>
      )}
      {runtime?.invite ? (
        <form
          className="flex flex-col gap-3 border-t border-c-border-soft pt-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (pending) return
            if (!isMatrixUserId(inviteId.trim())) {
              setResult('inviteInvalid')
              return
            }
            setPending(true)
            setResult(null)
            void runtime
              .invite?.(inviteId.trim())
              .then(
                () => {
                  setResult('invited')
                  setInviteId('')
                },
                () => setResult('inviteError')
              )
              .finally(() => setPending(false))
          }}
        >
          <TextField
            label={copy.inviteId}
            value={inviteId}
            onChange={(event) => setInviteId(event.target.value)}
          />
          <Button type="submit" loading={pending}>
            {copy.invite}
          </Button>
          <p role="status" className="text-sm text-c-ink-2">
            {result ? copy[result] : ''}
          </p>
        </form>
      ) : null}
      {canManage ? (
        <Link to="/$org/people" params={{ org }} onClick={onClose} className={LINK}>
          {copy.manageMembers}
        </Link>
      ) : null}
    </div>
  )
}

export default function WorkspaceSettings({
  org,
  organisationId,
  organisationName,
  displayName,
  role,
  onClose,
  returnFocus,
  initialSection = 'profile',
}: WorkspaceSettingsProps & {
  onClose: () => void
  returnFocus: RefObject<HTMLElement | null>
  initialSection?: Section
}) {
  const narrow = useNarrowViewport()
  const { t, i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const [section, setSection] = useState<Section>(initialSection)
  const themeCardsId = useId()
  const [studio, setStudio] = useState(false)
  const studioTrigger = useRef<HTMLButtonElement>(null)
  const closeStudio = () => {
    setStudio(false)
    requestAnimationFrame(() => {
      studioTrigger.current?.focus()
    })
  }
  const { preference, choose } = useThemePreference()
  const active = useWorkspaceSettingsRuntime()
  const runtime = active?.org === org ? active : undefined
  const tenant = useWorkspaceTenantQuery(organisationId)
  const shareTheme = useActiveThemeShare()
  const canManage = role === 'org_owner' || role === 'org_admin'
  const canBill = canManage || role === 'org_billing'
  // An area whose route renders only the placeholder is not offered: following the link lands on
  // « Cette page n'est pas encore disponible », which reads as something broken.
  const links = [
    { to: '/$org/status', label: copy.statusPage, show: true },
    { to: '/$org/domain', label: copy.domain, show: canManage },
    {
      to: '/$org/federation',
      label: copy.federation,
      show: canManage && !isStubArea('federation'),
    },
    { to: '/$org/security', label: copy.security, show: !isStubArea('security') },
    { to: '/$org/invoices', label: copy.billing, show: canBill },
  ]
  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          if (studio) {
            closeStudio()
            return
          }
          onClose()
        }
      }}
    >
      <Modal.Portal>
        <Modal.Overlay className="fixed inset-0 z-40 bg-c-scrim" />
        <Modal.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = returnFocus.current
            if (target?.isConnected) target.focus()
            else document.querySelector<HTMLElement>('[data-workspace-settings-trigger]')?.focus()
          }}
          className="fixed inset-0 z-40 flex flex-col bg-c-surface text-c-ink outline-hidden"
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-c-border-soft px-6 py-4">
            <div>
              <Modal.Title className="text-lg font-semibold">{copy.title}</Modal.Title>
              <p className="text-sm text-c-ink-3">{organisationName}</p>
            </div>
            {/* Closing is one gesture on a quiet control, not a labelled button competing with the
                panel's own actions: the shortcut is said beside it, and only where there is a
                keyboard to use it. */}
            <div className="flex shrink-0 items-center gap-2">
              <kbd className="rounded-sm border border-c-border-soft bg-c-sunken px-2 py-[2px] font-mono text-xs text-c-ink-3 narrow:hidden">
                {copy.escHint}
              </kbd>
              <Modal.Close
                aria-label={copy.close}
                className={cx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-c-ink-3',
                  TOUCH_TARGET,
                  'hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                  'motion-safe:transition-colors motion-safe:duration-150'
                )}
              >
                <CloseIcon />
              </Modal.Close>
            </div>
          </header>
          <Tabs.Root
            value={section}
            onValueChange={(value) => setSection(value as Section)}
            orientation={narrow ? 'horizontal' : 'vertical'}
            className="flex min-h-0 flex-1 narrow:flex-col"
          >
            <Tabs.List
              aria-label={copy.title}
              className="flex w-shell-sidebar-width shrink-0 flex-col gap-1 overflow-y-auto border-r border-c-border-soft bg-c-sunken p-4 narrow:w-full narrow:flex-row narrow:overflow-x-auto narrow:border-r-0 narrow:border-b"
            >
              {[
                { title: copy.personal, items: PERSONAL },
                { title: copy.workspace, items: WORKSPACE },
              ].map((group) => (
                <div
                  key={group.title}
                  className="mb-4 flex flex-col gap-1 narrow:mb-0 narrow:shrink-0 narrow:flex-row"
                >
                  <p className="px-3 py-2 text-xs font-semibold text-c-ink-3 narrow:hidden">
                    {group.title}
                  </p>
                  {group.items.map((item) => (
                    <Tabs.Trigger
                      key={item}
                      value={item}
                      className="rounded-md px-3 py-3 text-left text-sm font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden data-[state=active]:bg-c-accent-soft data-[state=active]:text-c-accent-ink narrow:shrink-0 narrow:whitespace-nowrap"
                    >
                      {copy[item]}
                    </Tabs.Trigger>
                  ))}
                </div>
              ))}
            </Tabs.List>
            <div className="min-w-0 flex-1 overflow-y-auto p-8 narrow:p-4">
              {[...PERSONAL, ...WORKSPACE].map((item) => (
                <Tabs.Content
                  key={item}
                  value={item}
                  // A panel is read, not operated: Radix makes it focusable so the keyboard can
                  // reach its content, and a ring around the whole section says « you are here »
                  // about something nothing can be done with. The ring stays on the controls.
                  className="mx-auto flex max-w-shell-document-max-width flex-col gap-6 outline-hidden"
                >
                  <h2 className="text-xl font-semibold">{copy[item]}</h2>
                  {item === 'profile' ? (
                    <>
                      <p className="text-sm text-c-ink-2">{copy.profileHint}</p>
                      {runtime ? (
                        <Profile runtime={runtime} name={displayName} />
                      ) : (
                        <p>{copy.unavailable}</p>
                      )}
                      <p className="text-xs text-c-ink-3">
                        {copy.roleHint}:{' '}
                        {role === 'org_owner'
                          ? copy.owner
                          : role === 'org_admin'
                            ? copy.admin
                            : role === 'org_billing'
                              ? copy.billing
                              : copy.member}
                      </p>
                    </>
                  ) : null}
                  {item === 'appearance' ? (
                    <>
                      <p className="text-sm text-c-ink-2">{copy.appearanceHint}</p>
                      <div
                        className="grid grid-cols-3 gap-4 narrow:grid-cols-1"
                        role="group"
                        aria-label={copy.appearance}
                      >
                        {/* Every theme the console has, « Automatique » and the two frosted-glass
                            ones included: offering three of six left the default theme with no
                            card, so its own member read « aucun thème choisi ». The chosen one is
                            said by its edge and by `aria-pressed`, not by a glyph inside its
                            name. */}
                        {THEME_PREFERENCES.map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            aria-pressed={preference === mode}
                            onClick={() => {
                              applyCustomTokensToDocument(null)
                              choose(mode)
                            }}
                            // Named by its theme and described by its hint, as the appearance
                            // screen does: without this the two run together into one word.
                            aria-labelledby={`${themeCardsId}-${mode}-label`}
                            aria-describedby={`${themeCardsId}-${mode}-hint`}
                            className="flex flex-col gap-3 rounded-lg border border-c-border p-4 text-left focus-visible:ring focus-visible:outline-hidden aria-pressed:border-c-accent-ink aria-pressed:ring-1 aria-pressed:ring-c-accent-ink motion-safe:transition-colors motion-safe:duration-150"
                          >
                            <span
                              data-theme={THEME_PREVIEW[mode][0]}
                              aria-hidden="true"
                              className="flex h-12 overflow-hidden rounded-md border border-c-border bg-c-page"
                            >
                              <span className="w-8 bg-c-inverse" />
                              {/* The panel level of the active theme's material: flat in the
                                  Givre family, frosted in the Ciel one, so the card shows what
                                  the theme actually draws. */}
                              <span className="material-panel w-12" />
                              <span className="flex flex-1 flex-col justify-center gap-2 p-3">
                                <span className="h-2 w-full rounded-full bg-c-muted" />
                                <span className="h-2 w-1/2 rounded-full bg-c-action" />
                              </span>
                            </span>
                            <span
                              id={`${themeCardsId}-${mode}-label`}
                              className="text-sm font-semibold"
                            >
                              {t(THEME_COPY[mode].label)}
                            </span>
                            <span
                              id={`${themeCardsId}-${mode}-hint`}
                              className="text-xs text-c-ink-3"
                            >
                              {t(THEME_COPY[mode].hint)}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div>
                        <Button
                          ref={studioTrigger}
                          variant="secondary"
                          onClick={() => setStudio(true)}
                        >
                          {copy.studio}
                        </Button>
                      </div>
                    </>
                  ) : null}
                  {item === 'audio' ? (
                    <>
                      <p className="text-sm text-c-ink-2">{copy.audioHint}</p>
                      <Voice runtime={runtime} />
                    </>
                  ) : null}
                  {item === 'members' ? (
                    <Members runtime={runtime} org={org} role={role} onClose={onClose} />
                  ) : null}
                  {item === 'moderation' ? (
                    canManage ? (
                      <ModerationPanel organisationId={organisationId} />
                    ) : (
                      <p className="text-sm text-c-ink-2">{copy.moderationRestricted}</p>
                    )
                  ) : null}
                  {item === 'extensions' ? <ExtensionsCatalogPanel /> : null}
                  {item === 'quotas' ? (
                    <WorkspaceQuotasPanel
                      org={org}
                      organisationId={organisationId}
                      role={role}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {item === 'privacy' ? (
                    <WorkspacePrivacyPanel org={org} organisationId={organisationId} role={role} />
                  ) : null}
                  {item === 'hosting' ? (
                    <>
                      <HostingOfferPanel
                        initiallyExpanded
                        organisation={organisationName}
                        mode={tenant.data?.hostingMode ?? tenant.data?.hosting_mode}
                      />
                      <section className="flex flex-col gap-3 rounded-lg border border-c-border p-5">
                        <h3 className="font-semibold">{copy.selfHosted}</h3>
                        <p className="text-sm text-c-ink-2">{copy.selfHostedHint}</p>
                        <a
                          className={LINK}
                          href="https://github.com/kodera-hq/kodera/tree/main/deploy/community"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {copy.selfHostedLink}
                        </a>
                      </section>
                      <h3 className="font-semibold">{copy.console}</h3>
                      <div className="flex flex-wrap gap-3">
                        {links
                          .filter((link) => link.show)
                          .map((link) => (
                            <Link
                              key={link.to}
                              to={link.to}
                              params={{ org }}
                              onClick={onClose}
                              className={LINK}
                            >
                              {link.label}
                            </Link>
                          ))}
                      </div>
                    </>
                  ) : null}
                </Tabs.Content>
              ))}
            </div>
          </Tabs.Root>
          <ThemeStudioModal
            open={studio}
            currentThemeMode={appliedTheme(preference)}
            onSelectCoreTheme={choose}
            onShareToChannel={shareTheme}
            returnFocusTo={studioTrigger}
            onClose={closeStudio}
          />
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root>
  )
}
