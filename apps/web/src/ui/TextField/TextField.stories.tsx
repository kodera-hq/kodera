import type { Meta, StoryObj } from '@storybook/react-vite'
import { TextField } from './TextField'

// Placeholder French for the inventory only. Product copy lives in the message
// catalogues and reaches this primitive as props.
const meta = {
  title: 'Primitives/TextField',
  component: TextField,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the control, clicking the label focuses it.',
          'The label is bound with `htmlFor` rather than wrapping the control, so a',
          'suffix can sit next to the input without swallowing the click.',
          '',
          'The error is wired with `aria-invalid` and `aria-describedby`; it is read',
          'when the field is reached, not shouted through a live region on every blur.',
          '',
          'Error copy says how to fix it — "essayez « acme-construction »", never "invalide".',
          '',
          'A suffix is read out with the field by default, because it is usually part of',
          'the value. It is not an action: a "Copier" control is a Button beside the',
          'field, since a suffix cannot be reached by a keyboard.',
          '',
          'Sizes are `md` (40 px) and `lg` (48 px). There is no `sm`: 32 px is sanctioned',
          'for Button alone (COMPONENTS.md).',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Nom de l’organisation',
  },
} satisfies Meta<typeof TextField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithPlaceholder: Story = {
  args: { placeholder: 'Acme Construction' },
}

export const WithHelp: Story = {
  args: {
    label: 'Domaine',
    help: 'Sans « www. ». Vous pourrez en ajouter d’autres plus tard.',
  },
}

export const WithError: Story = {
  args: {
    label: 'Domaine',
    defaultValue: 'acme construction',
    error: 'Ce nom est déjà pris. Essayez « acme-construction ».',
  },
}

export const WithHelpAndError: Story = {
  args: {
    label: 'Domaine',
    defaultValue: 'acme construction',
    help: 'Sans « www. ».',
    error: 'Ce nom est déjà pris. Essayez « acme-construction ».',
  },
}

export const WithSuffix: Story = {
  args: {
    label: 'Sous-domaine',
    defaultValue: 'acme',
    suffix: '.visio.kodera.io',
  },
}

export const WithDecorativeSuffix: Story = {
  args: {
    label: 'Budget mensuel',
    defaultValue: '250',
    suffix: '€',
    decorative: true,
    inputMode: 'numeric',
  },
  parameters: {
    docs: {
      description: {
        story:
          'The exception. The unit is already in the label, so announcing it again only makes the field longer to listen to — `decorative` is the decision to say nothing, taken one field at a time.',
      },
    },
  },
}

export const Sizes: Story = {
  // The width is the story's demo container, not the field — an arbitrary
  // pixel value, never a preset step invented to hit a round number.
  render: (args) => (
    <div className="flex w-[320px] flex-col gap-4">
      <TextField {...args} size="md" label="Standard" />
      <TextField {...args} size="lg" label="Grand" />
    </div>
  ),
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Acme Construction' },
}

export const ReadOnly: Story = {
  args: {
    label: 'Adresse de votre salon',
    readOnly: true,
    value: 'acme-construction',
    suffix: '.visio.kodera.io',
  },
  parameters: {
    docs: {
      description: {
        story:
          'A value the customer copies rather than edits. The copy control belongs beside the field as a Button, not inside it as a suffix: a suffix takes no focus and answers no key.',
      },
    },
  },
}

export const WithAction: Story = {
  args: {
    label: 'Mot de passe',
    defaultValue: 'motdepasse',
    action: (
      <button
        type="button"
        aria-label="Afficher le mot de passe"
        className="flex items-center border-l border-c-border px-3 text-c-ink-3 outline-hidden transition-colors duration-fast ease-out hover:text-c-ink focus-visible:ring"
      >
        <span aria-hidden="true">👁</span>
      </button>
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          'A second control sharing the field’s frame and its `focus-within:ring` — reached by `Tab` right after the input, unlike `suffix`, which is inert text. `PasswordField`’s reveal toggle composes `TextField` through this slot.',
      },
    },
  },
}
