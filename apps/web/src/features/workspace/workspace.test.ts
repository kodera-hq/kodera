// The workspace's pure rules (docs/specs/11-workspace.md §4.3, §6): one screen per Core answer,
// the reading rhythm, the starter labels, the current channel and the creation key.

import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiProblem, NetworkError } from '../../api/client'
import { PROBLEM_TYPES } from '../../api/generated/problems'
import { notInitialisedWorkspace, readyWorkspace } from '../../mocks/fixtures/workspaceFixtures'
import {
  categoryLabel,
  channelLabel,
  channelsInOrder,
  currentChannel,
  isStaleRead,
  keyAfterFailure,
  requireTenant,
  requireWorkspace,
  retryWorkspaceRead,
  tenantPhase,
  tenantRefetchInterval,
  welcomeChannel,
  workspaceRefetchInterval,
  withEveryRoomPending,
  workspaceView,
} from './workspace'
import type { Workspace, WorkspaceChannel } from './workspace'

/** The starter workspace with every room in the given state. */
function withRooms(state: WorkspaceChannel['room_state'], workspace = readyWorkspace()): Workspace {
  return {
    ...workspace,
    categories: workspace.categories.map((category) => ({
      ...category,
      channels: category.channels.map((entry) => ({ ...entry, room_state: state })),
    })),
    uncategorised_channels: workspace.uncategorised_channels.map((entry) => ({
      ...entry,
      room_state: state,
    })),
  }
}

const t = i18n.getFixedT('fr')

function problem(suffix: string, status: number): ApiProblem {
  const type = PROBLEM_TYPES.find((entry) => entry.endsWith(`/${suffix}`))
  if (type === undefined) throw new Error(`The contract has no ${suffix} problem.`)
  return new ApiProblem({ type, status, title: suffix })
}

function channel(overrides: Partial<WorkspaceChannel>): WorkspaceChannel {
  return {
    id: 'c',
    kind: 'text',
    name: 'stored',
    template_key: null,
    topic: '',
    lifecycle: 'active',
    room_state: 'ready',
    ...overrides,
  }
}

describe('workspaceView', () => {
  it.each([
    [{ state: 'pending', reason: null }, false, 'preparing'],
    [{ state: 'running', reason: null }, false, 'preparing'],
    [{ state: 'pending', reason: 'awaiting_owner_confirmation' }, false, 'confirming-owner'],
    [{ state: 'failed', reason: 'realm_job_failed' }, false, 'failed'],
    [{ state: 'failed', reason: 'issuer_untrusted' }, false, 'failed'],
    [{ state: 'ready', reason: null }, true, 'ready-to-create'],
    [{ state: 'ready', reason: null }, false, 'not-created'],
  ] as const)('draws %j (can_initialise %s) as %s', (setup, canInitialise, kind) => {
    expect(workspaceView(notInitialisedWorkspace(setup, canInitialise)).kind).toBe(kind)
  })

  it('draws an initialised workspace as the workspace', () => {
    expect(workspaceView(readyWorkspace()).kind).toBe('workspace')
  })

  it('says a stopped setup even when the workspace exists', () => {
    const stopped: Workspace = { ...readyWorkspace(), setup: { state: 'failed', reason: null } }
    expect(workspaceView(stopped).kind).toBe('failed')
  })
})

describe('workspaceRefetchInterval', () => {
  it('reads every 10 s while setup is under way and every 60 s while a person acts', () => {
    expect(workspaceRefetchInterval({ kind: 'preparing' }, false)).toBe(10_000)
    expect(workspaceRefetchInterval({ kind: 'confirming-owner' }, false)).toBe(60_000)
    expect(workspaceRefetchInterval({ kind: 'failed' }, false)).toBe(60_000)
    // Nothing runs while a member waits for someone to create it: the slow pace, not 10 s.
    expect(workspaceRefetchInterval({ kind: 'not-created' }, false)).toBe(60_000)
  })

  it('does not read again once there is nothing to wait for', () => {
    expect(workspaceRefetchInterval({ kind: 'ready-to-create' }, false)).toBe(false)
    expect(
      workspaceRefetchInterval({ kind: 'workspace', workspace: withRooms('ready') }, false)
    ).toBe(false)
    expect(workspaceRefetchInterval(undefined, false)).toBe(false)
  })

  it('reads every 10 s while a room is not created yet, every minute while one has failed', () => {
    // The contract's own example: two rooms ready, `lounge` pending.
    expect(
      workspaceRefetchInterval({ kind: 'workspace', workspace: readyWorkspace() }, false)
    ).toBe(10_000)
    const oneFailed = withRooms('ready')
    oneFailed.categories[1]!.channels[0]!.room_state = 'failed'
    expect(workspaceRefetchInterval({ kind: 'workspace', workspace: oneFailed }, false)).toBe(
      60_000
    )
    // A pending room in the uncategorised list counts as much as one in a category; a pending
    // room is waited for faster than a failed one.
    const loose: Workspace = {
      ...oneFailed,
      uncategorised_channels: [channel({ id: 'loose', room_state: 'pending' })],
    }
    expect(workspaceRefetchInterval({ kind: 'workspace', workspace: loose }, false)).toBe(10_000)
    expect(
      workspaceRefetchInterval({ kind: 'workspace', workspace: withRooms('pending') }, true)
    ).toBe(false)
  })

  it('never reads while the tab is hidden', () => {
    expect(workspaceRefetchInterval({ kind: 'preparing' }, true)).toBe(false)
  })
})

