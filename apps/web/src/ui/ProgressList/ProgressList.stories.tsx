import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProgressList } from './ProgressList'

const statusLabels = {
  pending: 'En attente',
  running: 'En cours',
  done: 'Terminé',
  failed: 'Échoué',
  skipped: 'Ignoré',
}

const meta = {
  title: 'Primitives/ProgressList',
  component: ProgressList,
  parameters: {
    docs: {
      description: {
        component: [
          'A status display, not a set of controls: no keyboard behaviour of',
          'its own. The running step carries `aria-current="step"`, and every',
          'step shows its own status word as visible text beside the label —',
          'never colour alone (`ui-common.md`). Two of the three design gaps',
          '(`docs/specs/README.md`): `failed` and `skipped`, which',
          "COMPONENTS.md's provisioning timeline does not define, plus a list",
          'with no timestamps at all.',
        ].join('\n'),
      },
    },
  },
  args: { statusLabels },
} satisfies Meta<typeof ProgressList>

export default meta
type Story = StoryObj<typeof meta>

export const Provisioning: Story = {
  args: {
    steps: [
      { id: 'order', label: 'Commande enregistrée', status: 'done' },
      { id: 'server', label: 'Serveur réservé à Paris', status: 'done' },
      {
        id: 'apps',
        label: 'Installation des applications',
        status: 'running',
        caption: 'en cours · sous 10 minutes',
      },
      { id: 'certs', label: 'Adresses et certificats', status: 'pending' },
      { id: 'accounts', label: 'Comptes et connexion', status: 'pending' },
      { id: 'backups', label: 'Sauvegardes et surveillance', status: 'pending' },
    ],
  },
}

export const WithAFailedStep: Story = {
  name: 'With a failed step',
  args: {
    steps: [
      { id: 'order', label: 'Commande enregistrée', status: 'done' },
      {
        id: 'domain',
        label: 'Vérification du domaine',
        status: 'failed',
        message: "L'enregistrement TXT est introuvable chez votre hébergeur.",
      },
      { id: 'certs', label: 'Certificat', status: 'pending' },
    ],
  },
}

export const WithASkippedStep: Story = {
  name: 'With a skipped step',
  args: {
    steps: [
      { id: 'order', label: 'Commande enregistrée', status: 'done' },
      { id: 'domain', label: 'Domaine personnalisé', status: 'skipped' },
      { id: 'apps', label: 'Installation des applications', status: 'running' },
    ],
  },
}

export const DunningLadderWithDates: Story = {
  name: 'Dunning ladder, with dates',
  args: {
    steps: [
      { id: 'due', label: 'Échéance dépassée', status: 'done', timestamp: '31 mars 2027' },
      { id: 'reminder-1', label: 'Rappel envoyé', status: 'done', timestamp: '7 avril' },
      { id: 'reminder-2', label: 'Second rappel', status: 'running', timestamp: '21 avril' },
      {
        id: 'notice',
        label: 'Mise en demeure, pénalités et indemnité forfaitaire de 40 €',
        status: 'pending',
        timestamp: '5 mai',
      },
      {
        id: 'notice-suspend',
        label: 'Préavis de suspension (7 jours)',
        status: 'pending',
        timestamp: '30 mai',
      },
      { id: 'suspend', label: 'Suspension des connexions', status: 'pending', timestamp: '6 juin' },
    ],
  },
}

export const DunningLadderWithoutDates: Story = {
  name: 'Dunning ladder, dates unavailable',
  args: {
    steps: [
      { id: 'due', label: 'Échéance dépassée', status: 'done' },
      { id: 'reminder-1', label: 'Rappel envoyé', status: 'done' },
      { id: 'reminder-2', label: 'Second rappel', status: 'pending' },
      { id: 'notice', label: 'Mise en demeure', status: 'pending' },
      { id: 'suspend', label: 'Suspension des connexions', status: 'pending' },
    ],
  },
}

export const AllPending: Story = {
  args: {
    steps: [
      { id: 'order', label: 'Commande enregistrée', status: 'pending' },
      { id: 'server', label: 'Serveur réservé', status: 'pending' },
    ],
  },
}
