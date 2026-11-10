import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  clearWorkspaceSettingsRuntime,
  getWorkspaceSettingsEpoch,
  registerWorkspaceSettingsRuntime,
  useWorkspaceSettingsRuntime,
} from './settingsRuntime'

const runtime = {
  org: 'community',
  userId: '@first:community.kodera.io',
  displayName: 'First',
  members: [],
  call: {
    getDeviceChoice: () => ({ input: '', output: '' }),
    chooseInput: async () => {},
    chooseOutput: async () => {},
  },
  invite: vi.fn(async () => {}),
  memberRole: () => 'member',
}
afterEach(clearWorkspaceSettingsRuntime)
it('keeps profile identity across console navigation but retires room actions', () => {
  const { result } = renderHook(useWorkspaceSettingsRuntime)
  let release = () => {}
  act(() => {
    release = registerWorkspaceSettingsRuntime(runtime)
  })
  expect(result.current?.invite).toBe(runtime.invite)
  act(release)
  expect(result.current?.userId).toBe(runtime.userId)
  expect(result.current?.call).toBeNull()
  expect(result.current?.invite).toBeUndefined()
})
it('clears cached identity and prevents a late old-room cleanup from replacing the next account', () => {
  const { result } = renderHook(useWorkspaceSettingsRuntime)
  let release = () => {}
  act(() => {
    release = registerWorkspaceSettingsRuntime(runtime)
  })
  act(clearWorkspaceSettingsRuntime)
  expect(result.current).toBeUndefined()
  act(() => {
    registerWorkspaceSettingsRuntime({ ...runtime, userId: '@second:community.kodera.io' })
  })
  act(release)
  expect(result.current?.userId).toBe('@second:community.kodera.io')
})

it('rejects a late publication from a store belonging to a retired authentication epoch', () => {
  const { result } = renderHook(useWorkspaceSettingsRuntime)
  const oldEpoch = getWorkspaceSettingsEpoch()
  act(() => {
    registerWorkspaceSettingsRuntime(runtime, oldEpoch)
  })
  act(clearWorkspaceSettingsRuntime)
  act(() => {
    registerWorkspaceSettingsRuntime(runtime, oldEpoch)
  })
  expect(result.current).toBeUndefined()
  act(() => {
    registerWorkspaceSettingsRuntime(
      { ...runtime, userId: '@second:community.kodera.io' },
      getWorkspaceSettingsEpoch()
    )
  })
  expect(result.current?.userId).toBe('@second:community.kodera.io')
})
