// "The VAT sentence is rendered from `vat_regime` … through the message
// catalogue, not from a server sentence" (§6). `fr_standard` needs no
// explanatory sentence of its own — the ordinary "TVA {rate} %" line already
// says what it is; the other three regimes each get one, since those are
// exactly the ones §2's "alone test" calls out ("A VAT-exempt or
// reverse-charge invoice states its regime in words on the row").

import type { MessageKey } from '../../i18n'
import type { components } from '../../api/schema'

export type VatRegime = components['schemas']['VatRegime']

const KEY: Partial<Record<VatRegime, MessageKey>> = {
  eu_reverse_charge: 'console.invoices._.vat-regime-eu-reverse-charge',
  exempt: 'console.invoices._.vat-regime-exempt',
  outside_eu: 'console.invoices._.vat-regime-outside-eu',
}

export function vatRegimeSentenceKey(regime: VatRegime | undefined): MessageKey | undefined {
  if (regime === undefined) return undefined
  return KEY[regime]
}
