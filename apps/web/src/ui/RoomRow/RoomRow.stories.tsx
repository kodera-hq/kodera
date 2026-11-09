import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { RoomRow } from './RoomRow'
import type { RoomOccupant } from './RoomRow'

const PEOPLE: RoomOccupant[] = [
  { id: '@paul', name: 'Paul Ferrand' },
  { id: '@claire', name: 'Claire Dubois', sharingScreen: true },
  { id: '@malik', name: 'Malik Benali' },
  { id: '@ines', name: 'Inès Kaci' },
  { id: '@hugo', name: 'Hugo Lefèvre' },
  { id: '@nadia', name: 'Nadia Chevalier' },
  { id: '@sofia', name: 'Sofia Marchetti' },
]

const meta = {
  title: 'Primitives/RoomRow',
  component: RoomRow,
  parameters: {
    docs: {
      description: {
        component: [
          'An always-open audio room in Espace’s sidebar. The row is the join button: its name',
          'is `joinLabel`, then `occupancyLabel(n)`, then each state that is on. The live look',
          'is for the room the viewer is connected to only. Occupants nest under it as a named',
          'list; past `maxOccupants`, a « +N » button reveals the rest in place. Who is',
          'speaking is shown only inside the call, never here (DESIGN.md §2.2).',
          '',
          'Keyboard: `Tab` reaches the row, `Enter`/`Space` joins; `Tab` again reaches « +N »,',
          '`Enter`/`Space` unfolds or folds the rest. An unavailable room is disabled.',
        ].join('\n'),
      },
    },
  },
  args: {
    name: 'Point quotidien',
    joinLabel: 'Rejoindre Point quotidien',
    occupancyLabel: (count: number) =>
      count === 0 ? 'vide' : count === 1 ? '1 personne' : `${count} personnes`,
    occupantsLabel: 'Dans Point quotidien',
    sharingLabel: 'partage son écran',
    overflowLabel: (hidden: number) => `Afficher ${hidden} autres personnes`,
  },
  decorators: [
    (Story) => (
      // A story's demo container, not a design step (src/ui/README.md).
      <ul className="w-[264px] bg-c-sunken p-2">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof RoomRow>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const Occupied: Story = { args: { occupants: PEOPLE.slice(0, 3) } }

export const Overflow: Story = { args: { occupants: PEOPLE } }

export const OverflowUnfolded: Story = {
  args: { occupants: PEOPLE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const more = canvas.getByRole('button', { name: 'Afficher 2 autres personnes' })
    await userEvent.click(more)
    await expect(more).toHaveAttribute('aria-expanded', 'true')
  },
}

export const Connected: Story = {
  args: { occupants: PEOPLE.slice(0, 3), connected: 'Connecté' },
}

export const ListenOnly: Story = {
  args: { occupants: PEOPLE.slice(0, 2), listenOnly: 'écoute seule' },
}

export const Unavailable: Story = {
  args: { occupants: PEOPLE.slice(0, 2), unavailable: 'réservé à la direction' },
}
