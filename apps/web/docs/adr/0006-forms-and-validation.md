# ADR-0006: Forms are react-hook-form with zod schemas, wrapped once

**Status:** Accepted
**Date:** 2026-09-02
**Deciders:** the crew

## Context

The console is mostly forms: ordering, inviting people, adding a domain, paying an invoice. The flow specs are precise about them in three ways that decide the choice.

**Validation timing is specified per field** (spec §8): some fields validate on blur, some only on submit. That is a property of the form, not something each screen should re-derive from event handlers.

**Every message a customer reads is a catalogue key** (`docs/dev/I18N.md`). A validation message written inline in a schema is an untranslated English string in production, and nothing fails — the same silent failure the copy rules exist to prevent.

**TypeScript is strict here in a way forms feel.** `exactOptionalPropertyTypes` makes the resolver boundary — where a schema's optional fields meet a form library's generic defaults — the single friction point of the whole approach. Left alone, that friction is re-encountered and re-worked around in every form.

There is also an overlap worth exploiting: ADR-0005 validates route search parameters with zod. If forms use something else, the console has two validation vocabularies for the same values.

## Decision

**react-hook-form for form state, zod for the schema, and exactly one wrapper.**

- **One zod schema per form**, and **the same zod schemas validate search parameters** (ADR-0005). A value's shape is declared once whether it arrives from a field or from the URL.
- **Validation timing comes from the schema's form, through react-hook-form's `mode`**, set to match spec §8 (on blur where the spec says on blur, on submit where it says on submit). No hand-written blur or change handler decides when a message appears.
- **`zodResolver` is wrapped exactly once, in `src/ui/Form`.** Nothing else imports the resolver. This is checkable in review: a PR that imports `zodResolver` outside `src/ui/Form` is wrong, and the `exactOptionalPropertyTypes` friction stays in that one file instead of being solved five different ways.
- **Error copy is keys, never sentences.** The schema returns a catalogue key; the field renders `t(key)`. A schema that contains a French or English sentence is a review comment.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: react-hook-form + zod, one wrapper in `src/ui/Form`** | Uncontrolled by default, so a large form does not re-render on every keystroke; `mode` expresses the spec's timing directly; zod is already in the stack for search parameters. Costs one adapter file that has to absorb the strict-TypeScript friction. |
| TanStack Form | Rejected: younger, with fewer documented accessibility patterns for the error-announcement and focus-management behaviour we need on every form, and it would add a second TanStack surface to learn on top of ADR-0005's two. |
| Formik | Rejected on maintenance: the console will be built on this for years, and its render-on-change model is the slower one on the long forms. |
| Hand-rolled form state | Rejected: it repeats focus management and error announcement in every form, which is exactly where accessibility regressions hide — and WCAG AA is a gate, not polish (AGENTS.md). |
| yup or valibot instead of zod | Rejected: not better here, and either one splits the vocabulary with the router's search-parameter schemas. |

## Consequences

- `src/ui/Form` is load-bearing and owned by CODEOWNERS alongside the rest of `src/ui/` (ADR-0004): every form in the console inherits its focus and announcement behaviour.
- Schemas become the place a reviewer looks for validation rules — one file per form, comparable line by line against the spec.
- A field's error key must exist in **both** catalogues in the same PR, or it renders as the key itself (`docs/dev/I18N.md` rule 3). This is worth a test per form rather than an assumption.
- Two dependencies arrive with the first form; neither is used anywhere else in the tree.
- Revisit if `exactOptionalPropertyTypes` friction cannot be contained in the single wrapper, or if a form needs field-level async validation the wrapper cannot express without leaking the resolver.
