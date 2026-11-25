import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { developerDocsCopy } from './developerDocsMessages'
import {
  CommunityPreviewDialog,
  useCommunityPreview,
  type CommunityPreviewController,
} from './communityPreview'
export function CommunityAccess({
  onOpenDocs,
  controller,
}: {
  onOpenDocs?: (() => void) | undefined
  controller?: CommunityPreviewController | undefined
}) {
  const internal = useCommunityPreview()
  const state = controller ?? internal
  const { i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  return (
    <>
      <Button
        ref={(node) => state.registerEntry(node)}
        className="h-auto min-h-10 max-w-full py-2"
        size="sm"
        variant="secondary"
        onClick={() => {
          state.open()
        }}
        aria-label={`${copy.community} · ${copy.domain}`}
      >
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span>{copy.community}</span>
          <span className="max-w-full truncate font-mono text-xs">{copy.domain}</span>
        </span>
      </Button>
      <CommunityPreviewDialog controller={state} onOpenDocs={onOpenDocs} />
    </>
  )
}
