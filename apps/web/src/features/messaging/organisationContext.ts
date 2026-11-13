// The organisation a conversation belongs to, for the calls a message makes to Core: uploading an
// attachment, opening one, previewing a link. Null outside a live workspace (the demo, a test),
// where none of them is offered.

import { createContext, useContext } from 'react'

export const MessagingOrganisation = createContext<string | null>(null)

export function useMessagingOrganisation(): string | null {
  return useContext(MessagingOrganisation)
}
