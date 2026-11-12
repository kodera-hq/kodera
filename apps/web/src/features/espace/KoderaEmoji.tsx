// One of Kodera's own emoji, drawn inline at the size of the text. The glyphs are a separate chunk
// (`KoderaEmojiGlyphs.tsx`), fetched the first time one is drawn; until then, and if it cannot be
// fetched, the code itself shows. Its accessible name is its code, as in the message's text.

import { Component, lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { InlineMarkdown } from '../messaging/MarkdownText'
import { koderaSegments, shortcodeOf, type KoderaEmojiName } from './koderaShortcodes'

const Glyph = lazy(() => import('./KoderaEmojiGlyphs'))

/** A chunk that failed to load shows the code: a message is never lost for a glyph. */
class CodeOnFailure extends Component<{ code: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? this.props.code : this.props.children
  }
}

export function KoderaEmoji({ name }: { name: KoderaEmojiName }) {
  const code = shortcodeOf(name)
  return (
    <span
      role="img"
      aria-label={code}
      title={code}
      data-kodera-emoji={name}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center align-text-bottom text-c-accent-ink"
    >
      <CodeOnFailure code={code}>
        <Suspense fallback={code}>
          <Glyph name={name} />
        </Suspense>
      </CodeOnFailure>
    </span>
  )
}

/** Text with its known Kodera codes drawn as glyphs; the rest keeps its inline Markdown. */
export function EmojiText({ text }: { text: string }) {
  const segments = koderaSegments(text)
  if (segments.length === 1 && 'text' in segments[0]!) return <InlineMarkdown text={text} />
  return (
    <>
      {segments.map((segment, index) =>
        'emoji' in segment ? (
          <KoderaEmoji key={index} name={segment.emoji} />
        ) : (
          <InlineMarkdown key={index} text={segment.text} />
        )
      )}
    </>
  )
}
