import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import '../../i18n'
import { RichComposerInput } from './RichComposerInput'
import { MessageText } from '../espace/MessageText'
import { formatSelection, stagedFiles, transformOutsideCode, caretInsideCode } from './formatting'
function Composer({
  sent = vi.fn(),
  readOnly = false,
}: {
  sent?: (body: string) => void
  readOnly?: boolean
}) {
  const [value, change] = useState('')
  const [staged, setStaged] = useState(false)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!staged) sent(value)
      }}
    >
      <label htmlFor="compose">Message</label>
      <RichComposerInput
        id="compose"
        value={value}
        onValueChange={change}
        members={[]}
        listLabel="Members"
        emojiListLabel="Emoji"
        onStagingChange={setStaged}
        readOnly={readOnly}
      />
      <button type="submit">Send</button>
    </form>
  )
}
describe('live rich composer', () => {
  it('preserves selection with formatting shortcuts and Shift Enter; plain Enter submits', async () => {
    const user = userEvent.setup()
    const sent = vi.fn()
    render(<Composer sent={sent} />)
    const field = screen.getByRole('textbox', { name: 'Message' })
    await user.type(field, 'hello')
    ;(field as HTMLTextAreaElement).setSelectionRange(0, 5)
    await user.keyboard('{Control>}b{/Control}')
    expect(field).toHaveValue('**hello**')
    await waitFor(() => expect((field as HTMLTextAreaElement).selectionStart).toBe(2))
    await user.keyboard('{End}{Shift>}{Enter}{/Shift}next')
    expect(field).toHaveValue('**hello**\nnext')
    await user.keyboard('{Enter}')
    expect(sent).toHaveBeenCalledWith('**hello**\nnext')
  })
  it('inserts accessible slash drafts and dismisses without losing text', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const field = screen.getByRole('textbox', { name: 'Message' })
    await user.type(field, '/')
    expect(screen.getAllByRole('option')).toHaveLength(5)
    expect(field).toHaveAttribute('aria-controls')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(field).toHaveValue('Question ?\n- Choix 1\n- Choix 2')
    await user.clear(field)
    await user.type(field, '/topic')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field).toHaveValue('/topic')
  })
  it('stages drops locally, never silently sends files, and allows explicit removal', async () => {
    const user = userEvent.setup()
    const sent = vi.fn()
    render(<Composer sent={sent} />)
    const field = screen.getByRole('textbox', { name: 'Message' })
    await user.type(field, 'draft')
    fireEvent.drop(field, {
      dataTransfer: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(screen.getByText(/uniquement des aperçus/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(sent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Retirer notes.txt' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(sent).toHaveBeenCalledWith('draft')
  })
  it('does not change a withdrawn/read-only draft', async () => {
    const user = userEvent.setup()
    render(<Composer readOnly />)
    await user.click(screen.getByRole('textbox'))
    await user.keyboard('{Control>}b{/Control}')
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Gras' })).toBeDisabled()
  })
  it('opens the supplied active-room invitation action instead of sending slash text', async () => {
    const user = userEvent.setup()
    const invite = vi.fn()
    const change = vi.fn()
    render(
      <RichComposerInput
        id="invite-composer"
        aria-label="Invite composer"
        value="/invite"
        onValueChange={change}
        members={[]}
        listLabel="Members"
        emojiListLabel="Emoji"
        onStagingChange={vi.fn()}
        onInvite={invite}
      />
    )
    await user.click(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(invite).toHaveBeenCalledOnce())
    expect(change).toHaveBeenCalledWith('')
  })
  it('keeps the field focused when room changes and discards local attachments', async () => {
    const user = userEvent.setup()
    const props = {
      id: 'scope-composer',
      value: '',
      onValueChange: vi.fn(),
      members: [],
      listLabel: 'Members',
      emojiListLabel: 'Emoji',
      onStagingChange: vi.fn(),
    }
    const { rerender } = render(<RichComposerInput {...props} scope="room-a" />)
    const field = screen.getByRole('textbox')
    await user.click(field)
    fireEvent.drop(field, { dataTransfer: { files: [new File(['x'], 'local.txt')] } })
    rerender(<RichComposerInput {...props} scope="room-b" />)
    expect(field).toHaveFocus()
    expect(screen.queryByText(/local.txt/)).toBeNull()
    rerender(<RichComposerInput {...props} scope="room-a" />)
    expect(screen.queryByText(/local.txt/)).toBeNull()
  })
  it('preserves literal code while transforming prose shortcodes', () => {
    expect(
      transformOutsideCode('`:smile:` :smile:', (text) => text.replaceAll(':smile:', '😀'))
    ).toBe('`:smile:` 😀')
    expect(caretInsideCode('```js\n:smile:', 14)).toBe(true)
    expect(caretInsideCode('`code` plain', 12)).toBe(false)
  })
  it('decodes local raster previews into pixels and closes the bitmap', async () => {
    const draw = vi.fn()
    const close = vi.fn()
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
    const decode = vi.fn().mockResolvedValue({ width: 2, height: 2, close })
    vi.stubGlobal('createImageBitmap', decode)
    try {
      render(<Composer />)
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: { files: [new File(['pixels'], 'picture.png', { type: 'image/png' })] },
      })
      await waitFor(() => expect(draw).toHaveBeenCalledOnce())
      expect(close).toHaveBeenCalledOnce()
      expect(decode).toHaveBeenCalledWith(expect.any(File), {
        resizeWidth: 256,
        resizeHeight: 256,
        resizeQuality: 'low',
      })
      expect(document.querySelector('img')).toBeNull()
    } finally {
      context.mockRestore()
      vi.unstubAllGlobals()
    }
  })
  it('closes late bitmaps without drawing after removal, and tolerates decode failure', async () => {
    const user = userEvent.setup()
    const draw = vi.fn()
    const close = vi.fn()
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
    let resolve!: (bitmap: { width: number; height: number; close: () => void }) => void
    const decode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockRejectedValueOnce(new Error('Invalid raster'))
    vi.stubGlobal('createImageBitmap', decode)
    try {
      render(<Composer />)
      const field = screen.getByRole('textbox')
      fireEvent.drop(field, {
        dataTransfer: { files: [new File(['pixels'], 'late.png', { type: 'image/png' })] },
      })
      await user.click(screen.getByRole('button', { name: 'Retirer late.png' }))
      resolve({ width: 2, height: 2, close })
      await waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(draw).not.toHaveBeenCalled()
      fireEvent.drop(field, {
        dataTransfer: { files: [new File(['invalid'], 'broken.png', { type: 'image/png' })] },
      })
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
      expect(screen.getByRole('button', { name: 'Retirer broken.png' })).toBeEnabled()
    } finally {
      context.mockRestore()
      vi.unstubAllGlobals()
    }
  })
  it.each(['scope', 'unmount'] as const)(
    'discards decoded pixels after %s retirement',
    async (retirement) => {
      const draw = vi.fn()
      const close = vi.fn()
      const context = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
      let resolve!: (bitmap: { width: number; height: number; close: () => void }) => void
      vi.stubGlobal(
        'createImageBitmap',
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      const props = {
        id: 'preview-composer',
        value: '',
        onValueChange: vi.fn(),
        members: [],
        listLabel: 'Members',
        emojiListLabel: 'Emoji',
        onStagingChange: vi.fn(),
      }
      try {
        const view = render(<RichComposerInput {...props} scope="room-a" />)
        fireEvent.drop(screen.getByRole('textbox'), {
          dataTransfer: { files: [new File(['pixels'], 'late.png', { type: 'image/png' })] },
        })
        if (retirement === 'scope') view.rerender(<RichComposerInput {...props} scope="room-b" />)
        else view.unmount()
        resolve({ width: 2, height: 2, close })
        await waitFor(() => expect(close).toHaveBeenCalledOnce())
        expect(draw).not.toHaveBeenCalled()
      } finally {
        context.mockRestore()
        vi.unstubAllGlobals()
      }
    }
  )
  it('wraps a fenced selection and bounds local staging', () => {
    expect(formatSelection('abc', 0, 3, 'fence')).toEqual({
      text: '```\nabc\n```',
      start: 4,
      end: 7,
    })
    const files = Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.txt`))
    expect(stagedFiles([], files)).toEqual({ files: files.slice(0, 5), rejected: true })
    expect(stagedFiles([], [new File([], 'empty')]).rejected).toBe(true)
  })
  it('renders safe markdown and copies literal fenced code without interpreting HTML', async () => {
    const user = userEvent.setup()
    render(
      <MessageText body={'**Bold** *italics* `inline`\n```html\n<script>alert(1)</script>\n```'} />
    )
    expect(screen.getByText('Bold').tagName).toBe('STRONG')
    expect(screen.getByText('italics').tagName).toBe('EM')
    expect(document.querySelector('script')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Copier le code' }))
    expect(await navigator.clipboard.readText()).toBe('<script>alert(1)</script>')
  })
})
