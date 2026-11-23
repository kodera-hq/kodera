import { pollMessages, type PollLocale } from './pollMessages'

export const POLL_FIELD = 'io.kodera.poll'
export const POLL_RESPONSE_EVENT = 'io.kodera.poll.response'
export const POLL_END_EVENT = 'io.kodera.poll.end'
export const MAX_POLL_OPTIONS = 10

export interface PollWirePayload {
  readonly question: string
  readonly options: readonly string[]
  readonly allowMultiple: boolean
  readonly anonymous: boolean
  readonly clientPollId?: string | undefined
}

export interface PollOption {
  readonly id: string
  readonly label: string
  readonly voterIds: readonly string[]
}

export interface ChannelPoll {
  readonly id: string
  readonly roomId: string
  readonly question: string
  readonly options: readonly PollOption[]
  readonly allowMultiple: boolean
  readonly anonymous: boolean
  readonly closed: boolean
  readonly createdBy: string
  readonly createdByName: string
  readonly createdAt: number
}

export type ParsePollCommandResult =
  | {
      readonly ok: true
      readonly question: string
      readonly options: readonly string[]
      readonly allowMultiple: boolean
      readonly anonymous: boolean
    }
  | {
      readonly ok: false
      readonly error: string
    }

export interface PollOptionSummary {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly percentage: number
  readonly voterIds: readonly string[]
}

export interface PollComputedSummary {
  readonly totalVotes: number
  readonly totalParticipants: number
  readonly options: readonly PollOptionSummary[]
}

const DOUBLE_QUOTE_CHAR = String.fromCharCode(34)
const SINGLE_QUOTE_CHAR = String.fromCharCode(39)

function tokenizePollArguments(rawArgs: string): {
  readonly segments: readonly string[]
  readonly flags: readonly string[]
  readonly unclosedQuote: boolean
} {
  const segments: string[] = []
  const flags: string[] = []
  let i = 0
  const len = rawArgs.length

  while (i < len) {
    while (i < len && rawArgs.charCodeAt(i) <= 32) {
      i += 1
    }
    if (i >= len) break

    const ch = rawArgs[i]
    if (ch === DOUBLE_QUOTE_CHAR || ch === SINGLE_QUOTE_CHAR) {
      const quoteChar = ch
      i += 1
      let buffer = ''
      let closed = false
      while (i < len) {
        const cur = rawArgs[i]
        if (cur === '\\' && i + 1 < len) {
          buffer += rawArgs[i + 1] ?? ''
          i += 2
          continue
        }
        if (cur === quoteChar) {
          closed = true
          i += 1
          break
        }
        buffer += cur ?? ''
        i += 1
      }
      if (!closed || (i < len && rawArgs.charCodeAt(i) > 32)) {
        return { segments, flags, unclosedQuote: true }
      }
      const trimmed = buffer.trim()
      if (trimmed.length > 0) {
        segments.push(trimmed)
      }
    } else {
      let token = ''
      while (i < len && rawArgs.charCodeAt(i) > 32) {
        token += rawArgs[i] ?? ''
        i += 1
      }
      if (token.startsWith('--')) {
        flags.push(token.toLowerCase())
      } else if (token.length > 0) {
        return { segments, flags, unclosedQuote: true }
      }
    }
  }

  return { segments, flags, unclosedQuote: false }
}

function tryParseMultilinePoll(afterCommand: string): ParsePollCommandResult | null {
  if (!afterCommand.includes('\n')) return null
  const lines = afterCommand
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length < 3) return null
  const firstLine = lines[0] ?? ''
  const flags: string[] = []
  const questionWords: string[] = []
  for (const part of firstLine.split(/\s+/u)) {
    if (part.startsWith('--')) flags.push(part.toLowerCase())
    else questionWords.push(part)
  }
  const question = questionWords.join(' ').trim()
  const options: string[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('--')) {
      flags.push(line.toLowerCase())
      continue
    }
    const cleaned = line.replace(/^[-*•]\s*/u, '').trim()
    if (cleaned.length > 0) options.push(cleaned)
  }
  if (question.length === 0 || options.length < 2) return null
  return {
    ok: true,
    question,
    options: options.slice(0, MAX_POLL_OPTIONS),
    allowMultiple: flags.includes('--multiple') || flags.includes('--multi'),
    anonymous: flags.includes('--anonymous') || flags.includes('--anon'),
  }
}

export function parsePollCommand(input: string, locale: PollLocale = 'fr'): ParsePollCommandResult {
  const copy = pollMessages[locale]
  const trimmed = input.trim()
  if (!trimmed.startsWith('/poll') || (trimmed.length > 5 && !/\s/u.test(trimmed[5]!))) {
    return {
      ok: false,
      error: copy.errNotPoll,
    }
  }

  const afterCommand = trimmed.slice('/poll'.length).trim()
  if (afterCommand.length === 0) {
    return {
      ok: false,
      error: copy.errUsage,
    }
  }

  const multiline = tryParseMultilinePoll(afterCommand)
  if (multiline !== null) {
    return multiline.ok && multiline.anonymous
      ? { ok: false, error: copy.errAnonymousUnsupported }
      : multiline
  }

  const { segments, flags, unclosedQuote } = tokenizePollArguments(afterCommand)
  if (unclosedQuote) {
    return {
      ok: false,
      error: copy.errUnclosedQuote,
    }
  }

  const allowMultiple = flags.includes('--multiple') || flags.includes('--multi')
  const anonymous = flags.includes('--anonymous') || flags.includes('--anon')
  if (anonymous) return { ok: false, error: copy.errAnonymousUnsupported }

  if (segments.length < 3) {
    return {
      ok: false,
      error: copy.errMinOptions,
    }
  }

  const question = segments[0]?.trim() ?? ''
  const options = segments
    .slice(1)
    .map((opt) => opt.trim())
    .filter((opt) => opt.length > 0)

  if (question.length === 0 || options.length < 2) {
    return {
      ok: false,
      error: copy.errEmptyQuestionOrOptions,
    }
  }

  return {
    ok: true,
    question,
    options: options.slice(0, MAX_POLL_OPTIONS),
    allowMultiple,
    anonymous,
  }
}

