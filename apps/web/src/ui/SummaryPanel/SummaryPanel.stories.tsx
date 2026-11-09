import type { Meta, StoryObj } from '@storybook/react-vite'
import { SummaryPanel } from './SummaryPanel'

const meta = {
  title: 'Primitives/SummaryPanel',
  component: SummaryPanel,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard map of its own: nothing here is a control. Sticks to',
          'the top of the viewport on wide screens (`lg:sticky`) while the',
          'form beside it scrolls.',
        ].join('\n'),
      },
    },
  },
  args: {
    title: 'Résumé de la commande',
    rows: [
      { label: 'Formule Standard', value: '59,00 €' },
      { label: 'Participants supplémentaires (×2)', value: '20,00 €' },
    ],
    total: { label: 'Total / mois', value: '79,00 €' },
  },
} satisfies Meta<typeof SummaryPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithANote: Story = {
  name: 'With a note',
  args: {
    note: 'Premier prélèvement à la validation de la commande.',
  },
}

export const SingleRow: Story = {
  args: {
    rows: [{ label: 'Formule Essentiel', value: '29,00 €' }],
    total: { label: 'Total / mois', value: '29,00 €' },
  },
}
