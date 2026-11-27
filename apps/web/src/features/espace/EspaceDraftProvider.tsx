import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import { isTenantSlug } from '../../api/tenantSlug'
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
import { registerEspaceVaultCleanup, registerLocalSessionCleanup } from '../../auth/localSession'
import {
  getMatrixRegistrationStamp,
  getMatrixSession,
  subscribeMatrixSession,
  type MatrixSession,
} from '../../auth/matrix'
import { espaceSessionFor } from '../workspace/OpenEspace'
import type { Workspace } from '../workspace/workspace'
import type { EspaceStoreLike } from './EspaceLiveView'
import {
  buildVaultAad,
  isVerifiedPlaintextBoundary,
  MAX_DRAFT_CHARS,
  MAX_DRAFT_ROOMS,
  openEspaceVault,
  principalOwnerKey,
  vaultSupported,
  type EspaceVault,
  type EspaceVaultPrincipal,
  type VerifiedPlaintextBoundary,
} from './matrix/encryptedCache'

export interface RoomTarget {
  roomId: string
  eventId: string
  /** Historical `{ userId, label }` mention targets preserved while editing a sent message. */
  mentionTargets?: readonly { userId: string; label: string }[] | undefined
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
  sharedRealm?: boolean | undefined
  organisationRealm?: string | null | undefined
  organisationId: string
  ownerId?: string | undefined
  membershipId?: string | undefined
  meGeneration: number
  meCredentialGeneration: number
}
interface Owner {
  generation: number
  realm: string
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
  principal: EspaceVaultPrincipal
  ownerKey: string
  /** The tenant's slug: its homeserver's server name, which the session belongs to. */
  serverSlug: string
}

const LEGACY_DRAFT_PREFIX = 'kodera:drafts:'
const SESSION_ENCRYPTED_DRAFT_PREFIX = 'kodera.web.encrypted-drafts.v1:'

interface SessionDraftKeyRecord {
  readonly incarnation: string
  readonly keyPromise: Promise<CryptoKey>
  active: boolean
}

interface EncryptedSessionDraftEntry {
  readonly incarnation: string
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly iv: string
  readonly ciphertext: string
}

const sessionDraftKeys = new Map<string, SessionDraftKeyRecord>()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function purgePlaintextDraftStorage(): void {
  for (const kind of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = globalThis[kind]
      if (!storage) continue
      for (const key of Object.keys(storage)) {
        if (key.startsWith(LEGACY_DRAFT_PREFIX)) {
          storage.removeItem(key)
        }
      }
    } catch {
      // Ignore restricted storage environments.
    }
  }
}

function clearAllSessionDraftKeys(): void {
  for (const record of sessionDraftKeys.values()) {
    record.active = false
  }
  sessionDraftKeys.clear()
  purgePlaintextDraftStorage()
  try {
    const storage = globalThis.sessionStorage
    if (!storage) return
    for (const key of Object.keys(storage)) {
      if (key.startsWith(SESSION_ENCRYPTED_DRAFT_PREFIX)) {
        storage.removeItem(key)
      }
    }
  } catch {
    // Ignore restricted sessionStorage environments.
  }
}

registerEspaceVaultCleanup(clearAllSessionDraftKeys)
registerLocalSessionCleanup(clearAllSessionDraftKeys)

function getOrCreateSessionDraftKey(ownerKey: string): SessionDraftKeyRecord {
  const existing = sessionDraftKeys.get(ownerKey)
  if (existing !== undefined && existing.active) return existing
  const record: SessionDraftKeyRecord = {
    incarnation: crypto.randomUUID(),
    keyPromise: crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    active: true,
  }
  sessionDraftKeys.set(ownerKey, record)
  return record
}

function revokeSessionDraftKey(ownerKey: string): void {
  const record = sessionDraftKeys.get(ownerKey)
  if (record !== undefined) {
    record.active = false
    sessionDraftKeys.delete(ownerKey)
  }
}
interface ViewRecord {
  store: EspaceStoreLike | null
  roomId: string
  owner: Owner | null
  active: boolean
  unsubscribe?: (() => void) | undefined
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
export class DraftMemory {
  private authority: Authority
  private owner: Owner | null = null
  private drafts = new Map<string, ChannelDraft>()
  private pendingWrites = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; write: () => void }
  >()
  private storageKey: string | null = null
  private vaultPromise: Promise<EspaceVault | null> | null = null
  private views = new Set<ViewRecord>()
  private attached = false
  private revision = 0
  private viewEpoch = 0
  private listeners = new Set<() => void>()

