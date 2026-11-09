import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from './Button'

// French here is placeholder copy for the inventory, not product copy: nothing
// a customer reads lives inside a primitive, and the real strings come from the
// message catalogues through props.
const meta = {
  title: 'Primitives/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the button, `Enter` and `Space` activate it.',
          'A `disabled` button is skipped by `Tab` — that is what the attribute means.',
          'A `loading` one is not: it keeps focus and refuses to act, so the person who',
          'pressed it is still standing on the thing they are waiting for.',
          '',
          'Hover and active are CSS states this inventory cannot enter on its own;',
          'they are checked by hand and by the Playwright pass (docs/dev/TESTING.md §3).',
          '',
          'One primary per screen. The label is a verb and an object, never "OK".',
        ].join('\n'),
      },
    },
  },
  args: {
    children: 'Inviter des personnes',
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}

export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Annuler' },
}

export const Tertiary: Story = {
  args: { variant: 'tertiary', children: 'Afficher les détails' },
}

export const Destructive: Story = {
  args: { variant: 'destructive', children: 'Retirer cette personne' },
}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Button {...args} size="sm">
        Petit
      </Button>
      <Button {...args} size="md">
        Standard
      </Button>
      <Button {...args} size="lg">
        Grand
      </Button>
    </div>
  ),
}

export const WithIcon: Story = {
  args: {
    children: 'Ajouter un domaine',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor">
        <path d="M8 3v10M3 8h10" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
}

export const Loading: Story = {
  args: { loading: true, children: 'Envoyer l’invitation' },
  parameters: {
    docs: {
      description: {
        story:
          'The spinner replaces the label visually and the label stays in the accessibility tree, so the button keeps both its width and its name while it is `aria-busy`. It is `aria-disabled` and not `disabled`: it stays focusable and refuses to act.',
      },
    },
  },
}

export const FocusVisible: Story = {
  args: { children: 'Enregistrer' },
  parameters: {
    docs: {
      description: {
        story:
          'The state a mouse never produces. `Tab` reaches the button and the ring appears; the same `play` is what the headless accessibility gate replays before it runs axe (docs/dev/TESTING.md §3).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.tab()

    await expect(within(canvasElement).getByRole('button', { name: 'Enregistrer' })).toHaveFocus()
  },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const DisabledVariants: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Button {...args} disabled variant="primary">
        Primaire
      </Button>
      <Button {...args} disabled variant="secondary">
        Secondaire
      </Button>
      <Button {...args} disabled variant="tertiary">
        Tertiaire
      </Button>
      <Button {...args} disabled variant="destructive">
        Destructif
      </Button>
    </div>
  ),
}

export const IconOnly: Story = {
  args: {
    variant: 'secondary',
    'aria-label': 'Plus d’actions',
    // An icon-only button has no text to name it, so the caller supplies the
    // name. Without this the button is an unlabelled control to a screen
    // reader, and axe fails the story.
    children: null,
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
        <circle cx="3" cy="8" r="1.4" />
        <circle cx="8" cy="8" r="1.4" />
        <circle cx="13" cy="8" r="1.4" />
      </svg>
    ),
  },
}

export const AsLink: Story = {
  args: { variant: 'secondary', asChild: true },
  render: (args) => (
    <Button {...args}>
      <a href="#factures">Voir les factures</a>
    </Button>
  ),
}

export const AsDisabledLink: Story = {
  args: { variant: 'secondary', asChild: true, disabled: true },
  parameters: {
    docs: {
      description: {
        story:
          'An `<a>` has no `disabled` attribute, so the state is spelled out: `aria-disabled`, `tabIndex={-1}` and a guard that swallows the activation. Without it the link looks unavailable and navigates anyway.',
      },
    },
  },
  render: (args) => (
    <Button {...args}>
      <a href="#factures">Voir les factures</a>
    </Button>
  ),
}
