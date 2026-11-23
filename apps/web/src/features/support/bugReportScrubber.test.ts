import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLUR_CSS_FILTER,
  MAX_BUG_NOTE_LENGTH,
  MAX_SCREENSHOT_BYTES,
  blurScreenshotFile,
  boxBlurRgba,
  buildOutgoingBugReportPayload,
  detectBuildId,
  detectDeviceClass,
  inspectBugReportNote,
  isValidBuildId,
  isValidErrorCode,
  revokeScreenshotPreview,
  stripAndValidateImageBytes,
} from './bugReportScrubber'

function writeBe32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function writeLe32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ])
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, item) => acc + item.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const item of parts) {
    out.set(item, offset)
    offset += item.length
  }
  return out
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crc = new Uint8Array([0x01, 0x02, 0x03, 0x04])
  return concatBytes([writeBe32(data.length), typeBytes, data, crc])
}

function buildTestPng(extraChunks: readonly Uint8Array[] = []): Uint8Array {
  const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrPayload = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
  ])
  const idatPayload = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])
  return concatBytes([
    magic,
    makePngChunk('IHDR', ihdrPayload),
    ...extraChunks,
    makePngChunk('IDAT', idatPayload),
    makePngChunk('IEND', new Uint8Array(0)),
  ])
}

function makeRiffSubchunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(fourcc)
  const pad = payload.length % 2 === 1 ? new Uint8Array([0x00]) : new Uint8Array(0)
  return concatBytes([header, writeLe32(payload.length), payload, pad])
}

function buildTestWebp(subchunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(subchunks)
  return concatBytes([
    new TextEncoder().encode('RIFF'),
    writeLe32(4 + body.length),
    new TextEncoder().encode('WEBP'),
    body,
  ])
}

function makeCheckerboardRgba(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const val = (x + y) % 2 === 0 ? 0 : 255
      const p = (y * width + x) * 4
      buf[p] = val
      buf[p + 1] = val
      buf[p + 2] = val
      buf[p + 3] = 255
    }
  }
  return buf
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('bugReportScrubber allowlist & detectors', () => {
  it('validates strict release build_id and error_code formats and refuses tokens/UUIDs/IPs/slugs', () => {
    expect(isValidBuildId('web-0.52.0+sha.6a20bec')).toBe(true)
    expect(isValidBuildId('v1.2.3-rc.1')).toBe(true)
    expect(isValidBuildId('6a20bec4')).toBe(true)
    expect(isValidBuildId('dev')).toBe(true)
    expect(isValidBuildId('')).toBe(false)
    expect(isValidBuildId(['ghp', '1234567890abcdef'].join('_'))).toBe(false)
    expect(isValidBuildId(['syt', 'YWxpY2U', 'sample123'].join('_'))).toBe(false)
    expect(isValidBuildId('11111111-2222-4333-8444-555555555555')).toBe(false)
    expect(isValidBuildId('192.0.2.44')).toBe(false)
    expect(isValidBuildId('acme-corp', { organisationSlug: 'acme-corp' })).toBe(false)

    expect(isValidErrorCode('UI_REPORTED_ISSUE:502')).toBe(true)
    expect(isValidErrorCode('HTTP_503')).toBe(true)
    expect(isValidErrorCode('lowercase_forbidden')).toBe(false)
    expect(isValidErrorCode(['GHP', '1234567890ABCDEF'].join('_'))).toBe(false)
    expect(isValidErrorCode(['SYT', 'SAMPLE', 'VALUE123'].join('_'))).toBe(false)
    expect(isValidErrorCode('ERR_12025550142')).toBe(false)
    expect(isValidErrorCode('ERR_12345')).toBe(false)
    expect(isValidErrorCode('11111111-2222-4333-8444-555555555555')).toBe(false)
    expect(isValidErrorCode('ERR_11111111-2222-4333-8444-555555555555')).toBe(false)
    expect(isValidErrorCode('192.0.2.44')).toBe(false)
    expect(isValidErrorCode('ERR_192.0.2.44')).toBe(false)
    expect(isValidErrorCode('ERR_ACME-CORP', { organisationSlug: 'acme-corp' })).toBe(false)
  })

  it('detects fallback build_id and device classes across web and Tauri shells', () => {
    expect(detectBuildId('web-2026.11.0')).toBe('web-2026.11.0')
    expect(detectBuildId(['ghp', 'leakedValue12345'].join('_'))).toBe('web-0.1.1')

    expect(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri/2.0', 0)).toBe(
      'desktop-macos'
    )
    expect(detectDeviceClass('Mozilla/5.0 (Windows NT 10.0) Tauri/2.0', 0)).toBe('desktop-windows')
    expect(detectDeviceClass('Mozilla/5.0 (X11; Linux x86_64) Tauri/2.0', 0)).toBe('desktop-linux')
    expect(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5)).toBe('web-mobile')
    expect(detectDeviceClass('Mozilla/5.0 (X11; Linux x86_64)', 0)).toBe('web-desktop')
  })
})

