import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { CopyableCode } from './CopyableCode'
import type { CopyStatus } from './CopyableCode'

const dnsRecord = [
  'Type   Nom    Valeur',
  'TXT    @      "kodera-verify=8f2c9a1d"',
  'CNAME  visio  visio.kodera.io.',
].join('\n')

function InteractiveCode() {
  const [status, setStatus] = useState<CopyStatus>('idle')

  return (
    <CopyableCode
      label="Enregistrements DNS"
      value={dnsRecord}
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
  title: 'Primitives/CopyableCode',
  component: CopyableCode,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the block — a scroll container with no',
          'focusable child of its own — and then the copy button, which',
          '`Enter`/`Space` activates. The block is always selectable text, so a',
          'browser that blocks clipboard access still leaves the value',
          'reachable.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Enregistrements DNS',
    value: dnsRecord,
    status: 'idle',
    copyLabel: 'Copier',
    copiedLabel: 'Copié',
    onCopy: () => {},
  },
} satisfies Meta<typeof CopyableCode>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  args: { label: 'Enregistrements DNS', status: 'idle' },
}

export const Copied: Story = {
  args: { label: 'Enregistrements DNS', status: 'copied' },
}

export const LabelHidden: Story = {
  args: { labelHidden: true, status: 'idle' },
}

export const Interactive: Story = {
  render: () => <InteractiveCode />,
}
