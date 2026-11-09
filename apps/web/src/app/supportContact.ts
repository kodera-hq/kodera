// The one address a customer is told to write to, everywhere in the console:
// the route error screen, the sign-in screen's help link, the order
// confirmation's fallback, and every catalogue sentence that names an address
// (it takes it as `{email}` rather than spelling it, and `src/i18n/index.ts`
// fills that placeholder with this constant). Changing it is a one-line change
// here, never a copy edit in two languages; `supportContact.test.ts` fails on
// an address written anywhere else, and `supportSentences.test.ts` on a
// sentence that tells the customer to write and gives none.
export const SUPPORT_EMAIL = 'support@kodera.io'