  constructor(
    private readonly lifetime: AuthLifetime,
    initial: Authority,
    private readonly tenantSlugFor: (organisationId: string) => string | undefined,
    private readonly idb: IDBFactory | undefined = globalThis.indexedDB
  ) {
    this.authority = initial
    purgePlaintextDraftStorage()
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
  private expectedRealm(): string | undefined {
    if (this.authority.sharedRealm === true) {
      return typeof this.authority.organisationRealm === 'string' &&
        isTenantSlug(this.authority.organisationRealm)
        ? this.authority.organisationRealm
        : undefined
    }
    return this.authority.org
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
  private ensureVault(owner: Owner): Promise<EspaceVault | null> {
    if (!vaultSupported(this.idb)) return Promise.resolve(null)
    this.vaultPromise ??= openEspaceVault(owner.principal, { idb: this.idb })
      .then((vault) => {
        if (this.owner !== owner || this.terminal(owner)) {
          void vault.close()
          return null
        }
        return vault
      })
      .catch(() => null)
    return this.vaultPromise
  }

  private persist(roomId: string, store: EspaceStoreLike) {
    const key = this.storageKey
    if (key === null) return
    const timer = this.pendingWrites.get(roomId)
    if (timer) clearTimeout(timer.timer)
    const owner = this.owner
    const write = () => {
      this.pendingWrites.delete(roomId)
      if (owner === null || owner !== this.owner || this.terminal(owner) || !this.accepted()) return
      purgePlaintextDraftStorage()
      const boundary = store.getRoomBoundary?.(roomId)
      if (boundary === 'unknown') {
        return
      }
      const draft = this.drafts.get(roomId)
      if (!isVerifiedPlaintextBoundary(boundary) || !draft || (!draft.text && !draft.threadText)) {
        this.deleteEncryptedRoom(key, owner, roomId)
        return
      }
      const text = draft.text.slice(0, MAX_DRAFT_CHARS)
      const threadText = draft.threadText.slice(0, MAX_DRAFT_CHARS)
      void this.writeEncryptedRoom(key, owner, roomId, text, threadText, store)
    }
    this.pendingWrites.set(roomId, { timer: setTimeout(write, 300), write })
  }

  private async writeEncryptedRoom(
    storageKey: string,
    owner: Owner,
    roomId: string,
    text: string,
    threadText: string,
    store: EspaceStoreLike
  ): Promise<void> {
    try {
      if (vaultSupported(this.idb)) {
        const vault = await this.ensureVault(owner)
        if (vault === null || owner !== this.owner || this.terminal(owner) || !this.accepted()) {
          return
        }
        const currentBoundary = store.getRoomBoundary?.(roomId)
        if (!isVerifiedPlaintextBoundary(currentBoundary)) {
          await vault.deleteDraft(roomId).catch(() => undefined)
          return
        }
        await vault.putDraft(roomId, currentBoundary, text, threadText).catch(() => undefined)
        return
      }

      const keyRecord = getOrCreateSessionDraftKey(owner.ownerKey)
      const cryptoKey = await keyRecord.keyPromise
      if (!keyRecord.active || owner !== this.owner || this.terminal(owner) || !this.accepted()) {
        return
      }
      const currentBoundary = store.getRoomBoundary?.(roomId)
      if (!isVerifiedPlaintextBoundary(currentBoundary)) {
        this.deleteSessionEncryptedRoom(storageKey, roomId)
        return
      }
      const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, text, threadText }))
      try {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: buildVaultAad(
              owner.principal,
              keyRecord.incarnation,
              'draft',
              roomId,
              currentBoundary
            ),
          },
          cryptoKey,
          plaintext
        )
        if (
          !keyRecord.active ||
          owner !== this.owner ||
          this.terminal(owner) ||
          !this.accepted() ||
          !isVerifiedPlaintextBoundary(store.getRoomBoundary?.(roomId))
        ) {
          return
        }
        const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')
        const saved: Record<string, unknown> =
          raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
        saved[roomId] = {
          incarnation: keyRecord.incarnation,
          verifiedBoundary: currentBoundary,
          iv: toBase64(iv),
          ciphertext: toBase64(new Uint8Array(ciphertext)),
        } satisfies EncryptedSessionDraftEntry
        const bounded = Object.fromEntries(Object.entries(saved).slice(-MAX_DRAFT_ROOMS))
        if (Object.keys(bounded).length) {
          sessionStorage.setItem(storageKey, JSON.stringify(bounded))
        } else {
          sessionStorage.removeItem(storageKey)
        }
      } finally {
        plaintext.fill(0)
      }
    } catch {
      /* Storage or WebCrypto restrictions never interrupt composing. */
    }
  }

  private deleteSessionEncryptedRoom(storageKey: string, roomId: string): void {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const remaining = { ...saved } as Record<string, unknown>
        delete remaining[roomId]
        if (Object.keys(remaining).length) {
          sessionStorage.setItem(storageKey, JSON.stringify(remaining))
        } else {
          sessionStorage.removeItem(storageKey)
        }
      }
    } catch {
      /* Ignore malformed or unavailable storage. */
    }
  }

  private deleteEncryptedRoom(storageKey: string, owner: Owner | null, roomId: string): void {
    this.deleteSessionEncryptedRoom(storageKey, roomId)
    if (owner !== null && vaultSupported(this.idb)) {
      void this.ensureVault(owner).then((vault) =>
        vault?.deleteDraft(roomId).catch(() => undefined)
      )
    }
  }

  private flush(roomId: string) {
    const pending = this.pendingWrites.get(roomId)
    if (pending) {
      clearTimeout(pending.timer)
      pending.write()
    }
  }

  private discardStoredRoom(roomId: string) {
    const timer = this.pendingWrites.get(roomId)
    if (timer) clearTimeout(timer.timer)
    this.pendingWrites.delete(roomId)
    purgePlaintextDraftStorage()
    if (this.storageKey !== null) {
      this.deleteEncryptedRoom(this.storageKey, this.owner, roomId)
    }
  }

  private restore(roomId: string, store: EspaceStoreLike) {
    purgePlaintextDraftStorage()
    const storageKey = this.storageKey
    const owner = this.owner
    if (storageKey === null || owner === null) return
    const boundary = store.getRoomBoundary?.(roomId)
    if (boundary === 'unknown') {
      // Cold-start before `/sync` classifies the room: hold hydration in suspense without
      // deleting the persisted encrypted draft until `/sync` resolves the boundary.
      this.drafts.delete(roomId)
      return
    }
    if (boundary === undefined || !permitsPlaintext(boundary)) {
      this.discardStoredRoom(roomId)
      if (boundary !== undefined) this.drafts.delete(roomId)
      return
    }
    if (this.drafts.has(roomId)) return
    void this.restoreEncryptedRoom(storageKey, owner, roomId, store)
  }

  private async restoreEncryptedRoom(
    storageKey: string,
    owner: Owner,
    roomId: string,
    store: EspaceStoreLike
  ): Promise<void> {
    try {
      let restored: { text: string; threadText: string } | null = null
      if (vaultSupported(this.idb)) {
        const vault = await this.ensureVault(owner)
        if (vault === null || owner !== this.owner || this.terminal(owner)) return
        const payload = await vault.readDraft(roomId).catch(() => null)
        if (payload !== null) {
          restored = { text: payload.text, threadText: payload.threadText }
        }
      } else {
        const keyRecord = sessionDraftKeys.get(owner.ownerKey)
        if (keyRecord === undefined || !keyRecord.active) return
        const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')
        const entry =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? ((raw as Record<string, unknown>)[roomId] as
                Partial<EncryptedSessionDraftEntry> | undefined)
            : undefined
        const entryBoundary = entry?.verifiedBoundary as RoomBoundary | undefined
        if (
          !entry ||
          entry.incarnation !== keyRecord.incarnation ||
          !isVerifiedPlaintextBoundary(entryBoundary) ||
          typeof entry.iv !== 'string' ||
          typeof entry.ciphertext !== 'string'
        ) {
          return
        }
        const iv = fromBase64(entry.iv)
        const ciphertext = fromBase64(entry.ciphertext)
        if (iv.byteLength !== 12 || ciphertext.byteLength < 18) return
        const cryptoKey = await keyRecord.keyPromise
        if (!keyRecord.active || owner !== this.owner || this.terminal(owner)) return
        let plaintext: Uint8Array<ArrayBuffer> | undefined
        try {
          const decrypted = await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv,
              additionalData: buildVaultAad(
                owner.principal,
                keyRecord.incarnation,
                'draft',
                roomId,
                entryBoundary
              ),
            },
            cryptoKey,
            ciphertext
          )
          plaintext = new Uint8Array(decrypted)
          const parsed = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
          ) as Record<string, unknown>
          if (
            parsed.v === 1 &&
            typeof parsed.text === 'string' &&
            typeof parsed.threadText === 'string' &&
            parsed.text.length <= MAX_DRAFT_CHARS &&
            parsed.threadText.length <= MAX_DRAFT_CHARS
          ) {
            restored = { text: parsed.text, threadText: parsed.threadText }
          }
        } finally {
          plaintext?.fill(0)
        }
      }

      if (restored === null || owner !== this.owner || this.terminal(owner) || !this.accepted()) {
        return
      }
      const liveBoundary = store.getRoomBoundary?.(roomId)
      if (liveBoundary === 'unknown') {
        return
      }
      if (liveBoundary === undefined || !permitsPlaintext(liveBoundary)) {
        this.discardStoredRoom(roomId)
        if (liveBoundary !== undefined && this.drafts.delete(roomId)) this.publish()
        return
      }
      if (!this.drafts.has(roomId)) {
        this.drafts.set(roomId, {
          ...EMPTY_DRAFT,
          text: restored.text,
          threadText: restored.threadText,
        })
        this.publish()
      }
    } catch {
      /* Ignore corrupt, revoked, or unavailable encrypted draft entries. */
    }
  }

  private retire(clearStorage = true) {
    for (const pending of this.pendingWrites.values()) clearTimeout(pending.timer)
    this.pendingWrites.clear()
    purgePlaintextDraftStorage()
    const retiringOwner = this.owner
    const closingVault = this.vaultPromise
    this.vaultPromise = null
    if (clearStorage) {
      if (retiringOwner !== null) {
        revokeSessionDraftKey(retiringOwner.ownerKey)
      }
      if (this.storageKey !== null) {
        try {
          sessionStorage.removeItem(this.storageKey)
        } catch {
          /* Storage may be blocked. */
        }
      }
      if (closingVault !== null) {
        void closingVault.then((vault) => vault?.wipe().catch(() => undefined))
      }
    } else if (closingVault !== null) {
      void closingVault.then((vault) => vault?.close().catch(() => undefined))
    }
    this.storageKey = null
    this.viewEpoch += 1
    this.owner = null
    this.drafts.clear()
    for (const view of this.views) {
      view.unsubscribe?.()
      view.unsubscribe = undefined
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
    const expectedRealm = this.expectedRealm()
    if (identity === undefined || session === undefined || expectedRealm === undefined) return true
    return (
      live.status === 'unauthenticated' ||
      !this.lifetime.hasUsableCredential() ||
      live.generation !== owner.generation ||
      this.lifetime.getRetirementStamp() !== owner.coreStamp ||
      live.user?.realm !== owner.realm ||
      owner.realm !== expectedRealm ||
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
    const expectedRealm = this.expectedRealm()
    if (
      session === undefined ||
      expectedRealm === undefined ||
      live.user?.realm !== expectedRealm ||
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
      if (this.owner !== null && !this.terminal(this.owner)) {
        for (const roomId of this.pendingWrites.keys()) this.flush(roomId)
      }
      this.attached = false
      this.retire(this.owner !== null && this.terminal(this.owner))
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
      const realm = live.user!.realm!
      const principal: EspaceVaultPrincipal = {
        ownerId: this.authority.ownerId ?? identity.subject,
        organisationId: this.authority.organisationId,
        membershipId: this.authority.membershipId ?? `${session.userId}@${session.baseUrl}`,
        deviceId: session.deviceId,
      }
      this.owner = {
        generation: live.generation,
        realm,
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
        principal,
        ownerKey: principalOwnerKey(principal),
        serverSlug,
      }
    }
    if (this.owner !== null) {
      this.storageKey = `${SESSION_ENCRYPTED_DRAFT_PREFIX}${encodeURIComponent(this.owner.organisationId)}:${encodeURIComponent(this.owner.org)}:${encodeURIComponent(this.owner.issuer)}:${encodeURIComponent(this.owner.userId)}:${encodeURIComponent(this.owner.baseUrl)}`
      this.restore(roomId, store)
    }
    // A committed replacement store or room supersedes all detached handlers.
    for (const previous of this.views) {
      if (previous.store !== store || previous.roomId !== roomId) {
        this.flush(previous.roomId)
        previous.unsubscribe?.()
        previous.unsubscribe = undefined
        previous.active = false
        previous.store = null
        previous.owner = null
        this.views.delete(previous)
      }
    }
    const view: ViewRecord = { store, roomId, owner: this.owner, active: true }
    this.views.add(view)
    view.unsubscribe = store.subscribe(() => {
      const boundary = store.getRoomBoundary?.(roomId)
      if (boundary === 'unknown') {
        if (this.drafts.delete(roomId)) this.publish()
        return
      }
      if (boundary !== undefined && !permitsPlaintext(boundary)) {
        this.discardStoredRoom(roomId)
        if (this.drafts.delete(roomId)) this.publish()
        return
      }
      if (boundary !== undefined && permitsPlaintext(boundary) && !this.drafts.has(roomId)) {
        this.restore(roomId, store)
      }
    })
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
        this.persist(roomId, store)
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
          if (patch !== undefined) {
            this.persist(roomId, store)
            this.publish()
          }
        }
        return true
      },
      release: () => {
        this.flush(roomId)
        view.unsubscribe?.()
        view.unsubscribe = undefined
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
  sharedRealm,
  organisationRealm,
  organisationId,
  ownerId,
  membershipId,
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
    () => ({
      org,
      sharedRealm,
      organisationRealm,
      organisationId,
      ownerId,
      membershipId,
      meGeneration,
      meCredentialGeneration,
    }),
    [
      org,
      sharedRealm,
      organisationRealm,
      organisationId,
      ownerId,
      membershipId,
      meGeneration,
      meCredentialGeneration,
    ]
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
