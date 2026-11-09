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

export function parsePollCommand(input: string): ParsePollCommandResult {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/poll')) {
    return {
      ok: false,
      error: 'La commande doit commencer par /poll.',
    }
  }

  const afterCommand = trimmed.slice('/poll'.length).trim()
  if (afterCommand.length === 0) {
    return {
      ok: false,
      error: 'Usage : /poll "Question ?" "Option A" "Option B" [--multiple] [--anonymous]',
    }
  }

  const { segments, flags, unclosedQuote } = tokenizePollArguments(afterCommand)
  if (unclosedQuote) {
    return {
      ok: false,
      error: 'Guillemet non refermé dans la commande /poll.',
    }
  }

  const allowMultiple = flags.includes('--multiple') || flags.includes('--multi')
  const anonymous = flags.includes('--anonymous') || flags.includes('--anon')

  if (segments.length < 3) {
    return {
      ok: false,
      error: 'Un sondage requiert une question et au moins 2 options.',
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
      error: 'Un sondage requiert une question valide et au moins 2 options non vides.',
    }
  }

  return {
    ok: true,
    question,
    options: options.slice(0, 10),
    allowMultiple,
    anonymous,
  }
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
    anonymous: Boolean(params.anonymous),
    closed: false,
    createdBy: params.createdBy,
    createdByName: params.createdByName,
    createdAt: params.createdAt ?? 1_762_510_500_000,
  }
}

export function castPollVote(
  poll: ChannelPoll,
  optionId: string,
  voterId: string
): ChannelPoll {
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

export function formatPollMarkdownForDocs(poll: ChannelPoll): string {
  const summary = computePollSummary(poll)
  const statusLabel = poll.closed ? 'Clôturé' : 'En cours'
  const modeLabel = poll.allowMultiple ? 'Choix multiple' : 'Choix unique'
  const anonymityLabel = poll.anonymous ? 'Vote anonyme' : 'Vote nominatif'

  const lines: string[] = [
    `### Sondage Kodera : ${poll.question}`,
    `- **Statut** : ${statusLabel} (${modeLabel} · ${anonymityLabel})`,
    `- **Participation** : ${summary.totalVotes} vote(s) (${summary.totalParticipants} participant(s))`,
    '',
    ...summary.options.map(
      (opt) => `- **${opt.label}** : ${opt.count} vote(s) (${opt.percentage} %)`
    ),
  ]

  return lines.join('\n')
}
