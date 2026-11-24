import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SandboxedWidgetCard } from './SandboxedWidgetCard'
import { validateWidgetCard, type WidgetCard } from './widgetSchema'

const VALID_CARD: WidgetCard = {
  schemaVersion: 'kodera.widget.v1',
  widgetId: 'deploy-gate',
  title: 'Deployment Gate',
  blocks: [
    { type: 'header', title: 'Release v1.8.0', subtitle: 'Scaleway PAR-2' },
    { type: 'text', body: 'Canary probe checks passed.', tone: 'muted' },
    { type: 'status_pill', label: 'Awaiting approval', state: 'warning' },
    { type: 'progress_bar', label: 'Rollout progress', value: 72, tone: 'success' },
    {
      type: 'kv_list',
      items: [
        { label: 'Commit', value: 'a91f02c', mono: true },
        { label: 'Region', value: 'eu-west-par' },
      ],
    },
    {
      type: 'button_row',
      actions: [
        { actionId: 'approve', label: 'Approve rollout', variant: 'primary', value: 'prod' },
        { actionId: 'abort', label: 'Abort', variant: 'destructive' },
      ],
    },
    {
      type: 'link_button',
      label: 'Open runbook',
      href: 'https://docs.kodera.example.org/runbooks/release',
      variant: 'secondary',
    },
  ],
}

describe('SandboxedWidgetCard & validateWidgetCard', () => {
  it('renders closed declarative primitives with CSSOM progress width, noopener https link, and action callbacks', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()

    const { container } = render(<SandboxedWidgetCard card={VALID_CARD} onAction={onAction} />)

    expect(screen.getByRole('region', { name: 'Deployment Gate' })).toBeInTheDocument()
    expect(screen.getByText('Release v1.8.0')).toBeInTheDocument()
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument()
    expect(screen.getByText('a91f02c')).toBeInTheDocument()

    // Zero iframe elements and zero inline style HTML attributes before CSSOM mount check:
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    const fill = screen.getByTestId('widget-progress-fill-deploy-gate')
    expect(fill.style.getPropertyValue('width')).toBe('72%')

    // Safe external HTTPS link enforces target="_blank" and rel="noopener noreferrer":
    const link = screen.getByTestId('widget-link-deploy-gate')
    expect(link).toHaveAttribute('href', 'https://docs.kodera.example.org/runbooks/release')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    // Action button dispatches closed callback payload:
    await user.click(screen.getByTestId('widget-action-deploy-gate-approve'))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({
      widgetId: 'deploy-gate',
      actionId: 'approve',
      value: 'prod',
    })
  })

  it('rejects prototype pollution, unknown blocks, >5 actions, out-of-range progress, >16 KiB size, and unsafe links', () => {
    const polluted = JSON.parse(
      '{"schemaVersion":"kodera.widget.v1","widgetId":"bad-card","__proto__":{"polluted":true},"blocks":[{"type":"text","body":"hi"}]}'
    ) as unknown
    expect(validateWidgetCard(polluted)).toEqual({
      ok: false,
      code: 'WIDGET_PROTOTYPE_POLLUTION',
    })

    expect(
      validateWidgetCard({
        schemaVersion: 'kodera.widget.v1',
        widgetId: 'bad-card',
        blocks: [{ type: 'raw_html', html: '<b>nope</b>' }],
      })
    ).toEqual({ ok: false, code: 'INVALID_WIDGET_BLOCK' })

    expect(
      validateWidgetCard({
        schemaVersion: 'kodera.widget.v1',
        widgetId: 'bad-card',
        blocks: [{ type: 'progress_bar', label: 'Over', value: 120 }],
      })
    ).toEqual({ ok: false, code: 'INVALID_WIDGET_PROGRESS' })

    expect(
      validateWidgetCard({
        schemaVersion: 'kodera.widget.v1',
        widgetId: 'bad-card',
        blocks: [
          {
            type: 'button_row',
            actions: Array.from({ length: 6 }, (_, idx) => ({
              actionId: `act_${idx}`,
              label: `Act ${idx}`,
            })),
          },
        ],
      })
    ).toEqual({ ok: false, code: 'WIDGET_TOO_MANY_ACTIONS' })

    for (const unsafeHref of [
      'http://docs.kodera.example.org/plain',
      'javascript:alert(1)',
      'https://localhost/internal',
      'https://127.0.0.1/secret',
    ]) {
      expect(
        validateWidgetCard({
          schemaVersion: 'kodera.widget.v1',
          widgetId: 'bad-card',
          blocks: [{ type: 'link_button', label: 'Unsafe', href: unsafeHref }],
        })
      ).toEqual({ ok: false, code: 'INVALID_WIDGET_LINK' })
    }

    const oversized = {
      schemaVersion: 'kodera.widget.v1',
      widgetId: 'bad-card',
      blocks: Array.from({ length: 10 }, (_, idx) => ({
        type: 'text',
        body: `Block ${idx} ` + 'x'.repeat(1800),
      })),
    }
    expect(validateWidgetCard(oversized)).toEqual({ ok: false, code: 'WIDGET_TOO_LARGE' })

    render(
      <SandboxedWidgetCard
        card={{
          schemaVersion: 'kodera.widget.v1',
          widgetId: 'bad-card',
          blocks: [{ type: 'link_button', label: 'Bad', href: 'http://example.com' }],
        }}
      />
    )
    expect(screen.getByTestId('sandboxed-widget-refused')).toHaveAttribute(
      'data-error-code',
      'INVALID_WIDGET_LINK'
    )
  })
})
