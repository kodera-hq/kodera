// Kodera's own SVG emoji and sanitized workspace custom WebP emoji, drawn inline at text height.
// Custom WebP blobs are resolved via URL.createObjectURL (`img-src 'self' blob:`).

import { Component, lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { useCustomEmojiBlobUrl } from './customEmojiStore'
import {
  isKoderaEmojiName,
  koderaSegments,
  shortcodeOf,
  type KoderaEmojiName,
} from './koderaShortcodes'

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

export function CustomWorkspaceEmoji({
  organisationId,
  shortcode,
}: {
  organisationId: string | null
  shortcode: string
}) {
  const code = shortcodeOf(shortcode)
  const blobUrl = useCustomEmojiBlobUrl(organisationId, shortcode)
  if (blobUrl === null) {
    return (
      <span title={code} data-custom-emoji={shortcode} className="font-mono text-xs text-c-ink-2">
        {code}
      </span>
    )
  }
  return (
    <img
      src={blobUrl}
      alt={code}
      title={code}
      data-custom-emoji={shortcode}
      className="inline-block h-5 w-5 shrink-0 object-contain align-text-bottom"
    />
  )
}

/** Render a reaction key (`👍`, `:kodera_rocket:`, or `:custom_code:`) as its glyph or text. */
export function renderReactionGlyph(
  key: string,
  organisationId: string | null,
  customShortcodes?: ReadonlySet<string>
): ReactNode {
  if (key.startsWith(':') && key.endsWith(':') && key.length > 3) {
    const inner = key.slice(1, -1)
    if (isKoderaEmojiName(inner)) {
      return <KoderaEmoji name={inner} />
    }
    if (customShortcodes?.has(inner)) {
      return <CustomWorkspaceEmoji organisationId={organisationId} shortcode={inner} />
    }
  }
  return key
}

/** A plain run with its known Kodera SVG codes and workspace custom WebP codes drawn inline. */
export function withGlyphs(
  run: string,
  organisationId: string | null = null,
  customShortcodes?: ReadonlySet<string>
): ReactNode {
  const segments = koderaSegments(run, customShortcodes)
  if (segments.length === 1 && 'text' in segments[0]!) return run
  return segments.map((segment, index) => {
    if ('emoji' in segment) return <KoderaEmoji key={index} name={segment.emoji} />
    if ('customEmoji' in segment) {
      return (
        <CustomWorkspaceEmoji
          key={index}
          organisationId={organisationId}
          shortcode={segment.customEmoji}
        />
      )
    }
    return segment.text
  })
}
