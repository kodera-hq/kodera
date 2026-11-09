import type { Meta, StoryObj } from '@storybook/react-vite'
import { FieldError } from './FieldError'

const meta = {
  title: 'Primitives/FieldError',
  component: FieldError,
  parameters: {
    docs: {
      description: {
        component: [
          'The error line the non-`TextField` fields in this unit render for',
          'themselves — `role="alert"` so it is announced without anyone having to',
          'be inside the field it belongs to. No keyboard map: it holds no control.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof FieldError>

export default meta
type Story = StoryObj<typeof meta>

export const WithMessage: Story = {
  args: { children: 'Ce nom est déjà pris. Essayez « acme-construction ».' },
}

export const Empty: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story: 'No message: renders nothing, not an empty alert nobody should hear.',
      },
    },
  },
}
