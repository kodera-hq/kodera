import Foundation
import KoderaDomain

public enum MatrixDeliveryStatus: String, Equatable, Sendable {
    case sending
    case sent
    case failed
}

public struct MatrixReplyPreview: Equatable, Sendable {
    public let eventId: String
    public let sender: String
    public let bodyExcerpt: String

    public init(eventId: String, sender: String, bodyExcerpt: String) {
        self.eventId = eventId
        self.sender = sender
        self.bodyExcerpt = bodyExcerpt
    }
}

public struct MatrixReactionSummary: Equatable, Sendable {
    public let key: String
    public let count: Int
    public let isSelectedByMe: Bool
    public let myReactionEventId: String?

    public init(key: String, count: Int, isSelectedByMe: Bool, myReactionEventId: String?) {
        self.key = key
        self.count = count
        self.isSelectedByMe = isSelectedByMe
        self.myReactionEventId = myReactionEventId
    }
}

public struct MatrixTimelineMessage: Equatable, Identifiable, Sendable {
    public let key: String
    public var id: String { key }
    public var eventId: String?
    public let transactionId: String?
    public let sender: String
    public let senderDisplayName: String
    public var body: String
    public let originServerTs: Int64
    public var deliveryStatus: MatrixDeliveryStatus
    public var isEdited: Bool
    public var isRedacted: Bool
    public let replyToEventId: String?
    public var replyPreview: MatrixReplyPreview?
    public var attachments: [AttachmentMetadataRef]
    public var reactions: [MatrixReactionSummary]

    public init(
        key: String,
        eventId: String?,
        transactionId: String?,
        sender: String,
        senderDisplayName: String,
        body: String,
        originServerTs: Int64,
        deliveryStatus: MatrixDeliveryStatus,
        isEdited: Bool = false,
        isRedacted: Bool = false,
        replyToEventId: String? = nil,
        replyPreview: MatrixReplyPreview? = nil,
        attachments: [AttachmentMetadataRef] = [],
        reactions: [MatrixReactionSummary] = []
    ) {
        self.key = key
        self.eventId = eventId
        self.transactionId = transactionId
        self.sender = sender
        self.senderDisplayName = senderDisplayName
        self.body = body
        self.originServerTs = originServerTs
        self.deliveryStatus = deliveryStatus
        self.isEdited = isEdited
        self.isRedacted = isRedacted
        self.replyToEventId = replyToEventId
        self.replyPreview = replyPreview
        self.attachments = attachments
        self.reactions = reactions
    }
}

/// Decoded Matrix room timeline event (`m.room.message`, `m.reaction`, `m.room.redaction`).
public struct MatrixRawTimelineEvent: Equatable, Sendable {
    public let type: String
    public let eventId: String
    public let sender: String
    public let originServerTs: Int64
    public let msgtype: String?
    public let body: String?
    public let newContentBody: String?
    public let relationType: String?
    public let relatesToEventId: String?
    public let reactionKey: String?
    public let replyToEventId: String?
    public let redactsEventId: String?
    public let transactionId: String?
    public let isRedactedUnsigned: Bool
    public let attachments: [AttachmentMetadataRef]

    public init(
        type: String,
        eventId: String,
        sender: String,
        originServerTs: Int64,
        msgtype: String? = nil,
        body: String? = nil,
        newContentBody: String? = nil,
        relationType: String? = nil,
        relatesToEventId: String? = nil,
        reactionKey: String? = nil,
        replyToEventId: String? = nil,
        redactsEventId: String? = nil,
        transactionId: String? = nil,
        isRedactedUnsigned: Bool = false,
        attachments: [AttachmentMetadataRef] = []
    ) {
        self.type = type
        self.eventId = eventId
        self.sender = sender
        self.originServerTs = originServerTs
        self.msgtype = msgtype
        self.body = body
        self.newContentBody = newContentBody
        self.relationType = relationType
        self.relatesToEventId = relatesToEventId
        self.reactionKey = reactionKey
        self.replyToEventId = replyToEventId
        self.redactsEventId = redactsEventId
        self.transactionId = transactionId
        self.isRedactedUnsigned = isRedactedUnsigned
        self.attachments = attachments
    }
}

/// Per-room incremental `/sync` delta including Matrix `limited` gap metadata.
public struct MatrixRoomSyncDelta: Equatable, Sendable {
    public let events: [MatrixRawTimelineEvent]
    public let limited: Bool
    public let prevBatch: String?

