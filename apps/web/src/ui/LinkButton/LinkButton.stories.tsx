import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { LinkButton } from './LinkButton'

const meta = {
  title: 'Primitives/LinkButton',
  component: LinkButton,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the link, `Enter` follows `href`. No `Space`',
          'activation and no `loading` — neither exists for navigation.',
          '',
          'A `target="_blank"` link gets `rel="noopener noreferrer"` unless the',
          'caller already set one.',
        ].join('\n'),
      },
    },
  },
  args: {
    href: '/factures',
    children: 'Voir les factures',
  },
} satisfies Meta<typeof LinkButton>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}

export const Secondary: Story = {
  args: { variant: 'secondary' },
}

export const Tertiary: Story = {
  args: { variant: 'tertiary', children: 'Afficher les détails' },
}

/** A link inside running text: underlined at rest, sized by the sentence. */
export const InlineInSentence: Story = {
  args: { inline: true, children: 'la page de statut', href: '/statut' },
  render: (args) => (
    <p className="text-sm text-c-ink-2">
      Les incidents en cours sont décrits sur <LinkButton {...args} />.
    </p>
  ),
}

export const WithIcon: Story = {
  args: {
    children: 'Voir le statut',
    href: 'https://status.kodera.io',
    target: '_blank',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor">
        <path
          d="M6 4h6v6M12 4 4 12"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
}

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(
      within(canvasElement).getByRole('link', { name: 'Voir les factures' })
    ).toHaveFocus()
  },
}

export const Disabled: Story = {
  args: { disabled: true },
  parameters: {
    docs: {
      description: {
        story:
          'An `<a>` has no `disabled` attribute, so the state is spelled out: `aria-disabled`, `tabIndex={-1}` and a guard that swallows the activation.',
      },
    },
  },
}

export const AsRouterLink: Story = {
  args: { asChild: true, variant: 'secondary' },
  render: (args) => (
    <LinkButton {...args}>
      <a href="/factures">Voir les factures</a>
    </LinkButton>
  ),
}
