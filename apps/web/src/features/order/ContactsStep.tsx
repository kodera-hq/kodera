// `contacts` — 01-order.md §4.2: who the buyer is, the space they want, and
// the three addresses that receive access, invoices and security alerts.
// The slug is checked server-side, debounced on blur (§8); a taken name
// never says who holds it (contract's own privacy rule for that endpoint).
//
// `TextField`/`EmailField` directly, not `FormField`: the zod schemas
// (`schemas.ts`) carry catalogue KEYS as their messages, not sentences —
// `FormField` renders whatever react-hook-form hands it verbatim, so a key
// would land on screen untranslated. `fieldProps` below is the one place
// a key becomes the text a customer reads.

import { zodResolver } from '@hookform/resolvers/zod'
import { useCallback, useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { FieldPath, UseFormRegisterReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { EmailField } from '../../ui/EmailField/EmailField'
import { FieldError } from '../../ui/FieldError/FieldError'
import { Select } from '../../ui/Select/Select'
import { useFormStash } from '../../auth/sessionExpiry'
import { isActiveOrderOwner } from './useOrderDraft'
import { OrderSummary } from './OrderSummary'
import { clearStashedContacts, readStashedContacts, stashContacts } from './contactStash'
import { ownerTuple, readEditable } from './editableStorage'
import type { OrderOwner } from './owner'
import { TextField } from '../../ui/TextField/TextField'
import { isTenantSlug } from '../../api/tenantSlug'
import { useSlugAvailabilityQuery } from './api'
import { configuredTenantDomain } from './tenantAddress'
import type { DraftContacts, OrderDraft } from './draft'
import type { ContactsFormValues } from './schemas'
import { contactsSchema } from './schemas'

export interface ContactsStepProps {
  draft: OrderDraft
  owner: OrderOwner
  update: (patch: Partial<OrderDraft>) => void
  onContinue: () => void
  onBack: () => void
}

const EMPTY: ContactsFormValues = {
  legalName: '',
  slug: '',
  registrationNumber: '',
  vatNumber: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'FR',
  billingReference: '',
  adminEmail: '',
  billingEmail: '',
  securityEmail: '',
}

const COUNTRIES = [
  { value: 'FR', label: 'France' },
  { value: 'BE', label: 'Belgique' },
  { value: 'LU', label: 'Luxembourg' },
  { value: 'DE', label: 'Allemagne' },
  { value: 'ES', label: 'Espagne' },
]

type FieldProps = UseFormRegisterReturn<FieldPath<ContactsFormValues>> & { error?: string }

export function ContactsStep(props: ContactsStepProps) {
  return (
    <ContactsForm
      key={JSON.stringify([
        ...ownerTuple(props.owner),
        props.owner.generation,
        props.draft.draftId,
      ])}
      {...props}
    />
  )
}

function ContactsForm({ draft, owner, update, onContinue, onBack }: ContactsStepProps) {
  const { t } = useTranslation()
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [checkedSlug, setCheckedSlug] = useState<string>()
  const [recovered] = useState(() => readStashedContacts(owner, draft.draftId))
  // The domain Core puts the tenant under (`tenantAddress.ts`); unset, the field names none.
  const tenantDomain = configuredTenantDomain()

  const form = useForm<ContactsFormValues>({
    resolver: zodResolver(contactsSchema),
    defaultValues: {
      ...EMPTY,
      ...(recovered?.contacts ??
        draft.contactEdits ??
        (draft.contacts as DraftContacts | undefined)),
    },
    mode: 'onBlur',
  })

  useEffect(() => {
    const subscription = form.watch((_values, { name }) => {
      if (name === undefined) return
      const values = form.getValues()
      update({ contactEdits: values, contacts: undefined })
      const saved = readEditable(draft.draftId, owner)
      if (
        isActiveOrderOwner(owner) &&
        saved.status === 'saved' &&
        JSON.stringify(saved.draft.contactEdits) === JSON.stringify(values)
      )
        clearStashedContacts(owner, draft.draftId)
    })
    return () => subscription.unsubscribe()
  }, [form, update, owner, draft.draftId])

  useFormStash(
    useCallback(() => {
      stashContacts(owner, draft.draftId, form.getValues())
    }, [owner, draft.draftId, form])
  )

  useEffect(() => {
    if (recovered === undefined) return
    let cancelled = false
    // Parent draft ownership becomes mounted after child effects. A microtask
    // also lets StrictMode cancel its discarded recovery before any save.
    queueMicrotask(() => {
      if (cancelled || !isActiveOrderOwner(owner)) return
      update({ contactEdits: recovered.contacts, contacts: undefined })
      const saved = readEditable(draft.draftId, owner)
      if (
        saved.status === 'saved' &&
        JSON.stringify(saved.draft.contactEdits) === JSON.stringify(recovered.contacts)
      )
        clearStashedContacts(owner, draft.draftId, recovered.raw)
    })
    return () => {
      cancelled = true
    }
  }, [recovered, owner, draft.draftId, update])

  const slugValue = form.watch('slug')
  const slugQuery = useSlugAvailabilityQuery(checkedSlug ?? '', checkedSlug !== undefined)
  const countryError = form.formState.errors.country?.message

  useEffect(() => {
    if (slugQuery.data === undefined) return
    if (slugQuery.data.available) {
      setSuggestions([])
      return
    }
    setSuggestions(slugQuery.data.suggestions ?? [])
    form.setError('slug', {
      message: t('console.order.contacts.error-slug-taken', {
        suggestion: slugQuery.data.suggestions?.[0] ?? slugQuery.data.slug,
      }),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugQuery.data])

  function handleSlugBlur() {
    const trimmed = slugValue.trim()
    // Only a well-formed tenant slug is asked about: the endpoint's `slug` parameter carries
    // the whole pattern and refuses anything else with `malformed-request`, and the format
    // error the schema raises on blur already tells the buyer what to fix.
    if (isTenantSlug(trimmed)) setCheckedSlug(trimmed)
  }

  function chooseSuggestion(value: string) {
    form.setValue('slug', value)
    form.clearErrors('slug')
    setSuggestions([])
    setCheckedSlug(value)
  }

  function onSubmit(values: ContactsFormValues) {
    update({ contacts: values, contactEdits: undefined })
    clearStashedContacts(owner, draft.draftId)
    onContinue()
  }

  /** Registers `name` and, when it is invalid, translates the catalogue key
   * the schema set as its message — the zod message IS already the final
   * text for a server-set error (`error-slug-taken` above interpolates a
   * suggestion at the point it is thrown, not through this path), and
   * `t()` on an already-translated sentence is a no-op key miss, so this
   * only translates keys that still look like one. */
  function fieldProps(
    name: keyof ContactsFormValues,
    tFn: TFunction,
    onBlur?: () => void
  ): FieldProps {
    const registration = form.register(name, onBlur === undefined ? {} : { onBlur })
    const message = form.formState.errors[name]?.message
    if (message === undefined) return registration
    const looksLikeKey = message.startsWith('console.')
    return { ...registration, error: looksLikeKey ? tFn(message as MessageKey) : message }
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      noValidate
      className="grid gap-6 lg:grid-cols-[1fr_320px] narrow:grid-cols-1"
    >
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-c-ink">{t('console.order.contacts.title')}</h1>

        <TextField
          label={t('console.order.contacts.label-legal-name')}
          {...fieldProps('legalName', t)}
        />

        <div>
          <TextField
            label={t('console.order.contacts.label-slug')}
            {...(tenantDomain === undefined
              ? { help: t('console.order.contacts.hint-slug-no-domain') }
              : {
                  suffix: `.${tenantDomain}`,
                  help: t('console.order.contacts.hint-slug', {
                    preview: `${slugValue === '' ? '…' : slugValue}.${tenantDomain}`,
                  }),
                })}
            {...fieldProps('slug', t, handleSlugBlur)}
          />
          {suggestions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => chooseSuggestion(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <Controller
            control={form.control}
            name="country"
            render={({ field }) => (
              <Select
                label={t('console.order.contacts.label-country')}
                options={COUNTRIES}
                value={field.value}
                onValueChange={field.onChange}
              />
            )}
          />
          {countryError === undefined ? null : (
            <FieldError>{t(countryError as MessageKey)}</FieldError>
          )}
        </div>

        <TextField
          label={t('console.order.contacts.label-registration')}
          {...fieldProps('registrationNumber', t)}
        />
        <TextField
          label={t('console.order.contacts.label-vat')}
          help={t('console.order.contacts.hint-vat')}
          {...fieldProps('vatNumber', t)}
        />

        <fieldset className="flex flex-col gap-4">
          <legend className="text-md font-semibold text-c-ink">
            {t('console.order.contacts.title-address')}
          </legend>
          <TextField
            label={t('console.order.contacts.label-address-line1')}
            {...fieldProps('addressLine1', t)}
          />
          <div className="grid grid-cols-2 gap-4 narrow:grid-cols-1">
            <TextField
              label={t('console.order.contacts.label-postal-code')}
              {...fieldProps('postalCode', t)}
            />
            <TextField label={t('console.order.contacts.label-city')} {...fieldProps('city', t)} />
          </div>
          <TextField
            label={t('console.order.contacts.label-reference')}
            help={t('console.order.contacts.hint-reference')}
            {...fieldProps('billingReference', t)}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="text-md font-semibold text-c-ink">
            {t('console.order.contacts.title-contacts')}
          </legend>
          <p className="text-xs text-c-ink-3">{t('console.order.contacts.hint-contacts')}</p>
          <EmailField
            label={t('console.order.contacts.label-admin-email')}
            help={t('console.order.contacts.hint-admin-email')}
            {...fieldProps('adminEmail', t)}
          />
          <EmailField
            label={t('console.order.contacts.label-billing-email')}
            {...fieldProps('billingEmail', t)}
          />
          <EmailField
            label={t('console.order.contacts.label-security-email')}
            {...fieldProps('securityEmail', t)}
          />
        </fieldset>

        <div className="flex justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onBack}>
            {t('console.common.action-back')}
          </Button>
          <Button type="submit">{t('console.common.action-continue')}</Button>
        </div>
      </div>

      <OrderSummary draft={draft} />
    </form>
  )
}
