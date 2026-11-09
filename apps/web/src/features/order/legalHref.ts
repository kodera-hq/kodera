// A legal document's readable version, linked only when it is an absolute https URL with a
// host and no credentials: the console never links a document to anything else. Shared by the
// order's agreements step and « Créez votre espace ».

export function legalHtmlHref(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return undefined
  if (/\s|\\|\p{Cc}/u.test(value)) return undefined
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0]
  if (!authority || authority.includes('@')) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== ''
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}
