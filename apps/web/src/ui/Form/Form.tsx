import { zodResolver } from '@hookform/resolvers/zod'
import { forwardRef } from 'react'
import type { FormHTMLAttributes, ReactNode, Ref } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import type { FieldValues, SubmitHandler, UseFormProps, UseFormReturn } from 'react-hook-form'
import type { ZodType } from 'zod'

export interface FormProps<TFieldValues extends FieldValues> extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'onSubmit' | 'children'
> {
  /**
   * The single source of validation — a `zodResolver` wraps it, so there is
   * no second, hand-written validation path to drift from this one. Both type
   * parameters are `TFieldValues`, matching `onSubmit`'s `SubmitHandler`: this
   * is a form, not a schema that reshapes data on the way through.
   */
  schema: ZodType<TFieldValues, TFieldValues>
  defaultValues: UseFormProps<TFieldValues>['defaultValues']
  /** When a field is (re-)validated. `onSubmit` (the default) validates once,
   * on submit; `onChange` / `onBlur` validate as the person fills the form in. */
  mode?: UseFormProps<TFieldValues>['mode']
  onSubmit: SubmitHandler<TFieldValues>
  /** Plain children read `FormField`'s context; a function gets the form
   * methods directly, for a submit-disabled-while-invalid button or the like. */
  children: ReactNode | ((methods: UseFormReturn<TFieldValues>) => ReactNode)
}

function FormInner<TFieldValues extends FieldValues>(
  {
    schema,
    defaultValues,
    mode = 'onSubmit',
    onSubmit,
    children,
    ...rest
  }: FormProps<TFieldValues>,
  ref: Ref<HTMLFormElement>
) {
  const methods = useForm<TFieldValues>({
    resolver: zodResolver(schema),
    // `exactOptionalPropertyTypes`: `UseFormProps['defaultValues']` is
    // optional but its type does not itself include `undefined`, so an
    // explicit `defaultValues: undefined` is a different (rejected) thing
    // from omitting the key — the same conditional-spread shape used for
    // every other optional prop in this unit (`Select.tsx`, `Switch.tsx`).
    ...(defaultValues === undefined ? {} : { defaultValues }),
    mode,
  })

  return (
    <FormProvider {...methods}>
      {/* `noValidate`: the browser's own validation bubbles say nothing a
          screen reader announces reliably and nothing the message catalogues
          control — `FieldError` is the one error UI this form ever shows.
          `handleSubmit`'s default `shouldFocusError` is what moves focus to
          the first invalid field; nothing here has to repeat that. */}
      <form {...rest} ref={ref} noValidate onSubmit={methods.handleSubmit(onSubmit)}>
        {typeof children === 'function' ? children(methods) : children}
      </form>
    </FormProvider>
  )
}

/**
 * `FormProvider` plus one `zodResolver` wrapper — the single place a schema
 * turns into form state, so no screen hand-rolls its own `resolver` call.
 * `FormField` reads the context this sets up; a caller who needs the raw
 * methods (a submit button disabled while the form is invalid, say) uses the
 * function-as-children form instead.
 *
 * Keyboard: `Enter` inside a single-line field submits, same as any HTML
 * form. On an invalid submit, focus moves to the first invalid field
 * (react-hook-form's own `shouldFocusError`, on by default) — never left on
 * the button that was just pressed.
 */
export const Form = forwardRef(FormInner) as <TFieldValues extends FieldValues>(
  props: FormProps<TFieldValues> & { ref?: Ref<HTMLFormElement> }
) => ReturnType<typeof FormInner>
