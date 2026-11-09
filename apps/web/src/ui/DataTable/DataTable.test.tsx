import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

interface Person {
  id: string
  name: string
  status: string
  failed?: boolean
}

const rows: Person[] = [
  { id: 'p1', name: 'Henri Duflot', status: 'Active' },
  { id: 'p2', name: 'Bruno Petit', status: 'En attente' },
]

const columns: DataTableColumn<Person>[] = [
  { key: 'name', header: 'Nom', render: (row) => row.name },
  { key: 'status', header: 'Statut', render: (row) => row.status, status: true },
]

describe('DataTable', () => {
  it('marks only the caller-selected identifying column as a row header', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns.map((column) => ({ ...column, rowHeader: column.key === 'name' }))}
        rows={rows}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
      />
    )

    expect(screen.getAllByRole('rowheader')).toHaveLength(rows.length)
    const header = screen.getByRole('rowheader', { name: 'Henri Duflot' })
    expect(header).toHaveAttribute('scope', 'row')
    expect(header).toHaveClass('font-regular', 'text-left', 'px-5', 'py-3')
    expect(screen.getByRole('cell', { name: 'Active' })).toBeInTheDocument()
    expect(screen.queryByRole('cell', { name: 'Henri Duflot' })).not.toBeInTheDocument()
  })

  it('renders one row per item, through the column definitions', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
      />
    )

    expect(screen.getByRole('cell', { name: 'Henri Duflot' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Bruno Petit' })).toBeInTheDocument()
  })

  it('shows the empty slot when there are no rows and it is not loading', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        empty={<p>Personne à afficher</p>}
      />
    )

    expect(screen.getByText('Personne à afficher')).toBeInTheDocument()
  })

  it('shows skeleton rows instead of data while loading, without the empty slot', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        loading
        loadingRowCount={3}
        empty={<p>Personne à afficher</p>}
      />
    )

    expect(screen.queryByText('Personne à afficher')).toBeNull()
    expect(screen.queryByText('Henri Duflot')).toBeNull()
    const table = screen.getByRole('table')
    // header row + 3 skeleton rows
    expect(within(table).getAllByRole('row')).toHaveLength(4)
  })

  it('announces the loading state to assistive technology', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        loading
        loadingLabel="Chargement des personnes"
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('Chargement des personnes')
  })

  it('marks a row the caller flags as a partial failure', () => {
    const failedRows: Person[] = [
      { id: 'p3', name: 'Carla Dupuis', status: 'Erreur', failed: true },
    ]
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={failedRows}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        rowFailed={(row) => row.failed === true}
      />
    )

    const row = screen.getByRole('cell', { name: 'Carla Dupuis' }).closest('tr')
    expect(row).toHaveClass('border-l-c-bad')
  })

  it('renders a row actions cell from the render slot, with a plain button in this unit', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        rowActions={(row) => (
          <button type="button" onClick={() => onRemove(row.id)}>
            Retirer {row.name}
          </button>
        )}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Retirer Henri Duflot' }))

    expect(onRemove).toHaveBeenCalledWith('p1')
  })

  it('takes the row actions header text from the caller, not a string baked into the primitive', () => {
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        actionsLabel="Actions rapides"
        rowActions={(row) => <button type="button">Retirer {row.name}</button>}
      />
    )

    expect(screen.getByText('Actions rapides')).toBeInTheDocument()
  })

  it('lets Tab reach the scroll container and then every row action in row order', async () => {
    const user = userEvent.setup()
    render(
      <DataTable
        caption="Personnes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        actionsLabel="Actions"
        rowActions={(row) => <button type="button">Retirer {row.name}</button>}
      />
    )

    // `Table` makes its horizontal scroll box focusable (WCAG 2.1.1), so it is
    // the first stop; the row actions keep their order behind it.
    await user.tab()
    expect(screen.getByRole('region', { name: 'Personnes' })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Retirer Henri Duflot' })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Retirer Bruno Petit' })).toHaveFocus()
  })
})
