import type { Meta, StoryObj } from '@storybook/react-vite'
import { PriceLine } from '../PriceLine/PriceLine'
import { PlanCard } from './PlanCard'

const meta = {
  title: 'Primitives/PlanCard',
  component: PlanCard,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the select action, `Enter`/`Space` activates',
          'it — the card itself carries no interaction. `recommended` draws a',
          '2 px cobalt border and a `Badge` pill; both read together, never',
          'colour alone.',
        ].join('\n'),
      },
    },
  },
  args: {
    title: 'Standard',
    priceLine: <PriceLine label="Facturation mensuelle" amount="59 €" caption="/ mois" emphasis />,
    features: [
      '150 participants simultanés',
      'Domaine personnalisé',
      'Support par e-mail sous 4 h ouvrées',
    ],
    action: (
      <button
        type="button"
        className="h-10 w-full rounded-md bg-c-action px-4 text-sm font-semibold text-c-on-inverse hover:bg-c-action-hover"
      >
        Choisir Standard
      </button>
    ),
  },
} satisfies Meta<typeof PlanCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Chosen: Story = {
  args: { chosen: true },
}

export const WithDescription: Story = {
  args: { description: 'Pour une organisation de taille moyenne, avec plusieurs équipes.' },
}

export const Recommended: Story = {
  args: {
    recommended: true,
    recommendedLabel: 'Recommandé',
  },
}

export const FewFeatures: Story = {
  name: 'Few features',
  args: {
    title: 'Essentiel',
    priceLine: <PriceLine label="Facturation mensuelle" amount="29 €" caption="/ mois" emphasis />,
    features: ['50 participants simultanés'],
    action: (
      <button
        type="button"
        className="h-10 w-full rounded-md border border-c-border-strong bg-c-surface px-4 text-sm font-semibold text-c-ink hover:bg-c-muted"
      >
        Choisir Essentiel
      </button>
    ),
  },
}
