// The e-mail address realm discovery accepts, verbatim from the pinned contract:
// `RealmDiscoveryRequest.email` is an "approved ASCII email" of at most 254 characters,
// at most 64 before the `@`, a dot-atom local part and a domain of two or more labels of
// letters, digits and inner hyphens. An address outside it is refused with `422`, which
// the sign-in screen can only answer with its generic message — so the screen checks it
// first, and says what is wrong before anything is sent.
//
// A copy rather than a read from `schema.d.ts`, which carries no `pattern` or
// `maxLength`. `discoveryEmail.test.ts` holds both to the contract's own text, so the copy
// cannot drift when the pin moves. `(?![\s\S])` in place of `$` is the contract's
// spelling, kept verbatim: JSON Schema matches by search and `$` would admit a trailing
// newline.
//
// Assembled from parts rather than written as one regex literal: the local part's
// character class contains a backtick, and a lone backtick in a source file is read as an
// unterminated template literal by the source scanners in `tests/unit/` (the spacing
// guard stops at it). `\u0060` puts the same character in the pattern without one.

const BACKTICK = '\u0060'
/** One character of the local part: the dot-atom `atext` set, ASCII only. */
const ATEXT = "[A-Za-z0-9!#$%&'*+\\-/=?^_" + BACKTICK + '{|}~]'
/** One domain label: letters and digits, inner hyphens, 63 characters at most. */
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'

export const DISCOVERY_EMAIL_PATTERN = new RegExp(
  '^(?=[^@]{1,64}@)' +
    ATEXT +
    '+(?:\\.' +
    ATEXT +
    '+)*@' +
    LABEL +
    '(?:\\.' +
    LABEL +
    ')+(?![\\s\\S])'
)

export const DISCOVERY_EMAIL_MAX_LENGTH = 254

export function isDiscoveryEmail(value: string): boolean {
  return value.length <= DISCOVERY_EMAIL_MAX_LENGTH && DISCOVERY_EMAIL_PATTERN.test(value)
}
