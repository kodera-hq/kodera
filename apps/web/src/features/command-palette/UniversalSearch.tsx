import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
  OPEN_PALETTE,
  usePaletteSource,
  useRegisterPalette,
  type PaletteSource,
} from './PaletteContext'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { isMac } from '../workspace/ChannelSearch'
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
function SearchContents({
  entries,
  onChoose,
  shortcut,
  documents = [],
  actions: quickActions = [],
  directMessages = [],
  members = [],
  hiddenTrigger,
  openEvent,
  onDismiss,
}: ChannelSearchProps & {
  actions?: readonly PaletteTarget[]
  documents?: readonly PaletteTarget[]
  directMessages?: readonly PaletteTarget[]
  members?: readonly PaletteTarget[]
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
  for (const person of members)
    add(`member:${person.id}`, person.label, copy.actions, () => requestAnimationFrame(person.open))
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
        palette
        {...(onDismiss ? { onDismiss } : {})}
        {...(hiddenTrigger === undefined ? {} : { hiddenTrigger })}
        {...(openEvent === undefined ? {} : { openEvent })}
        groupOrder={[
          copy.actions,
          copy.channels,
          copy.direct,
          copy.docs,
          copy.settings,
          copy.workspace,
          copy.theme,
        ]}
        groupLabel={copy.channels}
        recentLabel={copy.recent}
        legend={copy.legend}
        entries={[...entries.map((entry) => ({ ...entry, category: copy.channels })), ...commands]}
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

export function UniversalSearch(props: PaletteSource) {
  const registered = useRegisterPalette(props)
  const { t } = useTranslation()
  if (!registered || !props.shortcut) return <SearchContents {...props} />
  return (
    <button
      type="button"
      aria-label={t('console.workspace.search.action-open')}
      onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))}
      className="tactile flex h-10 w-full items-center gap-2 rounded-sm bg-c-muted px-2 text-sm text-c-ink-3 focus-visible:ring focus-visible:outline-hidden"
    >
      <KoderaIcon name="search" />
      <span className="flex-1 text-left">{t('console.workspace.search.action-open')}</span>
      <kbd aria-hidden="true">{isMac() ? '⌘K' : 'Ctrl+K'}</kbd>
    </button>
  )
}

const SHOW_PALETTE = 'kodera:show-palette'
export function GlobalUniversalSearch({ org, request }: { org?: string; request: number }) {
  const router = useRouter({ warn: false })
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  const registry = usePaletteSource()
  const [source, setSource] = useState<PaletteSource | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (request === 0) return
    let frame = requestAnimationFrame(() => {
      if (withdrawn(root.current) || document.querySelector('[role="dialog"]')) return
      setSource(registry?.read() ?? null)
      frame = requestAnimationFrame(() => window.dispatchEvent(new Event(SHOW_PALETTE)))
    })
    return () => cancelAnimationFrame(frame)
  }, [registry, request])
  return (
    <div ref={root}>
      <SearchContents
        {...(source ?? {
          entries: [],
          onChoose: () => null,
          actions: org
            ? [
                {
                  id: 'workspace',
                  label: copy.openWorkspace,
                  open: () => {
                    if (router) void router.navigate({ to: '/$org/workspace', params: { org } })
                    else window.location.assign(`/${encodeURIComponent(org)}/workspace`)
                  },
                },
              ]
            : [],
        })}
        onDismiss={() => setSource(null)}
        shortcut={false}
        hiddenTrigger
        openEvent={SHOW_PALETTE}
      />
    </div>
  )
}
