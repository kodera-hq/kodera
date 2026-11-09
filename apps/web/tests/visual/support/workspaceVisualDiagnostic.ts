import type { Page, TestInfo } from '@playwright/test'

export const PHASES = ['D0-before', 'D0-after', 'D1-before', 'D1-after'] as const
export const CAPTURE_OPTIONS = {
  type: 'png',
  fullPage: false,
  scale: 'css',
  omitBackground: false,
  animations: 'allow',
  caret: 'initial',
  timeout: 5000,
} as const

type Phase = (typeof PHASES)[number]
type Outcome =
  'complete' | 'guard-health' | 'sample' | 'capture' | 'validation' | 'attachment' | 'reporting'
type NullableNumbers = number[] | null

interface NodeSample {
  role: string
  rect: number[]
  borderWidth: NullableNumbers
  radius: NullableNumbers
  opacity: number | null
  backgroundColor: NullableNumbers
  borderColor: NullableNumbers
  backgroundKind: string
  backgroundClip: string
  transform: string
  filter: string
}

export interface DiagnosticSample {
  phase: Phase
  sampleTimeMs: number
  viewport: (number | null)[]
  profile: {
    theme: string
    colorScheme: string
    reducedMotion: boolean
    languageIsFr: boolean
    timezoneIsParis: boolean
  }
  fontStatus: string
  trigger: { expanded: boolean | 'unknown'; disabled: boolean; hover: boolean; focus: boolean }
  nodes: NodeSample[]
}

export interface DiagnosticPorts {
  sample: (phase: Phase) => Promise<unknown>
  capture: () => Promise<Buffer>
  attach: (name: string, body: Buffer | string, contentType: string) => Promise<void>
  report: (outcome: Outcome) => void
}

const ROLES = ['trigger', 'header', 'section', 'body']
const NODE_FIELDS = [
  'role',
  'rect',
  'borderWidth',
  'radius',
  'opacity',
  'backgroundColor',
  'borderColor',
  'backgroundKind',
  'backgroundClip',
  'transform',
  'filter',
]

function schemaFailure(): never {
  throw new Error('WORKSPACE_DIAGNOSTIC_SCHEMA')
}

function exactKeys(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  )
}

function numberWithin(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function numbers(value: unknown, length: number, minimum: number, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    Array.from(value).every((entry) => numberWithin(entry, minimum, maximum))
  )
}

function nullableNumbers(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || numbers(value, 4, minimum, maximum)
}

