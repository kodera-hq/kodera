import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fireEvent, userEvent, within } from 'storybook/test'
import { FileDrop } from './FileDrop'

const REJECTION_MESSAGE = (reason: 'type' | 'size') =>
  reason === 'type' ? 'Ce type de fichier n’est pas accepté.' : 'Le fichier dépasse 5 Mo.'

const meta = {
  title: 'Primitives/FileDrop',
  component: FileDrop,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the drop zone (or, once a file is chosen, the',
          'remove action in its place); `Enter` and `Space` open the platform file',
          'picker — a hidden native `<input type="file">` does the choosing, so',
          'nobody gets a re-implementation of it. Removing a file returns focus to',
          'the drop zone that takes its place, rather than dropping it on `body`.',
          '',
          'Rejection — wrong type or over the size limit — never silently drops the',
          'file: `rejectionMessage(reason)` renders and the field is left as it was,',
          "and it joins the zone's `aria-describedby` for as long as it stands.",
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Justificatif de domicile',
    rejectionMessage: REJECTION_MESSAGE,
    removeLabel: 'Retirer le fichier',
  },
} satisfies Meta<typeof FileDrop>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const WithHelp: Story = {
  args: { help: 'PDF ou image, 5 Mo maximum.' },
}

export const WithError: Story = {
  args: { error: 'Un justificatif est requis.' },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const Chosen: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The state after a file is accepted: name, and the remove action in place of the zone.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const dropzone = canvas.getByRole('button', { name: 'Justificatif de domicile' })

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['x'], 'facture.pdf', { type: 'application/pdf' })] },
    })

    await expect(await canvas.findByText('facture.pdf')).toBeVisible()
  },
}

export const Rejected: Story = {
  args: { maxSize: 5 },
  parameters: {
    docs: {
      description: {
        story:
          "A file over `maxSize`, dropped: the caller's `rejectionMessage('size')`, not a silent drop.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const dropzone = canvas.getByRole('button', { name: 'Justificatif de domicile' })

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File(['x'.repeat(10)], 'gros-fichier.pdf', { type: 'application/pdf' })],
      },
    })

    await expect(await canvas.findByRole('alert')).toHaveTextContent('Le fichier dépasse 5 Mo.')
  },
}

export const RemoveReturnsFocus: Story = {
  parameters: {
    docs: {
      description: {
        story: [
          'The remove control unmounts itself, so focus has to be sent somewhere',
          'deliberate: the drop zone that takes its place. Left alone it lands on',
          '`body` and a keyboard user restarts from the top of the document.',
        ].join(' '),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    fireEvent.drop(canvas.getByRole('button', { name: 'Justificatif de domicile' }), {
      dataTransfer: { files: [new File(['x'], 'facture.pdf', { type: 'application/pdf' })] },
    })
    const remove = await canvas.findByRole('button', { name: 'Retirer le fichier' })
    remove.focus()
    await expect(remove).toHaveFocus()

    await userEvent.keyboard('{Enter}')

    await expect(
      await canvas.findByRole('button', { name: 'Justificatif de domicile' })
    ).toHaveFocus()
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(
      within(canvasElement).getByRole('button', { name: 'Justificatif de domicile' })
    ).toHaveFocus()
  },
}