describe('labels', () => {
  it('names the starter audio channel from the catalogue', () => {
    expect(channelLabel(channel({ kind: 'audio', name: 'x', template_key: 'lounge' }), t)).toBe(
      'détente'
    )
  })

  it('names the starter rows from the catalogue, by kind', () => {
    const workspace = readyWorkspace()
    expect(workspace.categories.map((category) => categoryLabel(category, t))).toEqual([
      'Général',
      'Équipe',
    ])
    expect(workspace.categories[0]!.channels.map((entry) => channelLabel(entry, t))).toEqual([
      'bienvenue',
      'général',
    ])
  })

  it('shows the stored name for a row with no key or a key it does not know', () => {
    expect(channelLabel(channel({ name: 'chantier-nord', template_key: null }), t)).toBe(
      'chantier-nord'
    )
    expect(channelLabel(channel({ name: 'Salon', template_key: 'atelier' }), t)).toBe('Salon')
    expect(channelLabel(channel({ name: 'Proto', template_key: 'toString' }), t)).toBe('Proto')
    expect(
      categoryLabel({ id: 'k', name: 'Chantiers', template_key: 'welcome', channels: [] }, t)
    ).toBe('Chantiers')
  })
})

describe('channels', () => {
  const workspace: Workspace = {
    ...readyWorkspace(),
    uncategorised_channels: [
      channel({ id: 'loose', name: 'loose' }),
      channel({ id: 'audio', kind: 'audio', name: 'lounge' }),
    ],
  }

  it('lists text channels in the order received, categories first, audio left out', () => {
    expect(channelsInOrder(workspace).map((entry) => entry.name)).toEqual([
      'welcome',
      'general',
      'loose',
    ])
  })

  it('makes the first channel current, or the one the address names', () => {
    expect(currentChannel(workspace, undefined)?.name).toBe('welcome')
    expect(currentChannel(workspace, 'loose')?.name).toBe('loose')
  })

  it('finds no channel for an address it cannot see, audio included', () => {
    expect(currentChannel(workspace, 'nobody-knows')).toBeNull()
    expect(currentChannel(workspace, 'audio')).toBeNull()
  })

  it('has no current channel in a workspace without one', () => {
    const empty: Workspace = { ...readyWorkspace(), categories: [], uncategorised_channels: [] }
    expect(currentChannel(empty, undefined)).toBeUndefined()
  })
})

describe('keyAfterFailure', () => {
  const fresh = () => 'fresh-key-000000'

  it('keeps the key when the outcome is unknown', () => {
    expect(keyAfterFailure(problem('internal-error', 500), 'kept-key-0000000', fresh)).toBe(
      'kept-key-0000000'
    )
    expect(keyAfterFailure(new NetworkError(new TypeError('x')), 'kept-key-0000000', fresh)).toBe(
      'kept-key-0000000'
    )
  })

  it('takes a new key after any 4xx, whose answer is final for the old one', () => {
    expect(keyAfterFailure(problem('forbidden', 403), 'old-key-00000000', fresh)).toBe(
      'fresh-key-000000'
    )
    expect(
      keyAfterFailure(problem('invalid-state-transition', 409), 'old-key-00000000', fresh)
    ).toBe('fresh-key-000000')
  })

  it('reads again first after a 409 only', () => {
    expect(isStaleRead(problem('invalid-state-transition', 409))).toBe(true)
    expect(isStaleRead(problem('forbidden', 403))).toBe(false)
  })
})

