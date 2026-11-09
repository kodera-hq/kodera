// `quote` — 01-order.md §4.5: the Enterprise path. A short form that opens a
// support ticket of type `sales`; no price is shown (Enterprise discounts
// are never published).

import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { FieldError } from '../../ui/FieldError/FieldError'
import { TextField } from '../../ui/TextField/TextField'
import { useCapacityTiersQuery } from './api'
import { useCreateSupportTicketMutation } from './mutations'
import { largestCoveredHeadcount } from './recommendation'
import { quoteSchema } from './schemas'
import type { RegisterOptions, UseFormRegisterReturn } from 'react-hook-form'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'

type QuoteFormValues = z.infer<typeof quoteSchema>

export interface QuoteStepProps {
  onBack: () => void
}

export function QuoteStep({ onBack }: QuoteStepProps) {
  const { t } = useTranslation()
  const ticket = useCreateSupportTicketMutation()
  // The plan step's cutoff, from the same catalogue: a number of its own here
  // could say 330 while the plans stop at 333.
  const cutoff = largestCoveredHeadcount(useCapacityTiersQuery().data ?? [])
  const form = useForm<QuoteFormValues>({
    resolver: zodResolver(quoteSchema),
    defaultValues: { headcount: 0, country: 'FR', needs: '', contactEmail: '' },
    mode: 'onBlur',
  })

  function fieldProps(
    name: keyof QuoteFormValues,
    options?: RegisterOptions<QuoteFormValues>
  ): UseFormRegisterReturn & { error?: string } {
    const registration = form.register(name, options)
    const message = form.formState.errors[name]?.message
    if (message === undefined) return registration
    return { ...registration, error: t(message as MessageKey) }
  }

  function onSubmit(values: QuoteFormValues) {
    ticket.mutate({
      subject: `Devis Enterprise — ${values.headcount} personnes`,
      body: values.needs,
      contactEmail: values.contactEmail,
      locale: 'fr',
      idempotencyKey: crypto.randomUUID(),
    })
  }

  if (ticket.isSuccess && ticket.data !== undefined) {
    return (
      <Card>
        <CardBody>
          <p role="status" className="text-md text-c-ink">
            {t('console.order.quote.status-submitted', {
              hours: Math.ceil((ticket.data.sla?.first_response_target_minutes ?? 0) / 60),
            })}
          </p>
        </CardBody>
      </Card>
    )
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-c-ink">{t('console.order.quote.title')}</h1>
        <p className="mt-1 text-sm text-c-ink-3">
          {cutoff === undefined
            ? t('console.order.quote.subtitle-no-count')
            : t('console.order.quote.subtitle', { max: cutoff })}
        </p>
      </div>

      <TextField
        type="number"
        label={t('console.order.quote.label-headcount')}
        // Read as a number from the field itself, on change and on blur alike: a string read
        // back on blur would fail the schema's type check (live defect, 11-06).
        {...fieldProps('headcount', { valueAsNumber: true })}
      />
      <TextField label={t('console.order.quote.label-country')} {...fieldProps('country')} />
      <div className="flex flex-col gap-1">
        <label htmlFor="quote-needs" className="text-sm font-medium text-c-ink">
          {t('console.order.quote.label-needs')}
        </label>
        <textarea
          id="quote-needs"
          {...form.register('needs')}
          className="min-h-[96px] rounded-sm border border-c-border-input bg-c-surface p-3 text-md text-c-ink outline-hidden focus-visible:ring"
        />
        {form.formState.errors.needs?.message === undefined ? null : (
          <FieldError>{t(form.formState.errors.needs.message as MessageKey)}</FieldError>
        )}
      </div>
      <TextField
        type="email"
        label={t('console.order.quote.label-contact-email')}
        {...fieldProps('contactEmail')}
      />

      {ticket.isError ? (
        <p role="alert" className="text-xs text-c-bad-ink">
          {t('console.common.error-unexpected', { requestId: '—' })}
        </p>
      ) : null}

      <div className="flex justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onBack}>
          {t('console.common.action-back')}
        </Button>
        <Button type="submit" loading={ticket.isPending}>
          {t('console.order.quote.action-submit')}
        </Button>
      </div>
    </form>
  )
}
