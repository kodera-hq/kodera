// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual import-free entry helper without starting the page or importing auth.
const source = readFileSync(new URL('../entry-bootstrap.ts', import.meta.url), 'utf8')
const helper = source.slice(
  source.indexOf('export async function retireLegacyWorker'),
  source.indexOf('async function startEntry')
)
const javascript = ts.transpileModule(helper, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function fixture(controller: string | null = null, scripts: string[][] = []) {
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const worker = (url: string | undefined) => (url ? { scriptURL: url } : null)
  const registrations = scripts.map(([active, waiting, installing]) => ({
    active: worker(active),
    waiting: worker(waiting),
    installing: worker(installing),
    unregister: vi.fn(async () => true),
  }))
  const service = {
    controller: worker(controller ?? undefined),
    getRegistrations: vi.fn(async () => registrations),
  }
  const reload = vi.fn()
  const exports: { retireLegacyWorker?: () => Promise<string> } = {}
  runInNewContext(javascript, {
    exports,
    URL,
    navigator: { serviceWorker: service },
    sessionStorage: storage,
    location: { origin: 'https://community.example.test', reload },
  })
  return { values, storage, service, registrations, reload, run: exports.retireLegacyWorker! }
}
const legacy = 'https://community.example.test/mockServiceWorker.js'
describe('legacy simulation retirement', () => {
  it('unregisters active, waiting and installing legacy workers without touching unrelated origins or names', async () => {
    const f = fixture(null, [
      [legacy],
      ['', legacy],
      ['', '', legacy],
      ['https://community.example.test/offline.js'],
      ['https://foreign.example.test/mockServiceWorker.js'],
      ['https://community.example.test/mockServiceWorker.js.evil'],
    ])
    expect(await f.run()).toBe('ready')
    expect(f.registrations.map((r) => r.unregister.mock.calls.length)).toEqual([1, 1, 1, 0, 0, 0])
    expect(f.reload).not.toHaveBeenCalled()
  })
  it('removes only simulated storage while preserving PKCE, drafts and language', async () => {
    const f = fixture()
    for (const key of [
      'msw:scenarios',
      'msw:demo-disabled',
      'kodera.demo.view.community',
      'kodera.demo.local-workspaces',
      'oidc.state',
      'kodera.web.auth.realm',
      'order-draft:1',
      'console:language',
    ])
      f.values.set(key, 'keep')
    expect(await f.run()).toBe('ready')
    expect([...f.values.keys()]).toEqual([
      'oidc.state',
      'kodera.web.auth.realm',
      'order-draft:1',
      'console:language',
    ])
  })
  it('reloads once when controlled and blocks a second reload if control persists', async () => {
    const f = fixture(legacy, [[legacy]])
    expect(await f.run()).toBe('reload')
    expect(await f.run()).toBe('blocked')
    expect(f.reload).toHaveBeenCalledTimes(1)
    f.service.controller = null
    expect(await f.run()).toBe('ready')
    expect(f.values.size).toBe(0)
  })
  it('does not reload when storage cannot persist the loop guard', async () => {
    const f = fixture(legacy)
    f.storage.setItem = () => {
      throw new Error('storage denied')
    }
    expect(await f.run()).toBe('blocked')
    expect(f.reload).not.toHaveBeenCalled()
  })
  it('fails closed if worker retirement rejects while controlled', async () => {
    const f = fixture(legacy, [[legacy]])
    f.registrations[0]!.unregister.mockRejectedValueOnce(new Error('unavailable'))
    expect(await f.run()).toBe('blocked')
    expect(f.reload).not.toHaveBeenCalled()
  })
  it('does not prevent real authentication when storage is denied without mock control', async () => {
    const f = fixture()
    f.storage.removeItem = () => {
      throw new Error('storage denied')
    }
    expect(await f.run()).toBe('ready')
  })
})
