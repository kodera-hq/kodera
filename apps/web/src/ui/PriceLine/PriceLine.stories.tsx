import type { Meta, StoryObj } from '@storybook/react-vite'
import { PriceLine } from './PriceLine'

const meta = {
  title: 'Primitives/PriceLine',
  component: PriceLine,
  parameters: {
    docs: {
      description: {
        component: [
          'No formatting of its own: `amount` is a string the caller already',
          'ran through `Intl.NumberFormat` (docs/dev/I18N.md) — this primitive',
          'never guesses at `5,99 €` vs `5.99 €`, it renders whatever it is',
          'given.',
        ].join('\n'),
      },
    },
  },
  decorators: [
    (Story) => (
      // Demo container width only, no token for 288px.
      <div className="w-[288px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PriceLine>

export default meta
type Story = StoryObj<typeof meta>

export const LineItem: Story = {
  args: { label: 'Abonnement Visio', amount: '29,00 €', caption: '/ mois' },
}

export const Emphasis: Story = {
  args: { label: 'Total annuel', amount: '348,00 €', emphasis: true },
}

export const WithoutCaption: Story = {
  args: { label: 'Crédit appliqué', amount: '−12,00 €' },
}
