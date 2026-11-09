import * as Menu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrganisationSwitch } from '../../app/organisationSwitch'
import { useThemePreference } from '../../theme/useThemePreference'
import { workspaceMenuCopy } from './workspaceMenuMessages'
import { applyCustomTokensToDocument } from '../appearance/themeOverrides'

export type WorkspaceCommand = 'configure' | 'extensions' | 'studio' | 'hosting' | 'developer'
export const WORKSPACE_COMMAND_EVENT = 'kodera:workspace-command'
export function openWorkspaceCommand(command: WorkspaceCommand) {
  window.dispatchEvent(new CustomEvent(WORKSPACE_COMMAND_EVENT, { detail: command }))
}
const ITEM =
  'flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm text-c-ink outline-hidden data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink data-[highlighted]:ring-1 data-[highlighted]:ring-inset'

/** Both workspace entry points share the same keyboard-accessible action menu. */
export function WorkspaceMenu({
  name,
  slug,
  trigger,
}: {
  name: string
  slug: string
  trigger: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const copy = workspaceMenuCopy(i18n.resolvedLanguage)
  const organisationSwitch = useOrganisationSwitch()
  const memberships = organisationSwitch?.memberships ?? [{ name, slug, current: true }]
  const { preference, choose } = useThemePreference()
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          aria-label={t('console.workspace.sidebar.action-switch-organisation', { name })}
          align="start"
          sideOffset={4}
          className="z-50 max-h-screen min-w-shell-sidebar-width overflow-y-auto rounded-lg border border-c-border bg-c-elevated p-1 shadow-pop shadow-c-shadow-2"
        >
          <Menu.Label className="px-3 py-2 text-xs font-semibold text-c-ink-3">
            {copy.workspaces}
          </Menu.Label>
          <Menu.RadioGroup
            value={slug}
            onValueChange={(next) => {
              if (next !== slug) organisationSwitch?.onSwitch(next)
            }}
          >
            {memberships.map((entry) => (
              <Menu.RadioItem key={entry.slug} value={entry.slug} className={ITEM}>
                <span aria-hidden="true" className="w-4 shrink-0">
                  {entry.slug === slug ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entry.name}</span>
                  <span className="block truncate text-xs text-c-ink-3">
                    {entry.slug === 'community' ? 'community.kodera.io' : entry.slug}
                  </span>
                </span>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator className="my-1 h-px bg-c-border-soft" />
          <Menu.Item className={ITEM} onSelect={() => openWorkspaceCommand('configure')}>
            {copy.create}
          </Menu.Item>
          <Menu.Item className={ITEM} onSelect={() => openWorkspaceCommand('extensions')}>
            {copy.extensions}
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-c-border-soft" />
          <Menu.Label className="px-3 py-2 text-xs font-semibold text-c-ink-3">
            {copy.appearance}
          </Menu.Label>
          <Menu.RadioGroup aria-label={copy.appearance} value={preference}>
            {(['light', 'dark', 'black'] as const).map((mode) => (
              <Menu.RadioItem
                key={mode}
                value={mode}
                className={ITEM}
                onSelect={() => {
                  applyCustomTokensToDocument(null)
                  choose(mode)
                }}
              >
                <span aria-hidden="true" className="w-4">
                  {preference === mode ? '✓' : ''}
                </span>
                {copy[mode]}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Item className={ITEM} onSelect={() => openWorkspaceCommand('studio')}>
            {copy.studio}
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-c-border-soft" />
          <Menu.Item className={ITEM} onSelect={() => openWorkspaceCommand('hosting')}>
            {copy.hosting}
          </Menu.Item>
          <Menu.Item className={ITEM} onSelect={() => openWorkspaceCommand('developer')}>
            {copy.developer}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
