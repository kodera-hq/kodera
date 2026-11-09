import type { Meta, StoryObj } from '@storybook/react-vite'
import { Breadcrumb } from './Breadcrumb'

const meta = {
  title: 'Primitives/Breadcrumb',
  component: Breadcrumb,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches each earlier level in order. The current',
          'page is not a stop — it carries `aria-current="page"` and is plain',
          'text, never a link back to the page already open.',
        ].join('\n'),
      },
    },
  },
  args: {
    ariaLabel: 'Fil d’Ariane',
  },
} satisfies Meta<typeof Breadcrumb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    items: [
      { label: 'Organisation', href: '/organisation' },
      { label: 'Personnes', href: '/organisation/personnes' },
      { label: 'Henri Duflot' },
    ],
  },
}

export const TwoLevels: Story = {
  args: {
    items: [{ label: 'Organisation', href: '/organisation' }, { label: 'Domaines' }],
  },
}
