import { useTranslation } from 'react-i18next'
import { Skeleton } from '../ui/Skeleton/Skeleton'

export function SessionLoading() {
  const { t } = useTranslation()
  return (
    <main className="flex min-h-screen items-center justify-center p-6" aria-busy="true">
      <Skeleton className="w-full" label={t('console.shell.session.status-restoring')} />
    </main>
  )
}
