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
  it('honors workspace defaults until a member explicitly chooses Pro', () => {
    const { result } = renderHook(() => useWorkspaceUiMode('messages'))
    expect(result.current).toBe('messages')
    act(() => setUiMode('pro'))
    expect(result.current).toBe('pro')
  })

  it('accepts a legacy URL mode and canonicalizes the next selection', () => {
    window.history.replaceState(null, '', '?ui_mode=simple')
    expect(getUiModeSnapshot()).toBe('messages')
    act(() => setUiMode('messages'))
    expect(new URL(window.location.href).searchParams.get('ui_mode')).toBe('messages')
    window.history.replaceState(null, '', '/')
  })

  it('normalizes legacy preferences without losing the selected mode', () => {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, 'simple')
    expect(getUiModeSnapshot()).toBe('messages')
    setUiMode('simple')
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('messages')
  })
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
      uiModePreference.setMode('messages')
    })
    expect(result.current).toBe('messages')
    expect(window.localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('messages')
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
          newValue: 'messages',
        })
      )
    })
    expect(result.current).toBe('messages')

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
      setUiMode('messages')
    })
    expect(result.current).toBe('messages')
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
