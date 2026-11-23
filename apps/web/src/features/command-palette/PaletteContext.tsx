import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'
import type { ChannelSearchProps } from '../workspace/ChannelSearch'
import type { PaletteTarget } from './UniversalSearch'

export type PaletteSource = ChannelSearchProps & {
  actions?: readonly PaletteTarget[]
  documents?: readonly PaletteTarget[]
  files?: readonly PaletteTarget[]
  directMessages?: readonly PaletteTarget[]
  members?: readonly PaletteTarget[]
}
export const OPEN_PALETTE = 'kodera:open-palette'
class PaletteRegistry {
  private sources = new Map<object, { source: PaletteSource; priority: number }>()
  private listeners = new Set<() => void>()
  private cached: PaletteSource | null | undefined = undefined
  private emit() {
    for (const listener of [...this.listeners]) listener()
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  register(source: PaletteSource, priority: number) {
    const lease = {}
    this.sources.set(lease, { source, priority })
    this.cached = undefined
    this.emit()
    return () => {
      this.sources.delete(lease)
      this.cached = undefined
      this.emit()
    }
  }
  read = () => {
    if (this.cached !== undefined) return this.cached
    if (this.sources.size === 0) {
      this.cached = null
      return null
    }
    const ordered = [...this.sources.values()].sort((a, b) => a.priority - b.priority)
    let merged: PaletteSource = { ...ordered[0]!.source }
    for (let i = 1; i < ordered.length; i++) {
      const next = ordered[i]!.source
      const base = merged
      merged = { ...base, ...next }
      if (next.actions === undefined && base.actions !== undefined) merged.actions = base.actions
      if (next.documents === undefined && base.documents !== undefined)
        merged.documents = base.documents
      if (next.files === undefined && base.files !== undefined) merged.files = base.files
      if (next.directMessages === undefined && base.directMessages !== undefined)
        merged.directMessages = base.directMessages
      if (next.members === undefined && base.members !== undefined) merged.members = base.members
      if (next.dynamicEntries === undefined && base.dynamicEntries !== undefined)
        merged.dynamicEntries = base.dynamicEntries
    }
    this.cached = merged
    return merged
  }
}
const Context = createContext<PaletteRegistry | null>(null)
export function PaletteProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new PaletteRegistry())
  return <Context.Provider value={registry}>{children}</Context.Provider>
}
export const usePaletteSource = () => useContext(Context)
export function useRegisterPalette(source: PaletteSource, priority = 0) {
  const registry = usePaletteSource()
  useLayoutEffect(() => registry?.register(source, priority))
  return registry !== null
}
