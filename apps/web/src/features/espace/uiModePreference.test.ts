import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_UI_MODE,
  UI_MODE_STORAGE_KEY,
  favoriteChannelsStorageKey,
  getUiModeSnapshot,
  setUiMode,
  toggleUiMode,
  uiModeCopy,
  uiModePreference,
  useFavoriteChannels,
  useWorkspaceUiMode,
} from './uiModePreference'

describe('uiModePreference', () => {
  beforeEach(() => {
    window.localStorage.clear()
    act(() => {
      setUiMode('pro')
    })
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    act(() => {
      setUiMode('pro')
    })
    window.localStorage.clear()
  })

  it('defaults to pro mode and ignores corrupt storage values', () => {
    expect(DEFAULT_UI_MODE).toBe('pro')
    expect(getUiModeSnapshot()).toBe('pro')

    window.localStorage.setItem(UI_MODE_STORAGE_KEY, 'unexpected-mode')
    expect(getUiModeSnapshot()).toBe('pro')
  })

  it('persists mode switches and notifies subscribers on setMode, toggle, and cross-tab storage events', () => {
    const listener = vi.fn()
    const unsubscribe = uiModePreference.subscribe(listener)

    const { result } = renderHook(() => useWorkspaceUiMode())
    expect(result.current).toBe('pro')

    act(() => {
      uiModePreference.setMode('simple')
    })
    expect(result.current).toBe('simple')
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('simple')
    expect(listener).toHaveBeenCalledTimes(1)

    act(() => {
      const next = toggleUiMode()
      expect(next).toBe('pro')
    })
    expect(result.current).toBe('pro')
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('pro')

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: UI_MODE_STORAGE_KEY,
          newValue: 'simple',
        })
      )
    })
    expect(result.current).toBe('simple')

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: UI_MODE_STORAGE_KEY,
          newValue: null,
        })
      )
    })
    expect(result.current).toBe('pro')

    unsubscribe()
  })

  it('keeps in-memory mode active when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => useWorkspaceUiMode())
    act(() => {
      setUiMode('simple')
    })
    expect(result.current).toBe('simple')
  })

  it('persists favorite channels per org, workspace, and viewer with cross-tab sync', () => {
    const { result, rerender } = renderHook(
      ({ org, ws, viewer }) => useFavoriteChannels(org, ws, viewer),
      {
        initialProps: { org: 'acme', ws: 'ws-alpha', viewer: '@alice:kodera.io' },
      }
    )

    expect(result.current.favoriteChannels.size).toBe(0)
    act(() => {
      result.current.toggleChannelFavorite('ch-general')
    })
    expect(result.current.isChannelFavorite('ch-general')).toBe(true)
    expect(
      JSON.parse(
        window.localStorage.getItem(
          favoriteChannelsStorageKey('acme', 'ws-alpha', '@alice:kodera.io')
        ) ?? '[]'
      )
    ).toEqual(['ch-general'])

    rerender({ org: 'acme', ws: 'ws-alpha', viewer: '@bob:kodera.io' })
    expect(result.current.isChannelFavorite('ch-general')).toBe(false)

    rerender({ org: 'acme', ws: 'ws-alpha', viewer: '@alice:kodera.io' })
    expect(result.current.isChannelFavorite('ch-general')).toBe(true)

    const key = favoriteChannelsStorageKey('acme', 'ws-alpha', '@alice:kodera.io')
    act(() => {
      window.localStorage.setItem(key, JSON.stringify(['ch-general', 'ch-ops']))
      window.dispatchEvent(new StorageEvent('storage', { key }))
    })
    expect(result.current.isChannelFavorite('ch-ops')).toBe(true)

    act(() => {
      result.current.toggleChannelFavorite('ch-general')
      result.current.toggleChannelFavorite('ch-ops')
    })
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('keeps symmetric FR and EN copy keys', () => {
    expect(Object.keys(uiModeCopy('fr')).sort()).toEqual(Object.keys(uiModeCopy('en')).sort())
  })
})
