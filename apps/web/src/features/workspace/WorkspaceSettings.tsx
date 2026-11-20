import { LanguageSwitch } from '../appearance/LanguageSwitch'
import * as Modal from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { Link } from '@tanstack/react-router'
import { isStubArea } from '../../app/stubAreas'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
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
import { isMatrixUserId } from '../espace/roomInvitations'
import { ExtensionsCatalogPanel } from '../extensions/ExtensionsCatalogPanel'
import { useLocalProfile, type LocalProfile } from '../profile/localProfile'
import { AvatarRefused, AVATAR_TYPES, squareAvatarPng } from '../profile/avatarImage'
import { HostingOfferPanel } from './HostingOfferPanel'
import { ModerationPanel } from './moderation/ModerationPanel'
import { WorkspacePrivacyPanel } from './WorkspacePrivacyPanel'
import { WorkspaceQuotasPanel } from './WorkspaceQuotasPanel'
import { useWorkspaceQuery, useWorkspaceTenantQuery } from './queries'
import { useActiveThemeShare } from './themeSharing'
import {
  useWorkspaceSettingsRuntime,
  type WorkspaceSettingsProfile,
  type WorkspaceSettingsRuntime,
} from './settingsRuntime'
import { settingsCopy } from './settingsMessages'
import type { WorkspaceSettingsProps } from './WorkspaceSettingsHost'
import type { MessageKey } from '../../i18n'
import { adminCopy } from './admin/adminMessages'
import { BackIcon } from './admin/AdminIcons'
import { AuditLogPanel } from './admin/AuditLogPanel'
import { ChannelOverridesPanel } from './admin/ChannelOverridesPanel'
import { CommunityPanel } from './admin/CommunityPanel'
import { InvitesPanel } from './admin/InvitesPanel'
import { NotificationsSection, SecuritySection, ShortcutsSection } from './admin/PersonalPanels'
import {
  ADMIN_GROUPS,
  ADMIN_SECTIONS,
  delegatedSections,
  modeOf,
  PERSONAL_SECTIONS,
  type AdminSection,
  type Section,
  type SettingsMode,
} from './admin/sections'
import { useDelegation } from './admin/useIam'
import { WorkspaceMembersPanel } from './admin/WorkspaceMembersPanel'
import { WorkspaceProfilePanel } from './admin/WorkspaceProfilePanel'
import { WorkspaceRolesPanel, type RoleAuthority } from './admin/WorkspaceRolesPanel'

const LazySoundsScreen = lazy(() =>
  import('../sounds/SoundsScreen').then((module) => ({ default: module.SoundsScreen }))
)

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
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  async function choose(file: File | undefined) {
    if (file === undefined || busy) return
    setBusy(true)
    onSaved('saving')
    try {
      const square = await squareAvatarPng(file)
      if (!live.current) return
      await profile.setAvatar(square, 'avatar.png')
      if (live.current) onSaved('saved')
    } catch (error) {
      if (!live.current) return
      onSaved(
        error instanceof AvatarRefused
          ? error.reason === 'size'
            ? 'avatar-size'
            : 'avatar-type'
          : 'problem'
      )
    } finally {
      if (live.current) setBusy(false)
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
                    if (!live.current) return
                    onClearOptimistic()
                    onSaved('saved')
                  },
                  () => {
                    if (live.current) onSaved('problem')
                  }
                )
                .finally(() => {
                  if (live.current) setBusy(false)
                })
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

/** Invite someone into the conversation that is open behind the settings, by Matrix ID. */
function ConversationInvite({ runtime }: { runtime: WorkspaceSettingsRuntime | undefined }) {
  const { i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const [inviteId, setInviteId] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<'invited' | 'inviteInvalid' | 'inviteError' | null>(null)
  const invite = runtime?.invite
  if (invite === undefined) return null
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-c-border p-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        if (!isMatrixUserId(inviteId.trim())) {
          setResult('inviteInvalid')
          return
        }
        setPending(true)
        setResult(null)
        void invite(inviteId.trim())
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
      <h3 className="font-semibold">{copy.invite}</h3>
      <TextField
        label={copy.inviteId}
        value={inviteId}
        onChange={(event) => setInviteId(event.target.value)}
      />
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {copy.invite}
        </Button>
      </div>
      <p role="status" className="text-sm text-c-ink-2">
        {result ? copy[result] : ''}
      </p>
    </form>
  )
}

