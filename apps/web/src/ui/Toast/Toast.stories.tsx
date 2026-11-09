import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { ToastProvider, useToast } from './Toast'
import type { ToastKind } from './Toast'

// `ToastProvider` renders its own `RadixToast.Viewport`, portalled nowhere —
// unlike `Dialog`/`Drawer`, Radix Toast has no portal container prop and
// mounts its viewport inline where `ToastProvider` is rendered. Every toast
// it queues therefore already lives inside the story's own render container,
// and the a11y gate needs no special handling here.

function Demo({ kind, label }: { kind: ToastKind; label: string }) {
  const notify = useToast()
  return (
    <Button
      onClick={() =>
        notify(
          kind === 'success'
            ? { kind, title: 'Domaine vérifié.' }
            : {
                kind,
                title: 'La sauvegarde a échoué.',
                description: 'Vérifiez votre connexion et réessayez.',
              }
        )
      }
    >
      {label}
    </Button>
  )
}

const meta = {
  title: 'Primitives/Toast',
  component: ToastProvider,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `F8` moves focus into the toast region (Radix’s own',
          'hotkey); `Tab` then reaches each toast’s close control.',
          '',
          'Auto-dismiss pauses while a toast has hover or focus, and resumes from',
          'where it left off. `error` interrupts (`aria-live="assertive"`);',
          '`success` does not (`aria-live="polite"`).',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Notification',
    viewportLabel: 'Notifications',
    closeLabel: 'Fermer',
    children: null,
  },
} satisfies Meta<typeof ToastProvider>

export default meta
type Story = StoryObj<typeof meta>

export const Success: Story = {
  args: {},
  render: (args) => (
    <ToastProvider {...args}>
      <Demo kind="success" label="Enregistrer" />
    </ToastProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Enregistrer' }))

    await expect(canvas.getByText('Domaine vérifié.')).toBeInTheDocument()
  },
}

export const Error: Story = {
  args: {},
  render: (args) => (
    <ToastProvider {...args}>
      <Demo kind="error" label="Enregistrer" />
    </ToastProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Enregistrer' }))

    await expect(canvas.getByText('La sauvegarde a échoué.')).toBeInTheDocument()
    await expect(canvas.getByText('Vérifiez votre connexion et réessayez.')).toBeInTheDocument()
  },
}