/** Validates an untrusted `io.kodera.poll` payload on a Matrix `m.room.message` event. */
export function pollPayloadOf(content: unknown): PollWirePayload | undefined {
  if (content === null || typeof content !== 'object') return undefined
  const raw = (content as Record<string, unknown>)[POLL_FIELD]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const question = typeof obj.question === 'string' ? obj.question.trim() : ''
  if (question.length === 0 || question.length > 500 || !Array.isArray(obj.options)) {
    return undefined
  }
  const options = obj.options
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 200)
    .slice(0, MAX_POLL_OPTIONS)
  if (options.length < 2) return undefined
  const clientPollId =
    typeof obj.clientPollId === 'string' &&
    obj.clientPollId.trim().length > 0 &&
    obj.clientPollId.trim().length <= 128
      ? obj.clientPollId.trim()
      : undefined
  return {
    question,
    options,
    allowMultiple: obj.allowMultiple === true,
    anonymous: false,
    ...(clientPollId === undefined ? {} : { clientPollId }),
  }
}

export function pollFallbackBody(payload: PollWirePayload): string {
  return [
    `📊 ${payload.question}`,
    ...payload.options.map((opt, idx) => `${idx + 1}. ${opt}`),
  ].join('\n')
}

export interface CreateChannelPollParams {
  readonly id: string
  readonly roomId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowMultiple?: boolean | undefined
  readonly anonymous?: boolean | undefined
  readonly createdBy: string
  readonly createdByName: string
  readonly createdAt?: number | undefined
  readonly initialVotesByOptionIndex?: Readonly<Record<number, readonly string[]>> | undefined
}

export function createChannelPoll(params: CreateChannelPollParams): ChannelPoll {
  const options: PollOption[] = params.options.map((label, idx) => {
    const rawVoters = params.initialVotesByOptionIndex?.[idx] ?? []
    const uniqueVoters = Array.from(new Set(rawVoters))
    return {
      id: `${params.id}-opt-${idx + 1}`,
      label: label.trim(),
      voterIds: uniqueVoters,
    }
  })

  return {
    id: params.id,
    roomId: params.roomId,
    question: params.question.trim(),
    options,
    allowMultiple: Boolean(params.allowMultiple),
    anonymous: false,
    closed: false,
    createdBy: params.createdBy,
    createdByName: params.createdByName,
    createdAt: params.createdAt ?? 1_762_510_500_000,
  }
}

export function castPollVote(poll: ChannelPoll, optionId: string, voterId: string): ChannelPoll {
  if (poll.closed) {
    return poll
  }

  const targetExists = poll.options.some((opt) => opt.id === optionId)
  if (!targetExists) {
    return poll
  }

  if (poll.allowMultiple) {
    return {
      ...poll,
      options: poll.options.map((opt) => {
        if (opt.id !== optionId) return opt
        const alreadyVoted = opt.voterIds.includes(voterId)
        return {
          ...opt,
          voterIds: alreadyVoted
            ? opt.voterIds.filter((id) => id !== voterId)
            : [...opt.voterIds, voterId],
        }
      }),
    }
  }

  const targetOption = poll.options.find((opt) => opt.id === optionId)
  const togglingOffSameOption = Boolean(targetOption?.voterIds.includes(voterId))

  return {
    ...poll,
    options: poll.options.map((opt) => {
      const withoutVoter = opt.voterIds.filter((id) => id !== voterId)
      if (opt.id === optionId && !togglingOffSameOption) {
        return {
          ...opt,
          voterIds: [...withoutVoter, voterId],
        }
      }
      return {
        ...opt,
        voterIds: withoutVoter,
      }
    }),
  }
}

export function closeChannelPoll(poll: ChannelPoll): ChannelPoll {
  if (poll.closed) return poll
  return {
    ...poll,
    closed: true,
  }
}

export function computePollSummary(poll: ChannelPoll): PollComputedSummary {
  const uniqueParticipants = new Set<string>()
  let totalVotes = 0

  for (const option of poll.options) {
    totalVotes += option.voterIds.length
    for (const voterId of option.voterIds) {
      uniqueParticipants.add(voterId)
    }
  }

  const options: PollOptionSummary[] = poll.options.map((opt) => {
    const count = opt.voterIds.length
    const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
    return {
      id: opt.id,
      label: opt.label,
      count,
      percentage: Math.max(0, Math.min(100, percentage)),
      voterIds: opt.voterIds,
    }
  })

  return {
    totalVotes,
    totalParticipants: uniqueParticipants.size,
    options,
  }
}

export function formatPollMarkdownForDocs(poll: ChannelPoll, locale: PollLocale = 'fr'): string {
  const copy = pollMessages[locale]
  const summary = computePollSummary(poll)
  const statusLabel = poll.closed ? copy.mdStatusClosed : copy.mdStatusOpen
  const modeLabel = poll.allowMultiple ? copy.modeMultiple : copy.modeSingle
  const anonymityLabel = copy.mdNamedVote

  const lines: string[] = [
    copy.mdHeading(poll.question),
    copy.mdStatusLine(statusLabel, modeLabel, anonymityLabel),
    copy.mdParticipation(summary.totalVotes, summary.totalParticipants),
    '',
    ...summary.options.map((opt) => copy.mdOptionLine(opt.label, opt.count, opt.percentage)),
  ]

  return lines.join('\n')
}
