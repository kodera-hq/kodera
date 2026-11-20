import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { EspaceStoreLike, CanvasMode } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'
import { workspaceFilesOf } from '../espace/workspaceFiles'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchProps } from '../workspace/ChannelSearch'
import { useRegisterPalette } from './PaletteContext'
import { paletteCopy } from './messages'

/** The palette lists the newest files only: a long history never slows the search. */
const PALETTE_FILE_LIMIT = 200

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
  snapshot,
}: {
  store: EspaceStoreLike
  entries: ChannelSearchProps['entries']
  documents: readonly ChannelDoc[]
  openDocument?: ((doc: ChannelDoc) => unknown) | undefined
  onChoose: ChannelSearchProps['onChoose']
  onSelectDirect: (roomId: string) => void
  onChangeCanvasMode?: ((mode: CanvasMode) => void) | undefined
  simulation: boolean
  /** The synced workspace: its files are searchable and open the Files view. */
  snapshot?: EspaceSnapshot | undefined
}) {
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  // The names come from messages already synced: nothing is fetched to search them. Documents
  // are listed under their own group, so only files are taken here.
  const files = useMemo(
    () =>
      snapshot === undefined || onChangeCanvasMode === undefined
        ? []
        : workspaceFilesOf(store, snapshot, entries, [])
            .filter((file) => file.document === undefined)
            .slice(0, PALETTE_FILE_LIMIT)
            .map((file) => ({
              id: file.id,
              label: file.name,
              open: () => onChangeCanvasMode('files'),
            })),
    [store, snapshot, entries, onChangeCanvasMode]
  )
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
      files,
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
