import * as installedSdk from 'oidc-client-ts'
import { describe, it } from 'vitest'
import {
  provePopupBridgeRefusals,
  provePopupVariant,
  runPopupCase,
} from './test-support/oidcSdkContract'

describe('locked public SDK popup behavior with owned synthetic windows', () => {
  it.each([
    'stored-popup',
    'user-loaded-order',
    'wrong-origin',
    'wrong-message-tag',
    'wrong-source-state',
    'matching-state-other-source',
    'same-source-other-state',
    'same-source-unknown-state',
    'stored-redirect',
    'stored-silent',
    'stored-unknown',
    'missing-popup-state',
    'unknown-popup-state',
    'duplicate-popup',
    'abort-late-popup',
  ] as const)(
    'characterizes %s on the installed package and fresh pinned VM',
    async (id) => {
      await runPopupCase(installedSdk, id)
    },
    30000
  )

  it.each(['P01', 'P02', 'P03'] as const)(
    'rejects exact source control %s between fresh pristine probes',
    async (id) => {
      await provePopupVariant(installedSdk, id)
    },
    30000
  )

  it('refuses sticky bridge effects, retained receivers and unsettled work', async () => {
    await provePopupBridgeRefusals()
  }, 30000)
})
