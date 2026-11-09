import type { Meta, StoryObj } from '@storybook/react-vite'
import { Pagination } from './Pagination'

const meta = {
  title: 'Primitives/Pagination',
  component: Pagination,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches "précédente" then "suivante", `Enter`/`Space`',
          'activates the focused one. Cursor-only: no page number, no total —',
          'the Core API list endpoints send `next_cursor` and `has_more`, never',
          'a count, so this primitive never renders one either.',
        ].join('\n'),
      },
    },
  },
  args: {
    ariaLabel: 'Pagination',
    previousLabel: 'Page précédente',
    nextLabel: 'Page suivante',
    onPrevious: () => {},
    onNext: () => {},
  },
} satisfies Meta<typeof Pagination>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { hasPrevious: true, hasMore: true },
}

export const FirstPage: Story = {
  args: { hasPrevious: false, hasMore: true },
}

export const LastPage: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The only ceiling `has_more: false` describes — never a page number reaching a total.',
      },
    },
  },
  args: { hasPrevious: true, hasMore: false },
}

export const OnlyPage: Story = {
  args: { hasPrevious: false, hasMore: false },
}
