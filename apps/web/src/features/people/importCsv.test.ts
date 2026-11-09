import { describe, expect, it } from 'vitest'
import { buildCsv } from './importCsv'

/** The cells of the single data row, without the byte-order mark or the line end. */
function cells(value: string): string {
  return buildCsv([[value]]).slice(1, -1)
}

describe('buildCsv formula neutralisation', () => {
  it.each(['=1+1', '+33 6 12', '-2', '@SUM(A1)'])(
    'prefixes a cell starting with a formula character: %s',
    (value) => {
      expect(cells(value)).toBe("'" + value)
    }
  )

  it.each([' =HYPERLINK("x")', '  +1', ' -1', '\u0000@cmd', '\n=1'])(
    'prefixes a formula hidden behind leading whitespace or a control character: %j',
    (value) => {
      expect(cells(value).replace(/^"/, '')).toMatch(/^'/)
    }
  )

  it.each(['\tdata', '\rdata'])(
    'prefixes a cell starting with a tab or a carriage return: %j',
    (value) => {
      expect(cells(value).replace(/^"/, '')).toMatch(/^'/)
    }
  )

  it.each(['julie@acme.fr', 'a=b', 'Leroy', ' Leroy', ''])(
    'leaves a plain cell alone: %j',
    (value) => {
      expect(cells(value)).toBe(value)
    }
  )

  it('still quotes a neutralised cell that holds a separator', () => {
    expect(cells('=1;2')).toBe(`"'=1;2"`)
  })
})
