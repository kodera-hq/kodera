import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORG = '11111111-1111-4111-8111-111111111111'
const op = {
  method: 'post',
  path: '/organisations/{organisation_id}/workspace/attachments/uploads',
} as const
const upload = {
  params: { path: { organisation_id: ORG } },
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
  it('refuses synchronously at pre-check before any client middleware or transport runs', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { coreApi, NetworkError } = await import('./client')
    const { mutate } = await import('./mutations')
    const onRequest = vi.fn(({ request }) => request)
    coreApi().use({ onRequest })

    await expect(mutate(op, { ...upload, dispatchGuard: () => false })).rejects.toBeInstanceOf(
      NetworkError
    )
    expect(onRequest).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it('refuses metadata after policy retirement during asynchronous middleware', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { coreApi, NetworkError } = await import('./client')
    const { mutate } = await import('./mutations')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    coreApi().use({
      async onRequest({ request }) {
        entered()
        await gate
        return request
      },
    })
    let current = true
    const pending = mutate(op, { ...upload, dispatchGuard: () => current })
    const refused = expect(pending).rejects.toBeInstanceOf(NetworkError)
    await started
    current = false
    release()
    await refused
    expect(native).not.toHaveBeenCalled()
  })

  it('aborts attachment upload before retry dispatch when room classification changes across token refresh', async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'https://kodera.io/problems/unauthenticated',
          title: 'Expired token',
          status: 401,
        }),
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } }
      )
    )
    vi.stubGlobal('fetch', native)
    const { coreApi, NetworkError, setTokenProvider } = await import('./client')
    const { uploadAttachment } = await import(
      '../features/messaging/attachments/uploadAttachment'
    )
    let token = 'expired-token'
    setTokenProvider(() => token)

    let enteredRefresh!: () => void, releaseRefresh!: () => void
    const refreshing = new Promise<void>((resolve) => {
      enteredRefresh = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })

    coreApi().use({
      async onResponse({ request, response }) {
        if (response.status !== 401) return undefined
        enteredRefresh()
        await refreshGate
        token = 'fresh-token'
        const key = request.headers.get('Idempotency-Key') ?? ''
        const retried = await coreApi().POST(
          '/organisations/{organisation_id}/workspace/attachments/uploads',
          {
            params: { path: { organisation_id: ORG }, header: { 'Idempotency-Key': key } },
            body: upload.body,
          }
        )
        return retried.response
      },
    })

    let roomAllowsPlaintext = true
    const put = vi.fn<typeof fetch>()
    const file = new Blob(['0123456789'], { type: 'text/plain' })
    const pending = uploadAttachment({
      organisationId: ORG,
      file,
      checked: {
        ok: true,
        filename: 'private-document.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
      },
      put,
      mayUpload: () => roomAllowsPlaintext,
    })
    const refused = expect(pending).rejects.toBeInstanceOf(NetworkError)
    await refreshing
    roomAllowsPlaintext = false
    releaseRefresh()
    await refused

    expect(native).toHaveBeenCalledTimes(1)
    expect((native.mock.calls[0]![0] as Request).headers.get('Authorization')).toBe(
      'Bearer expired-token'
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('checks current policy at pre-check and final dispatch and preserves allowed request data', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({ accepted: true }))
    vi.stubGlobal('fetch', native)
    const { mutate } = await import('./mutations')
    const guard = vi.fn(() => true)
    await expect(mutate(op, { ...upload, dispatchGuard: guard })).resolves.toEqual({
      accepted: true,
    })
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(native).toHaveBeenCalledOnce()
    const request = native.mock.calls[0]![0] as Request
    expect(await request.json()).toEqual(upload.body)
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('fails closed if evaluating the live policy throws', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { mutate } = await import('./mutations')
    await expect(
      mutate(op, {
        ...upload,
        dispatchGuard: () => {
          throw new Error('Retired policy.')
        },
      })
    ).rejects.toThrow('The Core API could not be reached.')
    expect(native).not.toHaveBeenCalled()
  })

  it.each([
    [
      `https://other.example.test/api/v1/organisations/${ORG}/workspace/attachments/uploads`,
      'POST',
    ],
    ['https://core.example.test/api/v1/organisations', 'POST'],
    [
      `https://core.example.test/api/v1/organisations/${ORG}/workspace/attachments/uploads?extra=1`,
      'POST',
    ],
    [`https://core.example.test/api/v1/organisations/${ORG}/workspace/attachments/uploads`, 'GET'],
  ])('refuses an unrelated dispatch target or method: %s %s', async (url, method) => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { coreApi, NetworkError } = await import('./client')
    const { mutate } = await import('./mutations')
    coreApi().use({ onRequest: () => new Request(url, { method }) })
    await expect(mutate(op, { ...upload, dispatchGuard: () => true })).rejects.toBeInstanceOf(
      NetworkError
    )
    expect(native).not.toHaveBeenCalled()
  })

  it('refuses dispatchGuard on a non-attachment mutation path', async () => {
    const native = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', native)
    const { NetworkError } = await import('./client')
    const { mutate } = await import('./mutations')
    await expect(
      mutate(
        { method: 'post', path: '/auth/passport/switch-workspace' },
        {
          body: { organisation_id: ORG },
          dispatchGuard: () => true,
        }
      )
    ).rejects.toBeInstanceOf(NetworkError)
    expect(native).not.toHaveBeenCalled()
  })
})
