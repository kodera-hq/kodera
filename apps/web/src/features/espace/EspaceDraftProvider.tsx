import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { isDemoActive } from '../../app/interactiveDemo'
import { useAuthLifetime, type AuthLifetime } from '../../auth/AuthProvider'
import {
  getMatrixRegistrationStamp,
  getMatrixSession,
  subscribeMatrixSession,
  type MatrixSession,
} from '../../auth/matrix'
import { espaceSessionFor } from '../workspace/OpenEspace'
import type { Workspace } from '../workspace/workspace'
import type { EspaceStoreLike } from './EspaceLiveView'

export interface RoomTarget {
  roomId: string
  eventId: string
}
export interface ChannelDraft {
  text: string
  replyTo: RoomTarget | null
  editing: RoomTarget | null
  threadRoot: RoomTarget | null
  threadText: string
}
export const EMPTY_DRAFT: ChannelDraft = Object.freeze({
  text: '',
  replyTo: null,
  editing: null,
  threadRoot: null,
  threadText: '',
})

interface Authority {
  org: string
  organisationId: string
  meGeneration: number
  meCredentialGeneration: number
}
interface Owner {
  generation: number
  issuer: string
  subject: string
  coreStamp: object
  matrixStamp: object
  session: MatrixSession
  baseUrl: string
  userId: string
  deviceId: string
  org: string
  organisationId: string
  /** The tenant's slug: its homeserver's server name, which the session belongs to. */
  serverSlug: string
}
interface ViewRecord {
  store: EspaceStoreLike | null
  roomId: string
  owner: Owner | null
  active: boolean
}
export interface DraftLease {
  read(): ChannelDraft
  update(
    patch: Partial<ChannelDraft> | ((previous: ChannelDraft) => Partial<ChannelDraft>)
  ): boolean
  command(effect: () => unknown, patch?: Partial<ChannelDraft>): boolean
  release(): void
}

/** Private data and token-free authority stamps; transport owners live only in active leases. */
class DraftMemory {
  private authority: Authority
  private owner: Owner | null = null
  private drafts = new Map<string, ChannelDraft>()
  private views = new Set<ViewRecord>()
  private attached = false
  private revision = 0
  private viewEpoch = 0
  private listeners = new Set<() => void>()

