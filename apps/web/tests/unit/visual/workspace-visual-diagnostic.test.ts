// @vitest-environment node

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  assertDiagnosticBudget,
  assertPhaseOrder,
  encodeDiagnosticRecord,
  PHASES,
  runWorkspaceVisualDiagnostic,
} from '../../visual/support/workspaceVisualDiagnostic'
import type {
  DiagnosticPorts,
  DiagnosticSample,
} from '../../visual/support/workspaceVisualDiagnostic'

function sample(phase: DiagnosticSample['phase']): DiagnosticSample {
  return {
    phase,
    sampleTimeMs: 1,
    viewport: [390, 780, 0, 0, 1, 390, 780, 1],
    profile: {
      theme: 'light',
      colorScheme: 'light',
      reducedMotion: true,
      languageIsFr: true,
      timezoneIsParis: true,
    },
    fontStatus: 'loaded',
    trigger: { expanded: false, disabled: false, hover: false, focus: false },
    nodes: ['trigger', 'header', 'section', 'body'].map((role) => ({
      role,
      rect: [0, 0, 100, 44],
      borderWidth: [1, 1, 1, 1],
      radius: [8, 8, 8, 8],
      opacity: 1,
      backgroundColor: [255, 255, 255, 1],
      borderColor: [201, 211, 222, 1],
      backgroundKind: 'none',
      backgroundClip: 'border-box',
      transform: 'none',
      filter: 'none',
    })),
  }
}

function png(length = 24): Buffer {
  const buffer = Buffer.alloc(length)
  buffer.set([137, 80, 78, 71, 13, 10, 26, 10])
  buffer.write('IHDR', 12)
  buffer.writeUInt32BE(390, 16)
  buffer.writeUInt32BE(780, 20)
  return buffer
}

