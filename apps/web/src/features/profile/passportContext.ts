// What a profile card reads beyond the member it is opened on: their avatar's `blob:` address,
// their passport, and how to write to them. The live view provides it once (`EspaceLiveView`); a
// card drawn without it (a story, the demo) shows the member's name and initials alone.

import { createContext, useContext } from 'react'
import type { AvatarCache } from '../espace/matrix/avatarCache'
import type { Passport } from './passport'

export interface PassportServices {
  avatars?: AvatarCache | undefined
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => unknown
  /** The member's passport; `undefined` while it is not known (it is asked for then). */
  getPassport?: ((userId: string) => Passport | undefined) | undefined
  /** Writes `text` to the member in their direct conversation, starting it when there is none. */
  sendDirect?: ((userId: string, text: string) => Promise<void>) | undefined
}

export const PassportContext = createContext<PassportServices | null>(null)

export function usePassportServices(): PassportServices | null {
  return useContext(PassportContext)
}
