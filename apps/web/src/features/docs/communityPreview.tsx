import { COMMUNITY_CATEGORIES, COMMUNITY_CHANNELS } from './communityStructure'
export { COMMUNITY_CATEGORIES, COMMUNITY_CHANNELS } from './communityStructure'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Button } from '@/ui/Button/Button'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { developerDocsCopy } from './developerDocsMessages'
import type { CommunityChannelId } from './documentationExport'
export const COMMUNITY_TARGET_URL = 'https://community.kodera.io/'
export function useCommunityPreview() {
  const [channel, setChannel] = useState<CommunityChannelId | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const entry = useRef<HTMLButtonElement | null>(null)
  return {
    channel,
    registerEntry: (node: HTMLButtonElement | null) => {
      entry.current = node
    },
    returnTarget: () => (opener.current?.isConnected ? opener.current : entry.current),
    open: (id: CommunityChannelId = 'announcements') => {
      if (channel === null && document.activeElement instanceof HTMLElement)
        opener.current = document.activeElement
      setChannel(id)
    },
    close: () => setChannel(null),
  }
}
export type CommunityPreviewController = ReturnType<typeof useCommunityPreview>
export function CommunityPreviewDialog({
  controller,
  onOpenDocs,
  docsSlot,
  onShowChannels,
}: {
  controller: CommunityPreviewController
  onOpenDocs: () => void
  docsSlot?: ReactNode
  onShowChannels?: (() => void) | undefined
}) {
  const focusTarget = useRef<HTMLElement | null>(null)
  const { i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const selected =
    COMMUNITY_CHANNELS.find((channel) => channel.id === controller.channel) ?? COMMUNITY_CHANNELS[0]
  return (
    <Dialog
      open={controller.channel !== null}
      onOpenChange={(open) => {
        if (!open) {
          focusTarget.current = controller.returnTarget()
          controller.close()
        }
      }}
      title={copy.communityTitle}
      description={copy.communityNote}
      closeLabel={copy.close}
      size="lg"
      returnFocusTo={focusTarget}
    >
      <div className="flex max-h-[calc(100vh/2)] min-w-0 flex-col gap-4 overflow-y-auto p-1 lg:max-h-[calc(100vh*2/3)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-xs text-c-ink-2">{copy.domain}</span>
          <Button
            onClick={() => {
              if (docsSlot && onShowChannels) onShowChannels()
              else {
                focusTarget.current = controller.returnTarget()
                onOpenDocs()
              }
            }}
          >
            <span className="whitespace-normal">
              {docsSlot && onShowChannels ? copy.communityChannels : copy.openDocs}
            </span>
          </Button>
        </div>
        {docsSlot ?? (
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <nav aria-label={copy.communityChannels} className="flex min-w-0 flex-col gap-2">
              {COMMUNITY_CATEGORIES.map((category) => (
                <section
                  key={category.id}
                  aria-label={category.name}
                  className="flex flex-col gap-2"
                >
                  <h3 className="text-sm font-semibold">{category.name}</h3>
                  <p className="text-xs text-c-ink-2">{copy[category.audience]}</p>
                  {category.channels.map((channel) => (
                    <Button
                      key={channel.id}
                      variant={channel.id === selected.id ? 'primary' : 'secondary'}
                      aria-pressed={channel.id === selected.id}
                      onClick={() => controller.open(channel.id)}
                    >
                      <span className="min-w-0 truncate">
                        {channel.voice ? '🔊' : '#'} {channel.name}
                      </span>
                    </Button>
                  ))}
                </section>
              ))}
            </nav>
            <section
              aria-label={copy.communityDiscussion}
              className="flex min-w-0 flex-col gap-4 rounded-md border border-c-border bg-c-sunken p-4"
            >
              <h3 className="text-lg font-semibold break-words">
                {selected.voice ? '🔊' : '#'} {selected.name}
              </h3>
              <p className="text-sm">{copy[selected.description]}</p>
              <p className="text-sm text-c-ink-2">{copy.noMessages}</p>
            </section>
          </div>
        )}
        <LinkButton inline href={COMMUNITY_TARGET_URL} target="_blank">
          {copy.openSite}
        </LinkButton>
      </div>
    </Dialog>
  )
}