  constructor(
    private readonly lifetime: AuthLifetime,
    initial: Authority,
    private readonly tenantSlugFor: (organisationId: string) => string | undefined
  ) {
    this.authority = initial
  }
  /**
   * The organisation's tenant slug, read when asked: the session is its homeserver's, which may be
   * named otherwise than the organisation (quick-workspace SPEC §2.1). Read at the moment of each
   * check, from the same read the workspace screen drew from, so the two never disagree for a
   * commit.
   */
  private serverSlug(): string | undefined {
    return this.tenantSlugFor(this.authority.organisationId)
  }
  getSnapshot = () => this.revision
  getViewEpoch = () => this.viewEpoch
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish() {
    this.revision += 1
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue
      try {
        listener()
      } catch {
        /* One owned observer cannot skip retirement or another observer. */
      }
    }
  }
  private retire() {
    this.viewEpoch += 1
    this.owner = null
    this.drafts.clear()
    for (const view of this.views) {
      view.active = false
      view.store = null
      view.owner = null
    }
    this.views.clear()
    this.publish()
  }
  private terminal(owner: Owner): boolean {
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const session = getMatrixSession()
    if (identity === undefined || session === undefined) return true
    return (
      live.status === 'unauthenticated' ||
      !this.lifetime.hasUsableCredential() ||
      live.generation !== owner.generation ||
      this.lifetime.getRetirementStamp() !== owner.coreStamp ||
      live.user?.realm !== owner.org ||
      identity.issuer !== owner.issuer ||
      identity.subject !== owner.subject ||
      this.authority.org !== owner.org ||
      this.authority.organisationId !== owner.organisationId ||
      session !== owner.session ||
      getMatrixRegistrationStamp() !== owner.matrixStamp ||
      session.baseUrl !== owner.baseUrl ||
      session.userId !== owner.userId ||
      session.deviceId !== owner.deviceId ||
      this.serverSlug() !== owner.serverSlug ||
      espaceSessionFor(owner.serverSlug) !== session
    )
  }
  private accepted(): boolean {
    const live = this.lifetime.getSnapshot()
    return (
      live.status === 'ready' &&
      this.lifetime.hasUsableCredential() &&
      live.generation === this.authority.meGeneration &&
      live.credentialGeneration === this.authority.meCredentialGeneration
    )
  }
  private person(
    session: MatrixSession | undefined,
    workspaceOrganisation: string
  ): session is MatrixSession {
    const live = this.lifetime.getSnapshot()
    const identity = live.user?.identity
    const serverSlug = this.serverSlug()
    if (
      session === undefined ||
      live.user?.realm !== this.authority.org ||
      !identity?.issuer ||
      !identity.subject ||
      workspaceOrganisation !== this.authority.organisationId ||
      serverSlug === undefined ||
      espaceSessionFor(serverSlug) !== session ||
      getMatrixSession() !== session
    )
      return false
    const separator = session.userId.indexOf(':')
    return (
      session.userId.startsWith('@') &&
      separator > 1 &&
      session.userId.slice(1, separator) === identity.subject
    )
  }
  canPresent(
    session: MatrixSession | undefined,
    workspace: Workspace,
    store?: EspaceStoreLike
  ): boolean {
    if (
      !this.person(session, workspace.organisation_id) ||
      (store !== undefined && store.getUserId() !== session.userId)
    )
      return false
    // Only a new view may use this admission. An identical committed transport
    // separately follows canKeepView; it does not gain any draft authority.
    return this.accepted()
  }
  canKeepView(
    session: MatrixSession | undefined,
    workspace: Workspace,
    store?: EspaceStoreLike
  ): boolean {
    // This only preserves an already committed identical transport. It grants no
    // draft access and does not change the view's existing media expiry policy.
    return (
      this.person(session, workspace.organisation_id) &&
      (store === undefined || store.getUserId() === session.userId)
    )
  }
  connect() {
    this.attached = true
    const reconcile = () => {
      if (this.owner !== null && this.terminal(this.owner)) this.retire()
      else {
        if (this.owner === null) this.viewEpoch += 1
        this.publish()
      }
    }
    const offCore = this.lifetime.subscribe(reconcile)
    const offMatrix = subscribeMatrixSession(reconcile)
    reconcile()
    return () => {
      offCore()
      offMatrix()
      this.attached = false
      this.retire()
    }
  }
  accept(authority: Authority) {
    this.authority = authority
    if (this.owner !== null && this.terminal(this.owner)) this.retire()
    else {
      if (this.owner === null) this.viewEpoch += 1
      this.publish()
    }
  }
  observeView(session: MatrixSession | undefined, workspace: Workspace, store?: EspaceStoreLike) {
    if (
      this.owner !== null &&
      (this.terminal(this.owner) ||
        !this.person(session, workspace.organisation_id) ||
        (store !== undefined && store.getUserId() !== this.owner.userId))
    )
      this.retire()
  }
  attachView(
    store: EspaceStoreLike,
    workspace: Pick<Workspace, 'organisation_id'>,
    roomId: string
  ): DraftLease {
    const workspaceOrganisation = workspace.organisation_id
    if (
      this.owner !== null &&
      (this.terminal(this.owner) || workspaceOrganisation !== this.owner.organisationId)
    )
      this.retire()
    const session = getMatrixSession()
    const serverSlug = this.serverSlug()
    if (
      this.owner === null &&
      serverSlug !== undefined &&
      this.person(session, workspaceOrganisation) &&
      this.accepted()
    ) {
      const live = this.lifetime.getSnapshot()
      const identity = live.user!.identity!
      this.owner = {
        generation: live.generation,
        issuer: identity.issuer,
        subject: identity.subject,
        coreStamp: this.lifetime.getRetirementStamp(),
        matrixStamp: getMatrixRegistrationStamp(),
        session,
        baseUrl: session.baseUrl,
        userId: session.userId,
        deviceId: session.deviceId,
        org: this.authority.org,
        organisationId: this.authority.organisationId,
        serverSlug,
      }
    }
    // A committed replacement store or room supersedes all detached handlers.
    for (const previous of this.views) {
      if (previous.store !== store || previous.roomId !== roomId) {
        previous.active = false
        previous.store = null
        previous.owner = null
        this.views.delete(previous)
      }
    }
    const view: ViewRecord = { store, roomId, owner: this.owner, active: true }
    this.views.add(view)
    const current = () => {
      const owner = view.owner
      const currentStore = view.store
      if (
        !view.active ||
        !this.attached ||
        !this.views.has(view) ||
        owner === null ||
        currentStore === null ||
        owner !== this.owner ||
        this.terminal(owner) ||
        !this.accepted() ||
        workspaceOrganisation !== this.authority.organisationId
      )
        return false
      const viewerId = currentStore.getUserId()
      return (
        view.active &&
        view.owner === owner &&
        this.owner === owner &&
        view.store === currentStore &&
        viewerId === owner.userId &&
        this.person(owner.session, workspaceOrganisation) &&
        !this.terminal(owner) &&
        this.accepted()
      )
    }
    const allowedCommand = () => {
      if (current()) return true
      if (this.owner !== null && this.terminal(this.owner)) this.retire()
      return false
    }
    const lease: DraftLease = {
      read: () => (current() ? (this.drafts.get(roomId) ?? EMPTY_DRAFT) : EMPTY_DRAFT),
      update: (patch) => {
        if (!allowedCommand()) return false
        const previous = this.drafts.get(roomId) ?? EMPTY_DRAFT
        const change = typeof patch === 'function' ? patch(previous) : patch
        if (!allowedCommand()) return false
        this.drafts.set(roomId, { ...previous, ...change })
        this.publish()
        return true
      },
      command: (effect, patch) => {
        if (!allowedCommand()) return false
        if (patch !== undefined)
          this.drafts.set(roomId, { ...(this.drafts.get(roomId) ?? EMPTY_DRAFT), ...patch })
        try {
          effect()
        } finally {
          if (patch !== undefined) this.publish()
        }
        return true
      },
      release: () => {
        view.active = false
        view.store = null
        view.owner = null
        this.views.delete(view)
      },
    }
    return lease
  }
}

