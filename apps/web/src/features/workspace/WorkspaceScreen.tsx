import { readLocalWorkspaceView } from './localWorkspaceView'
import { COMMUNITY_CATEGORIES } from '../docs/communityStructure'
import { developerDocsCopy } from '../docs/developerDocsMessages'
import { DeveloperDocsHub } from '../docs/DeveloperDocsHub'
import { WORKSPACE_COMMAND_EVENT, type WorkspaceCommand } from './WorkspaceMenu'
import { workspaceMenuCopy } from './workspaceMenuMessages'
import { registerThemeShare, useActiveThemeShare } from './themeSharing'
import { ThemeStudioModal } from '../appearance/ThemeStudioModal'
import { ChannelCreateDialog } from './ChannelCreateDialog'
import {
  ChannelDocsEditor,
  createChannelDocsWorkspace,
  type ChannelDocsWorkspace,
  type ChannelDoc,
} from '../docs/ChannelDocsEditor'
import type { WorkspaceCategory, WorkspaceChannel } from './workspace'
import { appliedTheme, themeMode } from '../../theme/theme'
import { useThemePreference } from '../../theme/useThemePreference'
import { ExtensionsCatalogPanel } from '../extensions/ExtensionsCatalogPanel'
import { Dialog } from '../../ui/Dialog/Dialog'
import type { DocsWorkspaceView } from '../docs/DocsWorkspacePanel'
import { useQueryClient } from '@tanstack/react-query'
import { FirstRunOnboardingModal } from '../onboarding/FirstRunOnboardingModal'
import { HostingOfferPanel } from './HostingOfferPanel'
import { onboardingCopy } from '../onboarding/onboardingMessages'
// `/{org}/workspace` and `/{org}/workspace/{channelId}` (docs/specs/11-workspace.md): the
// organisation's workspace — its own surface beside the console, reached from the rail's
// « Messages » — once it exists, and, before it does, the setup state Core reports.
//
// Once it exists, the organisation's tenant says whether its homeserver does (quick-workspace
// SPEC W2): while the tenant is prepared, the channels are drawn greyed under « Votre espace se
// prépare » and nothing starts a Matrix sign-in; a stopped tenant is the failed state. The
// homeserver and the session are the tenant's, found from its slug, never the organisation's.
//
// The screen is the `workspace` route's own component and its two children draw nothing, so it
// stays mounted from one channel to the next: a collapsed category stays collapsed and the read is
// not repeated.

import { useParams, useRouter } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkspacePageRecord } from '../docs/WorkspaceCollaborativeDocs'
import {
  createDemoWorkspaceStore,
  isDemoActive,
  addCreatedDemoWorkspace,
  writeDemoView,
} from '../../app/interactiveDemo'
import type { EspaceStoreLike } from '../espace/EspaceLiveView'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import type { MatrixSession } from '../../auth/matrix'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { Drawer } from '../../ui/Drawer/Drawer'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { DocsWorkspacePanel } from '../docs/DocsWorkspacePanel'
import { EspaceLiveView } from '../espace/EspaceLiveView'
import { ChannelSidebar } from './ChannelSidebar'
import {
  espaceOffered,
  espaceSessionFor,
  OpenEspaceButton,
  OpenEspaceProblem,
  useAutoOpenEspace,
  useOpenEspace,
} from './OpenEspace'
import { useWorkspaceQuery, useWorkspaceTenantQuery } from './queries'
import { useChannelNavigation } from './useChannelNavigation'
import {
  ConfirmingOwnerState,
  FailedState,
  NotCreatedState,
  PreparingState,
  ReadyToCreateState,
} from './SetupState'
import {
  channelLabel,
  currentChannel,
  tenantPhase,
  welcomeChannel,
  withEveryRoomPending,
  workspaceView,
} from './workspace'
import type { Workspace, WorkspaceView } from './workspace'

/** What the screen's live region says for each state: its title. */
const STATE_TITLE: Record<WorkspaceView['kind'], MessageKey> = {
  preparing: 'console.workspace.setup.title-preparing',
  'confirming-owner': 'console.workspace.setup.title-confirming-owner',
  failed: 'console.workspace.setup.title-failed',
  'ready-to-create': 'console.workspace.setup.title-ready',
  'not-created': 'console.workspace.setup.title-not-created',
  workspace: 'console.workspace._.title',
}