    public init(events: [MatrixRawTimelineEvent], limited: Bool = false, prevBatch: String? = nil) {
        self.events = events
        self.limited = limited
        self.prevBatch = prevBatch
    }
}

/// Deterministic Matrix room timeline reducer maintaining stable UI keys across optimistic sends,
/// sender-verified `m.replace` edits, `m.in_reply_to` replies, redactions, and single-grapheme reactions.
public struct MatrixTimelineReducer: Sendable {
    public static let maxTimelineMessages = 250
    public static let maxTrackedReactions = 512
    private static let supportedMsgTypes: Set<String> = [
        "m.text", "m.notice", "m.file", "m.image", "m.audio", "m.video",
    ]

    private struct EditRecord: Equatable, Sendable {
        let editEventId: String
        let body: String
        let originServerTs: Int64
    }

    private struct ReactionRecord: Equatable, Sendable {
        let reactionEventId: String
        let targetEventId: String
        let sender: String
        let emojiKey: String
    }

    public let ownUserId: String
    private var entries: [MatrixTimelineMessage] = []
    private var keyByEventId: [String: String] = [:]
    private var keyByTransactionId: [String: String] = [:]
    private var originalBodyByKey: [String: String] = [:]
    private var editsByTargetEventId: [String: [EditRecord]] = [:]
    private var targetEventIdByEditEventId: [String: String] = [:]
    private var reactionsByReactionEventId: [String: ReactionRecord] = [:]
    private var reactionEventOrder: [String] = []

    public init(ownUserId: String) {
        self.ownUserId = ownUserId
    }

    public var trackedReactionCount: Int {
        reactionsByReactionEventId.count
    }

    public var messages: [MatrixTimelineMessage] {
        var byEventId: [String: MatrixTimelineMessage] = [:]
        for item in entries {
            if let eid = item.eventId {
                byEventId[eid] = item
            }
        }
        return entries.map { item in
            var copy = item
            if let replyEventId = item.replyToEventId, let target = byEventId[replyEventId] {
                let excerpt: String
                if target.isRedacted {
                    excerpt = ""
                } else if !target.body.isEmpty {
                    excerpt = String(target.body.prefix(120))
                } else if let firstAttachment = target.attachments.first {
                    excerpt = "📎 \(firstAttachment.filename)"
                } else {
                    excerpt = ""
                }
                copy.replyPreview = MatrixReplyPreview(
                    eventId: replyEventId,
                    sender: target.senderDisplayName,
                    bodyExcerpt: excerpt
                )
            }
            if let eventId = item.eventId, !item.isRedacted {
                copy.reactions = summarizeReactions(forEventId: eventId)
            } else {
                copy.reactions = []
            }
            return copy
        }
    }

    @discardableResult
    public mutating func enqueueOptimisticSend(
        transactionId: String,
        body: String,
        replyToEventId: String? = nil,
        attachments: [AttachmentMetadataRef] = [],
        nowMs: Int64
    ) -> MatrixTimelineMessage {
        if let existingKey = keyByTransactionId[transactionId],
           let index = entries.firstIndex(where: { $0.key == existingKey }) {
            entries[index].deliveryStatus = .sending
            return entries[index]
        }
        let uiKey = "txn:\(transactionId)"
        let normalizedBody = Self.normalizeBody(body, attachments: attachments, hasReplyFallback: false)
        let item = MatrixTimelineMessage(
            key: uiKey,
            eventId: nil,
            transactionId: transactionId,
            sender: ownUserId,
            senderDisplayName: Self.displayName(fromSender: ownUserId),
            body: normalizedBody,
            originServerTs: nowMs,
            deliveryStatus: .sending,
            replyToEventId: replyToEventId,
            attachments: attachments
        )
        keyByTransactionId[transactionId] = uiKey
        originalBodyByKey[uiKey] = normalizedBody
        entries.append(item)
        trimToCapacity()
        return item
    }

    public mutating func markOptimisticFailed(transactionId: String) {
        guard let uiKey = keyByTransactionId[transactionId],
              let idx = entries.firstIndex(where: { $0.key == uiKey }),
              entries[idx].deliveryStatus != .sent else { return }
        entries[idx].deliveryStatus = .failed
    }

