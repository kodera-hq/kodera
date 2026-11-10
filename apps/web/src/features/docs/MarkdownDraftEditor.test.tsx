import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '../../i18n'
import { MarkdownDraftEditor } from './MarkdownDraftEditor'

function Editor({ initial = 'One selected passage.' }: { initial?: string }) {
  const [content, onChange] = useState(initial)
  return (
    <MarkdownDraftEditor
      title="Review"
      channelName="design"
      content={content}
      onChange={onChange}
    />
  )
}
it('formats the actual selection, retains focus and supports undo/redo', async () => {
  const user = userEvent.setup()
  render(<Editor />)
  const source = screen.getByRole('textbox', { name: 'Source Markdown' }) as HTMLTextAreaElement
  source.focus()
  source.setSelectionRange(4, 12)
  fireEvent.select(source)
  await user.click(screen.getByRole('button', { name: 'Gras' }))
  expect(source.value).toBe('One **selected** passage.')
  await waitFor(() => expect(source).toHaveFocus())
  expect(screen.getByRole('button', { name: 'Gras' })).toHaveAttribute('aria-pressed', 'true')
  await user.keyboard('{Control>}z{/Control}')
  expect(source.value).toBe('One selected passage.')
  await user.click(screen.getByRole('button', { name: 'Rétablir' }))
  expect(source.value).toBe('One **selected** passage.')
})
it('uses task inputs to change source and escapes HTML without inventing comment state', async () => {
  const user = userEvent.setup()
  const { container } = render(
    <Editor initial={'## Review\n- [ ] Check access\n==Shared==\n<img src=x onerror=alert(1)>'} />
  )
  await user.click(screen.getByRole('checkbox', { name: 'Check access' }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('- [x] Check access')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('mark')).toHaveTextContent('Shared')
  expect(screen.getByRole('button', { name: 'Mention' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Partager' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Commentaires' }))
  expect(screen.queryByRole('complementary', { name: 'Commentaires' })).toBeNull()
})
