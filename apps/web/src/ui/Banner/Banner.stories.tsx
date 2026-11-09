import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import { Banner } from './Banner'

const meta = {
  title: 'Primitives/Banner',
  component: Banner,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the action, then the dismiss control, in that',
          'order. `Escape` does nothing — a banner is part of the page, not an',
          'overlay, and dismissing it is a deliberate click.',
          '',
          'Three lines at most: what happens, what it changes for the person,',
          'the action. `incident` is `role="alert"` and interrupts; the other',
          'three kinds are `role="status"` and are announced politely.',
        ].join('\n'),
      },
    },
  },
} satisfies Meta<typeof Banner>

export default meta
type Story = StoryObj<typeof meta>

export const Info: Story = {
  args: {
    kind: 'info',
    headline: 'La facture de janvier est prête.',
    detail: 'Elle est prélevée automatiquement le 5.',
    action: <Button variant="tertiary">Voir la facture</Button>,
  },
}

export const Maintenance: Story = {
  args: {
    kind: 'maintenance',
    headline: 'Maintenance prévue le 14 mars, 22h–23h.',
    detail: 'Le service reste disponible en lecture seule pendant cette fenêtre.',
  },
}

export const Incident: Story = {
  args: {
    kind: 'incident',
    headline: 'Incident en cours sur la messagerie.',
    detail: 'Les nouveaux messages sont retardés.',
    action: <Button variant="tertiary">Suivre l’incident</Button>,
  },
}

export const Success: Story = {
  args: {
    kind: 'success',
    headline: 'Domaine vérifié.',
  },
}

export const Dismissible: Story = {
  args: {
    kind: 'info',
    headline: 'Nouvelle version disponible.',
    dismissible: true,
    dismissLabel: 'Fermer ce message',
    onDismiss: () => {},
  },
}