function LoadingState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 gap-6 px-6 py-5 narrow:p-0">
      <div className="flex w-shell-sidebar-width flex-col gap-3 narrow:hidden">
        <Skeleton shape="block" label={t('console.common.a11y-loading')} />
        <Skeleton shape="text" />
        <Skeleton shape="text" />
      </div>
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton shape="block" />
      </div>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center narrow:px-0">
      <h1 className="text-lg font-semibold text-c-ink">{t('console.workspace._.title')}</h1>
      <InlineAlert kind="error" className="max-w-[420px] text-left">
        {t('console.common.error-unavailable')}
      </InlineAlert>
      <Button variant="secondary" onClick={onRetry}>
        {t('console.common.action-retry')}
      </Button>
    </section>
  )
}

interface ReadyWorkspaceProps {
  org: string
  organisationName: string
  workspace: Workspace
  channelId: string | undefined
  /** The tenant's slug, from which its homeserver is found; none without a tenant. */
  serverSlug: string | undefined
  /** The tenant's homeserver is still being prepared: nothing can be opened yet. */
  preparing: boolean
  actions: ReactNode
}

/**
 * The workspace's own layout: the channel column on the left, the conversation beside it. The
 * conversation comes first in the document, so its `h1` precedes the column's `h2`; the column is
 * moved to the left visually (`order-first`). Room is kept for what arrives later: a contextual
 * side panel (thread, members) to the right of the conversation, and the audio dock at the foot
 * of the channel column.
 */
function ReadyWorkspace({
  org,
  organisationName,
  workspace,
  channelId,
  serverSlug,
  preparing,
  actions,
}: ReadyWorkspaceProps) {
  const { t } = useTranslation()
  // Without a Matrix session, the layout only, and the way into the live workspace where this
  // deployment names a matrix domain and the tenant's homeserver exists.
  // `''` is no tenant slug and resolves nothing; `open` is reached only when `offered` holds.
  const espace = useOpenEspace(serverSlug ?? '')
  const offered = espaceOffered() && serverSlug !== undefined && !preparing
  // A first sign-in from the workspace's own address lands in #welcome, once its room exists.
  const welcome = channelId === undefined ? welcomeChannel(workspace) : undefined
  const returnTo =
    welcome === undefined
      ? undefined
      : `/${encodeURIComponent(org)}/workspace/${encodeURIComponent(welcome.id)}`
  // The automatic start counts as opening from the first draw: no invitation to open the messages
  // is drawn on a page that is about to leave for them.
  const opening = useAutoOpenEspace(espace, offered, returnTo) || espace.opening
  const narrow = useNarrowViewport()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  // Where the drawer sends focus as it closes: its trigger (Radix's own behaviour, while this is
  // empty), or the channel's heading when a channel was chosen. The heading is the element
  // `RouteFocus` focuses after the navigation, so the two agree instead of competing.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const channel = currentChannel(workspace, channelId)
  const currentId = channel?.id

  function openDrawer(open: boolean) {
    if (open) returnFocusTo.current = null
    setDrawerOpen(open)
  }

  function chooseInDrawer() {
    returnFocusTo.current = heading.current
    setDrawerOpen(false)
  }

  const sidebar = (variant: 'column' | 'drawer') => (
    <ChannelSidebar
      org={org}
      organisationName={organisationName}
      workspace={preparing ? withEveryRoomPending(workspace) : workspace}
      currentId={currentId}
      variant={variant}
      actionSlot={actions}
      {...(variant === 'drawer' ? { onNavigate: chooseInDrawer } : {})}
    />
  )

  const drawer = narrow ? (
    <Drawer
      open={drawerOpen}
      onOpenChange={openDrawer}
      side="bottom"
      title={t('console.workspace.sidebar.title')}
      closeLabel={t('console.common.action-close')}
      returnFocusTo={returnFocusTo}
      trigger={
        <Button variant="secondary" size="sm" className="shrink-0">
          {t('console.workspace.sidebar.title')}
        </Button>
      }
    >
      <div className="max-h-full overflow-y-auto pt-2 pb-4">{sidebar('drawer')}</div>
    </Drawer>
  ) : null

  return (
    <div className="flex min-h-0 flex-1 narrow:flex-col">
      <section className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-c-surface px-6 py-5 narrow:overflow-visible narrow:bg-transparent narrow:p-0">
        <header className="flex items-center gap-3 border-b border-c-border-soft pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {channel === null || channel === undefined ? (
              <h1
                ref={heading}
                tabIndex={-1}
                data-route-heading=""
                className="text-lg font-semibold text-c-ink"
              >
                {t(
                  channel === null
                    ? 'console.workspace.channel.title-not-found'
                    : 'console.workspace._.title'
                )}
              </h1>
            ) : (
              <h1
                ref={heading}
                tabIndex={-1}
                data-route-heading=""
                className="flex min-w-0 items-center gap-2 text-lg font-semibold text-c-ink"
              >
                <span aria-hidden="true" className="text-c-ink-3">
                  #
                </span>
                <span className="min-w-0 truncate">{channelLabel(channel, t)}</span>
              </h1>
            )}
            {channel !== null && channel !== undefined && channel.topic !== '' ? (
              <p className="text-sm text-c-ink-3">{channel.topic}</p>
            ) : null}
          </div>
          {drawer}
        </header>
        {preparing ? (
          // The screen's live region already says the state's title; this is its detail.
          <InlineAlert kind="info" inLiveRegion>
            {t('console.workspace.setup.banner-preparing')}
          </InlineAlert>
        ) : null}
        {offered ? <OpenEspaceProblem entry={espace} /> : null}
        {preparing || (channel === null && !offered) ? null : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12">
            <p className="max-w-[320px] text-center text-sm text-c-ink-3">
              {t(
                !offered
                  ? 'console.workspace.channel.body-empty'
                  : opening
                    ? 'console.workspace.channel.body-opening'
                    : 'console.workspace.channel.body-open'
              )}
            </p>
            {offered ? <OpenEspaceButton entry={espace} size="md" opening={opening} /> : null}
          </div>
        )}
      </section>
      {narrow ? null : sidebar('column')}
    </div>
  )
}

