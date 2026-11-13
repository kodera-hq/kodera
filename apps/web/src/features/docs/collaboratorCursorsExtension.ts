import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { CollaboratorPeer, CursorPaletteSlot } from './collabSession'

export const COLLABORATOR_CURSORS_PLUGIN_KEY = new PluginKey<DecorationSet>(
  'kodera-collaborator-cursors'
)

export const CURSOR_PALETTE_CLASSES: Readonly<
  Record<
    CursorPaletteSlot,
    {
      readonly caret: string
      readonly label: string
      readonly selection: string
    }
  >
> = {
  1: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-1 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-1 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-1-soft',
  },
  2: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-2 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-2 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-2-soft',
  },
  3: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-3 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-3 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-3-soft',
  },
  4: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-4 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-4 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-4-soft',
  },
  5: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-5 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-5 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-5-soft',
  },
  6: {
    caret: 'relative inline-block w-0 border-l-2 border-c-cursor-6 align-baseline',
    label:
      'pointer-events-none select-none whitespace-nowrap rounded-sm bg-c-cursor-6 px-1 text-xs font-semibold text-c-on-inverse',
    selection: 'rounded-sm bg-c-cursor-6-soft',
  },
}

function clampDocPos(pos: number, docContentSize: number): number {
  if (!Number.isFinite(pos)) return 1
  return Math.max(0, Math.min(Math.trunc(pos), docContentSize))
}

/**
 * Builds ProseMirror decorations for remote collaborator carets and selections using ONLY
 * semantic `@kodera/design-tokens` CSS classes (`c-cursor-1..6`, `c-cursor-1-soft..6-soft`).
 * Writes ZERO `style` attributes so browser `style-src-attr 'none'` CSP is strictly respected.
 */
export function buildCollaboratorDecorations(
  docSize: number,
  docNode: Parameters<typeof DecorationSet.create>[0],
  peers: readonly CollaboratorPeer[]
): DecorationSet {
  const decorations: Decoration[] = []

  for (const peer of peers) {
    if (!peer.selection) continue
    const palette = CURSOR_PALETTE_CLASSES[peer.cursorSlot]
    const anchor = clampDocPos(peer.selection.anchor, docSize)
    const head = clampDocPos(peer.selection.head, docSize)
    const from = Math.min(anchor, head)
    const to = Math.max(anchor, head)

    if (to > from) {
      decorations.push(
        Decoration.inline(from, to, {
          class: palette.selection,
          'data-collab-selection': peer.userId,
        })
      )
    }

    decorations.push(
      Decoration.widget(
        head,
        () => {
          const caret = document.createElement('span')
          caret.className = palette.caret
          caret.setAttribute('aria-hidden', 'true')
          caret.setAttribute('data-collab-caret', peer.userId)

          const badge = document.createElement('span')
          badge.className = palette.label
          badge.textContent = peer.name
          caret.appendChild(badge)
          return caret
        },
        {
          key: `caret-${peer.clientId}-${head}`,
          side: -1,
        }
      )
    )
  }

  return decorations.length > 0 ? DecorationSet.create(docNode, decorations) : DecorationSet.empty
}

export interface CollaboratorCursorsOptions {
  readonly initialPeers: readonly CollaboratorPeer[]
  readonly getPeers?: (() => readonly CollaboratorPeer[]) | undefined
}

export const CollaboratorCursorsExtension = Extension.create<CollaboratorCursorsOptions>({
  name: 'collaboratorCursors',

  addOptions() {
    return {
      initialPeers: [],
      getPeers: undefined,
    }
  },

  addProseMirrorPlugins() {
    let latestPeers: readonly CollaboratorPeer[] =
      this.options.getPeers?.() ?? this.options.initialPeers
    const readPeers = () => this.options.getPeers?.() ?? latestPeers
    return [
      new Plugin<DecorationSet>({
        key: COLLABORATOR_CURSORS_PLUGIN_KEY,
        state: {
          init(_, state) {
            return buildCollaboratorDecorations(
              state.doc.content.size,
              state.doc,
              readPeers()
            )
          },
          apply(tr, oldSet, _oldState, newState) {
            const metaPeers = tr.getMeta(COLLABORATOR_CURSORS_PLUGIN_KEY) as
              | readonly CollaboratorPeer[]
              | undefined
            if (metaPeers !== undefined) {
              latestPeers = metaPeers
            }
            if (metaPeers !== undefined || tr.docChanged) {
              return buildCollaboratorDecorations(
                newState.doc.content.size,
                newState.doc,
                metaPeers ?? readPeers()
              )
            }
            return oldSet
          },
        },
        props: {
          decorations(state) {
            return COLLABORATOR_CURSORS_PLUGIN_KEY.getState(state) ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})
