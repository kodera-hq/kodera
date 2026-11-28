import { useTranslation } from 'react-i18next'
import { KoderaStageEmblem } from '../ui/StageFrame/KoderaStageEmblem'

export function SessionLoading() {
  const { t } = useTranslation()
  const label = t('console.shell.session.status-restoring')
  return (
    <main className="kodera-stage kodera-stage-screen" aria-busy="true">
      <KoderaStageEmblem animated />
      <p role="status" aria-label={label} className="stage-status stage-status-on">
        {label}
      </p>
    </main>
  )
}
