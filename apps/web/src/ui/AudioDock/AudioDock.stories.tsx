import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { AudioDock } from './AudioDock'
import type { AudioDockProps } from './AudioDock'

const meta = {
  title: 'Primitives/AudioDock',
  component: AudioDock,
  parameters: {
    docs: {
      description: {
        component: [
          'The call docked at the foot of Espace’s sidebar; `layout="banner"` is the phone’s',
          'full-width banner with 52 px controls.',
          '',
          'Keyboard: `Tab` reaches mute, deafen and leave in that order; `Enter`/`Space`',
          'toggles (`aria-pressed`) or leaves. Rings are the on-inverse tone.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Appel en cours',
    room: 'Point quotidien',
    category: 'Équipe',
    status: 'connected',
    statusLabel: 'Connecté · 12 min · 3 personnes',
    muted: false,
    deafened: false,
    labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter' },
    onToggleMute: () => {},
    onToggleDeafen: () => {},
    onLeave: () => {},
  },
} satisfies Meta<typeof AudioDock>

export default meta
type Story = StoryObj<typeof meta>

function Live(args: AudioDockProps) {
  const [muted, setMuted] = useState(args.muted)
  const [deafened, setDeafened] = useState(args.deafened)
  // What the microphone was before deafening, restored when the sound comes back.
  const [mutedBefore, setMutedBefore] = useState(args.muted)
  return (
    <AudioDock
      {...args}
      muted={muted}
      deafened={deafened}
      onToggleMute={() => {
        if (!deafened) setMuted((value) => !value)
      }}
      onToggleDeafen={() => {
        // Deafening also mutes, as in every call client; undeafening gives the
        // microphone back as it was.
        if (deafened) {
          setDeafened(false)
          setMuted(mutedBefore)
        } else {
          setMutedBefore(muted)
          setDeafened(true)
          setMuted(true)
        }
      }}
    />
  )
}

function InSidebar(args: AudioDockProps) {
  return (
    // A story's demo container, not a design step (src/ui/README.md).
    <div className="w-[264px] bg-c-sunken">
      <Live {...args} />
    </div>
  )
}

export const Sidebar: Story = { render: (args) => <InSidebar {...args} /> }

export const Muted: Story = {
  args: { muted: true },
  render: (args) => <InSidebar {...args} />,
}

export const MutedAndDeafened: Story = {
  args: { muted: true, deafened: true },
  render: (args) => <InSidebar {...args} />,
}

export const Connecting: Story = {
  args: { status: 'connecting', statusLabel: 'Connexion…' },
  render: (args) => <InSidebar {...args} />,
}

export const Reconnecting: Story = {
  args: { status: 'reconnecting', statusLabel: 'Reconnexion… · 12 min' },
  render: (args) => <InSidebar {...args} />,
}

export const WithOpenCall: Story = {
  args: {
    onOpenCall: () => {},
    labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: 'Ouvrir l’appel' },
  },
  render: (args) => <InSidebar {...args} />,
}

export const PhoneBanner: Story = {
  args: { layout: 'banner', statusLabel: '12 min · 3 personnes' },
  render: (args) => (
    // A story's demo container, not a design step (src/ui/README.md).
    <div className="w-[375px] bg-c-surface p-4">
      <Live {...args} />
    </div>
  ),
}
