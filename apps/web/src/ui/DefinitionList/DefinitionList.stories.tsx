import type { Meta, StoryObj } from '@storybook/react-vite'
import { DefinitionList } from './DefinitionList'

const meta = {
  title: 'Primitives/DefinitionList',
  component: DefinitionList,
  args: {
    items: [
      { term: 'Nom', description: 'Acme Construction' },
      { term: 'SIRET', description: '123 456 789 00012' },
      { term: 'Adresse', description: '12 rue des Bâtisseurs, 69000 Lyon' },
    ],
  },
  decorators: [
    (Story) => (
      // Demo container width only, no token for 384px.
      <div className="w-[384px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DefinitionList>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithRichDescription: Story = {
  args: {
    items: [
      {
        term: 'Statut du domaine',
        description: <span className="font-mono text-xs text-c-ok-ink">Vérifié</span>,
      },
      { term: 'Ajouté le', description: '2 septembre 2026' },
    ],
  },
}