describe('inspectBugReportNote secret blocker & PII scrubber', () => {
  it.each([
    ['bearer_token', ['Header leaked Bearer ', 'sample_session_credential'].join('')],
    [
      'jwt_token',
      ['Token eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'c2lnbmF0dXJl'].join('.'),
    ],
    ['api_credential', ['Stripe rk', 'live', '9876543210abcdef'].join('_')],
    ['api_credential', ['GitHub ghp', '1234567890abcdef'].join('_')],
    ['api_credential', ['GitHub PAT github', 'pat', '1234567890abcdef'].join('_')],
    ['api_credential', ['Synapse access_token=', 'syt_', 'YWxpY2U_sample'].join('')],
    ['api_credential', ['Synapse refresh syr', 'YWxpY2U', 'refresh'].join('_')],
    ['api_credential', ['Synapse media mda', 'YWxpY2U', 'media'].join('_')],
    ['api_credential', ['Bare assignment pass', 'word: ', 'sample_value'].join('')],
    ['api_credential', ['Bare tok', 'en=', 'SyntheticSecret'].join('')],
    ['api_credential', ['Header x-api-', 'key: ', 'SyntheticKey'].join('')],
    ['api_credential', ['Session coo', 'kie=', 'sid_sample'].join('')],
    ['api_credential', ['Analytics phc', '1234567890abcdef'].join('_')],
    ['api_credential', ['Scaleway SCW', 'SAMPLEKEY123456'].join('')],
    ['pem_material', ['Key -----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['invite_or_auth_link', 'Path /invitations/accept-member'],
    ['invite_or_auth_link', 'Query ?token=secret_query_value'],
    ['invite_or_auth_link', 'Fragment \x23token=secret_fragment_value'],
    ['url_forbidden', 'Visit https://console.kodera.example/workspace'],
    ['url_forbidden', 'FTP link ftp://files.kodera.example/archive'],
    ['url_forbidden', 'Protocol relative //evil.example/exfiltrate'],
    ['url_forbidden', ['Localhost //alice:', 'SyntheticPass', '@localhost/private'].join('')],
    ['url_forbidden', ['Open //alice:', 'SyntheticPass', '@localhost now'].join('')],
    ['url_forbidden', ['Open //alice:', 'SyntheticPass', '@[::1] now'].join('')],
    ['url_forbidden', 'Visit //example.com.'],
    ['url_forbidden', 'Deep link kodera://room/open'],
  ] as const)('blocks %s when present in note (%s)', (expectedReason, input) => {
    const result = inspectBugReportNote(input)
    expect(result.blockedReasons).toContain(expectedReason)
  })

  it('scrubs emails, UUIDs, IPs, phones, Matrix IDs, and caller slugs', () => {
    const note = [
      'Contact alice.martin@acme.example or +33 6 12 34 56 78.',
      'Org 11111111-2222-4333-8444-555555555555 on acme-corp / acme-tenant.',
      'Host 192.0.2.44 and 2001:db8::42.',
      'Matrix @alice:matrix.example in !room_alpha:matrix.example (\x23general:matrix.example) event $eventIdentifier99:matrix.example.',
    ].join(' ')

    const result = inspectBugReportNote(note, {
      organisationSlug: 'acme-corp',
      tenantSlug: 'acme-tenant',
    })

    expect(result.blockedReasons).toEqual([])
    expect(result.exceedsMaxLength).toBe(false)
    expect(result.sanitizedNote).not.toContain('alice.martin@acme.example')
    expect(result.sanitizedNote).not.toContain('6 12 34 56 78')
    expect(result.sanitizedNote).not.toContain('11111111-2222-4333-8444-555555555555')
    expect(result.sanitizedNote).not.toContain('acme-corp')
    expect(result.sanitizedNote).not.toContain('acme-tenant')
    expect(result.sanitizedNote).not.toContain('192.0.2.44')
    expect(result.sanitizedNote).not.toContain('2001:db8::42')
    expect(result.sanitizedNote).not.toContain('@alice:matrix.example')
    expect(result.sanitizedNote).not.toContain('!room_alpha:matrix.example')
    expect(result.sanitizedNote).not.toContain('general:matrix.example')
    expect(result.sanitizedNote).not.toContain('$eventIdentifier99')
    expect(result.sanitizedNote).toContain('[REDACTED_EMAIL]')
    expect(result.sanitizedNote).toContain('[REDACTED_PHONE]')
    expect(result.sanitizedNote).toContain('[REDACTED_UUID]')
    expect(result.sanitizedNote).toContain('[REDACTED_ORG]')
    expect(result.sanitizedNote).toContain('[REDACTED_TENANT]')
    expect(result.sanitizedNote).toContain('[REDACTED_IP]')
    expect(result.sanitizedNote).toContain('[REDACTED_MATRIX_ID]')
  })

  it('flags notes exceeding 500 characters', () => {
    const oversized = 'A'.repeat(MAX_BUG_NOTE_LENGTH + 1)
    expect(inspectBugReportNote(oversized).exceedsMaxLength).toBe(true)
  })
})

describe('stripAndValidateImageBytes & blurScreenshotFile', () => {
  it('strips PNG tEXt, iTXt, zTXt, eXIf, and tIME metadata chunks while keeping image data', () => {
    const authorText = makePngChunk('tEXt', new TextEncoder().encode('Author\0Alice Dupont'))
    const exifChunk = makePngChunk('eXIf', new TextEncoder().encode('MM\0*CameraSerial999'))
    const pngWithMeta = buildTestPng([authorText, exifChunk])

    const cleaned = stripAndValidateImageBytes(pngWithMeta, 'image/png')
    const ascii = new TextDecoder('latin1').decode(cleaned)
    expect(ascii).toContain('IHDR')
    expect(ascii).toContain('IDAT')
    expect(ascii).toContain('IEND')
    expect(ascii).not.toContain('tEXt')
    expect(ascii).not.toContain('eXIf')
    expect(ascii).not.toContain('Alice Dupont')
    expect(ascii).not.toContain('CameraSerial999')
  })

  it('strips WebP EXIF and XMP subchunks and clears VP8X metadata flags', () => {
    const vp8xPayload = new Uint8Array([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const vp8Bitstream = new Uint8Array([0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00])
    const exifPayload = new TextEncoder().encode('Exif\0\0OwnerSecret')
    const xmpPayload = new TextEncoder().encode('<x:xmpmeta>AuthorAlice</x:xmpmeta>')
    const webpWithMeta = buildTestWebp([
      makeRiffSubchunk('VP8X', vp8xPayload),
      makeRiffSubchunk('VP8 ', vp8Bitstream),
      makeRiffSubchunk('EXIF', exifPayload),
      makeRiffSubchunk('XMP ', xmpPayload),
    ])

    const cleaned = stripAndValidateImageBytes(webpWithMeta, 'image/webp')
    const ascii = new TextDecoder('latin1').decode(cleaned)
    expect(ascii).toContain('RIFF')
    expect(ascii).toContain('WEBP')
    expect(ascii).toContain('VP8X')
    expect(ascii).not.toContain('EXIF')
    expect(ascii).not.toContain('OwnerSecret')
    expect(ascii).not.toContain('AuthorAlice')
    expect(cleaned[20]! & 0x0c).toBe(0)
  })

  it('rejects oversized or invalid magic-byte screenshot buffers', () => {
    expect(() =>
      stripAndValidateImageBytes(new Uint8Array(MAX_SCREENSHOT_BYTES + 1), 'image/png')
    ).toThrow(/256 KiB/)
    expect(() => stripAndValidateImageBytes(new Uint8Array(40), 'image/png')).toThrow(/PNG magic/)
    expect(() => stripAndValidateImageBytes(new Uint8Array(40), 'image/webp')).toThrow(/WebP magic/)
  })

  it('layers CSS blur(12px) with 3x3 pixel box-blur and issues a revocable blob: preview URL', async () => {
    const cleanPng = buildTestPng([
      makePngChunk('tEXt', new TextEncoder().encode('Author\0HiddenName')),
    ])
    const closeSpy = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 280, height: 140, close: closeSpy })
    )
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:https://console.kodera.example/preview-uuid')
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const filterHistory: string[] = []
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        const state = {
          width: 8,
          height: 8,
          pixels: makeCheckerboardRgba(20, 10),
          filter: 'none',
        }
        const fakeCtx = {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          get filter() {
            return state.filter
          },
          set filter(val: string) {
            state.filter = val
            filterHistory.push(val)
          },
          drawImage: vi.fn((_src: unknown, ...rest: number[]) => {
            const targetW = rest.length >= 4 ? rest[rest.length - 2]! : state.width
            const targetH = rest.length >= 4 ? rest[rest.length - 1]! : state.height
            state.pixels = makeCheckerboardRgba(targetW, targetH)
          }),
          getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
            if (state.pixels.length !== w * h * 4) {
              state.pixels = makeCheckerboardRgba(w, h)
            }
            return { data: new Uint8ClampedArray(state.pixels), width: w, height: h }
          }),
          putImageData: vi.fn((imgData: { data: Uint8ClampedArray }) => {
            state.pixels = new Uint8ClampedArray(imgData.data)
          }),
        }
        return {
          get width() {
            return state.width
          },
          set width(v: number) {
            state.width = v
          },
          get height() {
            return state.height
          },
          set height(v: number) {
            state.height = v
          },
          getContext: () => fakeCtx,
          toBlob: (cb: (b: Blob | null) => void) => {
            cb(new Blob([new Uint8Array(cleanPng)], { type: 'image/png' }))
          },
        } as unknown as HTMLCanvasElement
      }
      return origCreateElement(tagName)
    }) as typeof document.createElement)

    const attachment = await blurScreenshotFile(
      new Blob([new Uint8Array(cleanPng)], { type: 'image/png' })
    )
    expect(filterHistory).toContain(BLUR_CSS_FILTER)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1)
    expect(attachment.previewObjectUrl).toBe('blob:https://console.kodera.example/preview-uuid')
    expect(attachment.previewObjectUrl.startsWith('data:')).toBe(false)
    expect(attachment.blurred).toBe(true)
    expect(atob(attachment.dataBase64)).not.toContain('HiddenName')

    revokeScreenshotPreview(attachment)
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith(
      'blob:https://console.kodera.example/preview-uuid'
    )
  })

  it('genuinely blurs sharp pixels when ctx.filter is undefined (Safari/iOS) and fails closed if unblurred', async () => {
    const cleanPng = buildTestPng()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 224, height: 224, close: vi.fn() })
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://console.kodera.example/safari')

    const stageBuffers: Uint8ClampedArray[] = []
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        const state = { width: 16, height: 16, pixels: makeCheckerboardRgba(16, 16) }
        // Deliberately omit `filter` property to simulate Safari/iOS without Canvas 2D filter support!
        const safariCtx = {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: vi.fn(() => {
            if (stageBuffers.length === 0) {
              state.pixels = makeCheckerboardRgba(state.width, state.height)
            }
          }),
          getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(state.pixels),
            width: w,
            height: h,
          })),
          putImageData: vi.fn((imgData: { data: Uint8ClampedArray }) => {
            state.pixels = new Uint8ClampedArray(imgData.data)
            stageBuffers.push(new Uint8ClampedArray(state.pixels))
          }),
        }
        return {
          get width() {
            return state.width
          },
          set width(v: number) {
            state.width = v
          },
          get height() {
            return state.height
          },
          set height(v: number) {
            state.height = v
          },
          getContext: () => safariCtx,
          toBlob: (cb: (b: Blob | null) => void) => {
            cb(new Blob([new Uint8Array(cleanPng)], { type: 'image/png' }))
          },
        } as unknown as HTMLCanvasElement
      }
      return origCreateElement(tagName)
    }) as typeof document.createElement)

    const result = await blurScreenshotFile(
      new Blob([new Uint8Array(cleanPng)], { type: 'image/png' })
    )
    expect(result.blurred).toBe(true)
    expect(stageBuffers).toHaveLength(1)
    const written = stageBuffers[0]!
    // Raw checkerboard had only 0 and 255; after 2-pass 3x3 boxBlurRgba, interior pixels converge near ~127!
    const interiorRed = written[(8 * 16 + 8) * 4]!
    expect(interiorRed).toBeGreaterThan(90)
    expect(interiorRed).toBeLessThan(165)

    // Verify fail-closed refusal when a broken 2D context ignores putImageData and leaves raw pixels intact.
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        const rawPixels = makeCheckerboardRgba(16, 16)
        const brokenCtx = {
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'high',
          drawImage: vi.fn(),
          getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(rawPixels),
            width: w,
            height: h,
          })),
          putImageData: vi.fn(), // no-op: readback still returns unblurred rawPixels!
        }
        return {
          width: 16,
          height: 16,
          getContext: () => brokenCtx,
          toBlob: (cb: (b: Blob | null) => void) =>
            cb(new Blob([new Uint8Array(cleanPng)], { type: 'image/png' })),
        } as unknown as HTMLCanvasElement
      }
      return origCreateElement(tagName)
    }) as typeof document.createElement)

    await expect(
      blurScreenshotFile(new Blob([new Uint8Array(cleanPng)], { type: 'image/png' }))
    ).rejects.toThrow(/failed closed/)
  })

  it('boxBlurRgba smooths sharp pixel edges deterministically', () => {
    const raw = makeCheckerboardRgba(8, 8)
    const { blurred, hadSpatialVariance, changedBytes } = boxBlurRgba(raw, 8, 8, 2)
    expect(hadSpatialVariance).toBe(true)
    expect(changedBytes).toBeGreaterThan(0)
    expect(blurred[(4 * 8 + 4) * 4]!).toBeGreaterThan(100)
    expect(blurred[(4 * 8 + 4) * 4]!).toBeLessThan(155)
  })

  it('builds closed outgoing BugReportCreateRequest payloads', () => {
    expect(
      buildOutgoingBugReportPayload({
        buildId: 'web-0.52.0',
        component: 'calls',
        errorCode: 'TURN_ICE_TIMEOUT',
        deviceClass: 'web-desktop',
        consent: false,
        sanitizedNote: '',
      })
    ).toEqual({
      build_id: 'web-0.52.0',
      component: 'calls',
      error_code: 'TURN_ICE_TIMEOUT',
      device_class: 'web-desktop',
      consent: false,
    })
  })
})
