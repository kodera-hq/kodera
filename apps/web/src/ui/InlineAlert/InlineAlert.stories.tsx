import type { Meta, StoryObj } from '@storybook/react-vite'
import { InlineAlert } from './InlineAlert'

const meta = {
  title: 'Primitives/InlineAlert',
  component: InlineAlert,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map: nothing here is a control.',
          '',
          '`error` is `role="alert"` and interrupts, which is right next to the',
          'field it explains. The other three kinds are `role="status"`.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof InlineAlert>

export default meta
type Story = StoryObj<typeof meta>

export const Info: Story = {
  args: { kind: 'info', children: 'Le sous-domaine est réservé pendant 24 h.' },
}

export const Success: Story = {
  args: { kind: 'success', children: 'Domaine vérifié.' },
}

export const Warning: Story = {
  args: { kind: 'warning', children: 'La capacité approche 90 %.' },
}

export const Error: Story = {
  args: { kind: 'error', children: 'Le nom de domaine est déjà utilisé.' },
}
