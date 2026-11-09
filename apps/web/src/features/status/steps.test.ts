import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_STEP_ORDER,
  customerSteps,
  failedStep,
  justCompletedIndex,
  runningStepIndex,
} from './steps'
import type { ProvisioningStep } from './steps'

function step(overrides: Partial<ProvisioningStep>): ProvisioningStep {
  return {
    key: 'preflight',
    customer_label_key: 'accounts',
    title: 'Preflight',
    status: 'pending',
    ...overrides,
  }
}

describe('customerSteps', () => {
  it('always returns the six customer steps, in the fixed order', () => {
    const result = customerSteps([])
    expect(result.map((entry) => entry.label)).toEqual(CUSTOMER_STEP_ORDER)
  })

  it('maps an internal step with no matching label to pending', () => {
    const result = customerSteps([])
    expect(result.every((entry) => entry.status === 'pending')).toBe(true)
  })

  it('maps a succeeded internal step to done', () => {
    const result = customerSteps([step({ customer_label_key: 'order', status: 'succeeded' })])
    expect(result[0]?.status).toBe('done')
  })

  it('maps a running internal step to running and carries its job id', () => {
    const result = customerSteps([
      step({ customer_label_key: 'apps', status: 'running', job_id: 'job-1' }),
    ])
    const appsStep = result.find((entry) => entry.label === 'apps')
    expect(appsStep?.status).toBe('running')
    expect(appsStep?.jobId).toBe('job-1')
  })

  it('never lets an internal step key reach the output', () => {
    const result = customerSteps([step({ key: 'dns', customer_label_key: 'addresses' })])
    expect(JSON.stringify(result)).not.toContain('dns')
  })

  it('rolls several internal steps behind one label into its worst state', () => {
    const result = customerSteps([
      step({ customer_label_key: 'apps', status: 'succeeded', key: 'deploy' }),
      step({ customer_label_key: 'apps', status: 'failed', key: 'probes' }),
    ])
    const appsStep = result.find((entry) => entry.label === 'apps')
    expect(appsStep?.status).toBe('failed')
  })

  it('prefers a running internal step over an already-succeeded one behind the same label', () => {
    const result = customerSteps([
      step({ customer_label_key: 'apps', status: 'succeeded', key: 'deploy' }),
      step({ customer_label_key: 'apps', status: 'running', key: 'probes' }),
    ])
    const appsStep = result.find((entry) => entry.label === 'apps')
    expect(appsStep?.status).toBe('running')
  })
})

describe('runningStepIndex', () => {
  it('finds the running step among the six', () => {
    const steps = customerSteps([
      step({ customer_label_key: 'order', status: 'succeeded' }),
      step({ customer_label_key: 'server', status: 'succeeded' }),
      step({ customer_label_key: 'apps', status: 'running' }),
    ])
    expect(runningStepIndex(steps)).toBe(2)
  })

  it('returns undefined when nothing is running', () => {
    expect(runningStepIndex(customerSteps([]))).toBeUndefined()
  })
})

describe('failedStep', () => {
  it('returns the failed step with its job reference', () => {
    const steps = customerSteps([
      step({ customer_label_key: 'addresses', status: 'failed', job_id: 'job-9' }),
    ])
    expect(failedStep(steps)?.jobId).toBe('job-9')
  })

  it('returns undefined when nothing failed', () => {
    expect(failedStep(customerSteps([]))).toBeUndefined()
  })
})

describe('justCompletedIndex', () => {
  it('is undefined on the very first render — nothing to compare against', () => {
    const current = customerSteps([step({ customer_label_key: 'order', status: 'succeeded' })])
    expect(justCompletedIndex(undefined, current)).toBeUndefined()
  })

  it('finds the step that just transitioned to done', () => {
    const previous = customerSteps([step({ customer_label_key: 'server', status: 'running' })])
    const current = customerSteps([step({ customer_label_key: 'server', status: 'succeeded' })])
    expect(justCompletedIndex(previous, current)).toBe(1)
  })

  it('is undefined when polling changes nothing', () => {
    const steps = customerSteps([step({ customer_label_key: 'order', status: 'succeeded' })])
    expect(justCompletedIndex(steps, steps)).toBeUndefined()
  })

  it('is undefined when a step is still running, not yet done', () => {
    const previous = customerSteps([step({ customer_label_key: 'apps', status: 'pending' })])
    const current = customerSteps([step({ customer_label_key: 'apps', status: 'running' })])
    expect(justCompletedIndex(previous, current)).toBeUndefined()
  })
})
