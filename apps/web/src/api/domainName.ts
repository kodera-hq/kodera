// The one rule for a domain the console is configured with (the matrix domain, the tenant domain):
// a lowercase DNS name of two labels at least, at most 253 characters, with no scheme, port, path,
// wildcard or trailing dot, whose last label is not a number. `server/static.mjs` applies the same
// rule to `--matrix-domain`.

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DNS_NAME = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`)

export function isDomainName(value: string): boolean {
  return (
    value.length <= 253 && DNS_NAME.test(value) && !/^[0-9]+$/.test(value.split('.').at(-1) ?? '')
  )
}