    public mutating func markOptimisticRetrying(transactionId: String) {
        guard let uiKey = keyByTransactionId[transactionId],
              let idx = entries.firstIndex(where: { $0.key == uiKey }),
              entries[idx].deliveryStatus == .failed else { return }
        entries[idx].deliveryStatus = .sending
    }

    public mutating func acknowledgeOptimisticSend(transactionId: String, eventId: String) {
        guard !eventId.isEmpty,
              let uiKey = keyByTransactionId[transactionId],
              let idx = entries.firstIndex(where: { $0.key == uiKey }) else { return }
        entries[idx].eventId = eventId
        entries[idx].deliveryStatus = .sent
        keyByEventId[eventId] = uiKey
    }

    public mutating func applySyncDelta(
        _ delta: MatrixRoomSyncDelta,
        backfilledEvents: [MatrixRawTimelineEvent] = []
    ) {
        if delta.limited {
            resetSyncedTimelinePreservingPendingOptimistic()
            if !backfilledEvents.isEmpty {
                applyEvents(backfilledEvents)
            }
        }
        if !delta.events.isEmpty {
            applyEvents(delta.events)
        }
        if delta.limited {
            let synced = entries.filter { $0.deliveryStatus == .sent && $0.eventId != nil }
            let pending = entries.filter { $0.deliveryStatus != .sent || $0.eventId == nil }
            entries = synced + pending
        }
    }

    private mutating func resetSyncedTimelinePreservingPendingOptimistic() {
        let preserved = entries.filter { $0.deliveryStatus != .sent || $0.eventId == nil }
        entries = preserved
        keyByEventId.removeAll()
        keyByTransactionId.removeAll()
        var survivingOriginalBodies: [String: String] = [:]
        for item in preserved {
            if let tid = item.transactionId {
                keyByTransactionId[tid] = item.key
            }
            survivingOriginalBodies[item.key] = originalBodyByKey[item.key] ?? item.body
        }
        originalBodyByKey = survivingOriginalBodies
        editsByTargetEventId.removeAll()
        targetEventIdByEditEventId.removeAll()
        reactionsByReactionEventId.removeAll()
        reactionEventOrder.removeAll()
    }

    public mutating func applyEvents(_ events: [MatrixRawTimelineEvent]) {
        for event in events {
            guard !event.eventId.isEmpty, !event.sender.isEmpty else { continue }
            switch event.type {
            case "m.room.message":
                applyMessageEvent(event)
            case "m.reaction":
                applyReactionEvent(event)
            case "m.room.redaction":
                applyRedactionEvent(event)
            default:
                continue
            }
        }
        trimToCapacity()
    }

    public mutating func clear() {
        entries.removeAll()
        keyByEventId.removeAll()
        keyByTransactionId.removeAll()
        originalBodyByKey.removeAll()
        editsByTargetEventId.removeAll()
        targetEventIdByEditEventId.removeAll()
        reactionsByReactionEventId.removeAll()
        reactionEventOrder.removeAll()
    }

