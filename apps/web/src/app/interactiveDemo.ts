import type { ClaimedWorkspace } from '../features/onboarding/instantClaimClient'
// Only the mock browser bootstrap registers this capability. Production has no factory,
// demo data or credentials, even when someone adds a demo query parameter to the URL.
import type { EspaceStoreLike } from '../features/espace/EspaceLiveView'
import type { Workspace } from '../features/workspace/workspace'

interface InteractiveDemo {
  slug: string
  landing?: '/$org/workspace'
  createStore: (workspace: Workspace) => EspaceStoreLike
}

let active: readonly InteractiveDemo[] = []
const stores = new Map<string, EspaceStoreLike>()

export function registerInteractiveDemos(demos: readonly InteractiveDemo[]): void {
  for (const slug of stores.keys()) {
    if (!demos.some((demo) => demo.slug === slug)) stores.delete(slug)
  }
  active = demos
}

export function registerInteractiveDemo(demo: InteractiveDemo | undefined): void {
  registerInteractiveDemos(demo === undefined ? [] : [demo])
}

export function isDemoActive(slug?: string): boolean {
  return active.some((demo) => slug === undefined || demo.slug === slug)
}

export function demoLandingFor(slug: string): '/$org/workspace' | undefined {
  return active.find((demo) => demo.slug === slug)?.landing
}

export function createDemoWorkspaceStore(
  slug: string,
  workspace: Workspace
): EspaceStoreLike | undefined {
  const demo = active.find((entry) => entry.slug === slug)
  if (!demo) return undefined
  let store = stores.get(slug)
  if (!store) {
    store = demo.createStore(workspace)
    stores.set(slug, store)
  }
  return store
}

let createWorkspace: ((workspace: ClaimedWorkspace) => void) | undefined
export function registerDemoWorkspaceCreator(creator: (workspace: ClaimedWorkspace) => void): void {
  createWorkspace = creator
}
export function addCreatedDemoWorkspace(workspace: ClaimedWorkspace): boolean {
  if (!createWorkspace || !isDemoActive()) return false
  createWorkspace(workspace)
  return true
}

interface DemoViewStorage {
  read: (key: string) => unknown
  write: (key: string, value: unknown) => void
}
let viewStorage: DemoViewStorage | undefined
export function registerDemoViewStorage(storage: DemoViewStorage): void {
  viewStorage = storage
}
export function readDemoView(key: string): unknown {
  return isDemoActive() ? viewStorage?.read(key) : undefined
}
export function writeDemoView(key: string, value: unknown): void {
  if (isDemoActive()) viewStorage?.write(key, value)
}
