import { createContext, useContext } from 'react'
import type { AuthSessionSnapshot } from './AuthAdapter'

export interface AuthLifetime {
  getSnapshot(): AuthSessionSnapshot
  hasUsableCredential(): boolean
  getRetirementStamp(): object
  subscribe(listener: () => void): () => void
}

export const AuthLifetimeContext = createContext<AuthLifetime | null>(null)

/** The stable lifetime of this provider's actual captured adapter. */
export function useAuthLifetime(): AuthLifetime {
  const value = useContext(AuthLifetimeContext)
  if (value === null) throw new Error('useAuthLifetime must be used within an AuthProvider')
  return value
}

/** Optional lifetime reader for views rendered either inside `AuthProvider` or standalone in tests. */
export function useOptionalAuthLifetime(): AuthLifetime | null {
  return useContext(AuthLifetimeContext)
}