function color(value: unknown): boolean {
  return (
    value === null ||
    (numbers(value, 4, 0, 255) && Array.isArray(value) && numberWithin(value[3], 0, 1))
  )
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function assertSample(value: unknown): asserts value is DiagnosticSample {
  if (
    !exactKeys(value, [
      'phase',
      'sampleTimeMs',
      'viewport',
      'profile',
      'fontStatus',
      'trigger',
      'nodes',
    ])
  ) {
    schemaFailure()
  }
  const viewport = value.viewport
  const profile = value.profile
  const trigger = value.trigger
  const nodes = value.nodes
  if (
    !oneOf(value.phase, PHASES) ||
    !numberWithin(value.sampleTimeMs, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(viewport) ||
    viewport.length !== 8 ||
    viewport[0] !== 390 ||
    viewport[1] !== 780 ||
    !Array.from(viewport)
      .slice(0, 5)
      .every((entry) => numberWithin(entry, -10000000, 10000000)) ||
    !numberWithin(viewport[4], 0, 16) ||
    ![5, 6].every(
      (index) => viewport[index] === null || numberWithin(viewport[index], 0, 1000000)
    ) ||
    !(viewport[7] === null || numberWithin(viewport[7], 0, 16)) ||
    !exactKeys(profile, [
      'theme',
      'colorScheme',
      'reducedMotion',
      'languageIsFr',
      'timezoneIsParis',
    ]) ||
    !oneOf(profile.theme, ['light', 'dark', 'black', 'unknown']) ||
    !oneOf(profile.colorScheme, ['light', 'dark', 'unknown']) ||
    !['reducedMotion', 'languageIsFr', 'timezoneIsParis'].every(
      (name) => typeof profile[name] === 'boolean'
    ) ||
    !oneOf(value.fontStatus, ['loaded', 'loading', 'unknown']) ||
    !exactKeys(trigger, ['expanded', 'disabled', 'hover', 'focus']) ||
    !(typeof trigger.expanded === 'boolean' || trigger.expanded === 'unknown') ||
    !['disabled', 'hover', 'focus'].every((name) => typeof trigger[name] === 'boolean') ||
    !Array.isArray(nodes) ||
    nodes.length !== 4
  ) {
    schemaFailure()
  }
  for (const [index, node] of nodes.entries()) {
    if (
      !exactKeys(node, NODE_FIELDS) ||
      node.role !== ROLES[index] ||
      !numbers(node.rect, 4, -10000000, 10000000) ||
      !Array.isArray(node.rect) ||
      !node.rect.slice(2).every((entry) => numberWithin(entry, 0, 1000000)) ||
      !nullableNumbers(node.borderWidth, 0, 1000000) ||
      !nullableNumbers(node.radius, 0, 1000000) ||
      !(node.opacity === null || numberWithin(node.opacity, 0, 1)) ||
      !color(node.backgroundColor) ||
      !color(node.borderColor) ||
      !oneOf(node.backgroundKind, ['none', 'linear-gradient', 'other']) ||
      !oneOf(node.backgroundClip, ['border-box', 'padding-box', 'content-box', 'other']) ||
      !oneOf(node.transform, ['none', 'non-none', 'unknown']) ||
      !oneOf(node.filter, ['none', 'non-none', 'unknown'])
    ) {
      schemaFailure()
    }
  }
}

export function assertDiagnosticBudget(pngBytes: number, jsonBytes: number): void {
  if (!numberWithin(pngBytes, 0, 524288)) {
    throw new Error(`WORKSPACE_DIAGNOSTIC_PNG_BUDGET expected=524288 actual=${pngBytes}`)
  }
  if (!numberWithin(jsonBytes, 0, 16384)) {
    throw new Error(`WORKSPACE_DIAGNOSTIC_JSON_BUDGET expected=16384 actual=${jsonBytes}`)
  }
}

export function assertPhaseOrder(phases: readonly unknown[]): void {
  if (phases.length !== 4 || !phases.every((phase) => oneOf(phase, PHASES))) schemaFailure()
  for (const [index, expected] of PHASES.entries()) {
    if (phases[index] !== expected) {
      throw new Error(
        `WORKSPACE_DIAGNOSTIC_ORDER index=${index} expected=${expected} actual=${String(phases[index])}`
      )
    }
  }
}

export function encodeDiagnosticRecord(
  samples: unknown[],
  pngBytes: [number, number],
  primaryOutcome: 'passed' | 'failed'
): string {
  for (const entry of samples) assertSample(entry)
  assertPhaseOrder(samples.map((entry) => (entry as DiagnosticSample).phase))
  const encoded = JSON.stringify({
    schema: 1,
    primaryOutcome,
    guardHealth: 'passed',
    captureOptions: CAPTURE_OPTIONS,
    pngBytes,
    samples,
  })
  assertDiagnosticBudget(pngBytes[0] + pngBytes[1], Buffer.byteLength(encoded))
  return encoded
}

function guardHealth(): void {
  const refuse = (operation: () => void, expected: string) => {
    let refused = false
    try {
      operation()
    } catch (error) {
      refused = error instanceof Error && error.message === expected
    }
    if (!refused) throw new Error('WORKSPACE_DIAGNOSTIC_GUARD_HEALTH')
  }
  assertDiagnosticBudget(0, 0)
  refuse(
    () => assertDiagnosticBudget(524289, 0),
    'WORKSPACE_DIAGNOSTIC_PNG_BUDGET expected=524288 actual=524289'
  )
  assertDiagnosticBudget(0, 0)
  assertPhaseOrder(PHASES)
  refuse(
    () => assertPhaseOrder(['D0-after', 'D0-before', 'D1-before', 'D1-after']),
    'WORKSPACE_DIAGNOSTIC_ORDER index=0 expected=D0-before actual=D0-after'
  )
  assertPhaseOrder([...PHASES])
}

function assertPng(buffer: Buffer): void {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR' ||
    buffer.readUInt32BE(16) !== 390 ||
    buffer.readUInt32BE(20) !== 780
  ) {
    schemaFailure()
  }
}

export async function runWorkspaceVisualDiagnostic(
  primary: () => Promise<void>,
  ports: DiagnosticPorts
): Promise<void> {
  let primaryFailed = false
  let primaryError: unknown
  try {
    await primary()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }
  let outcome: Outcome = 'guard-health'
  let stage: Outcome = 'guard-health'
  let first: Buffer | undefined
  let second: Buffer | undefined
  let encoded: string | undefined
  const samples: unknown[] = []
  const read = async (phase: Phase) => {
    stage = 'sample'
    const value = await ports.sample(phase)
    stage = 'validation'
    assertSample(value)
    samples.push(value)
  }
  try {
    guardHealth()
    await read('D0-before')
    stage = 'capture'
    first = await ports.capture()
    stage = 'validation'
    assertPng(first)
    assertDiagnosticBudget(first.length, 0)
    await read('D0-after')
    await read('D1-before')
    stage = 'capture'
    second = await ports.capture()
    stage = 'validation'
    assertPng(second)
    assertDiagnosticBudget(first.length + second.length, 0)
    await read('D1-after')
    encoded = encodeDiagnosticRecord(
      samples,
      [first.length, second.length],
      primaryFailed ? 'failed' : 'passed'
    )
    stage = 'attachment'
    await ports.attach('workspace-diagnostic-D0', first, 'image/png')
    await ports.attach('workspace-diagnostic-D1', second, 'image/png')
    await ports.attach('workspace-diagnostic-state', encoded, 'application/json')
    outcome = 'complete'
  } catch {
    outcome = stage
    if (stage !== 'attachment') {
      try {
        await ports.attach(
          'workspace-diagnostic-state',
          JSON.stringify({
            schema: 1,
            outcome,
            primaryOutcome: primaryFailed ? 'failed' : 'passed',
          }),
          'application/json'
        )
      } catch {
        outcome = 'attachment'
      }
    }
  } finally {
    first = undefined
    second = undefined
    encoded = undefined
    samples.length = 0
  }
  try {
    ports.report(outcome)
  } catch {
    outcome = 'reporting'
  }
  if (primaryFailed) throw primaryError
  if (outcome !== 'complete') throw new Error(`WORKSPACE_VISUAL_DIAGNOSTIC_INCOMPLETE:${outcome}`)
}

async function readState(page: Page, phase: Phase): Promise<unknown> {
  return page.evaluate((label) => {
    const matches = document.querySelectorAll('main button[aria-haspopup="dialog"]')
    const trigger = matches[0]
    const header = trigger?.closest('header')
    const section = trigger?.closest('section')
    if (matches.length !== 1 || !(trigger instanceof HTMLButtonElement) || !header || !section) {
      throw new Error('WORKSPACE_DIAGNOSTIC_TARGET_UNAVAILABLE')
    }
    const px = (text: string) =>
      /^(?:\d+\.?\d*|\.\d+)px$/.test(text) ? Number(text.slice(0, -2)) : null
    const lengths = (values: string[]) => {
      const parsed = values.map(px)
      return parsed.some((value) => value === null) ? null : parsed
    }
    const rgba = (text: string) => {
      const match = /^rgba?\(([\d.,\s]+)\)$/.exec(text)
      if (match?.[1] === undefined) return null
      const values = match[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      return values.length === 3 ? [...values, 1] : values.length === 4 ? values : null
    }
    const nodes = [trigger, header, section, document.body].map((element, index) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        role: ['trigger', 'header', 'section', 'body'][index],
        rect: [box.x, box.y, box.width, box.height],
        borderWidth: lengths([
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ]),
        radius: lengths([
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ]),
        opacity: Number.isFinite(Number(style.opacity)) ? Number(style.opacity) : null,
        backgroundColor: rgba(style.backgroundColor),
        borderColor: rgba(style.borderTopColor),
        backgroundKind:
          style.backgroundImage === 'none'
            ? 'none'
            : style.backgroundImage.startsWith('linear-gradient(')
              ? 'linear-gradient'
              : 'other',
        backgroundClip: ['border-box', 'padding-box', 'content-box'].includes(style.backgroundClip)
          ? style.backgroundClip
          : 'other',
        transform:
          style.transform === '' ? 'unknown' : style.transform === 'none' ? 'none' : 'non-none',
        filter: style.filter === '' ? 'unknown' : style.filter === 'none' ? 'none' : 'non-none',
      }
    })
    const theme = document.documentElement.dataset.theme
    const expanded = trigger.getAttribute('aria-expanded')
    return {
      phase: label,
      sampleTimeMs: performance.now(),
      viewport: [
        innerWidth,
        innerHeight,
        scrollX,
        scrollY,
        devicePixelRatio,
        visualViewport?.width ?? null,
        visualViewport?.height ?? null,
        visualViewport?.scale ?? null,
      ],
      profile: {
        theme: theme === 'light' || theme === 'dark' || theme === 'black' ? theme : 'unknown',
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'unknown',
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        languageIsFr: navigator.language === 'fr-FR',
        timezoneIsParis: Intl.DateTimeFormat().resolvedOptions().timeZone === 'Europe/Paris',
      },
      fontStatus:
        document.fonts.status === 'loaded'
          ? 'loaded'
          : document.fonts.status === 'loading'
            ? 'loading'
            : 'unknown',
      trigger: {
        expanded: expanded === 'true' ? true : expanded === 'false' ? false : 'unknown',
        disabled: trigger.disabled,
        hover: trigger.matches(':hover'),
        focus: document.activeElement === trigger,
      },
      nodes,
    }
  }, phase)
}

export async function withWorkspaceVisualDiagnostic(
  page: Page,
  testInfo: TestInfo,
  primary: () => Promise<void>
): Promise<void> {
  const annotation = { type: 'workspace-visual-diagnostic', description: 'collecting' }
  let registered = false
  const register = () => {
    if (!registered) {
      testInfo.annotations.push(annotation)
      registered = true
    }
  }
  await runWorkspaceVisualDiagnostic(primary, {
    sample: (phase) => readState(page, phase),
    capture: () => page.screenshot(CAPTURE_OPTIONS),
    attach: async (name, body, contentType) => {
      register()
      await testInfo.attach(name, { body, contentType })
    },
    report: (outcome) => {
      register()
      annotation.description = outcome
      try {
        console.log(`WORKSPACE_VISUAL_DIAGNOSTIC outcome=${outcome}`)
      } catch {
        annotation.description = 'reporting'
        throw new Error('WORKSPACE_DIAGNOSTIC_REPORTING')
      }
    },
  })
}
