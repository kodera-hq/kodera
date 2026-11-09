import type { Meta, StoryObj } from '@storybook/react-vite'
import { MetricCard } from './MetricCard'

const meta = {
  title: 'Primitives/MetricCard',
  component: MetricCard,
  args: {
    label: 'Personnes actives',
    value: '42',
  },
  decorators: [
    (Story) => (
      // Demo container width only, no token for 256px.
      <div className="w-[256px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MetricCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithCaption: Story = {
  args: { caption: 'sur 50 places disponibles' },
}

export const DeltaUp: Story = {
  args: {
    label: 'Factures payées',
    value: '12',
    delta: { value: '+3', direction: 'up' },
  },
}

export const DeltaDown: Story = {
  args: {
    label: 'Tickets ouverts',
    value: '2',
    delta: { value: '-1', direction: 'down' },
  },
}

export const DeltaNeutral: Story = {
  args: {
    label: 'Domaines vérifiés',
    value: '4',
    delta: { value: '±0', direction: 'neutral' },
  },
}

export const Inverse: Story = {
  args: {
    label: 'Solde du contrat',
    value: '1 200 €',
    caption: 'Renouvellement le 3 janvier 2027',
    tone: 'inverse',
  },
}
