// The TOTP branch of `mfa-enrol` (docs/specs/00-shell-and-login.md §4.4, §8):
// pure formatting and validation, kept apart from `MfaEnrolSimulation.tsx` so
// the six-digit rule and the recovery-code shape are unit-tested directly.
//
// `verifyTotpCode`'s "server" is Keycloak, not the Core API (§6 Notes), and
// nothing in this repository's mocked surface stands in for Keycloak's own
// verification endpoint (only the discovery document and the token endpoint
// are faked, in `src/mocks/auth.ts`, for the OIDC round trip itself). This
// is the guide's own stand-in: every correctly-formatted code is accepted
// except the one reserved sentinel, `000000`, which end-to-end specs use to
// exercise the wrong-code and lockout states on purpose.

export const WRONG_CODE_SENTINEL = '000000'

export const MAX_ATTEMPTS = 5
export const LOCKOUT_S = 60

/** Groups a base32 secret into 4-character blocks, the way an authenticator
 * app's own "enter manually" screen shows it. */
export function formatSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ')
}

/** `otpauth://` URI the QR encodes (RFC 6238 / Google Authenticator's own
 * key-uri format) — `issuer` and `account` are shown by every authenticator
 * app once the code is scanned, so the entry reads "Kodera — the
 * person's email" rather than an anonymous six-digit source. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** §8: "Exactly 6 digits, spaces stripped." Applied before both the format
 * check and the (mock) server check, same as `normalizeSlug` for discovery. */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\s+/g, '')
}

export function isTotpFormatValid(code: string): boolean {
  return /^\d{6}$/.test(code)
}

/** See the module comment: everything but the reserved sentinel "succeeds",
 * because nothing in this build's mocked surface is Keycloak's own verifier. */
export function verifyTotpCode(code: string): boolean {
  return code !== WRONG_CODE_SENTINEL
}

/** The symbols a recovery code is drawn from: the ten digits and the twenty-six
 * uppercase Latin letters — exactly the set the displayed `XXXX-XXXX` shape
 * admits, so the display contract is unchanged. Eight symbols out of 36 carry
 * log2(36^8) ~= 41.4 bits of entropy per code.
 *
 * The full set is used rather than a transcription-friendly subset (dropping
 * `O`/`0` and `I`/`1`, as some recovery-code schemes do): a subset would be a
 * silent narrowing of what the display and its tests accept, and it would buy
 * legibility this build has no use for — these are demonstration strings shown
 * on screen for copying, never dictated or hand-transcribed. */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Symbols per code, shown as two groups of four. */
const RECOVERY_CODE_LENGTH = 8

/** `getRandomValues` fills bytes uniformly over 0..255 and 256 is not a
 * multiple of 36, so a plain `byte % 36` would draw the first four symbols
 * eight times in 256 and the other thirty-two seven times — a real bias, not a
 * rounding detail. Bytes at or above the largest multiple of 36 that fits in a
 * byte (36 * 7 = 252) are rejected and redrawn instead, which discards four
 * byte values in 256 (~1.6%) and leaves every symbol exactly equally likely. */
const UNBIASED_BYTE_CEILING = 256 - (256 % RECOVERY_CODE_ALPHABET.length)

/** Both loops below redraw on a condition that a working `crypto` clears
 * immediately. These bounds exist only so a degenerate source — a stub, a
 * broken polyfill, a byte generator stuck on one value — fails loudly instead
 * of spinning forever. They are far beyond anything real randomness reaches. */
const MAX_BYTES_PER_SYMBOL = 32
const MAX_DRAWS_PER_CODE = 8

/** Draws `length` symbols uniformly from the alphabet, rejecting biased bytes
 * rather than folding them. Always returns exactly `length` symbols or throws;
 * it can never return a short string, which is the defect this replaces. */
function drawSymbols(length: number): string {
  const size = RECOVERY_CODE_ALPHABET.length
  const maxBytes = length * MAX_BYTES_PER_SYMBOL
  let symbols = ''
  let bytesDrawn = 0
  while (symbols.length < length) {
    if (bytesDrawn >= maxBytes) {
      throw new Error(
        `recovery code: ${bytesDrawn} random bytes yielded only ${symbols.length} of ${length} symbols`
      )
    }
    const bytes = crypto.getRandomValues(new Uint8Array(length - symbols.length))
    for (const byte of bytes) {
      bytesDrawn += 1
      // In range by construction: `byte % size` is always 0..size-1.
      if (byte < UNBIASED_BYTE_CEILING) symbols += RECOVERY_CODE_ALPHABET.charAt(byte % size)
    }
  }
  return symbols
}

/** Demonstration strings for the recovery step. They are not registered with
 * an identity provider and cannot recover or authenticate a real account.
 *
 * Every code is exactly eight symbols shown as `XXXX-XXXX`. At ~41.4 bits a
 * code, two codes in one batch of eight collide with probability ~1e-11, so
 * the uniqueness redraw effectively never runs; the bound is there for the
 * degenerate-source case only. */
export function generateRecoveryCodes(count = 8): string[] {
  const codes = new Set<string>()
  const maxDraws = count * MAX_DRAWS_PER_CODE
  let draws = 0
  while (codes.size < count) {
    if (draws >= maxDraws) {
      throw new Error(
        `recovery codes: ${draws} draws yielded ${codes.size} unique of ${count} requested`
      )
    }
    draws += 1
    const symbols = drawSymbols(RECOVERY_CODE_LENGTH)
    codes.add(`${symbols.slice(0, 4)}-${symbols.slice(4)}`)
  }
  return [...codes]
}
