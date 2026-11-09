import Foundation

public enum ChannelPollError: Error, Equatable, Sendable {
    case invalidScope, invalidDefinition, invalidOption, invalidTally, unavailable, closed, stopped, staleContext
}

/// Correlation metadata for one local preview; it is not channel membership or voting authority.
public struct ChannelPollScope: Equatable, Sendable {
    public let organisationId: String
    public let channelId: String
    public init(organisationId: String, channelId: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId), Self.validText(channelId, maximumBytes: 255) else {
            throw ChannelPollError.invalidScope
        }
        self.organisationId = organisationId
        self.channelId = channelId
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.organisationId == rhs.organisationId && lhs.channelId.utf8.elementsEqual(rhs.channelId.utf8)
    }
    static func validText(_ value: String, maximumBytes: Int) -> Bool {
        (1...maximumBytes).contains(value.utf8.count)
            && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
                    || $0.value == 0x2028 || $0.value == 0x2029
            }
    }
}

/// Immutable projection of the one explicitly local preview voter's selection.
public struct ChannelPollOption: Equatable, Sendable {
    public let id: Int
    public let label: String
    public let voteCount: Int
    public let isSelectedByCurrentUser: Bool
    public let percentage: Int
    fileprivate init(id: Int, label: String, selected: Bool, percentage: Int) {
        self.id = id
        self.label = label
        voteCount = selected ? 1 : 0
        isSelectedByCurrentUser = selected
        self.percentage = percentage
    }
}

/// Deterministic one-local-voter preview. No remote totals, persistence or poll service is supplied.
public struct ChannelPollState: Equatable, Sendable {
    public enum Availability: Equatable, Sendable { case unprovisioned, localPreviewOnly, stopped }
    public static let maximumOptions = 10
    public private(set) var scope: ChannelPollScope?
    public private(set) var availability: Availability = .unprovisioned
    public private(set) var question = ""
    public private(set) var allowsMultipleChoices = false
    public private(set) var isClosed = false
    private var labels: [String] = []
    private var selection: Set<Int> = []
    public var totalVotes: Int { selection.isEmpty ? 0 : 1 }
    public var options: [ChannelPollOption] {
        labels.enumerated().map {
            let selected = selection.contains($0.offset)
            return ChannelPollOption(id: $0.offset, label: $0.element, selected: selected,
                                     percentage: Self.percentage(voteCount: selected ? 1 : 0, totalVotes: totalVotes))
        }
    }
    public init() {}

    public mutating func configure(_ scope: ChannelPollScope?) throws {
        guard availability != .stopped else { throw ChannelPollError.stopped }
        clear()
        self.scope = scope
    }
    public mutating func beginLocalPreview(scope: ChannelPollScope, question: String,
                                          optionLabels: [String], allowsMultipleChoices: Bool) throws {
        guard availability != .stopped else { throw ChannelPollError.stopped }
        guard ChannelPollScope.validText(question, maximumBytes: 280),
              (2...Self.maximumOptions).contains(optionLabels.count),
              optionLabels.allSatisfy({ ChannelPollScope.validText($0, maximumBytes: 120) }),
              Set(optionLabels.map { Data($0.utf8) }).count == optionLabels.count else {
            throw ChannelPollError.invalidDefinition
        }
        clear()
        self.scope = scope
        self.question = question
        labels = optionLabels
        self.allowsMultipleChoices = allowsMultipleChoices
        availability = .localPreviewOnly
    }
    public mutating func toggleOption(_ id: Int) throws {
        try requireOpenPreview()
        guard labels.indices.contains(id) else { throw ChannelPollError.invalidOption }
        if allowsMultipleChoices {
            if !selection.insert(id).inserted { selection.remove(id) }
        } else {
            selection = [id]
        }
    }
    public mutating func closePoll() throws {
        try requireOpenPreview()
        isClosed = true
    }
    /// Owner lifecycle teardown is permitted even for a closed poll; it is not a vote mutation.
    public mutating func clear() {
        scope = nil; question = ""; labels = []; selection = []
        allowsMultipleChoices = false; isClosed = false
        if availability != .stopped { availability = .unprovisioned }
    }
    public mutating func leave() { clear() }
    public mutating func stop() { clear(); availability = .stopped }

    /// Shared bounded tally arithmetic. Actual native previews never invent additional voters.
    public static func roundedPercentage(voteCount: Int, totalVotes: Int) throws -> Int {
        guard (0...512).contains(totalVotes), (0...totalVotes).contains(voteCount) else {
            throw ChannelPollError.invalidTally
        }
        return percentage(voteCount: voteCount, totalVotes: totalVotes)
    }
    private static func percentage(voteCount: Int, totalVotes: Int) -> Int {
        totalVotes == 0 ? 0 : (voteCount * 100 + totalVotes / 2) / totalVotes
    }
    private func requireOpenPreview() throws {
        guard availability == .localPreviewOnly else { throw ChannelPollError.unavailable }
        guard !isClosed else { throw ChannelPollError.closed }
    }
}
