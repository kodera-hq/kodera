import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../Button/Button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowActions,
  TableStatusCell,
} from './Table'

const meta = {
  title: 'Primitives/Table',
  component: Table,
  parameters: {
    docs: {
      description: {
        component: [
          'No roving keyboard behaviour of its own: every cell is static',
          'markup, and each interactive element inside a row (a row action, a',
          'link) is reached with `Tab` like any other control on the page.',
          '`DataTable` is what adds column definitions, loading rows and a',
          'keyboard-navigable action slot on top of this primitive.',
        ].join('\n'),
      },
    },
  },
  // Every story below replaces the render entirely; this is only here to
  // satisfy `caption` and `children`, which `Table` requires and `Meta`
  // therefore requires too.
  args: {
    caption: 'Table',
    children: null,
  },
} satisfies Meta<typeof Table>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Table caption="Personnes de l'organisation">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Nom</TableHeaderCell>
          <TableHeaderCell>E-mail</TableHeaderCell>
          <TableHeaderCell status>Statut</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableCell>Henri Duflot</TableCell>
          <TableCell>henri.duflot@acme-construction.fr</TableCell>
          <TableStatusCell>Active</TableStatusCell>
          <TableRowActions>
            <Button variant="tertiary" size="sm">
              Retirer
            </Button>
          </TableRowActions>
        </TableRow>
        <TableRow>
          <TableCell>Bruno Petit</TableCell>
          <TableCell>bruno@acme-construction.fr</TableCell>
          <TableStatusCell>En attente</TableStatusCell>
          <TableRowActions>
            <Button variant="tertiary" size="sm">
              Renvoyer
            </Button>
          </TableRowActions>
        </TableRow>
      </TableBody>
    </Table>
  ),
}

export const PartialFailureRow: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The row style `DataTable` applies when a row is a partial failure — a hairline still separates rows, and a left border plus a tint reinforce a status word that lives in the row itself, never colour alone.',
      },
    },
  },
  render: () => (
    <Table caption="Import de personnes">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Ligne</TableHeaderCell>
          <TableHeaderCell status>Statut</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableCell>henri.duflot@acme-construction.fr</TableCell>
          <TableStatusCell>Importée</TableStatusCell>
        </TableRow>
        <TableRow tone="danger">
          <TableCell>bruno@acme-construction</TableCell>
          <TableStatusCell>Adresse invalide</TableStatusCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
}
