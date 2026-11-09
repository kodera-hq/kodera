// @vitest-environment node

import { ESLint } from 'eslint'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type LintResult = Awaited<ReturnType<ESLint['lintText']>>[number]
type Diagnostic = {
  ruleId: string | null
  messageId: string | undefined
  severity: number
  message: string
  line: number
  column: number
}
type NegativeInput = {
  name: string
  source: string
  expected: Diagnostic[]
  filePath?: string
  inlineWarning?: boolean
}
type ConfigProjection = {
  rules: Record<string, unknown>
  linterOptions?: { noInlineConfig?: boolean }
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const clientPath = fileURLToPath(new URL('../../../src/api/client.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../../../eslint.config.js', import.meta.url))
const otherPath = fileURLToPath(
  new URL('../../../src/features/owner-claim/claimAttempt.ts', import.meta.url)
)
const policyRule = 'kodera/owner-claim-native-fetch'
const nativeCall =
  "fetch('https://core.invalid/api/v1/owner-claims/actions/consume', { method: 'POST' })"
const inlineDirective = '/* eslint-disable kodera/owner-claim-native-fetch */'
const lint = new ESLint({ cwd: root, overrideConfigFile: configPath, fix: false })

function withBody(body: string) {
  return `function invokeOwnerClaimNative() {
${body}
}
void invokeOwnerClaimNative()
export type NativeSignature = typeof invokeOwnerClaimNative
`
}

const pristine = withBody(`  return ${nativeCall}`)
const erased = `export type fetch = { method: 'GET' }
export type NativeSignature = typeof globalThis.fetch
`
const alias = withBody(`  const alias = fetch
  const kind = typeof fetch
  void kind
  return alias('https://core.invalid/api/v1/owner-claims/actions/consume', { method: 'POST' })`)
const outside = `${withBody('  return Promise.resolve(Response.json({}))')}void ${nativeCall}\n`
const asynchronous = pristine.replace(
  'function invokeOwnerClaimNative',
  'async function invokeOwnerClaimNative'
)
const nested = withBody(`  return (() => ${nativeCall})()`)
const second = withBody(`  const first = ${nativeCall}
  void first
  return ${nativeCall}`)
const globalMember = pristine.replace('return fetch(', 'return globalThis.fetch(')
const computedMember = pristine.replace('return fetch(', "return window['fetch'](")
const shadow = pristine.replace(
  'invokeOwnerClaimNative() {',
  'invokeOwnerClaimNative(fetch: typeof globalThis.fetch) {'
)
const exported = `${pristine}export { invokeOwnerClaimNative as exposedNative }
export default invokeOwnerClaimNative
`
const inlineDisabled = `${inlineDirective}\n${outside}`
const nonclient = `void ${nativeCall}\n`

function location(source: string, context: string, token: string) {
  const contextOffset = source.indexOf(context)
  expect(contextOffset).toBeGreaterThanOrEqual(0)
  expect(source.lastIndexOf(context)).toBe(contextOffset)
  const tokenOffset = context.indexOf(token)
  expect(tokenOffset).toBeGreaterThanOrEqual(0)
  const prefix = source.slice(0, contextOffset + tokenOffset)
  return {
    line: prefix.split('\n').length,
    column: prefix.length - prefix.lastIndexOf('\n'),
  }
}

function policyDiagnostic(
  source: string,
  marker: string,
  form: string,
  context: string,
  token: string
): Diagnostic {
  return {
    ruleId: policyRule,
    messageId: marker,
    severity: 2,
    message: `${marker} (${form})`,
    ...location(source, context, token),
  }
}

const outsideExpected = [
  policyDiagnostic(outside, 'NATIVE_FETCH_BOUNDARY', 'outside', `void ${nativeCall}`, 'fetch'),
]
const negatives: NegativeInput[] = [
  {
    name: 'N1 alias and runtime typeof',
    source: alias,
    expected: [
      policyDiagnostic(
        alias,
        'NATIVE_FETCH_REFERENCE',
        'value-alias',
        'const alias = fetch',
        'fetch'
      ),
      policyDiagnostic(
        alias,
        'NATIVE_FETCH_REFERENCE',
        'runtime-typeof',
        'const kind = typeof fetch',
        'fetch'
      ),
    ],
  },
  { name: 'N2 outside', source: outside, expected: outsideExpected },
  {
    name: 'N3 async',
    source: asynchronous,
    expected: [
      policyDiagnostic(
        asynchronous,
        'NATIVE_FETCH_BOUNDARY',
        'async',
        `return ${nativeCall}`,
        'fetch'
      ),
    ],
  },
  {
    name: 'N4 nested',
    source: nested,
    expected: [
      policyDiagnostic(
        nested,
        'NATIVE_FETCH_BOUNDARY',
        'nested',
        `return (() => ${nativeCall})()`,
        'fetch'
      ),
    ],
  },
  {
    name: 'N5 second callsite',
    source: second,
    expected: [
      policyDiagnostic(
        second,
        'NATIVE_FETCH_MULTIPLICITY',
        'second-callsite',
        `return ${nativeCall}`,
        'fetch'
      ),
    ],
  },
  {
    name: 'N6 global member',
    source: globalMember,
    expected: [
      policyDiagnostic(
        globalMember,
        'NATIVE_FETCH_ESCAPE',
        'global-object',
        'return globalThis.fetch(',
        'globalThis'
      ),
      policyDiagnostic(
        globalMember,
        'NATIVE_FETCH_ESCAPE',
        'fetch-property',
        'return globalThis.fetch(',
        'fetch'
      ),
    ],
  },
  {
    name: 'N7 computed member',
    source: computedMember,
    expected: [
      policyDiagnostic(
        computedMember,
        'NATIVE_FETCH_ESCAPE',
        'global-object',
        "return window['fetch'](",
        'window'
      ),
      policyDiagnostic(
        computedMember,
        'NATIVE_FETCH_ESCAPE',
        'fetch-property',
        "return window['fetch'](",
        "'fetch'"
      ),
    ],
  },
  {
    name: 'N8 runtime shadow',
    source: shadow,
    expected: [
      policyDiagnostic(
        shadow,
        'NATIVE_FETCH_SHADOW',
        'binding',
        'fetch: typeof globalThis.fetch',
        'fetch'
      ),
    ],
  },
  {
    name: 'N9 indirect and default runtime exports',
    source: exported,
    expected: [
      policyDiagnostic(
        exported,
        'NATIVE_FETCH_BOUNDARY',
        'indirect-export',
        'export { invokeOwnerClaimNative as exposedNative }',
        'invokeOwnerClaimNative'
      ),
      policyDiagnostic(
        exported,
        'NATIVE_FETCH_BOUNDARY',
        'default-export',
        'export default invokeOwnerClaimNative',
        'invokeOwnerClaimNative'
      ),
    ],
  },
  {
    name: 'N10 inline disable',
    source: inlineDisabled,
    inlineWarning: true,
    expected: [
      policyDiagnostic(
        inlineDisabled,
        'NATIVE_FETCH_BOUNDARY',
        'outside',
        `void ${nativeCall}`,
        'fetch'
      ),
    ],
  },
  {
    name: 'N11 other production path',
    source: nonclient,
    filePath: otherPath,
    expected: [
      {
        ruleId: 'no-restricted-globals',
        messageId: 'customMessage',
        severity: 2,
        message:
          "Unexpected use of 'fetch'. Use the generated Core API client (src/api). ADR-0003: the console talks to the Core API and nothing else.",
        ...location(nonclient, `void ${nativeCall}`, 'fetch'),
      },
    ],
  },
]

function severity(setting: unknown) {
  return Array.isArray(setting) ? setting[0] : setting
}

function diagnostics(result: LintResult, level: number): Diagnostic[] {
  return result.messages
    .filter((message) => message.severity === level)
    .map((message) => ({
      ruleId: message.ruleId,
      messageId: message.messageId,
      severity: message.severity,
      message: message.message,
      line: message.line,
      column: message.column,
    }))
}

async function lintOne(instance: ESLint, source: string, filePath = clientPath) {
  expect(await instance.isPathIgnored(filePath)).toBe(false)
  const results = await instance.lintText(source, { filePath })
  expect(results).toHaveLength(1)
  const result = results[0]
  if (!result) throw new Error('NATIVE_POLICY_RESULT_MISSING')
  expect(result.filePath).toBe(filePath)
  expect(result.fatalErrorCount).toBe(0)
  expect(result.messages.some((message) => message.fatal)).toBe(false)
  expect(result.suppressedMessages).toEqual([])
  expect(result.errorCount).toBe(diagnostics(result, 2).length)
  expect(result.warningCount).toBe(diagnostics(result, 1).length)
  return result
}

function assertAccepted(result: LintResult) {
  expect(result.messages).toEqual([])
  expect(result.errorCount).toBe(0)
  expect(result.warningCount).toBe(0)
}

class MissingPolicyDiagnostic extends Error {
  constructor(readonly expected: Diagnostic[]) {
    super('NATIVE_POLICY_GUARD_DISABLED')
  }
}

function assertRefusal(result: LintResult, expected: Diagnostic[], inlineWarning = false) {
  const errors = diagnostics(result, 2)
  if (errors.length === 0) throw new MissingPolicyDiagnostic(expected)
  expect(errors).toEqual(expected)
  const warnings = diagnostics(result, 1)
  if (inlineWarning) {
    expect(warnings).toEqual([
      {
        ruleId: null,
        messageId: undefined,
        severity: 1,
        message: expect.stringMatching(
          /^'\/\* eslint-disable kodera\/owner-claim-native-fetch \*\/' has no effect because you have 'noInlineConfig' setting in your config(?: \(kodera\/owner-claim-native-boundary\))?\.$/
        ),
        line: 1,
        column: 1,
      },
    ])
  } else {
    expect(warnings).toEqual([])
  }
}

let originalClient: string
let originalConfig: string

beforeAll(async () => {
  originalClient = await readFile(clientPath, 'utf8')
  originalConfig = await readFile(configPath, 'utf8')
  expect(await lint.isPathIgnored(clientPath)).toBe(false)
  expect(await lint.isPathIgnored(otherPath)).toBe(false)
  const clientConfig = (await lint.calculateConfigForFile(clientPath)) as
    ConfigProjection | undefined
  const otherConfig = (await lint.calculateConfigForFile(otherPath)) as ConfigProjection | undefined
  expect(clientConfig).toBeDefined()
  expect(otherConfig).toBeDefined()
  if (!clientConfig || !otherConfig) throw new Error('NATIVE_POLICY_CONFIG_MISSING')
  expect(severity(clientConfig.rules[policyRule])).toBe(2)
  expect(severity(clientConfig.rules['no-restricted-globals'])).toBe(0)
  expect(clientConfig.linterOptions?.noInlineConfig).toBe(true)
  expect(severity(otherConfig.rules['no-restricted-globals'])).toBe(2)
  expect(otherConfig.rules[policyRule]).toBeUndefined()
  expect(negatives).toHaveLength(11)
})

afterAll(async () => {
  expect(await readFile(clientPath, 'utf8')).toBe(originalClient)
  expect(await readFile(configPath, 'utf8')).toBe(originalConfig)
})

describe('the actual configured native consume reference policy', () => {
  it('P0 accepts the actual current client source', async () => {
    assertAccepted(await lintOne(lint, originalClient))
  })

  it('P1 accepts one private synchronous native callsite and its erased type export', async () => {
    assertAccepted(await lintOne(lint, pristine))
  })

  it('P2 accepts erased-only fetch declarations and queries', async () => {
    assertAccepted(await lintOne(lint, erased))
  })

  it.each(negatives)('$name refuses its exact policy vector and restores P1', async (input) => {
    const result = await lintOne(lint, input.source, input.filePath)
    assertRefusal(result, input.expected, input.inlineWarning)
    assertAccepted(await lintOne(lint, pristine))
  })

  it('refuses a disabled guard itself, then restores actual N2 and pristine P1', async () => {
    const disabled = new ESLint({
      cwd: root,
      overrideConfigFile: configPath,
      fix: false,
      overrideConfig: {
        files: ['src/api/client.ts'],
        rules: { [policyRule]: 'off' },
      },
    })
    const disabledResult = await lintOne(disabled, outside)
    assertAccepted(disabledResult)
    try {
      assertRefusal(disabledResult, outsideExpected)
      throw new Error('NATIVE_POLICY_HEALTH_NOT_REFUSED')
    } catch (error) {
      if (!(error instanceof MissingPolicyDiagnostic)) throw error
      expect(error.message).toBe('NATIVE_POLICY_GUARD_DISABLED')
      expect(error.expected).toEqual(outsideExpected)
    }
    assertRefusal(await lintOne(lint, outside), outsideExpected)
    assertAccepted(await lintOne(lint, pristine))
  })
})