    private mutating func applyMessageEvent(_ event: MatrixRawTimelineEvent) {
        if event.relationType == "m.replace", let targetEventId = event.relatesToEventId {
            guard let targetKey = keyByEventId[targetEventId],
                  let targetIdx = entries.firstIndex(where: { $0.key == targetKey }) else {
                return
            }
            // Sender-verified m.replace only, and redacted events cannot be resurrected by an edit.
            guard entries[targetIdx].sender == event.sender,
                  !entries[targetIdx].isRedacted,
                  !event.isRedactedUnsigned,
                  targetEventIdByEditEventId[event.eventId] == nil else {
                return
            }
            let candidateBody = Self.stripEditPrefix(event.newContentBody ?? event.body ?? "")
            var history = editsByTargetEventId[targetEventId] ?? []
            history.append(EditRecord(
                editEventId: event.eventId,
                body: candidateBody,
                originServerTs: event.originServerTs
            ))
            editsByTargetEventId[targetEventId] = history
            targetEventIdByEditEventId[event.eventId] = targetEventId
            recomputeEditedMessage(targetEventId: targetEventId)
            return
        }

        if !event.isRedactedUnsigned {
            guard let msgtype = event.msgtype, Self.supportedMsgTypes.contains(msgtype) else {
                return
            }
        }

        let normalizedBody = event.isRedactedUnsigned
            ? ""
            : Self.normalizeBody(
                event.body ?? "",
                attachments: event.attachments,
                hasReplyFallback: event.replyToEventId != nil
            )

        // Match existing entry by eventId OR by optimistic transactionId (preserving stable UI key!).
        if let matchedKey = keyByEventId[event.eventId]
            ?? event.transactionId.flatMap({ keyByTransactionId[$0] }),
           let existingIdx = entries.firstIndex(where: { $0.key == matchedKey }) {
            entries[existingIdx].eventId = event.eventId
            entries[existingIdx].deliveryStatus = .sent
            if event.isRedactedUnsigned {
                entries[existingIdx].isRedacted = true
                entries[existingIdx].isEdited = false
                entries[existingIdx].body = ""
                entries[existingIdx].attachments = []
                originalBodyByKey[matchedKey] = ""
                purgeEditsAndReactions(forMessageEventId: event.eventId)
            } else {
                originalBodyByKey[matchedKey] = normalizedBody
                if !entries[existingIdx].isEdited {
                    entries[existingIdx].body = normalizedBody
                }
                if !event.attachments.isEmpty {
                    entries[existingIdx].attachments = event.attachments
                }
            }
            keyByEventId[event.eventId] = matchedKey
            return
        }

        let uiKey = "evt:\(event.eventId)"
        let item = MatrixTimelineMessage(
            key: uiKey,
            eventId: event.eventId,
            transactionId: event.transactionId,
            sender: event.sender,
            senderDisplayName: Self.displayName(fromSender: event.sender),
            body: normalizedBody,
            originServerTs: event.originServerTs,
            deliveryStatus: .sent,
            isEdited: false,
            isRedacted: event.isRedactedUnsigned,
            replyToEventId: event.replyToEventId,
            attachments: event.isRedactedUnsigned ? [] : event.attachments
        )
        keyByEventId[event.eventId] = uiKey
        originalBodyByKey[uiKey] = normalizedBody
        if let txnId = event.transactionId {
            keyByTransactionId[txnId] = uiKey
        }
        entries.append(item)
    }

    private mutating func recomputeEditedMessage(targetEventId: String) {
        guard let targetKey = keyByEventId[targetEventId],
              let idx = entries.firstIndex(where: { $0.key == targetKey }),
              !entries[idx].isRedacted else {
            return
        }
        if let history = editsByTargetEventId[targetEventId], !history.isEmpty {
            var winning = history[0]
            for edit in history.dropFirst() where edit.originServerTs >= winning.originServerTs {
                winning = edit
            }
            entries[idx].body = winning.body
            entries[idx].isEdited = true
        } else {
            entries[idx].body = originalBodyByKey[targetKey] ?? ""
            entries[idx].isEdited = false
        }
    }

    private mutating func purgeEditsAndReactions(forMessageEventId messageEventId: String) {
        if let edits = editsByTargetEventId.removeValue(forKey: messageEventId) {
            for edit in edits {
                targetEventIdByEditEventId.removeValue(forKey: edit.editEventId)
            }
        }
        let matchingReactionIds = reactionsByReactionEventId.values
            .filter { $0.targetEventId == messageEventId }
            .map(\.reactionEventId)
        if !matchingReactionIds.isEmpty {
            let idSet = Set(matchingReactionIds)
            for rid in idSet {
                reactionsByReactionEventId.removeValue(forKey: rid)
            }
            reactionEventOrder.removeAll { idSet.contains($0) }
        }
    }

    private mutating func applyReactionEvent(_ event: MatrixRawTimelineEvent) {
        guard !event.isRedactedUnsigned,
              event.relationType == "m.annotation",
              let targetEventId = event.relatesToEventId,
              !targetEventId.isEmpty,
              let key = event.reactionKey,
              ReactionKeyValidator.isValid(key),
              reactionsByReactionEventId[event.eventId] == nil else {
            return
        }
        // Ignore reactions targeting an already-redacted message.
        if let targetKey = keyByEventId[targetEventId],
           let targetIdx = entries.firstIndex(where: { $0.key == targetKey }),
           entries[targetIdx].isRedacted {
            return
        }
        while reactionEventOrder.count >= Self.maxTrackedReactions {
            let oldestId = reactionEventOrder.removeFirst()
            reactionsByReactionEventId.removeValue(forKey: oldestId)
        }
        reactionsByReactionEventId[event.eventId] = ReactionRecord(
            reactionEventId: event.eventId,
            targetEventId: targetEventId,
            sender: event.sender,
            emojiKey: key
        )
        reactionEventOrder.append(event.eventId)
    }

