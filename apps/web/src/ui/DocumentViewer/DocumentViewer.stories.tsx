import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { DocumentViewer } from './DocumentViewer'
import type { DocumentViewerSection } from './DocumentViewer'

const sections: DocumentViewerSection[] = [
  {
    id: 'roles',
    heading: '1. Rôles des parties',
    paragraphs: [
      'Le sous-traitant agit sur instruction documentée du responsable de traitement, pour la seule durée du contrat.',
    ],
  },
  {
    id: 'security',
    heading: '2. Sécurité',
    paragraphs: [
      'Les données sont chiffrées au repos et en transit, et l’accès est restreint au personnel habilité.',
      'Tout incident de sécurité est notifié sous 72 heures.',
    ],
  },
  {
    id: 'subprocessors',
    heading: '3. Sous-traitants ultérieurs',
    paragraphs: [
      'La liste des sous-traitants ultérieurs est tenue à jour et communiquée sur demande.',
    ],
  },
]

function printButton() {
  return (
    <button
      type="button"
      className="h-8 rounded-sm border border-c-border-strong bg-c-surface px-3 text-sm font-medium text-c-ink hover:bg-c-muted"
    >
      Imprimer
    </button>
  )
}

function downloadButton() {
  return (
    <button
      type="button"
      className="h-8 rounded-sm border border-c-border-strong bg-c-surface px-3 text-sm font-medium text-c-ink hover:bg-c-muted"
    >
      PDF
    </button>
  )
}

const meta = {
  title: 'Primitives/DocumentViewer',
  component: DocumentViewer,
  parameters: {
    docs: {
      description: {
        component: [
          'Keyboard: `Tab` reaches the region; once focused, `ArrowUp`/',
          '`ArrowDown` scroll a line, `PageUp`/`PageDown`/`Space` a viewport,',
          '`Home`/`End` jump to the start or the end. `Tab` also reaches each',
          'table-of-contents entry and, inside the region, each heading',
          '(`tabIndex={-1}`, reachable only by activating its entry, never by',
          'tabbing through). Reaching the end fires `onReadToEnd` once.',
          '',
          'A design gap (`docs/specs/README.md`): scrollable, focusable,',
          'labelled `role="region"`, its own heading outline as a table of',
          'contents, and the print/download states this primitive answers.',
        ].join('\n'),
      },
    },
  },
  args: {
    label: 'Contrat de sous-traitance — ACME Construction',
    tocLabel: 'Sommaire du document',
    progressLabel: 'Progression de lecture',
    printAction: printButton(),
    downloadAction: downloadButton(),
  },
} satisfies Meta<typeof DocumentViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  args: { status: 'loading' },
}

export const Failed: Story = {
  args: {
    status: 'failed',
    failureMessage: 'Ce document est momentanément indisponible.',
  },
}

export const Ready: Story = {
  args: { status: 'ready', sections },
}

export const TableOfContentsFocusesTheHeading: Story = {
  name: 'Table of contents moves focus to the heading',
  args: { status: 'ready', sections },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '2. Sécurité' }))

    await expect(canvas.getByRole('heading', { level: 3, name: '2. Sécurité' })).toHaveFocus()
  },
}

export const KeyboardScrollReachesTheEnd: Story = {
  name: 'Keyboard scroll reaches the end',
  args: { status: 'ready', sections },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = canvas.getByRole('region')
    region.focus()
    await expect(region).toHaveFocus()

    await userEvent.keyboard('{End}')
  },
}