describe('requireWorkspace', () => {
  it('accepts the contract example', () => {
    expect(requireWorkspace(readyWorkspace())).toEqual(readyWorkspace())
  })

  it('refuses a state the console has no screen for', () => {
    const unknown = { ...readyWorkspace(), setup: { state: 'paused', reason: null } }
    expect(() => requireWorkspace(unknown)).toThrow()
  })

  it('refuses a channel lifecycle the contract never returns', () => {
    const workspace = readyWorkspace()
    workspace.categories[0]!.channels[0]!.lifecycle = 'deleted' as 'archived'
    expect(() => requireWorkspace(workspace)).toThrow()
  })

  it('refuses a room state the contract never returns', () => {
    const workspace = readyWorkspace()
    workspace.categories[0]!.channels[0]!.room_state = 'creating' as 'pending'
    expect(() => requireWorkspace(workspace)).toThrow()
  })
})

describe('retryWorkspaceRead', () => {
  it('does not ask again after a 404 from a Core that does not serve the workspace yet', () => {
    expect(retryWorkspaceRead(0, problem('not-found', 404))).toBe(false)
  })

  it('keeps two retries for anything else', () => {
    expect(retryWorkspaceRead(0, problem('internal-error', 500))).toBe(true)
    expect(retryWorkspaceRead(1, new NetworkError(new TypeError('x')))).toBe(true)
    expect(retryWorkspaceRead(2, problem('internal-error', 500))).toBe(false)
  })
})

describe('the workspace drawn while its tenant is prepared', () => {
  it('has every room pending, uncategorised ones included, and leaves the read itself alone', () => {
    const read = withRooms('ready')
    read.uncategorised_channels = [
      { ...read.categories[0]!.channels[0]!, id: 'loose', template_key: null, name: 'loose' },
    ]
    const drawn = withEveryRoomPending(read)
    expect(everyRoomState(drawn)).toEqual(everyRoomState(read).map(() => 'pending'))
    expect(drawn.uncategorised_channels.map((channel) => channel.room_state)).toEqual(['pending'])
    expect(everyRoomState(read).every((state) => state === 'ready')).toBe(true)
  })
})

function everyRoomState(workspace: Workspace) {
  return [
    ...workspace.categories.flatMap((category) => category.channels),
    ...workspace.uncategorised_channels,
  ].map((channel) => channel.room_state)
}

describe('the tenant', () => {
  it.each([
    ['ordered', 'preparing'],
    ['provisioning', 'preparing'],
    ['ready', 'preparing'],
    ['failed', 'failed'],
    ['active', 'open'],
    ['upgrading', 'open'],
    ['maintenance', 'open'],
    ['suspended', 'closed'],
    ['decommissioning', 'closed'],
    ['deleted', 'closed'],
  ] as const)('reads a %s tenant as %s', (status, phase) => {
    expect(tenantPhase(status)).toBe(phase)
  })

  it('is read every 10 s while prepared, every minute while it waits on an operator, then never', () => {
    expect(tenantRefetchInterval({ slug: 'acme', status: 'provisioning' }, false)).toBe(10_000)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'ready' }, false)).toBe(10_000)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'ordered' }, false)).toBe(60_000)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'failed' }, false)).toBe(60_000)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'active' }, false)).toBe(false)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'suspended' }, false)).toBe(false)
    expect(tenantRefetchInterval(null, false)).toBe(false)
    expect(tenantRefetchInterval(undefined, false)).toBe(false)
    expect(tenantRefetchInterval({ slug: 'acme', status: 'ordered' }, true)).toBe(false)
  })

  it('keeps the slug and the status, and refuses a status this build does not know', () => {
    expect(requireTenant({ id: 't', slug: 'acme-team', status: 'active', name: 'x' })).toEqual({
      slug: 'acme-team',
      status: 'active',
    })
    expect(() => requireTenant({ slug: 'acme-team', status: 'hibernating' })).toThrow()
    expect(() => requireTenant({ slug: '', status: 'active' })).toThrow()
  })
})

describe('welcomeChannel', () => {
  it('is the starter welcome text channel, once its room exists', () => {
    expect(welcomeChannel(withRooms('ready'))?.template_key).toBe('welcome')
    expect(welcomeChannel(withRooms('pending'))).toBeUndefined()
    expect(welcomeChannel(withRooms('failed'))).toBeUndefined()
  })

  it('is never an audio channel keyed welcome', () => {
    const workspace: Workspace = {
      ...readyWorkspace(),
      categories: [],
      uncategorised_channels: [channel({ kind: 'audio', template_key: 'welcome' })],
    }
    expect(welcomeChannel(workspace)).toBeUndefined()
  })
})