    private mutating func applyRedactionEvent(_ event: MatrixRawTimelineEvent) {
        guard let targetId = event.redactsEventId, !targetId.isEmpty else { return }
        if reactionsByReactionEventId.removeValue(forKey: targetId) != nil {
            reactionEventOrder.removeAll { $0 == targetId }
            return
        }
        if let parentMessageId = targetEventIdByEditEventId.removeValue(forKey: targetId) {
            if var history = editsByTargetEventId[parentMessageId] {
                history.removeAll { $0.editEventId == targetId }
                if history.isEmpty {
                    editsByTargetEventId.removeValue(forKey: parentMessageId)
                } else {
                    editsByTargetEventId[parentMessageId] = history
                }
            }
            recomputeEditedMessage(targetEventId: parentMessageId)
            return
        }
        if let targetKey = keyByEventId[targetId],
           let idx = entries.firstIndex(where: { $0.key == targetKey }) {
            entries[idx].isRedacted = true
            entries[idx].isEdited = false
            entries[idx].body = ""
            entries[idx].attachments = []
            entries[idx].reactions = []
            originalBodyByKey[targetKey] = ""
            purgeEditsAndReactions(forMessageEventId: targetId)
        }
    }

    private func summarizeReactions(forEventId targetEventId: String) -> [MatrixReactionSummary] {
        var orderedKeys: [String] = []
        var sendersByKey: [String: Set<String>] = [:]
        var ownReactionEventByKey: [String: String] = [:]

        for reactionEventId in reactionEventOrder {
            guard let record = reactionsByReactionEventId[reactionEventId],
                  record.targetEventId == targetEventId else { continue }
            if sendersByKey[record.emojiKey] == nil {
                orderedKeys.append(record.emojiKey)
                sendersByKey[record.emojiKey] = []
            }
            sendersByKey[record.emojiKey]?.insert(record.sender)
            if record.sender == ownUserId && ownReactionEventByKey[record.emojiKey] == nil {
                ownReactionEventByKey[record.emojiKey] = record.reactionEventId
            }
        }

        return orderedKeys.compactMap { emojiKey in
            guard let senders = sendersByKey[emojiKey], !senders.isEmpty else { return nil }
            return MatrixReactionSummary(
                key: emojiKey,
                count: senders.count,
                isSelectedByMe: senders.contains(ownUserId),
                myReactionEventId: ownReactionEventByKey[emojiKey]
            )
        }
    }

    private mutating func trimToCapacity() {
        guard entries.count > Self.maxTimelineMessages else { return }
        let overflow = entries.count - Self.maxTimelineMessages
        let dropped = entries.prefix(overflow)
        for item in dropped {
            originalBodyByKey.removeValue(forKey: item.key)
            if let eid = item.eventId {
                keyByEventId.removeValue(forKey: eid)
                purgeEditsAndReactions(forMessageEventId: eid)
            }
            if let tid = item.transactionId {
                keyByTransactionId.removeValue(forKey: tid)
            }
        }
        entries.removeFirst(overflow)
    }

    public static func displayName(fromSender sender: String) -> String {
        guard sender.hasPrefix("@"), let colon = sender.firstIndex(of: ":") else {
            return sender
        }
        let local = String(sender[sender.index(after: sender.startIndex)..<colon])
        return local.isEmpty ? sender : local
    }

    private static func normalizeBody(
        _ rawBody: String,
        attachments: [AttachmentMetadataRef],
        hasReplyFallback: Bool
    ) -> String {
        var text = hasReplyFallback ? stripReplyFallback(rawBody) : rawBody
        if !attachments.isEmpty {
            let fallback = AttachmentMetadataRef.fallbackBody(for: attachments)
            if text == fallback {
                text = ""
            } else if text.hasSuffix("\n\n" + fallback) {
                text = String(text.dropLast(2 + fallback.count))
            }
        }
        return text
    }

    private static func stripReplyFallback(_ raw: String) -> String {
        guard raw.hasPrefix("> ") else { return raw }
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: false)
        var index = 0
        while index < lines.count, lines[index].hasPrefix(">") {
            index += 1
        }
        if index < lines.count, lines[index].isEmpty {
            index += 1
        }
        return lines[index...].joined(separator: "\n")
    }

    private static func stripEditPrefix(_ raw: String) -> String {
        if raw.hasPrefix("* ") {
            return String(raw.dropFirst(2))
        }
        return raw
    }
}
