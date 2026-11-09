import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from '../Avatar/Avatar'
import { KoderaMark } from '../icons/KoderaMark'
import { ModuleGlyph } from '../icons/ModuleGlyph'
import { Rail, RailItem } from './Rail'

const meta = {
  title: 'Primitives/Rail',
  component: Rail,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: [
          'The module rail of the workspace shell (P01). Presentational: the caller decides the',
          'destinations and which one is current. `RailItem asChild` wraps the router’s `Link`.',
          '',
          'Keyboard: each item is a link in document order; the ring is the on-inverse tone.',
          'The current item carries `aria-current="page"`, the action plate and a bar.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Applications',
    children: null,
  },
} satisfies Meta<typeof Rail>

export default meta
type Story = StoryObj<typeof meta>

function Example({ current = 'console', waiting }: { current?: string; waiting?: string }) {
  return (
    <Rail
      label="Applications"
      mark={
        <a
          href="#accueil"
          aria-label="Accueil de ACME SAS"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-c-on-inverse focus-visible:ring focus-visible:ring-c-on-inverse focus-visible:outline-hidden"
        >
          <KoderaMark className="h-5 w-auto" />
        </a>
      }
      footer={<Avatar name="Inès Kaci" variant="member" />}
    >
      <RailItem
        href="#visio"
        label="Visio"
        icon={<ModuleGlyph name="visio" />}
        opensElsewhere="s’ouvre dans un nouvel onglet"
      />
      <RailItem
        href="#espace"
        label="Espace"
        icon={<ModuleGlyph name="workspace" />}
        current={current === 'workspace'}
        {...(waiting === undefined ? {} : { attention: waiting })}
      />
      <RailItem
        href="#console"
        label="Console"
        icon={<ModuleGlyph name="console" />}
        current={current === 'console'}
      />
    </Rail>
  )
}

export const Default: Story = { render: () => <Example /> }

export const WorkspaceCurrent: Story = { render: () => <Example current="workspace" /> }

export const SomethingWaits: Story = { render: () => <Example waiting="2 personnes attendent" /> }