const LazyWorkspaceCollaborativeDocs = lazy(() => import('../docs/WorkspaceCollaborativeDocs'))

const demoWorkspaceViews = new WeakMap<
  EspaceStoreLike,
  { channels: Record<string, WorkspaceChannel[]>; docs: ChannelDocsWorkspace }
>()

interface LiveWorkspaceProps {
  organisationId: string
  org: string
  organisationName: string
  workspace: Workspace
  channelId: string | undefined
  session?: MatrixSession
  store?: EspaceStoreLike
  actions: ReactNode
  /** The tenant's slug: « Se reconnecter » signs in to its homeserver again. */
  serverSlug: string
}

/**
 * The live workspace, wired to the address and to the sign-in: a channel chosen in it becomes the
 * address (the channel route draws nothing, so the screen stays mounted), and « Se reconnecter »
 * runs the same sign-in as « Ouvrir les messages ».
 */
function LiveWorkspace({
  organisationId,
  org,
  organisationName,
  workspace,
  channelId,
  session,
  store,
  actions,
  serverSlug,
}: LiveWorkspaceProps) {
  const { t, i18n } = useTranslation()
  const communityCopy = developerDocsCopy(i18n.resolvedLanguage)
  const [localChannels, setLocalChannels] = useState<Record<string, WorkspaceChannel[]>>(() =>
    store
      ? (demoWorkspaceViews.get(store)?.channels ??
        readLocalWorkspaceView(`${org}:${workspace.id}`).channels)
      : {}
  )
  const [createCategory, setCreateCategory] = useState<WorkspaceCategory | null>(null)
  const [docsWorkspace, setDocsWorkspace] = useState(() =>
    store
      ? (demoWorkspaceViews.get(store)?.docs ??
        readLocalWorkspaceView(`${org}:${workspace.id}`, store.getInitialDocuments?.()).docs)
      : createChannelDocsWorkspace()
  )
  useEffect(() => {
    if (store) {
      const value = { channels: localChannels, docs: docsWorkspace }
      demoWorkspaceViews.set(store, value)
      if (isDemoActive(org)) writeDemoView(`${org}:${workspace.id}`, value)
    }
  }, [store, org, workspace.id, localChannels, docsWorkspace])
  const liveWorkspace = {
    ...workspace,
    categories: workspace.categories.map((category) => ({
      ...category,
      channels: [...category.channels, ...(localChannels[category.id] ?? [])],
    })),
  }
  const categoryDescriptions =
    isDemoActive(org) && org === 'community'
      ? Object.fromEntries(
          workspace.categories.map((category) => {
            const definition = COMMUNITY_CATEGORIES.find((item) => item.name === category.name)
            return [category.id, definition ? communityCopy[definition.audience] : '']
          })
        )
      : undefined
  const userId = session?.userId ?? store?.getUserId() ?? ''
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [canvas, setCanvas] = useState<'chat' | 'docs'>('chat')
  const [docsView, setDocsView] = useState<DocsWorkspaceView>('team')
  const [workspacePages, setWorkspacePages] = useState<readonly WorkspacePageRecord[]>([])
  const [activeWorkspacePageId, setActiveWorkspacePageId] = useState<string | undefined>(undefined)
  const channel = channelId
    ? liveWorkspace.categories
        .flatMap((category) => category.channels)
        .concat(liveWorkspace.uncategorised_channels)
        .find((entry) => entry.id === channelId)
    : currentChannel(liveWorkspace, channelId)
  const navigation = useChannelNavigation(org)
  const espace = useOpenEspace(serverSlug)
  useEffect(() => {
    const command = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === 'developer') {
        setDocsView('developer')
        setCanvas('docs')
      }
    }
    window.addEventListener(WORKSPACE_COMMAND_EVENT, command)
    return () => window.removeEventListener(WORKSPACE_COMMAND_EVENT, command)
  }, [])
  useEffect(() => {
    if (!channel || channel.kind !== 'text' || !store) return
    const room = store.getSnapshot().channels.get(channel.id)
    if (room?.state !== 'resolved') return
    return registerThemeShare(async (name, code) => {
      await store.send(room.roomId, `${name}\n${code}`)
    })
  }, [channel, store])

  return (
    <>
      {espace.problem === undefined ? null : (
        <div className="px-6 pt-4 narrow:px-0">
          <OpenEspaceProblem entry={espace} />
        </div>
      )}
      <EspaceLiveView
        categoryDescriptions={categoryDescriptions}
        org={org}
        organisationName={organisationName}
        workspace={liveWorkspace}
        channelId={channelId}
        {...(session ? { session } : {})}
        {...(store ? { store } : {})}
        focusedDocs={canvas === 'docs' && (docsView === 'developer' || docsView === 'pages')}
        documents={[
          ...docsWorkspace.docs,
          ...workspacePages.map(
            (page): ChannelDoc => ({
              id: `workspace-page:${page.id}`,
              channelId: channel?.id ?? '',
              title: page.title,
              content: page.markdown,
              parentId: page.parentId,
              role: page.role,
            })
          ),
        ]}
        onOpenDocument={(doc: ChannelDoc) => {
          if (doc.id.startsWith('workspace-page:')) {
            setActiveWorkspacePageId(doc.id.slice('workspace-page:'.length))
            setDocsView('pages')
            setCanvas('docs')
            return
          }
          setDocsWorkspace((prev) => ({
            ...prev,
            selectedByChannel: { ...prev.selectedByChannel, [doc.channelId]: doc.id },
          }))
          setDocsView('team')
          setCanvas('docs')
          if (doc.channelId !== channel?.id) void navigation.onNavigateChannel(doc.channelId)
        }}
        activeCanvasMode={canvas}
        onChangeCanvasMode={setCanvas}
        organisationActionSlot={actions}
        {...(store?.addChannel ? { onCreateInCategory: setCreateCategory } : {})}
        docsCanvasSlot={
          channel ? (
            <DocsWorkspacePanel
              key={channel.id}
              workspacePagesSlot={
                <Suspense
                  fallback={
                    <p className="p-4 text-sm text-c-ink-2">
                      {t('console.docs.collab.editor-loading')}
                    </p>
                  }
                >
                  <LazyWorkspaceCollaborativeDocs
                    {...(store ? { localDocuments: workspacePages, onLocalDocumentsChange: setWorkspacePages } : { organisationId })}
                    currentUser={{
                      id: userId || 'member',
                      name: userId || 'Member',
                    }}
                    activeDocumentId={activeWorkspacePageId}
                    onActiveDocumentChange={setActiveWorkspacePageId}
                    onDocumentsLoaded={setWorkspacePages}
                  />
                </Suspense>
              }
              teamPadsSlot={
                store ? (
                  <ChannelDocsEditor
                    channelId={channel.id}
                    channelName={channel.name}
                    workspace={docsWorkspace}
                    onWorkspaceChange={setDocsWorkspace}
                    onNavigateDocument={(targetDoc) => {
                      setDocsView('team')
                      setCanvas('docs')
                      if (targetDoc.channelId !== channel.id) {
                        void navigation.onNavigateChannel(targetDoc.channelId)
                      }
                    }}
                    author={{
                      userId,
                      name:
                        store
                          .getSnapshot()
                          .rooms.flatMap((room) => room.names?.[userId] ?? [])[0] ?? userId,
                    }}
                    members={(() => {
                      const room = store.getSnapshot().channels.get(channel.id)
                      return room?.state === 'resolved'
                        ? (store.getMembers?.(room.roomId) ?? [])
                        : []
                    })()}
                    onPublish={async (title, content, documentId) => {
                      const room = store.getSnapshot().channels.get(channel.id)
                      if (room?.state !== 'resolved')
                        throw new Error('The channel is not available')
                      if (store.publishDocument)
                        await store.publishDocument(room.roomId, {
                          id: documentId,
                          channelId: channel.id,
                          title,
                          content,
                        })
                      else await store.send(room.roomId, `## ${title}\n\n${content}`)
                    }}
                  />
                ) : undefined
              }
              view={docsView}
              onViewChange={setDocsView}
              onOpenSupportChannel={(selected) => {
                setCanvas('chat')
                if (org === 'community') {
                  const target = liveWorkspace.categories
                    .flatMap((category) => category.channels)
                    .find((entry) => entry.name === selected)
                  if (target) void navigation.onNavigateChannel(target.id)
                } else {
                  window.open(
                    'https://community.kodera.io/community/workspace',
                    '_blank',
                    'noopener,noreferrer'
                  )
                }
              }}
              tenantSlug={serverSlug}
              channelId={channel.id}
              channelName={channel.name}
              draftContent={drafts[`${userId}:${org}:${serverSlug}:${channel.id}`]}
              onDraftContentChange={(content) =>
                setDrafts((prev) => {
                  const key = `${userId}:${org}:${serverSlug}:${channel.id}`
                  const next = { ...prev, [key]: content }
                  if (Object.keys(next).length > 128) {
                    const oldest = Object.keys(next)[0]
                    if (oldest) delete next[oldest]
                  }
                  return next
                })
              }
            />
          ) : null
        }
        {...navigation}
        {...(store ? {} : { onReconnect: () => void espace.open() })}
      />
      {createCategory ? (
        <ChannelCreateDialog
          open
          category={createCategory}
          existingNames={liveWorkspace.categories.flatMap((category) =>
            category.channels.map((item) => item.name)
          )}
          onClose={() => setCreateCategory(null)}
          onCreate={(name, kind, options) => {
            const created: WorkspaceChannel & { access: 'members' | 'invite' } = {
              id: `local-${crypto.randomUUID()}`,
              name,
              kind,
              topic: options.topic,
              access: options.access,
              template_key: null,
              lifecycle: 'active',
              room_state: 'ready',
            }
            store?.addChannel?.(created)
            setLocalChannels((previous) => ({
              ...previous,
              [createCategory.id]: [...(previous[createCategory.id] ?? []), created],
            }))
            setCreateCategory(null)
            setCanvas('chat')
            void navigation.onNavigateChannel(created.id)
          }}
        />
      ) : null}
    </>
  )
}

