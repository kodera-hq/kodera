import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrganisationSwitch } from '../../app/organisationSwitch'
import { saveThemePreference, THEME_PREFERENCES } from '../../theme/theme'
import {
  ChannelSearch,
  type ChannelSearchProps,
  type ChannelSearchEntry,
} from '../workspace/ChannelSearch'
import { WORKSPACE_COMMAND_EVENT } from '../workspace/WorkspaceMenu'
import { withdrawn } from '../workspace/ChannelSearch'
import { fuzzyEntries } from './search'
import { paletteCopy } from './messages'
import { communitySupportPath } from './support'

export interface PaletteTarget {
  id: string
  label: string
  open: () => void
}
export function UniversalSearch({
  entries,
  onChoose,
  shortcut,
  documents = [],
  actions: quickActions = [],
  directMessages = [],
}: ChannelSearchProps & {
  actions?: readonly PaletteTarget[]
  documents?: readonly PaletteTarget[]
  directMessages?: readonly PaletteTarget[]
}) {
  const surface = useRef<HTMLDivElement>(null)
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  const switcher = useOrganisationSwitch()
  const [notice, setNotice] = useState('')
  const actions = new Map<string, () => void>()
  const commands: ChannelSearchEntry[] = []
  const add = (id: string, label: string, category: string, action: () => void) => {
    const key = `command:${id}`
    commands.push({ id: key, label, category, kind: 'command' })
    actions.set(key, action)
  }
  for (const member of switcher?.memberships ?? [])
    add(`workspace:${member.slug}`, member.name, copy.workspace, () =>
      switcher?.onSwitch(member.slug)
    )
  for (const action of quickActions)
    add(`action:${action.id}`, action.label, copy.actions, () => requestAnimationFrame(action.open))
  for (const doc of documents) add(`doc:${doc.id}`, doc.label, copy.docs, doc.open)
  for (const dm of directMessages) add(`dm:${dm.id}`, dm.label, copy.direct, dm.open)
  for (const section of [
    'profile',
    'appearance',
    'audio',
    'members',
    'extensions',
    'hosting',
  ] as const) {
    add(`settings:${section}`, copy[section], copy.settings, () => {
      // Let the palette's focus restoration finish before the next modal takes focus.
      requestAnimationFrame(() =>
        window.dispatchEvent(
          new CustomEvent(WORKSPACE_COMMAND_EVENT, { detail: { command: 'settings', section } })
        )
      )
    })
  }
  for (const theme of THEME_PREFERENCES)
    add(`theme:${theme}`, copy[theme], copy.theme, () => saveThemePreference(theme))
  commands.push({
    id: 'command:support',
    label: copy.support,
    category: copy.workspace,
    kind: 'command',
  })

  return (
    <div ref={surface}>
      <ChannelSearch
        entries={[...entries, ...commands]}
        shortcut={shortcut}
        title={copy.title}
        emptyLabel={copy.empty}
        queryLabel={copy.query}
        match={fuzzyEntries}
        footer={directMessages.length === 0 ? copy.noDirect : undefined}
        onChoose={(entry) => {
          if (entry.id === 'command:support') {
            setNotice('')
            void communitySupportPath()
              .then((path) => {
                if (!surface.current?.isConnected || withdrawn(surface.current)) return
                if (path) window.location.assign(path)
                else setNotice(copy.unavailable)
              })
              .catch(() => setNotice(copy.unavailable))
            return null
          }
          const action = actions.get(entry.id)
          if (!action) return onChoose(entry)
          action()
          return null
        }}
      />
      {notice ? (
        <p role="status" className="text-sm text-c-ink-2">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
