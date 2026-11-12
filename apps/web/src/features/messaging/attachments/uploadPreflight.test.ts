import { describe, expect, it } from 'vitest'
import { cleanFilename, MAX_ATTACHMENT_BYTES, preflight } from './uploadPreflight'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0)
const PDF = text('%PDF-1.7\n')
const WEBP = text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
const GIF = text('GIF89a')

const file = (name: string, type: string, size = 1024) => ({ name, type, size })

describe('what may be attached', () => {
  it('accepts the contract types that start like what they claim', () => {
    expect(preflight(file('photo.png', 'image/png'), PNG)).toEqual({
      ok: true,
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 1024,
    })
    expect(preflight(file('a.jpg', 'image/jpeg'), JPEG).ok).toBe(true)
    expect(preflight(file('a.webp', 'image/webp'), WEBP).ok).toBe(true)
    expect(preflight(file('a.gif', 'image/gif'), GIF).ok).toBe(true)
    expect(preflight(file('cr.pdf', 'application/pdf'), PDF).ok).toBe(true)
    expect(preflight(file('notes.txt', 'text/plain'), text('bonjour'))).toMatchObject({
      ok: true,
      contentType: 'text/plain',
    })
  })

  it('sends any other harmless file as opaque bytes', () => {
    expect(
      preflight(file('budget.xlsx', 'application/vnd.ms-excel'), bytes(0x50, 0x4b, 3, 4))
    ).toMatchObject({ ok: true, contentType: 'application/octet-stream' })
  })

  it('refuses an empty file and one over 25 MiB', () => {
    expect(preflight(file('a.txt', 'text/plain', 0), text(''))).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(preflight(file('a.bin', '', MAX_ATTACHMENT_BYTES + 1), bytes(1))).toEqual({
      ok: false,
      reason: 'too-large',
    })
    expect(preflight(file('a.bin', '', MAX_ATTACHMENT_BYTES), bytes(1)).ok).toBe(true)
  })

  it('refuses active content by its type or by any of its extensions', () => {
    for (const [name, type] of [
      ['page.html', 'text/html'],
      ['logo.svg', 'image/svg+xml'],
      ['logo.svg', ''],
      ['app.js', 'text/javascript'],
      ['rapport.html.pdf', 'application/pdf'],
      ['setup.exe', 'application/octet-stream'],
      ['macro.docm', 'application/octet-stream'],
      ['innocent.bin', 'application/xhtml+xml'],
    ] as const) {
      expect(preflight(file(name, type), PDF)).toEqual({ ok: false, reason: 'active-content' })
    }
  })

  it('refuses a file that claims to be an image or a PDF without starting like one', () => {
    expect(preflight(file('photo.png', 'image/png'), text('<html>'))).toEqual({
      ok: false,
      reason: 'type-mismatch',
    })
    expect(preflight(file('cr.pdf', 'application/pdf'), PNG)).toEqual({
      ok: false,
      reason: 'type-mismatch',
    })
  })

  it('refuses markup hidden under a harmless name', () => {
    for (const head of [
      '<!DOCTYPE html><p>',
      '\uFEFF  <svg onload=x>',
      '<script>',
      '<?xml version="1.0"?>',
    ]) {
      expect(preflight(file('notes.txt', 'text/plain'), text(head))).toEqual({
        ok: false,
        reason: 'active-content',
      })
    }
  })

  it('keeps a name without its path, control or direction characters', () => {
    expect(cleanFilename('C:\\Users\\x\\rapport.pdf')).toBe('rapport.pdf')
    expect(cleanFilename('../../etc/passwd')).toBe('passwd')
    expect(cleanFilename('facture\u202Efdp.exe')).toBe('facturefdp.exe')
    expect(cleanFilename('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(cleanFilename('...')).toBe('file')
    expect([...cleanFilename('é'.repeat(400))]).toHaveLength(255)
  })

  it('reads a direction override in a name as the extension it hides', () => {
    // « facture\u202Efdp.exe » shows as « facture exe.pdf » but is an executable.
    expect(preflight(file('facture\u202Efdp.exe', 'application/pdf'), PDF)).toEqual({
      ok: false,
      reason: 'active-content',
    })
  })
})
