import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Wizard } from './Wizard'
import type { WizardStep } from './Wizard'

const steps: WizardStep[] = [
  {
    id: 'plan',
    label: 'Formule',
    content: <p className="text-sm text-c-ink">Choisissez votre formule.</p>,
  },
  {
    id: 'contacts',
    label: 'Contacts',
    content: <p className="text-sm text-c-ink">Vos coordonnées.</p>,
  },
  {
    id: 'agreements',
    label: 'Documents',
    content: <p className="text-sm text-c-ink">Acceptez les documents.</p>,
  },
  {
    id: 'confirmation',
    label: 'Confirmation',
    content: <p className="text-sm text-c-ink">C'est prêt.</p>,
  },
]

function backButton() {
  return (
    <button
      type="button"
      className="h-10 rounded-md border border-c-border-strong bg-c-surface px-4 text-sm font-semibold text-c-ink hover:bg-c-muted"
    >
      Précédent
    </button>
  )
}

function nextButton(label: string) {
  return (
    <button
      type="button"
      className="h-10 rounded-md bg-c-action px-4 text-sm font-semibold text-c-on-inverse hover:bg-c-action-hover"
    >
      {label}
    </button>
  )
}

const meta = {
  title: 'Primitives/Wizard',
  component: Wizard,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches whatever the active panel and the',
          '`back`/`next` slots put in the tab order — the shell adds nothing',
          'of its own. The header `Stepper` is a status display, not a set of',
          'tabs. `step` is controlled, driven by the URL; changing it',
          'announces the new step politely without moving focus.',
        ].join('\n'),
      },
    },
  },
  args: { steps, stepperLabel: 'Étapes de la commande' },
} satisfies Meta<typeof Wizard>

export default meta
type Story = StoryObj<typeof meta>

export const FirstStep: Story = {
  name: 'First step',
  args: {
    step: 'plan',
    announcement: 'Étape 1 sur 4 : Formule',
    next: nextButton('Continuer'),
  },
}

export const MiddleStep: Story = {
  name: 'Middle step',
  args: {
    step: 'contacts',
    announcement: 'Étape 2 sur 4 : Contacts',
    back: backButton(),
    next: nextButton('Continuer'),
  },
}

export const LastStep: Story = {
  name: 'Last step',
  args: {
    step: 'confirmation',
    announcement: 'Étape 4 sur 4 : Confirmation',
    back: backButton(),
    next: nextButton('Valider la commande'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("C'est prêt.")).toBeInTheDocument()
    await expect(canvas.getByText('Documents').closest('li')).not.toHaveAttribute('aria-current')
    await expect(canvas.getByText('Confirmation').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    )
  },
}

export const KeyboardReachesBackAndNext: Story = {
  name: 'Keyboard reaches back and next',
  args: {
    step: 'contacts',
    announcement: 'Étape 2 sur 4 : Contacts',
    back: backButton(),
    next: nextButton('Continuer'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'Précédent' })).toHaveFocus()
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'Continuer' })).toHaveFocus()
  },
}
