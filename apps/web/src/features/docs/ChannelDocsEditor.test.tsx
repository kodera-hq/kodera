import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '../../i18n'
import { ChannelDocsEditor, createChannelDocsWorkspace } from './ChannelDocsEditor'

it('keeps documents isolated by channel and publishes the edited Markdown', async () => {
  const publish = vi.fn().mockResolvedValue(undefined)
  function Editor() {
    const [workspace, setWorkspace] = useState(createChannelDocsWorkspace)
    const [channelId, setChannelId] = useState('general')
    return (
      <>
        <button onClick={() => setChannelId(channelId === 'general' ? 'design' : 'general')}>
          Switch channel
        </button>
        <ChannelDocsEditor
          key={channelId}
          channelId={channelId}
          channelName={channelId}
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onPublish={publish}
        />
      </>
    )
  }
  const user = userEvent.setup()
  render(<Editor />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Modèle' }), 'meeting')
  await user.click(screen.getByRole('button', { name: 'Nouveau document' }))
  await user.click(screen.getByText('Documents du salon', { selector: 'summary' }))
  const title = screen.getByRole('textbox', { name: 'Titre du document' })
  await user.clear(title)
  await user.type(title, 'Planning')
  const body = screen.getByRole('textbox', { name: 'Source Markdown' })
  expect((body as HTMLTextAreaElement).value).toContain('## Ordre du jour')
  await user.clear(body)
  await user.type(body, '## Ready')
  await user.click(screen.getByRole('button', { name: 'Publier dans le salon' }))
  expect(publish).toHaveBeenCalledWith('Planning', '## Ready')
  expect(await screen.findByText('Document publié dans le salon.')).toHaveAttribute(
    'role',
    'status'
  )
  await user.click(screen.getByRole('button', { name: 'Switch channel' }))
  expect(screen.queryByRole('textbox', { name: 'Titre du document' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Switch channel' }))
  expect(screen.getByRole('textbox', { name: 'Source Markdown' })).toHaveValue('## Ready')
})

it('keeps a draft and reports publication failure truthfully', async () => {
  function Editor() {
    const [workspace, setWorkspace] = useState(createChannelDocsWorkspace)
    return (
      <ChannelDocsEditor
        channelId="general"
        channelName="general"
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
        onPublish={async () => {
          throw new Error('offline')
        }}
      />
    )
  }
  const user = userEvent.setup()
  render(<Editor />)
  await user.click(screen.getByRole('button', { name: 'Nouveau document' }))
  await user.click(screen.getByRole('button', { name: 'Publier dans le salon' }))
  expect(
    await screen.findByText('La publication a échoué. Votre brouillon est conservé.')
  ).toHaveAttribute('role', 'status')
  expect(screen.getByRole('textbox', { name: 'Source Markdown' })).toHaveValue('## Notes\n')
})