function Appearance({
  onOpenStudio,
  studioTrigger,
}: {
  onOpenStudio: () => void
  studioTrigger: RefObject<HTMLButtonElement | null>
}) {
  const { t, i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const themeCardsId = useId()
  const { preference, choose } = useThemePreference()
  return (
    <>
      <LanguageSwitch />
      <p className="text-sm text-c-ink-2">{copy.appearanceHint}</p>
      <div
        className="grid grid-cols-3 gap-4 narrow:grid-cols-1"
        role="group"
        aria-label={copy.appearance}
      >
        {/* Every theme the console has, « Automatique » and the two frosted-glass ones included.
            The chosen one is said by its edge and by `aria-pressed`, not by a glyph inside its
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
              <span className="material-panel w-12" />
              <span className="flex flex-1 flex-col justify-center gap-2 p-3">
                <span className="h-2 w-full rounded-full bg-c-muted" />
                <span className="h-2 w-1/2 rounded-full bg-c-action" />
              </span>
            </span>
            <span id={`${themeCardsId}-${mode}-label`} className="text-sm font-semibold">
              {t(THEME_COPY[mode].label)}
            </span>
            <span id={`${themeCardsId}-${mode}-hint`} className="text-xs text-c-ink-3">
              {t(THEME_COPY[mode].hint)}
            </span>
          </button>
        ))}
      </div>
      <div>
        <Button ref={studioTrigger} variant="secondary" onClick={onOpenStudio}>
          {copy.studio}
        </Button>
      </div>
    </>
  )
}

const TAB =
  'rounded-md px-3 py-3 text-left text-sm font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden data-[state=active]:bg-c-accent-soft data-[state=active]:text-c-accent-ink narrow:shrink-0 narrow:whitespace-nowrap'
const HEADER_ICON = cx(
  'flex h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-full text-c-ink-3',
  TOUCH_TARGET,
  'hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
  'motion-safe:transition-colors motion-safe:duration-150'
)

export default function WorkspaceSettings({
  org,
  organisationId,
  personId,
  membershipId,
  organisationName,
  displayName,
  role,
  onClose,
  returnFocus,
  initialSection = 'profile',
  mode: initialMode,
}: WorkspaceSettingsProps & {
  onClose: () => void
  returnFocus: RefObject<HTMLElement | null>
  initialSection?: Section
  mode?: SettingsMode
}) {
  const narrow = useNarrowViewport()
  const { i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const admin = adminCopy(i18n.resolvedLanguage)
  const [mode, setMode] = useState<SettingsMode>(initialMode ?? modeOf(initialSection))
  const [section, setSection] = useState<Section>(
    initialMode === undefined || modeOf(initialSection) === initialMode
      ? initialSection
      : initialMode === 'admin'
        ? 'overview'
        : 'profile'
  )
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
  const workspaceSummary = useWorkspaceQuery(organisationId)
  const shareTheme = useActiveThemeShare()
  const canManage = role === 'org_owner' || role === 'org_admin'
  const canBill = canManage || role === 'org_billing'
  // Part of the administration is held through assigned workspace roles: a member's delegated
  // sections, and an administrator's role ceiling. Only an owner needs no read to know it.
  const delegation = useDelegation(organisationId, membershipId, role !== 'org_owner')
  const adminSections: readonly AdminSection[] = canManage
    ? ADMIN_SECTIONS
    : delegatedSections(delegation)
  const canAdminister = adminSections.length > 0
  const authority: RoleAuthority = {
    owner: role === 'org_owner',
    admin: canManage,
    ceiling: delegation.ceiling,
    held: delegation.held,
  }
  const links = [
    { to: '/$org/status', label: copy.statusPage, show: true },
    { to: '/$org/domain', label: copy.domain, show: canManage },
    {
      to: '/$org/federation',
      label: copy.federation,
      show: canManage && !isStubArea('federation'),
    },
    { to: '/$org/invoices', label: copy.billing, show: canBill },
  ]
  const switchMode = (next: SettingsMode) => {
    setMode(next)
    setSection(next === 'admin' ? (adminSections[0] ?? 'overview') : 'profile')
  }
  const groups =
    mode === 'personal'
      ? [
          {
            key: 'personal',
            title: admin.groups.personal,
            items: PERSONAL_SECTIONS as readonly Section[],
          },
        ]
      : ADMIN_GROUPS.map((group) => ({
          key: group.key,
          title: admin.groups[group.key],
          items: group.items.filter((item) => adminSections.includes(item)) as readonly Section[],
        })).filter((group) => group.items.length > 0)
  const visible = groups.flatMap((group) => group.items)
  const title = mode === 'personal' ? admin.titlePersonal : admin.titleAdmin
  const restricted = <p className="text-sm text-c-ink-2">{admin.sectionRestricted}</p>

  function body(item: Section) {
    switch (item) {
      case 'profile':
        return (
          <>
            <p className="text-sm text-c-ink-2">{copy.profileHint}</p>
            {runtime ? <Profile runtime={runtime} name={displayName} /> : <p>{copy.unavailable}</p>}
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
        )
      case 'security':
        return <SecuritySection org={org} onNavigate={onClose} />
      case 'appearance':
        return <Appearance onOpenStudio={() => setStudio(true)} studioTrigger={studioTrigger} />
      case 'audio':
        return (
          <>
            <p className="text-sm text-c-ink-2">{copy.audioHint}</p>
            <Voice runtime={runtime} />
            <Suspense fallback={null}>
              <LazySoundsScreen embedded />
            </Suspense>
          </>
        )
      case 'notifications':
        return <NotificationsSection onOpenAudio={() => setSection('audio')} />
      case 'privacy':
        return (
          <WorkspacePrivacyPanel
            org={org}
            organisationId={organisationId}
            personId={personId}
            role={role}
          />
        )
      case 'shortcuts':
        return <ShortcutsSection />
      case 'overview':
        return (
          <WorkspaceProfilePanel
            organisationId={organisationId}
            organisationName={organisationName}
            canEdit={canManage}
          />
        )
      case 'members':
        return (
          <>
            <WorkspaceMembersPanel
              organisationId={organisationId}
              callerRole={role}
              callerMembershipId={membershipId}
              authority={authority}
            />
            <ConversationInvite runtime={runtime} />
          </>
        )
      case 'roles':
        return <WorkspaceRolesPanel organisationId={organisationId} authority={authority} />
      case 'channels':
        return <ChannelOverridesPanel organisationId={organisationId} authority={authority} />
      case 'invites':
        return canManage ? (
          <InvitesPanel organisationId={organisationId} authority={authority} />
        ) : (
          restricted
        )
      case 'extensions':
        return <ExtensionsCatalogPanel channels={runtime?.channels} />
      case 'moderation':
        return canManage ? <ModerationPanel organisationId={organisationId} /> : restricted
      case 'audit':
        return <AuditLogPanel organisationId={organisationId} />
      case 'community':
        return <CommunityPanel organisationId={organisationId} canEdit={canManage} />
      case 'quotas':
        return (
          <WorkspaceQuotasPanel
            org={org}
            organisationId={organisationId}
            role={role}
            onNavigate={onClose}
          />
        )
      case 'hosting':
        return (
          <>
            <HostingOfferPanel
              initiallyExpanded
              workspace={
                workspaceSummary.data?.workspace
                  ? {
                      channels: [
                        ...workspaceSummary.data.workspace.categories.flatMap(
                          (category) => category.channels
                        ),
                        ...workspaceSummary.data.workspace.uncategorised_channels,
                      ],
                    }
                  : undefined
              }
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
        )
    }
  }

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
          data-settings-mode={mode}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = returnFocus.current
            if (target?.isConnected) target.focus()
            else document.querySelector<HTMLElement>('[data-workspace-settings-trigger]')?.focus()
          }}
          className="material-dialog fixed inset-0 z-40 flex flex-col text-c-ink outline-hidden"
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-c-border-soft px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* Leaving the settings is one gesture, top left, where a « back » is looked for:
                  the conversation, its call and its drafts were never unmounted behind it. */}
              <button
                title={admin.backHint}
                type="button"
                onClick={onClose}
                className={cx(HEADER_ICON, 'px-3')}
              >
                <BackIcon />
                <span className="text-sm font-medium narrow:sr-only">{admin.back}</span>
              </button>
              <div className="min-w-0">
                <Modal.Title className="truncate text-lg font-semibold">{title}</Modal.Title>
                <p className="truncate text-sm text-c-ink-3">{organisationName}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {mode === 'personal' && canAdminister ? (
                <button
                  type="button"
                  className={cx(LINK, 'py-2 narrow:hidden')}
                  onClick={() => switchMode('admin')}
                >
                  {admin.switchToAdmin}
                </button>
              ) : null}
              {mode === 'admin' ? (
                <button
                  type="button"
                  className={cx(LINK, 'py-2 narrow:hidden')}
                  onClick={() => switchMode('personal')}
                >
                  {admin.switchToPersonal}
                </button>
              ) : null}
              <kbd className="rounded-sm border border-c-border-soft bg-c-sunken px-2 py-[2px] font-mono text-xs text-c-ink-3 narrow:hidden">
                {admin.escHint}
              </kbd>
              <Modal.Close aria-label={copy.close} className={HEADER_ICON}>
                <CloseIcon />
              </Modal.Close>
            </div>
          </header>
          {mode === 'admin' && !canAdminister ? (
            <div className="mx-auto flex max-w-shell-document-max-width flex-col gap-4 p-8">
              <p className="text-sm text-c-ink-2">{admin.adminRestricted}</p>
            </div>
          ) : (
            <Tabs.Root
              value={visible.includes(section) ? section : (visible[0] ?? section)}
              onValueChange={(value) => setSection(value as Section)}
              orientation={narrow ? 'horizontal' : 'vertical'}
              className="flex min-h-0 flex-1 narrow:flex-col"
            >
              <div className="material-panel flex w-shell-sidebar-width shrink-0 flex-col overflow-y-auto border-r border-c-border-soft p-4 narrow:w-full narrow:flex-row narrow:items-center narrow:gap-1 narrow:overflow-x-auto narrow:border-r-0 narrow:border-b">
                <Tabs.List
                  aria-label={title}
                  className="flex flex-col gap-1 narrow:shrink-0 narrow:flex-row"
                >
                  {groups.map((group) => (
                    <div
                      key={group.key}
                      role="presentation"
                      className="mb-4 flex flex-col gap-1 narrow:mb-0 narrow:shrink-0 narrow:flex-row"
                    >
                      <p
                        aria-hidden="true"
                        className="px-3 py-2 text-xs font-semibold text-c-ink-3 narrow:hidden"
                      >
                        {group.title}
                      </p>
                      {group.items.map((item) => (
                        <Tabs.Trigger key={item} value={item} className={TAB}>
                          {admin.sections[item]}
                        </Tabs.Trigger>
                      ))}
                    </div>
                  ))}
                </Tabs.List>
                {narrow && (mode === 'admin' || canAdminister) ? (
                  <button
                    type="button"
                    className={cx(TAB, 'shrink-0 border border-c-border')}
                    onClick={() => switchMode(mode === 'admin' ? 'personal' : 'admin')}
                  >
                    {mode === 'admin' ? admin.switchToPersonal : admin.switchToAdmin}
                  </button>
                ) : null}
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto p-8 narrow:p-4">
                {visible.map((item) => (
                  <Tabs.Content
                    key={item}
                    value={item}
                    // A panel is read, not operated: the ring stays on the controls.
                    className="mx-auto flex max-w-shell-document-max-width flex-col gap-6 outline-hidden"
                  >
                    <h2 className="text-xl font-semibold">{admin.sections[item]}</h2>
                    {body(item)}
                  </Tabs.Content>
                ))}
              </div>
            </Tabs.Root>
          )}
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
