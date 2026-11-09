import type { Meta, StoryObj } from '@storybook/react-vite'
import { QrPanel } from './QrPanel'

const meta = {
  title: 'Primitives/QrPanel',
  component: QrPanel,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the copy button beside the QR, `Enter`/`Space`',
          'activates it — the QR image itself is not a control. A camera that',
          'cannot read the image, or a person who cannot use one, still has the',
          'code to type by hand.',
          '',
          'A design gap (`docs/specs/README.md`): the delivered system has no',
          'anatomy for a QR. `sm`/`md`/`lg` are bracket px, not a spacing step —',
          "96/144/192 px, a phone camera's practical range at arm's length up to",
          'a printed sheet.',
        ].join('\n'),
      },
    },
  },
  args: {
    value: 'otpauth://totp/Kodera:claire@acme.fr?secret=JBSWY3DPEHPK3PXP',
    alt: "Code QR à scanner avec l'application d'authentification",
    failureMessage: 'Le code QR est indisponible pour le moment.',
    code: {
      label: 'ou saisissez la clé',
      value: 'JBSW Y3DP EHPK 3PXP',
      status: 'idle',
      copyLabel: 'Copier',
      copiedLabel: 'Copié',
      onCopy: () => {},
    },
  },
} satisfies Meta<typeof QrPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Small: Story = {
  args: { size: 'sm' },
}

export const Large: Story = {
  args: { size: 'lg' },
}

export const Copied: Story = {
  args: {
    code: {
      label: 'ou saisissez la clé',
      value: 'JBSW Y3DP EHPK 3PXP',
      status: 'copied',
      copyLabel: 'Copier',
      copiedLabel: 'Copié',
      onCopy: () => {},
    },
  },
}

export const FailureEmptyValue: Story = {
  name: 'Failure — empty value',
  args: { value: '' },
}

export const FailureEncodingOverflow: Story = {
  name: 'Failure — value too long to encode',
  args: { value: 'x'.repeat(5000) },
}
