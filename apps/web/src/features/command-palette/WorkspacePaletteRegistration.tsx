import { useTranslation } from 'react-i18next'
import type { EspaceStoreLike, CanvasMode } from '../espace/liveViewModel'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchProps } from '../workspace/ChannelSearch'
import { useRegisterPalette } from './PaletteContext'
import { paletteCopy } from './messages'

/** The source outlives the phone's drawer, but never its owning workspace view. */
export function WorkspacePaletteRegistration({
  store,
  entries,
  documents,
  openDocument,
  onChoose,
  onSelectDirect,
  onChangeCanvasMode,
  simulation,
}: {
  store: EspaceStoreLike
  entries: ChannelSearchProps['entries']
  documents: readonly ChannelDoc[]
  openDocument?: ((doc: ChannelDoc) => unknown) | undefined
  onChoose: ChannelSearchProps['onChoose']
  onSelectDirect: (roomId: string) => void
  onChangeCanvasMode?: ((mode: CanvasMode) => void) | undefined
  simulation: boolean
}) {
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  useRegisterPalette(
    {
      entries,
      onChoose,
      shortcut: false,
      documents: openDocument
        ? documents.map((doc) => ({
            id: doc.id,
            label: doc.title,
            open: () => {
              openDocument(doc)
            },
          }))
        : [],
      directMessages: simulation
        ? []
        : (store.getDirects?.() ?? []).map((dm) => ({
            id: dm.roomId,
            label: dm.name,
            open: () => onSelectDirect(dm.roomId),
          })),
      actions: onChangeCanvasMode
        ? [
            { id: 'docs', label: copy.docs, open: () => onChangeCanvasMode('docs') },
            { id: 'files', label: copy.files, open: () => onChangeCanvasMode('files') },
            {
              id: 'integrations',
              label: copy.integrations,
              open: () => onChangeCanvasMode('integrations'),
            },
          ]
        : [],
    },
    -1
  )
  return null
}
