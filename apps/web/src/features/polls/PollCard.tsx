import { useId, useState } from 'react'
import { Button } from '../../ui/Button/Button'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { cx } from '../../ui/cx'
import {
  computePollSummary,
  formatPollMarkdownForDocs,
  type ChannelPoll,
} from './pollState'

export interface PollCardProps {
  readonly poll: ChannelPoll
  readonly currentUserId: string
  readonly onVote: (pollId: string, optionId: string) => void
  readonly onClosePoll: (pollId: string) => void
  readonly onCopyDocsSummary?: ((pollId: string, markdown: string) => void) | undefined
  readonly defaultCollapsed?: boolean | undefined
}

export function PollCard({
  poll,
  currentUserId,
  onVote,
  onClosePoll,
  onCopyDocsSummary,
  defaultCollapsed = false,
}: PollCardProps) {
  const headingId = useId()
  const bodyId = useId()
  const [copiedMarkdown, setCopiedMarkdown] = useState<string | null>(null)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(defaultCollapsed)
  const summary = computePollSummary(poll)

  const handleCopySummary = () => {
    const markdown = formatPollMarkdownForDocs(poll)
    setCopiedMarkdown(markdown)
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      void navigator.clipboard.writeText(markdown).catch(() => {})
    }
    onCopyDocsSummary?.(poll.id, markdown)
  }

  return (
    <article
      aria-labelledby={headingId}
      data-testid="kodera-poll-card"
      data-poll-id={poll.id}
      className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state={poll.closed ? 'neutral' : 'info'}>
              {poll.closed ? 'Sondage clôturé' : 'Sondage en cours'}
            </StatusPill>
            <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink-2">
              {poll.allowMultiple ? 'Choix multiple' : 'Choix unique'}
            </span>
            {poll.anonymous ? (
              <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink-2">
                Vote anonyme
              </span>
            ) : null}
          </div>
          <h3 id={headingId} className="text-md font-semibold text-c-ink">
            {poll.question}
          </h3>
          <span className="text-xs font-regular text-c-ink-3">
            Proposé par {poll.createdByName} • {summary.totalVotes} vote(s) •{' '}
            {summary.totalParticipants} participant(s)
          </span>
        </div>

        <Button
          size="sm"
          variant="tertiary"
          data-testid="poll-collapse-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={bodyId}
          onClick={() => setIsCollapsed((prev) => !prev)}
        >
          {isCollapsed ? 'Développer ▾' : 'Réduire ▴'}
        </Button>
      </div>

      {isCollapsed ? null : (
        <div id={bodyId} className="flex flex-col gap-3">
          <div role="group" aria-label={poll.question} className="flex flex-col gap-2">
            {summary.options.map((opt, idx) => {
              const hasVoted = opt.voterIds.includes(currentUserId)
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`poll-option-${idx + 1}`}
                  data-option-id={opt.id}
                  aria-pressed={hasVoted}
                  disabled={poll.closed}
                  onClick={() => onVote(poll.id, opt.id)}
                  className={cx(
                    'flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors focus-visible:outline-hidden focus-visible:ring',
                    hasVoted
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                      : 'border-c-border-soft bg-c-sunken text-c-ink hover:bg-c-muted'
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{opt.label}</span>
                    <span className="font-mono text-xs font-medium text-c-ink-2">
                      {opt.count} vote(s) · {opt.percentage} %
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="h-2 w-full overflow-hidden rounded-full bg-c-muted"
                  >
                    <div
                      data-testid={`poll-progress-${idx + 1}`}
                      className="h-full rounded-full bg-c-action transition-all"
                      style={{
                        width: `${opt.percentage}%`,
                      }}
                    />
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-c-border-soft pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="poll-close-btn"
                disabled={poll.closed}
                onClick={() => onClosePoll(poll.id)}
              >
                {poll.closed ? 'Sondage clôturé' : 'Clôturer le sondage'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-testid="poll-copy-docs-btn"
                onClick={handleCopySummary}
              >
                Copier le résumé pour Docs
              </Button>
            </div>

            <div role="status" aria-live="polite">
              {copiedMarkdown !== null ? (
                <span
                  data-testid="poll-docs-copied-status"
                  className="font-mono text-xs font-medium text-c-ok-ink"
                >
                  Résumé Markdown prêt pour Docs
                </span>
              ) : null}
            </div>
          </div>

          {copiedMarkdown !== null ? (
            <pre
              data-testid="poll-docs-markdown-preview"
              className="overflow-x-auto rounded-md border border-c-border-soft bg-c-sunken p-3 font-mono text-xs font-regular text-c-ink-2"
            >
              {copiedMarkdown}
            </pre>
          ) : null}
        </div>
      )}
    </article>
  )
}