function harness() {
  const calls: string[] = []
  const attachments: { name: string; body: Buffer | string }[] = []
  const outcomes: string[] = []
  const ports: DiagnosticPorts = {
    sample: async (phase) => {
      calls.push(phase)
      return sample(phase)
    },
    capture: async () => {
      calls.push('capture')
      return png()
    },
    attach: async (name, body) => {
      calls.push(name)
      attachments.push({ name, body })
    },
    report: (outcome) => {
      calls.push('report')
      outcomes.push(outcome)
    },
  }
  return { ports, calls, attachments, outcomes }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('workspace visual diagnostic', () => {
  it('runs the unchanged primary before all observations and collects exactly once', async () => {
    const state = harness()
    await runWorkspaceVisualDiagnostic(async () => {
      state.calls.push('primary')
    }, state.ports)
    expect(state.calls).toEqual([
      'primary',
      'D0-before',
      'capture',
      'D0-after',
      'D1-before',
      'capture',
      'D1-after',
      'workspace-diagnostic-D0',
      'workspace-diagnostic-D1',
      'workspace-diagnostic-state',
      'report',
    ])
    expect(state.outcomes).toEqual(['complete'])
    expect(JSON.parse(String(state.attachments[2]?.body)).primaryOutcome).toBe('passed')
  })

  it('does not sample pending primary or abandon pending capture and attachment work', async () => {
    const state = harness()
    const primary = deferred<void>()
    const capture = deferred<Buffer>()
    const captureStarted = deferred<void>()
    const attachment = deferred<void>()
    const attachmentStarted = deferred<void>()
    let captures = 0
    let attachments = 0
    state.ports.capture = async () => {
      captures += 1
      if (captures === 1) {
        captureStarted.resolve()
        return capture.promise
      }
      return png()
    }
    state.ports.attach = async () => {
      attachments += 1
      if (attachments === 1) {
        attachmentStarted.resolve()
        await attachment.promise
      }
    }
    let finished = false
    const work = runWorkspaceVisualDiagnostic(() => primary.promise, state.ports).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(state.calls).toEqual([])
    primary.resolve()
    await captureStarted.promise
    expect(state.calls).toEqual(['D0-before'])
    expect(finished).toBe(false)
    capture.resolve(png())
    await attachmentStarted.promise
    expect(attachments).toBe(1)
    expect(finished).toBe(false)
    attachment.resolve()
    await work
    expect(captures).toBe(2)
    expect(attachments).toBe(3)
    expect(finished).toBe(true)
  })

  for (const failure of ['none', 'sample', 'capture', 'schema', 'attach', 'report'] as const) {
    it(`preserves primary identity and foreign resources when ${failure} fails`, async () => {
      const state = harness()
      const primaryError = new Error('PRIMARY')
      const diagnosticError = new Error('NO_LOG')
      const foreign = new EventEmitter()
      const listener = () => undefined
      foreign.on('canary', listener)
      const inject = (ports: DiagnosticPorts) => {
        if (failure === 'sample') ports.sample = async () => Promise.reject(diagnosticError)
        if (failure === 'capture') ports.capture = async () => Promise.reject(diagnosticError)
        if (failure === 'schema') ports.sample = async () => ({ unsafe: 'NO_LOG' })
        if (failure === 'attach') ports.attach = async () => Promise.reject(diagnosticError)
        if (failure === 'report') {
          ports.report = () => {
            throw diagnosticError
          }
        }
      }
      inject(state.ports)
      await expect(
        runWorkspaceVisualDiagnostic(() => Promise.reject(primaryError), state.ports)
      ).rejects.toBe(primaryError)
      expect(foreign.listeners('canary')).toEqual([listener])
      expect(JSON.stringify(state.attachments)).not.toContain('NO_LOG')
      if (failure === 'none') expect(state.outcomes).toEqual(['complete'])
      else if (failure !== 'report') expect(state.outcomes).not.toEqual(['complete'])
      const passing = harness()
      inject(passing.ports)
      if (failure === 'none') {
        await runWorkspaceVisualDiagnostic(async () => undefined, passing.ports)
      } else {
        const expected = {
          sample: 'sample',
          capture: 'capture',
          schema: 'validation',
          attach: 'attachment',
          report: 'reporting',
        }[failure]
        await expect(
          runWorkspaceVisualDiagnostic(async () => undefined, passing.ports)
        ).rejects.toThrow(`WORKSPACE_VISUAL_DIAGNOSTIC_INCOMPLETE:${expected}`)
      }
    })
  }

  it('retains rejected undefined rather than treating it as success', async () => {
    const state = harness()
    let rejected = false
    await runWorkspaceVisualDiagnostic(() => Promise.reject(undefined), state.ports).then(
      () => {
        throw new Error('PRIMARY_WAS_LOST')
      },
      (error: unknown) => {
        rejected = true
        expect(error).toBeUndefined()
      }
    )
    expect(rejected).toBe(true)
    expect(JSON.parse(String(state.attachments[2]?.body)).primaryOutcome).toBe('failed')
  })

  it('makes evidence failure distinct after a successful primary', async () => {
    const state = harness()
    state.ports.capture = async () => Promise.reject(new Error('NO_LOG'))
    await expect(runWorkspaceVisualDiagnostic(async () => undefined, state.ports)).rejects.toThrow(
      'WORKSPACE_VISUAL_DIAGNOSTIC_INCOMPLETE:capture'
    )
    expect(state.outcomes).toEqual(['capture'])
    expect(JSON.stringify(state.attachments)).not.toContain('NO_LOG')
  })

  it('refuses excess PNG bytes before raw attachment and restores pristine input', async () => {
    assertDiagnosticBudget(524288, 16384)
    expect(() => assertDiagnosticBudget(524289, 0)).toThrow(
      'WORKSPACE_DIAGNOSTIC_PNG_BUDGET expected=524288 actual=524289'
    )
    assertDiagnosticBudget(524288, 16384)
    const state = harness()
    state.ports.capture = async () => png(262144)
    await runWorkspaceVisualDiagnostic(async () => undefined, state.ports)
    const invalid = harness()
    invalid.ports.capture = async () => png(262145)
    await expect(
      runWorkspaceVisualDiagnostic(async () => undefined, invalid.ports)
    ).rejects.toThrow('WORKSPACE_VISUAL_DIAGNOSTIC_INCOMPLETE:validation')
    expect(invalid.attachments.every(({ name }) => name === 'workspace-diagnostic-state')).toBe(
      true
    )
    const restored = harness()
    await runWorkspaceVisualDiagnostic(async () => undefined, restored.ports)
  })

  it('checks actual UTF-8 length with a finite budget input mutation and restoration', () => {
    assertDiagnosticBudget(0, Buffer.byteLength(' '.repeat(16384)))
    expect(() => assertDiagnosticBudget(0, Buffer.byteLength(' '.repeat(16385)))).toThrow(
      'WORKSPACE_DIAGNOSTIC_JSON_BUDGET expected=16384 actual=16385'
    )
    assertDiagnosticBudget(0, Buffer.byteLength(' '.repeat(16384)))
  })

  it('awaits late failures without masking primary or leaving collection running', async () => {
    for (const failure of ['capture', 'attach'] as const) {
      const state = harness()
      const primaryError = new Error('PRIMARY')
      let captures = 0
      let attachments = 0
      state.ports.capture = async () => {
        captures += 1
        if (failure === 'capture' && captures === 2) throw new Error('NO_LOG')
        return png()
      }
      state.ports.attach = async () => {
        attachments += 1
        if (failure === 'attach' && attachments === 3) throw new Error('NO_LOG')
      }
      await expect(
        runWorkspaceVisualDiagnostic(() => Promise.reject(primaryError), state.ports)
      ).rejects.toBe(primaryError)
      expect(captures).toBe(2)
      expect(attachments).toBe(failure === 'capture' ? 1 : 3)
      expect(state.outcomes).toEqual([failure === 'capture' ? 'capture' : 'attachment'])
    }
  })

  it('refuses reordered evidence with the exact operand and pristine restoration', () => {
    assertPhaseOrder(PHASES)
    expect(() => assertPhaseOrder(['D0-after', 'D0-before', 'D1-before', 'D1-after'])).toThrow(
      'WORKSPACE_DIAGNOSTIC_ORDER index=0 expected=D0-before actual=D0-after'
    )
    assertPhaseOrder([...PHASES])
  })

  for (const mutation of ['unknown-field', 'nonfinite', 'unsafe-color', 'invalid-enum'] as const) {
    it(`rejects ${mutation} without serializing it and accepts fresh restoration`, () => {
      const pristine = () => PHASES.map(sample)
      expect(encodeDiagnosticRecord(pristine(), [24, 24], 'passed')).not.toContain('NO_LOG')
      const invalid = pristine()
      const node = invalid[0]?.nodes[0]
      if (node === undefined) throw new Error('MISSING_UNIT_INPUT')
      if (mutation === 'unknown-field') Object.assign(node, { unsafe: 'NO_LOG' })
      if (mutation === 'nonfinite') node.rect[0] = NaN
      if (mutation === 'unsafe-color') Object.assign(node, { backgroundColor: 'url(NO_LOG)' })
      if (mutation === 'invalid-enum') node.backgroundKind = 'NO_LOG'
      expect(() => encodeDiagnosticRecord(invalid, [24, 24], 'passed')).toThrow(
        'WORKSPACE_DIAGNOSTIC_SCHEMA'
      )
      expect(encodeDiagnosticRecord(pristine(), [24, 24], 'passed')).not.toContain('NO_LOG')
    })
  }
})
