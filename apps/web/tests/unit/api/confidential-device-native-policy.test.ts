// @vitest-environment node
// Actual configured policy controls; no replacement parser or source rewriting.
import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const client = fileURLToPath(new URL('../../../src/api/client.ts', import.meta.url))
const factory = fileURLToPath(
  new URL('../../../src/features/confidential/device-worker-client.ts', import.meta.url)
)
const workerEntry = fileURLToPath(
  new URL('../../../src/features/confidential/device.worker.ts', import.meta.url)
)
const other = fileURLToPath(
  new URL('../../../src/features/confidential/not-the-factory.ts', import.meta.url)
)
const config = fileURLToPath(new URL('../../../eslint.config.js', import.meta.url))
const nativeRule = 'kodera/owner-claim-native-fetch'
const importRule = 'kodera/confidential-device-private-import'
const workerImportRule = 'kodera/confidential-device-worker-import'
const lint = new ESLint({ cwd: root, overrideConfigFile: config, fix: false })
const pristine = `function invokeConfidentialDeviceNative(cell: {url: string; init: RequestInit}) {
  return fetch(cell.url, cell.init)
}
void invokeConfidentialDeviceNative
`
// A direct call, rather than an escaping value reference, makes the helper live.
const healthy = pristine.replace(
  'void invokeConfidentialDeviceNative',
  "void invokeConfidentialDeviceNative({url:'https://core.invalid/api/v1/me',init:{method:'GET'}})"
)
const ownerAndDevice =
  healthy +
  `function invokeOwnerClaimNative() {
  return fetch('https://core.invalid/api/v1/owner-claims/actions/consume', {method:'POST'})
}
void invokeOwnerClaimNative()
`
async function one(instance: ESLint, source: string, filePath = client) {
  expect(await instance.isPathIgnored(filePath)).toBe(false)
  const results = await instance.lintText(source, { filePath })
  expect(results).toHaveLength(1)
  const result = results[0]
  if (!result) throw new Error('POLICY_RESULT_MISSING')
  expect(result.fatalErrorCount).toBe(0)
  expect(
    result.suppressedMessages.filter(
      (message) =>
        message.ruleId === nativeRule ||
        message.ruleId === importRule ||
        message.ruleId === workerImportRule
    )
  ).toEqual([])
  return result
}
async function accepted(source: string, filePath = client) {
  expect((await one(lint, source, filePath)).messages).toEqual([])
}
function refused(result: Awaited<ReturnType<typeof one>>, rule: string) {
  expect(result.messages.some((m) => m.ruleId === rule && m.severity === 2)).toBe(true)
}

describe('configured confidential device native exception', () => {
  it('accepts the actual client and one private callsite per named helper', async () => {
    await accepted(await readFile(client, 'utf8'))
    await accepted(ownerAndDevice)
  })
  it.each([
    [
      'async',
      healthy.replace(
        'function invokeConfidentialDeviceNative',
        'async function invokeConfidentialDeviceNative'
      ),
    ],
    [
      'generator',
      healthy.replace(
        'function invokeConfidentialDeviceNative',
        'function* invokeConfidentialDeviceNative'
      ),
    ],
    [
      'nested',
      healthy.replace(
        'return fetch(cell.url, cell.init)',
        'return (() => fetch(cell.url, cell.init))()'
      ),
    ],
    [
      'alias',
      healthy.replace(
        'return fetch(cell.url, cell.init)',
        'const saved = fetch; return saved(cell.url, cell.init)'
      ),
    ],
    ['global', healthy.replace('return fetch(', 'return globalThis.fetch(')],
    ['computed', healthy.replace('return fetch(', "return self['fetch'](")],
    ['arbitrary URL', healthy.replace('cell.url', "'https://outside.invalid/'")],
    ['arbitrary init', healthy.replace('cell.init)', "{method:'DELETE'})")],
    [
      'second',
      healthy.replace(
        'return fetch(cell.url, cell.init)',
        'void fetch(cell.url, cell.init); return fetch(cell.url, cell.init)'
      ),
    ],
    ['export', healthy + 'export {invokeConfidentialDeviceNative}\n'],
    ['value escape', pristine],
    ['shadow', healthy.replace('cell: {', 'fetch: typeof globalThis.fetch, cell: {')],
    [
      'inline disable',
      '/* eslint-disable kodera/owner-claim-native-fetch */\n' +
        healthy.replace('return fetch(', 'return globalThis.fetch('),
    ],
  ])('%s refuses its actual policy vector and restores healthy helper', async (_name, source) => {
    refused(await one(lint, source), nativeRule)
    await accepted(healthy)
  })
  it('detects disabled native enforcement as an unhealthy negative oracle', async () => {
    const disabled = new ESLint({
      cwd: root,
      overrideConfigFile: config,
      fix: false,
      overrideConfig: { files: ['src/api/client.ts'], rules: { [nativeRule]: 'off' } },
    })
    const bad = healthy.replace('cell.url', "'https://outside.invalid/'")
    const unguarded = await one(disabled, bad)
    expect(unguarded.messages).toEqual([])
    expect(() => refused(unguarded, nativeRule)).toThrow()
    refused(await one(lint, bad), nativeRule)
    await accepted(healthy)
  })
  it('strictly bans native and globalThis fetch in sibling src/api modules including dispatchGuard.ts', async () => {
    for (const relative of ['../../../src/api/dispatchGuard.ts', '../../../src/api/mutations.ts']) {
      const target = fileURLToPath(new URL(relative, import.meta.url))
      const configured: Linter.Config | undefined = await lint.calculateConfigForFile(target)
      expect(configured?.rules?.[nativeRule]).toBeUndefined()
      refused(
        await one(lint, "export const call = () => fetch('https://core.invalid/')\n", target),
        'no-restricted-globals'
      )
      refused(
        await one(
          lint,
          "export const call = () => globalThis.fetch('https://core.invalid/')\n",
          target
        ),
        'no-restricted-properties'
      )
    }
  })
})

