import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import { TopBar } from './TopBar'

const meta = {
  title: 'Primitives/TopBar',
  component: TopBar,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: [
          'The content header of the workspace shell (P01): where the person is, and the few',
          'actions that belong there. The title is text, not a heading; the page keeps its `h1`.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'En-tête de la console',
    title: 'Facturation',
  },
} satisfies Meta<typeof TopBar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithSubtitleAndActions: Story = {
  args: {
    title: 'Accueil',
    subtitle: 'Mardi 21 octobre',
    leading: (
      <Button variant="tertiary" size="sm" aria-label="Masquer la navigation" aria-expanded>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </Button>
    ),
    actions: (
      <>
        <Button variant="tertiary" size="sm">
          Aide
        </Button>
        <Button size="sm">Inviter des personnes</Button>
      </>
    ),
  },
}

export const LongTitle: Story = {
  args: {
    title: 'Domaine et identité — vérification des enregistrements DNS de l’organisation',
    subtitle: 'Dernière vérification il y a deux minutes',
    actions: <Button size="sm">Vérifier maintenant</Button>,
  },
  decorators: [
    (Story) => (
      // A narrow frame on purpose (demo container, not a design step): the title
      // must truncate before it reaches the actions.
      <div className="w-[600px]">
        <Story />
      </div>
    ),
  ],
}
