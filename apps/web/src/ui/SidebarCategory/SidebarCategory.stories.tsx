import type { Meta, StoryObj } from '@storybook/react-vite'
import { ChannelRow } from '../ChannelRow/ChannelRow'
import { RoomRow } from '../RoomRow/RoomRow'
import { SidebarCategory } from './SidebarCategory'

const meta = {
  title: 'Primitives/SidebarCategory',
  component: SidebarCategory,
  parameters: {
    docs: {
      description: {
        component: [
          'A category of Espace’s sidebar, mixing text channels and audio rooms (M-D4).',
          '',
          'Keyboard: `Tab` reaches the header, `Enter`/`Space` folds or unfolds the rows;',
          '`aria-expanded` and the chevron say which. The rows follow it in tab order.',
        ].join('\n'),
      },
    },
  },
  args: { label: 'Équipe', children: null },
  decorators: [
    (Story) => (
      // A story's demo container, not a design step (src/ui/README.md).
      <nav aria-label="Espace" className="w-[264px] bg-c-sunken p-2">
        <Story />
      </nav>
    ),
  ],
} satisfies Meta<typeof SidebarCategory>

export default meta
type Story = StoryObj<typeof meta>

const occupancy = (count: number) =>
  count === 0 ? 'vide' : count === 1 ? '1 personne' : `${count} personnes`

function Rows() {
  return (
    <>
      <ChannelRow href="#general" name="général" />
      <ChannelRow href="#annonces" name="annonces" readOnly="lecture seule" />
      <ChannelRow href="#atlas" name="projet-atlas" selected />
      <ChannelRow
        href="#support"
        name="support-clients"
        unread="non lu"
        mentions={{ count: 2, label: '2 mentions' }}
      />
      <RoomRow
        name="lounge"
        joinLabel="Rejoindre lounge"
        occupancyLabel={occupancy}
        occupants={[
          { id: '@paul', name: 'Paul Ferrand' },
          { id: '@claire', name: 'Claire Dubois', sharingScreen: true },
        ]}
        occupantsLabel="Dans lounge"
        sharingLabel="partage son écran"
        overflowLabel={(hidden) => `Afficher ${hidden} autres personnes`}
        connected="Connecté"
      />
      <RoomRow
        name="Bureau produit"
        joinLabel="Rejoindre Bureau produit"
        occupancyLabel={occupancy}
        occupants={[{ id: '@hugo', name: 'Hugo Lefèvre' }]}
        occupantsLabel="Dans Bureau produit"
        sharingLabel="partage son écran"
        overflowLabel={(hidden) => `Afficher ${hidden} autres personnes`}
      />
      <RoomRow
        name="Salon d’accueil"
        joinLabel="Rejoindre Salon d’accueil"
        occupancyLabel={occupancy}
        occupantsLabel="Dans Salon d’accueil"
        sharingLabel="partage son écran"
        overflowLabel={(hidden) => `Afficher ${hidden} autres personnes`}
      />
    </>
  )
}

export const Open: Story = {
  render: (args) => (
    <SidebarCategory {...args}>
      <Rows />
    </SidebarCategory>
  ),
}

export const Closed: Story = {
  render: (args) => (
    <SidebarCategory {...args} defaultOpen={false}>
      <Rows />
    </SidebarCategory>
  ),
}

export const WithAction: Story = {
  render: (args) => (
    <SidebarCategory
      {...args}
      actions={
        <button
          type="button"
          aria-label="Créer un canal dans Équipe"
          className="flex h-6 w-6 items-center justify-center rounded-sm text-c-ink-3 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden"
        >
          +
        </button>
      }
    >
      <Rows />
    </SidebarCategory>
  ),
}
