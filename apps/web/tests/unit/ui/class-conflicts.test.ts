import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'
import { classConflicts } from './classConflicts'

// Two colour classes for one property on one element: the stylesheet, not the
// source, picks the winner. See `classConflicts.ts` for what is resolved.
const SRC = join(import.meta.dirname, '..', '..', '..', 'src')
const FIXTURE = join(SRC, 'fixture.tsx')

const conflicts = (source: string) =>
  classConflicts(FIXTURE, source, SRC).map(({ classes }) => classes.join(' + '))

describe('colour class conflicts', () => {
  it('finds none on any element under src', () => {
    const files = sourceFiles(SRC).filter((path) => /(?<!\.test)\.tsx$/.test(path))
    const found = files.flatMap((path) =>
      classConflicts(path, readFileSync(path, 'utf8'), SRC).map(
        ({ line, classes }) =>
          `${relative(SRC, path).split('\\').join('/')}:${line} ${classes.join(' + ')}`
      )
    )
    expect(found).toEqual([])
    // Floor: 172 .tsx files measured, set at about 80%.
    expect(files.length).toBeGreaterThan(137)
  })

  it('finds a conditional state class beside an unconditional base', () => {
    expect(
      conflicts(
        "const BASE = 'border border-c-ink-4'\nexport const X = ({ on }: { on: boolean }) => <div className={cx(BASE, on && 'border-c-accent-ink')} />"
      )
    ).toEqual(['border-c-accent-ink + border-c-ink-4'])
  })

  it('finds a router link whose base colour meets its active colour', () => {
    expect(
      conflicts(
        'export const X = () => <Link className="text-c-ink" activeProps={{ className: \'text-c-accent-ink\' }} />'
      )
    ).toEqual(['text-c-accent-ink + text-c-ink'])
  })

  it('follows a record, a template and an import from another file', () => {
    expect(
      conflicts(
        [
          "import { LINK_TEXT } from '@/ui/linkText'",
          "const TONE = { a: 'bg-c-surface', b: 'bg-c-muted' }",
          "export const X = ({ t }: { t: 'a' | 'b' }) => <p className={`${TONE[t]} bg-c-sunken`} />",
          "export const Y = () => <a className={cx('text-c-ink-2', LINK_TEXT.standalone)} />",
        ].join('\n')
      )
    ).toEqual([
      'bg-c-sunken + bg-c-surface',
      'bg-c-muted + bg-c-sunken',
      'text-c-ink + text-c-ink-2',
    ])
  })

  it('leaves exclusive branches and different variants alone', () => {
    expect(
      conflicts(
        [
          "export const X = ({ on }: { on: boolean }) => <div className={cx('text-c-ink', on ? 'border-c-bad' : 'border-c-ink-4', 'hover:border-c-accent-ink data-[highlighted]:text-c-accent-ink')} />",
          "export const Y = () => <Link className=\"border\" activeProps={{ className: 'border-c-accent-ink' }} inactiveProps={{ className: 'border-transparent' }} />",
        ].join('\n')
      )
    ).toEqual([])
  })
})