const DraftContext = createContext<DraftMemory | null>(null)
export function useEspaceDraftMemory() {
  return useContext(DraftContext)
}
export function EspaceDraftProvider({
  children,
  org,
  organisationId,
  meGeneration,
  meCredentialGeneration,
  tenantSlugFor,
}: Authority & {
  children: ReactNode
  /** The organisation's tenant slug, as last read (`cachedTenantSlug`); read at each check. */
  tenantSlugFor: (organisationId: string) => string | undefined
}) {
  const lifetime = useAuthLifetime()
  const authority = useMemo(
    () => ({ org, organisationId, meGeneration, meCredentialGeneration }),
    [org, organisationId, meGeneration, meCredentialGeneration]
  )
  // Fixed for the provider's life: the application has one query cache.
  const [memory] = useState(() => new DraftMemory(lifetime, authority, tenantSlugFor))
  useLayoutEffect(() => memory.connect(), [memory])
  useLayoutEffect(() => {
    memory.accept(authority)
  }, [memory, authority])
  // Local demo stores own their drafts and never acquire a Matrix transport lease.
  // Registration comes exclusively from the mock browser bootstrap for this organisation.
  return (
    <DraftContext.Provider value={isDemoActive(org) ? null : memory}>
      {children}
    </DraftContext.Provider>
  )
}