const direct =
  "import {bindConfidentialDeviceDispatch} from '../../api/client'\nvoid bindConfidentialDeviceDispatch()\n"
describe('configured internal dispatcher import boundary', () => {
  it('audits actual production imports with the configured rule and inline disabling ignored', async () => {
    // This test is the non-overridable import-policy gate. Ordinary lint keeps
    // unrelated source suppressions; only this policy's diagnostics are judged.
    const configured: Linter.Config | undefined = await lint.calculateConfigForFile(other)
    if (!configured) throw new Error('DEVICE_POLICY_CONFIG_MISSING')
    const rule = configured.rules?.[importRule],
      workerRule = configured.rules?.[workerImportRule],
      plugin = configured.plugins?.kodera
    const severity = Array.isArray(rule) ? rule[0] : rule
    const workerSeverity = Array.isArray(workerRule) ? workerRule[0] : workerRule
    if (
      (severity !== 2 && severity !== 'error') ||
      (workerSeverity !== 2 && workerSeverity !== 'error') ||
      !rule ||
      !workerRule ||
      !plugin?.rules?.['confidential-device-private-import'] ||
      !plugin?.rules?.['confidential-device-worker-import'] ||
      !configured.languageOptions?.parser
    )
      throw new Error('DEVICE_POLICY_NOT_ENABLED')
    // Reuse the actual configured parser/plugin/rule setting. Omit unrelated
    // rules so this whole-project import gate does not run every other linter.
    const gate = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      fix: false,
      allowInlineConfig: false,
      overrideConfig: [
        {
          files: ['src/**/*.{ts,tsx}'],
          ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          languageOptions: configured.languageOptions,
          plugins: { kodera: plugin },
          rules: { [importRule]: rule, [workerImportRule]: workerRule },
        },
      ],
    })
    const hidden = '/* eslint-disable kodera/confidential-device-private-import */\n' + direct
    refused(await one(gate, hidden, other), importRule)
    const hiddenWorker =
      '/* eslint-disable kodera/confidential-device-worker-import */\n' +
      "import './device.worker'\n"
    refused(await one(gate, hiddenWorker, other), workerImportRule)
    // Preserve actual configured global ignores, especially the generated
    // megabyte-scale declaration, without copying a second ignore policy.
    const pending = [fileURLToPath(new URL('../../../src/', import.meta.url))]
    const files: string[] = []
    let entries = 0
    while (pending.length > 0) {
      const directory = pending.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 16384 || entry.isSymbolicLink()) throw new Error('DEVICE_POLICY_SOURCE_SET')
        const path = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(path)
        else if (entry.isFile() && /\.tsx?$/.test(path) && !(await lint.isPathIgnored(path)))
          files.push(path)
      }
    }
    expect(files.length).toBeGreaterThan(0)
    const results = await gate.lintFiles(files.sort())
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.fatalErrorCount).toBe(0)
      expect(
        result.messages.filter(
          (message) => message.ruleId === importRule || message.ruleId === workerImportRule
        )
      ).toEqual([])
    }
  }, 20_000)
  it('allows only the fixed factory direct import/call and erased type imports', async () => {
    await accepted(direct, factory)
    for (const path of ['/src/api/client.ts', '/src/api/client'])
      await accepted(direct.replace('../../api/client', path), factory)
    // This new rule must not disable existing unrelated source directives.
    await accepted(
      direct +
        '// eslint-disable-next-line @typescript-eslint/no-unused-vars\nconst intentional = 1\n',
      factory
    )
    await accepted(
      "import type * as Api from '../../api/client'\nexport type Snapshot = typeof Api\n",
      other
    )
  })
  it.each([
    ['root-relative named', direct.replace('../../api/client', '/src/api/client.ts'), other],
    ['root-relative extensionless', direct.replace('../../api/client', '/src/api/client'), other],
    [
      'root-relative re-export',
      "export {bindConfidentialDeviceDispatch} from '/src/api/client.ts'",
      other,
    ],
    ['root-relative namespace', "import * as api from '/src/api/client'; void api", other],
    ['root-relative dynamic', "const api = await import('/src/api/client.ts'); void api", other],
    ['root-relative require', "const api = require('/src/api/client'); void api", other],
    ['named outside', direct, other],
    [
      'renamed outside',
      direct
        .replaceAll('bindConfidentialDeviceDispatch', 'internal')
        .replace('{internal}', '{bindConfidentialDeviceDispatch as internal}'),
      other,
    ],
    [
      'named re-export',
      "export {bindConfidentialDeviceDispatch as escaped} from '../../api/client'",
      other,
    ],
    ['star re-export', "export * from '../../api/client'", other],
    ['namespace', "import * as api from '../../api/client'; void api.coreApi", other],
    ['dynamic namespace', "const api = await import('../../api/client'); void api", other],
    ['require namespace', "const api = require('../../api/client'); void api", other],
    [
      'factory value escape',
      "import {bindConfidentialDeviceDispatch as internal} from '../../api/client'; export {internal}",
      factory,
    ],
  ])('%s cannot expose internal transport', async (_name, source, path) => {
    refused(await one(lint, source, path), importRule)
    await accepted(direct, factory)
  })
  it('proves the private-import guard is actually configured', async () => {
    const disabled = new ESLint({
      cwd: root,
      overrideConfigFile: config,
      fix: false,
      overrideConfig: { files: ['src/**/*.ts'], rules: { [importRule]: 'off' } },
    })
    const unguarded = await one(disabled, direct, other)
    expect(unguarded.messages).toEqual([])
    expect(() => refused(unguarded, importRule)).toThrow()
    refused(await one(lint, direct, other), importRule)
  })
})

