import * as Modal from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { Link } from '@tanstack/react-router'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { TextField } from '../../ui/TextField/TextField'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { useThemePreference } from '../../theme/useThemePreference'
import { ThemeStudioModal } from '../appearance/ThemeStudioModal'
import { applyCustomTokensToDocument } from '../appearance/themeOverrides'
import { AudioSettings, type AudioSettingsCall } from '../espace/AudioSettings'
import { readDeviceChoice, saveDeviceChoice } from '../espace/audio/devices'
import { isMatrixUserId } from '../espace/roomInvitations'
import { ExtensionsCatalogPanel } from '../extensions/ExtensionsCatalogPanel'
import { useLocalProfile, type LocalProfile } from '../profile/localProfile'
import { HostingOfferPanel } from './HostingOfferPanel'
import { useWorkspaceTenantQuery } from './queries'
import { useActiveThemeShare } from './themeSharing'
import { useWorkspaceSettingsRuntime, type WorkspaceSettingsRuntime } from './settingsRuntime'
import { settingsCopy } from './settingsMessages'
import type { WorkspaceSettingsProps } from './WorkspaceSettingsHost'

export type Section = 'profile' | 'appearance' | 'audio' | 'members' | 'extensions' | 'hosting'
const PERSONAL: Section[] = ['profile', 'appearance', 'audio']
const WORKSPACE: Section[] = ['members', 'extensions', 'hosting']
const LINK =
  'rounded-md border border-c-border px-4 py-3 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'

function Profile({ runtime, name }: { runtime: WorkspaceSettingsRuntime; name: string }) {
  const { i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const { profile, updateProfile } = useLocalProfile(runtime.userId)
  const [draftName, setDraftName] = useState(profile.displayName || runtime.displayName || name)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const displayName = profile.displayName || runtime.displayName || name
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4 rounded-lg border border-c-border bg-c-sunken p-5">
        <Avatar name={displayName} />
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{displayName}</p>
          <p className="text-sm text-c-ink-2">
            {copy[profile.presence]}
            {profile.status ? ` · ${profile.status}` : ''}
          </p>
        </div>
      </div>
      <TextField
        label={copy.displayName}
        value={draftName}
        maxLength={80}
        onChange={(event) => {
          setDraftName(event.target.value)
          updateProfile({ displayName: event.target.value })
        }}
      />
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
      <p className="text-xs text-c-ink-3">{copy.local}</p>
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
  const { i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
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
                <Avatar name={member.name ?? member.userId} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{member.name ?? member.userId}</p>
                  <p className="truncate text-xs text-c-ink-3">{member.userId}</p>
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
  const { i18n } = useTranslation()
  const copy = settingsCopy(i18n.resolvedLanguage)
  const [section, setSection] = useState<Section>(initialSection)
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
  const links = [
    { to: '/$org/status', label: copy.statusPage, show: true },
    { to: '/$org/domain', label: copy.domain, show: canManage },
    { to: '/$org/federation', label: copy.federation, show: canManage },
    { to: '/$org/security', label: copy.security, show: true },
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
            <Modal.Close asChild>
              <Button variant="secondary">{copy.close}</Button>
            </Modal.Close>
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
                  className="mx-auto flex max-w-shell-document-max-width flex-col gap-6 outline-hidden focus-visible:ring"
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
                        {(['light', 'dark', 'black'] as const).map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            aria-pressed={preference === mode}
                            onClick={() => {
                              applyCustomTokensToDocument(null)
                              choose(mode)
                            }}
                            className="flex flex-col gap-3 rounded-lg border border-c-border p-4 text-left focus-visible:ring focus-visible:outline-hidden aria-pressed:border-c-accent-ink aria-pressed:ring-1 aria-pressed:ring-c-accent-ink"
                          >
                            <span
                              data-theme={mode}
                              aria-hidden="true"
                              className="flex h-12 overflow-hidden rounded-md border border-c-border bg-c-surface"
                            >
                              <span className="w-8 bg-c-inverse" />
                              <span className="w-12 bg-c-sunken" />
                              <span className="flex flex-1 flex-col justify-center gap-2 p-3">
                                <span className="h-2 w-full rounded-full bg-c-muted" />
                                <span className="h-2 w-1/2 rounded-full bg-c-action" />
                              </span>
                            </span>
                            <span className="text-sm font-semibold">
                              {copy[mode]} {preference === mode ? '✓' : ''}
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
                  {item === 'extensions' ? <ExtensionsCatalogPanel /> : null}
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
            currentThemeMode={preference === 'system' ? 'light' : preference}
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
