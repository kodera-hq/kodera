import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const op = {
  method: 'post',
  path: '/organisations/{organisation_id}/workspace/attachments/uploads',
} as const
const upload = {
  params: { path: { organisation_id: '11111111-1111-4111-8111-111111111111' } },
  body: {
    filename: 'private-document.txt',
    contentType: 'text/plain' as const,
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
  },
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.example.test/api/v1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('mutation dispatch policy', () => {
  it('refuses metadata after policy retirement during asynchronous middleware', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { coreApi, NetworkError } = await import('./client')
    const { mutate } = await import('./mutations')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    coreApi().use({ async onRequest({ request }) { entered(); await gate; return request } })
    let current = true
    const pending = mutate(op, { ...upload, dispatchGuard: () => current })
    const refused = expect(pending).rejects.toBeInstanceOf(NetworkError)
    await started
    current = false
    release()
    await refused
    expect(native).not.toHaveBeenCalled()
  })

  it('checks current policy once at native dispatch and preserves allowed request data', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({ accepted: true }))
    vi.stubGlobal('fetch', native)
    const { mutate } = await import('./mutations')
    const guard = vi.fn(() => true)
    await expect(mutate(op, { ...upload, dispatchGuard: guard })).resolves.toEqual({ accepted: true })
    expect(guard).toHaveBeenCalledOnce()
    expect(native).toHaveBeenCalledOnce()
    const request = native.mock.calls[0]![0] as Request
    expect(await request.json()).toEqual(upload.body)
    expect(request.method).toBe('POST')
    expect(request.headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('fails closed if evaluating the live policy throws', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { mutate } = await import('./mutations')
    await expect(mutate(op, {
      ...upload,
      dispatchGuard: () => { throw new Error('Retired policy.') },
    })).rejects.toThrow('The Core API could not be reached.')
    expect(native).not.toHaveBeenCalled()
  })

  it.each([
    ['https://other.example.test/api/v1/organisations/11111111-1111-4111-8111-111111111111/workspace/attachments/uploads', 'POST'],
    ['https://core.example.test/api/v1/organisations', 'POST'],
    ['https://core.example.test/api/v1/organisations/11111111-1111-4111-8111-111111111111/workspace/attachments/uploads?extra=1', 'POST'],
    ['https://core.example.test/api/v1/organisations/11111111-1111-4111-8111-111111111111/workspace/attachments/uploads', 'GET'],
  ])('refuses an unrelated dispatch target or method: %s %s', async (url, method) => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { guardCoreDispatch } = await import('./dispatchGuard')
    expect(() => guardCoreDispatch(() => true)(new Request(url, { method }))).toThrow('Request context changed.')
    expect(native).not.toHaveBeenCalled()
  })
})
