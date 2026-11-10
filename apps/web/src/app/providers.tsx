// Every provider the application mounts once, at the root — composed here so
// `src/main.tsx` stays a boot sequence rather than a second place these are
// wired. The router itself is not one of these: `RouterProvider` needs the
// concrete router instance from `src/app/routeTree.ts`, so `main.tsx` renders
// it as the child these providers wrap, not as one of them.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthProvider } from '../auth/AuthProvider'
import { SessionExpiryProvider } from '../auth/sessionExpiry'
import { ToastProvider } from '../ui/Toast/Toast'
import { clearWorkspaceSettingsRuntime } from '../features/workspace/settingsRuntime'

/**
 * The query cache owns every server read (ADR-0005). `refetchOnWindowFocus`
 * is off: a background tab regaining focus refetching every open query at
 * once is not a rule any spec asks for, and the resources that DO need to
 * refresh on a rule (status, capacity) get their own `refetchInterval` where
 * they are declared. `retry: 2` is this client's own default — generous
 * enough that a single dropped response does not surface as an error, short
 * enough that a genuinely down Core API fails within a few seconds rather
 * than hanging the screen; a resource with its own retry story overrides it
 * at the query, not here.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        refetchOnWindowFocus: false,
      },
    },
  })
}

function ToastProviderWithCopy({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <ToastProvider
      label={t('console.common.a11y-notification')}
      viewportLabel={t('console.common.a11y-notifications-region')}
      closeLabel={t('console.common.action-close')}
    >
      {children}
    </ToastProvider>
  )
}

export interface AppProvidersProps {
  children: ReactNode
  /** Overrides the default client — tests render against one they control
   * directly rather than reaching into this component's own state. */
  queryClient?: QueryClient
}

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [client] = useState<QueryClient>(() => queryClient ?? createQueryClient())
  return (
    <QueryClientProvider client={client}>
      <AuthProvider
        onSessionEnded={() => {
          clearWorkspaceSettingsRuntime()
          client.clear()
        }}
        onCredentialChanged={() => {
          void client.cancelQueries({ queryKey: ['me'] })
          client.removeQueries({ queryKey: ['me'] })
        }}
      >
        <SessionExpiryProvider>
          <ToastProviderWithCopy>{children}</ToastProviderWithCopy>
        </SessionExpiryProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
