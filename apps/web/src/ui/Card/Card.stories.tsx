import type { Meta, StoryObj } from '@storybook/react-vite'
import { Card, CardBody, CardFooter, CardHeader } from './Card'
import { Button } from '../Button/Button'

const meta = {
  title: 'Primitives/Card',
  component: Card,
  parameters: {
    docs: {
      description: {
        component: [
          'No keyboard behaviour of its own — a card is a container, and',
          'whatever it holds carries its own focus order. `CardHeader`,',
          '`CardBody` and `CardFooter` are the only slots; compose only the',
          'ones a screen needs.',
        ].join('\n'),
      },
    },
  },
  args: {
    children: 'Carte',
  },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    // Demo width only, no token for 320px.
    <Card className="w-[320px]">
      <CardBody>Un contenu simple, sans en-tête ni pied.</CardBody>
    </Card>
  ),
}

export const WithSlots: Story = {
  render: () => (
    // Demo width only, no token for 320px.
    <Card className="w-[320px]">
      <CardHeader>
        <h2 className="text-lg font-semibold text-c-ink">Domaine</h2>
      </CardHeader>
      <CardBody>
        <p className="text-sm text-c-ink-3">acme-construction.kodera.io est vérifié.</p>
      </CardBody>
      <CardFooter>
        <Button variant="secondary" size="sm">
          Annuler
        </Button>
        <Button size="sm">Enregistrer</Button>
      </CardFooter>
    </Card>
  ),
}

export const Inverse: Story = {
  render: () => (
    // Demo width only, no token for 320px.
    <Card tone="inverse" className="w-[320px]">
      <CardBody>
        <p className="text-sm font-medium text-c-on-inverse-dim">Contrat annuel</p>
        <p className="mt-1 text-lg font-semibold">Renouvellement le 3 janvier 2027</p>
      </CardBody>
    </Card>
  ),
}
