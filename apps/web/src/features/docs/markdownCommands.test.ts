import { describe, expect, it } from 'vitest'
import { applyMarkdownCommand, markdownState, safeDocumentLink } from './markdownCommands'

describe('selection-based document commands', () => {
  it('formats only the selected text and toggles it back', () => {
    const result = applyMarkdownCommand('one two three', 4, 7, 'bold')
    expect(result.text).toBe('one **two** three')
    expect(markdownState(result.text, result.start, result.end).bold).toBe(true)
    expect(applyMarkdownCommand(result.text, result.start, result.end, 'bold').text).toBe(
      'one two three'
    )
  })
  it('applies tasks to selected lines without touching adjacent paragraphs', () => {
    expect(applyMarkdownCommand('Intro\nFirst\nSecond\nEnd', 6, 18, 'task').text).toBe(
      'Intro\n- [ ] First\n- [ ] Second\nEnd'
    )
  })
  it('replaces heading levels and does not admit script links', () => {
    expect(applyMarkdownCommand('## Topic', 3, 8, 'h3').text).toBe('### Topic')
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://user:pass@example.com',
      '/relative',
    ])
      expect(safeDocumentLink(value)).toBeNull()
    expect(safeDocumentLink('https://example.com/review')).toBe('https://example.com/review')
  })
})
