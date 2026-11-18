import type { APIRequestContext } from '@playwright/test'
import type * as Playwright from '@playwright/test'
import { exactOrigin, guard, object } from './oracles/shared'

const assertionsPackage = '@playwright/test'

export function mailLinkPattern(target: string): RegExp {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}#[^\\s"<>]+`)
}

/** One bounded scan. Only the caller receives the link; failures contain no message data. */
export async function findMailLink(
  request: APIRequestContext,
  mailpit: string,
  to: string,
  pattern: RegExp
): Promise<string | undefined> {
  try {
    exactOrigin(mailpit)
    const listing = await request.get(`${mailpit}/api/v1/messages?limit=50`, { maxRedirects: 0 })
    guard(listing.status() === 200, 'WAVE2_MAIL_STATUS')
    const body: unknown = await listing.json()
    guard(object(body) && Array.isArray(body.messages), 'WAVE2_MAIL_SHAPE')
    for (const message of body.messages) {
      guard(object(message) && typeof message.ID === 'string', 'WAVE2_MAIL_SHAPE')
      if (
        !Array.isArray(message.To) ||
        !message.To.some(
          (recipient: unknown) =>
            object(recipient) &&
            typeof recipient.Address === 'string' &&
            recipient.Address.toLowerCase() === to.toLowerCase()
        )
      )
        continue
      const response = await request.get(
        `${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}`,
        { maxRedirects: 0 }
      )
      guard(response.status() === 200, 'WAVE2_MAIL_STATUS')
      const full: unknown = await response.json()
      guard(object(full), 'WAVE2_MAIL_SHAPE')
      const text = `${typeof full.Text === 'string' ? full.Text : ''}\n${typeof full.HTML === 'string' ? full.HTML : ''}`
      const match = text.match(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')))
      if (match) return match[0].replace(/&amp;/g, '&')
    }
    return undefined
  } catch {
    throw new Error('WAVE2_MAIL_SCAN')
  }
}

export async function linkFromMail(
  request: APIRequestContext,
  mailpit: string,
  to: string,
  pattern: RegExp
): Promise<string> {
  const { expect } = (await import(/* @vite-ignore */ assertionsPackage)) as typeof Playwright
  let link: string | undefined
  try {
    // Poll a boolean so assertion diagnostics never retain the one-use URL or recipient.
    await expect
      .poll(
        async () => {
          link = await findMailLink(request, mailpit, to, pattern)
          return link !== undefined
        },
        { timeout: 30_000, message: 'WAVE2_MAIL_PENDING' }
      )
      .toBe(true)
  } catch {
    throw new Error('WAVE2_MAIL_PENDING')
  }
  guard(link, 'WAVE2_MAIL_PENDING')
  return link
}
