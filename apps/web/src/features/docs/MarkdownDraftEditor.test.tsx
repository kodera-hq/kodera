import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '../../i18n'
import { studioMessages } from '../workspace/studioMessages'
import type { DocumentComment } from './documentComments'
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
  expect(screen.queryByRole('button', { name: 'Partager' })).toBeNull()
  expect(screen.getByText(studioMessages.fr.shareGap)).toBeVisible()
  expect(screen.getByText(studioMessages.fr.commentGap)).toBeVisible()
  expect(screen.queryByText(studioMessages.fr.noComments)).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Commentaires' }))
  expect(screen.queryByRole('complementary', { name: 'Commentaires' })).toBeNull()
})

function ReviewEditor() {
  const [content, onChange] = useState('One selected passage.')
  const [comments, onCommentsChange] = useState<readonly DocumentComment[]>([])
  return (
    <MarkdownDraftEditor
      title="Review"
      channelName="design"
      content={content}
      onChange={onChange}
      members={[{ userId: 'claire', name: 'Claire Mercer' }]}
      author={{ userId: 'reviewer', name: 'Reviewer' }}
      commentThreads={comments}
      onCommentsChange={onCommentsChange}
    />
  )
}

it('anchors comments to the selected quote and can resolve and reopen them without changing source', async () => {
  const user = userEvent.setup()
  render(<ReviewEditor />)
  const source = screen.getByRole('textbox', { name: 'Source Markdown' }) as HTMLTextAreaElement
  source.focus()
  source.setSelectionRange(4, 12)
  fireEvent.select(source)
  await user.type(
    screen.getByRole('textbox', { name: 'Votre commentaire' }),
    'Please clarify this.'
  )
  await user.click(screen.getByRole('button', { name: 'Ajouter un commentaire' }))
  expect(screen.getByText('Please clarify this.')).toBeInTheDocument()
  expect(screen.getByText('Reviewer')).toBeInTheDocument()
  expect(screen.getAllByText('selected', { selector: 'blockquote' })).toHaveLength(2)
  expect(source).toHaveValue('One selected passage.')
  await user.click(screen.getByRole('button', { name: 'Résoudre' }))
  expect(screen.getByRole('button', { name: 'Rouvrir' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: 'Rouvrir' }))
  expect(screen.getByRole('button', { name: 'Résoudre' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('button', { name: 'Ajouter un commentaire' })).toBeDisabled()
})

it('inserts a channel member at the selection, restores focus and supports undo', async () => {
  const user = userEvent.setup()
  render(<ReviewEditor />)
  const source = screen.getByRole('textbox', { name: 'Source Markdown' }) as HTMLTextAreaElement
  source.focus()
  source.setSelectionRange(4, 12)
  fireEvent.select(source)
  await user.click(screen.getByRole('button', { name: 'Mention' }))
  await user.click(screen.getByRole('button', { name: 'Claire Mercer' }))
  expect(source).toHaveValue('One @Claire Mercer  passage.')
  await waitFor(() => expect(source).toHaveFocus())
  await user.click(screen.getByRole('button', { name: 'Annuler' }))
  expect(source).toHaveValue('One selected passage.')
})
