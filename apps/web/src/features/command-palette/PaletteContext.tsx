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
  register(source: PaletteSource, priority: number) {
    const lease = {}
    this.sources.set(lease, { source, priority })
    return () => {
      this.sources.delete(lease)
    }
  }
  read() {
    let chosen: { source: PaletteSource; priority: number } | undefined
    for (const candidate of this.sources.values())
      if (!chosen || candidate.priority >= chosen.priority) chosen = candidate
    return chosen?.source ?? null
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
