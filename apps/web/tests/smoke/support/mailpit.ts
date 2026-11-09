// The organisation's mail, through Mailpit's HTTP API (`/api/v1/messages`, `/api/v1/message/{id}`).

interface Listed {
  ID: string
  To?: { Address: string }[]
  Created?: string
}

/** The first link matching `pattern` in the newest message to `to` received after `since`. */
export async function linkFromMail(
  mailpit: string,
  to: string,
  pattern: RegExp,
  { since = 0, timeoutMs = 30_000 }: { since?: number; timeoutMs?: number } = {}
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listing = (await (await fetch(`${mailpit}/api/v1/messages?limit=50`)).json()) as {
      messages?: Listed[]
    }
    for (const message of listing.messages ?? []) {
      if (!message.To?.some((recipient) => recipient.Address.toLowerCase() === to.toLowerCase()))
        continue
      if (message.Created !== undefined && Date.parse(message.Created) < since) continue
      const full = (await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json()) as {
        Text?: string
        HTML?: string
      }
      const found = `${full.Text ?? ''}\n${full.HTML ?? ''}`.match(pattern)
      if (found) return found[0].replace(/&amp;/g, '&')
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`no mail to ${to} carries a link matching ${pattern}`)
}
