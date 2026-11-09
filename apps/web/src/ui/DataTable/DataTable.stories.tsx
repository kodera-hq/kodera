import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Button } from '../Button/Button'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

interface Person {
  id: string
  name: string
  email: string
  status: string
  failed?: boolean
}

const rows: Person[] = [
  { id: 'p1', name: 'Henri Duflot', email: 'henri.duflot@acme-construction.fr', status: 'Active' },
  { id: 'p2', name: 'Bruno Petit', email: 'bruno@acme-construction.fr', status: 'En attente' },
  {
    id: 'p3',
    name: 'Carla Dupuis',
    email: 'carla@acme-construction',
    status: 'Adresse invalide',
    failed: true,
  },
]

const columns: DataTableColumn<Person>[] = [
  { key: 'name', header: 'Nom', render: (row) => row.name },
  { key: 'email', header: 'E-mail', render: (row) => row.email },
  { key: 'status', header: 'Statut', render: (row) => row.status, status: true },
]

// `DataTable` is generic; this instantiation expression (TS 4.7+) fixes its
// type parameter to `Person` for every story below, the way a caller in a
// screen fixes it to whatever row type that screen has.
const TypedDataTable = DataTable<Person>

const meta = {
  title: 'Primitives/DataTable',
  component: TypedDataTable,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: each row action is a real, individually focusable',
          'control — `Tab` reaches them in row order, the same as any other',
          'set of controls on the page. There is no roving tabindex here; the',
          '`···` menu the row actions slot is built for arrives with the',
          'sibling `feat/ui-forms` unit and brings its own key handling with',
          'it.',
        ].join('\n'),
      },
    },
  },
  args: {
    actionsLabel: 'Actions',
  },
} satisfies Meta<typeof TypedDataTable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    caption: "Personnes de l'organisation",
    columns,
    rows,
    rowKey: (row) => row.id,
    rowFailed: (row) => row.failed === true,
  },
}

export const WithRowActions: Story = {
  args: {
    caption: "Personnes de l'organisation",
    columns,
    rows,
    rowKey: (row) => row.id,
    rowActions: (row) => (
      <Button variant="tertiary" size="sm">
        Retirer {row.name}
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The horizontal scroll container is a tab stop of its own — a table with
    // no row actions would otherwise be scrollable by pointer only — so it
    // takes the first `Tab`, and the row actions follow it in row order.
    await userEvent.tab()
    await expect(canvas.getByRole('region', { name: "Personnes de l'organisation" })).toHaveFocus()

    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'Retirer Henri Duflot' })).toHaveFocus()
  },
}

export const Loading: Story = {
  args: {
    caption: "Personnes de l'organisation",
    columns,
    rows: [],
    rowKey: (row) => row.id,
    loading: true,
    loadingRowCount: 4,
    loadingLabel: 'Chargement des personnes',
  },
}

export const Empty: Story = {
  args: {
    caption: "Personnes de l'organisation",
    columns,
    rows: [],
    rowKey: (row) => row.id,
    empty: (
      <div className="flex flex-col items-center gap-1 text-sm text-c-ink-3">
        <p className="font-medium text-c-ink">Personne à afficher</p>
        <p>Invitez la première personne de votre organisation.</p>
      </div>
    ),
  },
}
