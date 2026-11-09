import type { Meta, StoryObj } from '@storybook/react-vite'
import { PlanPrice } from './PlanPrice'

const meta = {
  title: 'Primitives/PlanPrice',
  component: PlanPrice,
  parameters: {
    docs: {
      description: {
        component:
          'A plan’s headline price on a tier card: amount in the sans face with tabular figures, the period beside it, a note under it. Nothing here is a control.',
      },
    },
  },
  args: { amount: '134 €', per: '/mois' },
} satisfies Meta<typeof PlanPrice>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AnnualWithMonthlyNote: Story = {
  // The strings mirror the console catalogue (`console.order.plan.label-price-per-month`,
  // `label-price-monthly`); a screen takes them from there, never inline.
  args: { amount: '314 €', per: '/mois', note: '349 € par mois sans engagement' },
}

export const NoPrice: Story = { render: () => <PlanPrice amount="—" /> }