describe('configured worker-only module import boundary', () => {
  it('accepts actual device.worker.ts and the fixed worker URL constructor in device-worker-client.ts', async () => {
    await accepted(await readFile(workerEntry, 'utf8'), workerEntry)
    await accepted("import './attachment-crypto.worker'\n", workerEntry)
    await accepted(await readFile(factory, 'utf8'), factory)
  })
  it.each([
    ['relative attachment crypto', "import './attachment-crypto.worker'\n", other],
    ['factory attachment crypto', "import './attachment-crypto.worker.ts'\n", factory],
    [
      'alias attachment crypto',
      "void import('@/features/confidential/attachment-crypto.worker')\n",
      client,
    ],
    [
      'root-relative attachment crypto',
      "export * from '/src/features/confidential/attachment-crypto.worker.ts'\n",
      other,
    ],
    [
      'template attachment crypto',
      "const target = 'ts'; void import(`./attachment-crypto.worker.${target}`)\n",
      other,
    ],
    ['relative side-effect device.worker', "import './device.worker'\n", other],
    ['relative extension device.worker.ts', "import './device.worker.ts'\n", factory],
    [
      'vite query device.worker?worker',
      "import WorkerEntry from './device.worker?worker'\nvoid WorkerEntry\n",
      factory,
    ],
    ['alias device.worker', "import '@/features/confidential/device.worker'\n", client],
    [
      'root-relative device.worker',
      "import '/src/features/confidential/device.worker.ts'\n",
      client,
    ],
    ['dynamic device.worker', "void import('./device.worker')\n", other],
    ['require device.worker', "const mod = require('./device.worker'); void mod\n", other],
    ['re-export device.worker', "export * from './device.worker'\n", other],
    ['worker self-import device.worker', "import './device.worker'\n", workerEntry],
    [
      'relative native glue',
      "import initializeNative, {BrowserMlsHttpDevice} from './native/kodera_rs.js'\nvoid initializeNative\nvoid BrowserMlsHttpDevice\n",
      other,
    ],
    [
      'factory native glue',
      "import initializeNative from './native/kodera_rs.js'\nvoid initializeNative\n",
      factory,
    ],
    [
      'alias native glue',
      "import initializeNative from '@/features/confidential/native/kodera_rs.js'\nvoid initializeNative\n",
      client,
    ],
    [
      'root-relative native wasm url',
      "import wasmUrl from '/src/features/confidential/native/kodera_rs_bg.wasm?url'\nvoid wasmUrl\n",
      other,
    ],
    ['dynamic native glue', "void import('@/features/confidential/native/kodera_rs.js')\n", other],
    [
      'template dynamic native',
      "const target = 'kodera_rs.js'; void import(`./native/${target}`)\n",
      other,
    ],
    [
      're-export native glue',
      "export {BrowserMlsHttpDevice} from './native/kodera_rs.js'\n",
      other,
    ],
    ['require native glue', "const mod = require('./native/kodera_rs.js'); void mod\n", other],
    [
      'type import native glue',
      "import type {BrowserMlsHttpDevice} from './native/kodera_rs.js'\nexport type Actor = BrowserMlsHttpDevice\n",
      other,
    ],
    [
      'import-type query native glue',
      "export type Actor = typeof import('./native/kodera_rs.js')\n",
      other,
    ],
    [
      'relative device-cas-host',
      "import {createDeviceCasHost} from './device-cas-host'\nvoid createDeviceCasHost\n",
      other,
    ],
    [
      'factory device-cas-host',
      "import {createDeviceCasHost} from './device-cas-host.ts'\nvoid createDeviceCasHost\n",
      factory,
    ],
    [
      'alias device-cas-host',
      "import {createDeviceCasHost} from '@/features/confidential/device-cas-host'\nvoid createDeviceCasHost\n",
      client,
    ],
    [
      'root-relative device-cas-host',
      "import {createDeviceCasHost} from '/src/features/confidential/device-cas-host.ts'\nvoid createDeviceCasHost\n",
      other,
    ],
    ['dynamic device-cas-host', "void import('./device-cas-host')\n", other],
    ['re-export device-cas-host', "export {createDeviceCasHost} from './device-cas-host'\n", other],
    ['require device-cas-host', "const mod = require('./device-cas-host'); void mod\n", other],
    [
      'type import device-cas-host',
      "import type {DeviceCasHostError} from './device-cas-host'\nexport type HostError = DeviceCasHostError\n",
      other,
    ],
  ])('%s is rejected outside device.worker.ts', async (_name, source, path) => {
    refused(await one(lint, source, path), workerImportRule)
  })
  it('proves the worker-only import guard is actually configured', async () => {
    const sample =
      "import {createDeviceCasHost} from './device-cas-host'\nvoid createDeviceCasHost\n"
    const disabled = new ESLint({
      cwd: root,
      overrideConfigFile: config,
      fix: false,
      overrideConfig: { files: ['src/**/*.ts'], rules: { [workerImportRule]: 'off' } },
    })
    const unguarded = await one(disabled, sample, other)
    expect(unguarded.messages).toEqual([])
    expect(() => refused(unguarded, workerImportRule)).toThrow()
    refused(await one(lint, sample, other), workerImportRule)
  })
})

describe('collaboration and media worker isolation', () => {
  it.each(['collab-crypto', 'media-crypto'])(
    'refuses %s worker imports on the main thread',
    async (name) => {
      for (const source of [
        `import * as worker from './${name}.worker'; void worker`,
        `export * from './${name}.worker'`,
        `void import('./${name}.worker')`,
        `void import('@/features/confidential/${name}.worker.ts')`,
        `void import('/src/features/confidential/${name}.worker.ts')`,
        `void require('./${name}.worker')`,
      ])
        refused(await one(lint, source, other), workerImportRule)
    }
  )
})
