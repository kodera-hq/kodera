import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { CopyableField } from './CopyableField'
import type { CopyStatus } from './CopyableField'

function InteractiveField() {
  const [status, setStatus] = useState<CopyStatus>('idle')

  return (
    <CopyableField
      label="Clé API"
      value="F-2026-0042"
      status={status}
      copyLabel="Copier"
      copiedLabel="Copié"
      onCopy={() => {
        setStatus('copied')
        window.setTimeout(() => setStatus('idle'), 1500)
      }}
    />
  )
}

const meta = {
  title: 'Primitives/CopyableField',
  component: CopyableField,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the copy button, `Enter`/`Space` activates',
          'it. The value is always visible, selectable text — copying is a',
          'shortcut, never the only way to get it.',
          '',
          'The 1.5 s "Copié" window is the caller\'s own timer, driven through',
          'the `status` prop; this story wires one up to show the shape a',
          'screen would use.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Clé API',
    value: 'F-2026-0042',
    status: 'idle',
    copyLabel: 'Copier',
    copiedLabel: 'Copié',
    onCopy: () => {},
  },
} satisfies Meta<typeof CopyableField>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  args: { status: 'idle' },
}

export const Copied: Story = {
  args: { status: 'copied' },
}

export const Interactive: Story = {
  render: () => <InteractiveField />,
}