/** Demo store instances retain their local work while switching workspaces. */
function DemoWorkspace(props: Omit<LiveWorkspaceProps, 'session' | 'store'>) {
  const [store] = useState(() => createDemoWorkspaceStore(props.org, props.workspace))
  if (!store) return null
  return <LiveWorkspace {...props} store={store} />
}

/** The tenant's Matrix session, with the slug it belongs to; none while its homeserver is being
 * prepared, and none without a tenant. */
function liveEntry(serverSlug: string | undefined, preparing: boolean) {
  if (serverSlug === undefined || preparing) return undefined
  const session = espaceSessionFor(serverSlug)
  return session === undefined ? undefined : { serverSlug, session }
}

export function WorkspaceScreen() {
  const shareTheme = useActiveThemeShare()
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [hostingOpen, setHostingOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [developerDocsOpen, setDeveloperDocsOpen] = useState(false)
  const router = useRouter()
  const { preference, choose } = useThemePreference()
  const queryClient = useQueryClient()
  const { t, i18n } = useTranslation()
  const { membership } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const params = useParams({ strict: false }) as { channelId?: string }
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const menuCopy = workspaceMenuCopy(i18n.resolvedLanguage)
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.slug === org) {
        void queryClient.invalidateQueries({ queryKey: ['workspace', membership.organisation.id] })
        void queryClient.invalidateQueries({
          queryKey: ['workspace-tenant', membership.organisation.id],
        })
      }
    }
    window.addEventListener('kodera:workspace-claimed', refresh)
    return () => window.removeEventListener('kodera:workspace-claimed', refresh)
  }, [org, membership.organisation.id, queryClient])
  const organisationId = membership.organisation.id
  const organisationName = membership.organisation.name
  const query = useWorkspaceQuery(organisationId)
  const tenantQuery = useWorkspaceTenantQuery(organisationId)
  const tenant = tenantQuery.data
  const phase = tenant === undefined || tenant === null ? undefined : tenantPhase(tenant.status)
  const read = query.data === undefined ? undefined : workspaceView(query.data.workspace)
  // Only the owner is the one being confirmed; to anyone else it is setup still under way. A
  // stopped tenant is a stopped setup: an operator acts first.
  const view: WorkspaceView | undefined =
    read?.kind === 'confirming-owner' && membership.role !== 'org_owner'
      ? { kind: 'preparing' }
      : read?.kind === 'workspace' && phase === 'failed'
        ? { kind: 'failed' }
        : read
  // The workspace is drawn once the tenant is known, so nothing is offered, or started, before it
  // is known whether its homeserver exists.
  const awaitingTenant = view?.kind === 'workspace' && tenant === undefined
  const preparing = view?.kind === 'workspace' && phase === 'preparing'
  // The same resolution governs the canvas and commands that require a live conversation.
  const serverSlug = phase === 'closed' ? undefined : tenant?.slug
  const live = liveEntry(serverSlug, preparing)
  const hasLiveWorkspace =
    view?.kind === 'workspace' &&
    !awaitingTenant &&
    ((isDemoActive(org) && serverSlug !== undefined && !preparing) || live !== undefined)

  useEffect(() => {
    const command = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const action = event.detail as WorkspaceCommand
      if (action === 'configure') setOnboardingOpen(true)
      if (action === 'extensions') setConnectorsOpen(true)
      if (action === 'hosting') setHostingOpen(true)
      if (action === 'studio') setStudioOpen(true)
      if (action === 'developer' && !hasLiveWorkspace) setDeveloperDocsOpen(true)
    }
    window.addEventListener(WORKSPACE_COMMAND_EVENT, command)
    return () => window.removeEventListener(WORKSPACE_COMMAND_EVENT, command)
  }, [hasLiveWorkspace])

  const configureAction =
    membership.role === 'org_owner' ? (
      <Button variant="secondary" size="sm" onClick={() => setOnboardingOpen(true)}>
        {copy.configure}
      </Button>
    ) : null
  const actions = null

  let content
  if (query.data === undefined || view === undefined) {
    content = query.isError ? <ErrorState onRetry={() => void query.refetch()} /> : <LoadingState />
  } else if (awaitingTenant) {
    content = tenantQuery.isError ? (
      <ErrorState onRetry={() => void tenantQuery.refetch()} />
    ) : (
      <LoadingState />
    )
  } else {
    switch (view.kind) {
      case 'preparing':
        content = <PreparingState organisationName={organisationName} />
        break
      case 'confirming-owner':
        content = <ConfirmingOwnerState organisationName={organisationName} />
        break
      case 'not-created':
        content = <NotCreatedState organisationName={organisationName} />
        break
      case 'failed':
        content = (
          <FailedState
            org={org}
            organisationName={organisationName}
            // The workspace read's id only when that read is the one that said it stopped.
            requestId={read?.kind === 'failed' ? query.data.requestId : undefined}
          />
        )
        break
      case 'ready-to-create':
        content = (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex justify-end px-6 pt-4">{configureAction}</div>
            <ReadyToCreateState
              organisationId={organisationId}
              organisationName={organisationName}
            />
          </div>
        )
        break
      case 'workspace': {
        // Only this tenant's session: the Console keeps one, from the last organisation opened,
        // and another's would show that organisation's rooms here. None while the homeserver is
        // being prepared.
        // A closed tenant's homeserver is no more one to sign in to than a missing one's.
        content =
          isDemoActive(org) && serverSlug !== undefined && !preparing ? (
            <DemoWorkspace
              key={`${org}:${serverSlug}`}
              organisationId={organisationId}
              org={org}
              organisationName={organisationName}
              workspace={view.workspace}
              channelId={params.channelId}
              serverSlug={serverSlug}
              actions={actions}
            />
          ) : live !== undefined ? (
            <LiveWorkspace
              // One organisation's workspace: its drafts, its chosen channel and its sign-in state
              // are never carried into another's.
              key={live.serverSlug}
              organisationId={organisationId}
              org={org}
              organisationName={organisationName}
              workspace={view.workspace}
              channelId={params.channelId}
              session={live.session}
              serverSlug={live.serverSlug}
              actions={actions}
            />
          ) : (
            <ReadyWorkspace
              org={org}
              organisationName={organisationName}
              workspace={view.workspace}
              channelId={params.channelId}
              serverSlug={serverSlug}
              preparing={preparing}
              actions={actions}
            />
          )
        break
      }
    }
  }

  return (
    <>
      {/* One region for the life of the page (§10): it carries the current state's title, so a
          state that changes while the page is open — setup finishing, the workspace created —
          is read out once. Mounted before any state is known, so its first change is heard. */}
      <p role="status" aria-live="polite" className="sr-only">
        {view === undefined || awaitingTenant
          ? ''
          : t(STATE_TITLE[preparing ? 'preparing' : view.kind])}
      </p>
      {content}
      <>
        <Dialog
          open={connectorsOpen}
          onOpenChange={setConnectorsOpen}
          title={copy.connectors}
          closeLabel={t('console.common.action-close')}
          size="lg"
        >
          <div className="max-h-[calc(100vh*2/3)] overflow-y-auto">
            <ExtensionsCatalogPanel defaultSelectedId="io.kodera.ext.frameio-review-bridge" />
          </div>
        </Dialog>
        <Dialog
          open={hostingOpen}
          onOpenChange={setHostingOpen}
          title={menuCopy.hosting}
          closeLabel={t('console.common.action-close')}
          size="lg"
        >
          <HostingOfferPanel
            initiallyExpanded
            organisation={organisationName}
            mode={tenant?.hostingMode ?? tenant?.hosting_mode}
          />
        </Dialog>
        <Dialog
          open={developerDocsOpen}
          onOpenChange={setDeveloperDocsOpen}
          title={menuCopy.developer}
          closeLabel={t('console.common.action-close')}
          size="lg"
        >
          <div className="max-h-[calc(100vh*2/3)] overflow-y-auto">
            <DeveloperDocsHub
              onOpenSupportChannel={() =>
                window.open(
                  'https://community.kodera.io/community/workspace',
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            />
          </div>
        </Dialog>
        <ThemeStudioModal
          open={studioOpen}
          currentThemeMode={appliedTheme(preference)}
          onSelectCoreTheme={choose}
          onShareToChannel={shareTheme}
          onClose={() => setStudioOpen(false)}
        />
        <FirstRunOnboardingModal
          key={organisationId}
          claimMode={isDemoActive(org) ? 'preview' : 'cloud'}
          open={onboardingOpen}
          initialThemeMode={themeMode(appliedTheme(preference))}
          isDarkTheme={themeMode(appliedTheme(preference)) !== 'light'}
          onSelectTheme={(dark) => choose(dark ? 'dark' : 'light')}
          onClaimed={(workspace) => {
            if (addCreatedDemoWorkspace(workspace)) {
              void queryClient.invalidateQueries()
              void router.invalidate().then(() =>
                router.navigate({
                  to: '/$org/workspace',
                  params: { org: workspace.payload.slug },
                })
              )
              setOnboardingOpen(false)
            }
            choose(
              workspace.payload.themeId === 'real-black'
                ? 'black'
                : workspace.payload.themeId === 'ardoise'
                  ? 'dark'
                  : 'light'
            )
          }}
          onComplete={() => setOnboardingOpen(false)}
          onDismiss={() => setOnboardingOpen(false)}
        />
      </>
    </>
  )
}
