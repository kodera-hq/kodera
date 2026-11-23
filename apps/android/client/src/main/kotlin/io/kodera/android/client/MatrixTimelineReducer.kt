package io.kodera.android.client

import io.kodera.android.domain.AttachmentMetadataRef
import io.kodera.android.domain.ReactionKeyValidator

enum class MatrixDeliveryStatus {
    SENDING,
    SENT,
    FAILED,
}

data class MatrixReplyPreview(
    val eventId: String,
    val sender: String,
    val bodyExcerpt: String,
)

data class MatrixReactionSummary(
    val key: String,
    val count: Int,
    val isSelectedByMe: Boolean,
    val myReactionEventId: String?,
)

data class MatrixTimelineMessage(
    val key: String,
    val eventId: String?,
    val transactionId: String?,
    val sender: String,
    val senderDisplayName: String,
    val body: String,
    val originServerTs: Long,
    val deliveryStatus: MatrixDeliveryStatus,
    val isEdited: Boolean = false,
    val isRedacted: Boolean = false,
    val replyToEventId: String? = null,
    val replyPreview: MatrixReplyPreview? = null,
    val attachments: List<AttachmentMetadataRef> = emptyList(),
    val reactions: List<MatrixReactionSummary> = emptyList(),
)

data class MatrixRawTimelineEvent(
    val type: String,
    val eventId: String,
    val sender: String,
    val originServerTs: Long,
    val msgtype: String? = null,
    val body: String? = null,
    val newContentBody: String? = null,
    val relationType: String? = null,
    val relatesToEventId: String? = null,
    val reactionKey: String? = null,
    val replyToEventId: String? = null,
    val redactsEventId: String? = null,
    val transactionId: String? = null,
    val isRedactedUnsigned: Boolean = false,
    val attachments: List<AttachmentMetadataRef> = emptyList(),
)

/** Per-room incremental `/sync` delta including Matrix `limited` gap metadata. */
data class MatrixRoomSyncDelta(
    val events: List<MatrixRawTimelineEvent>,
    val limited: Boolean = false,
    val prevBatch: String? = null,
)

/**
 * Deterministic Matrix room timeline reducer preserving stable UI keys across optimistic `UUIDv7` sends,
 * sender-verified `m.replace` edits, `m.in_reply_to` replies, redactions, and single-grapheme reactions.
 */
class MatrixTimelineReducer(ownUserId: String) {
    var ownUserId: String = ownUserId
        private set

    fun updateOwnUserId(userId: String) {
        if (userId.isNotEmpty()) {
            ownUserId = userId
        }
    }
    private data class EditRecord(
        val editEventId: String,
        val body: String,
        val originServerTs: Long,
    )

    private data class ReactionRecord(
        val reactionEventId: String,
        val targetEventId: String,
        val sender: String,
        val emojiKey: String,
    )

    private val entries = ArrayList<MatrixTimelineMessage>()
    private val keyByEventId = HashMap<String, String>()
    private val keyByTransactionId = HashMap<String, String>()
    private val originalBodyByKey = HashMap<String, String>()
    private val editsByTargetEventId = HashMap<String, MutableList<EditRecord>>()
    private val targetEventIdByEditEventId = HashMap<String, String>()
    private val reactionsByReactionEventId = LinkedHashMap<String, ReactionRecord>()

    val trackedReactionCount: Int
        get() = reactionsByReactionEventId.size

    fun messages(): List<MatrixTimelineMessage> {
        val byEventId = HashMap<String, MatrixTimelineMessage>(entries.size)
        for (entry in entries) {
            val eid = entry.eventId
            if (eid != null) byEventId[eid] = entry
        }
        return entries.map { item ->
            val preview = item.replyToEventId?.let { replyEventId ->
                byEventId[replyEventId]?.let { target ->
                    val excerpt = when {
                        target.isRedacted -> ""
                        target.body.isNotEmpty() -> target.body.take(120)
                        target.attachments.isNotEmpty() -> "📎 ${target.attachments[0].filename}"
                        else -> ""
                    }
                    MatrixReplyPreview(
                        eventId = replyEventId,
                        sender = target.senderDisplayName,
                        bodyExcerpt = excerpt,
                    )
                }
            }
            val reactions = if (!item.isRedacted && item.eventId != null) {
                summarizeReactions(item.eventId)
            } else {
                emptyList()
            }
            item.copy(replyPreview = preview, reactions = reactions)
        }
    }

    fun enqueueOptimisticSend(
        transactionId: String,
        body: String,
        replyToEventId: String? = null,
        attachments: List<AttachmentMetadataRef> = emptyList(),
        nowMs: Long,
    ): MatrixTimelineMessage {
        val existingKey = keyByTransactionId[transactionId]
        if (existingKey != null) {
            val idx = entries.indexOfFirst { it.key == existingKey }
            if (idx >= 0) {
                val updated = entries[idx].copy(deliveryStatus = MatrixDeliveryStatus.SENDING)
                entries[idx] = updated
                return updated
            }
        }
        val uiKey = "txn:$transactionId"
        val normalizedBody = normalizeBody(body, attachments, hasReplyFallback = false)
        val item = MatrixTimelineMessage(
            key = uiKey,
            eventId = null,
            transactionId = transactionId,
            sender = ownUserId,
            senderDisplayName = displayName(ownUserId),
            body = normalizedBody,
            originServerTs = nowMs,
            deliveryStatus = MatrixDeliveryStatus.SENDING,
            replyToEventId = replyToEventId,
            attachments = attachments,
        )
        keyByTransactionId[transactionId] = uiKey
        originalBodyByKey[uiKey] = normalizedBody
        entries.add(item)
        trimToCapacity()
        return item
    }

    fun markOptimisticFailed(transactionId: String) {
        val uiKey = keyByTransactionId[transactionId] ?: return
        val idx = entries.indexOfFirst { it.key == uiKey }
        if (idx >= 0 && entries[idx].deliveryStatus != MatrixDeliveryStatus.SENT) {
            entries[idx] = entries[idx].copy(deliveryStatus = MatrixDeliveryStatus.FAILED)
        }
    }

    fun markOptimisticRetrying(transactionId: String) {
        val uiKey = keyByTransactionId[transactionId] ?: return
        val idx = entries.indexOfFirst { it.key == uiKey }
        if (idx >= 0 && entries[idx].deliveryStatus == MatrixDeliveryStatus.FAILED) {
            entries[idx] = entries[idx].copy(deliveryStatus = MatrixDeliveryStatus.SENDING)
        }
    }

    fun acknowledgeOptimisticSend(transactionId: String, eventId: String) {
        if (eventId.isEmpty()) return
        val uiKey = keyByTransactionId[transactionId] ?: return
        val idx = entries.indexOfFirst { it.key == uiKey }
        if (idx >= 0) {
            entries[idx] = entries[idx].copy(eventId = eventId, deliveryStatus = MatrixDeliveryStatus.SENT)
            keyByEventId[eventId] = uiKey
        }
    }

    fun applySyncDelta(
        delta: MatrixRoomSyncDelta,
        backfilledEvents: List<MatrixRawTimelineEvent> = emptyList(),
    ) {
        if (delta.limited) {
            resetSyncedTimelinePreservingPendingOptimistic()
            if (backfilledEvents.isNotEmpty()) {
                applyEvents(backfilledEvents)
            }
        }
        if (delta.events.isNotEmpty()) {
            applyEvents(delta.events)
        }
        if (delta.limited) {
            val synced = entries.filter { it.deliveryStatus == MatrixDeliveryStatus.SENT && it.eventId != null }
            val pending = entries.filter { it.deliveryStatus != MatrixDeliveryStatus.SENT || it.eventId == null }
            entries.clear()
            entries.addAll(synced)
            entries.addAll(pending)
        }
    }

    private fun resetSyncedTimelinePreservingPendingOptimistic() {
        val preserved = entries.filter { it.deliveryStatus != MatrixDeliveryStatus.SENT || it.eventId == null }
        entries.clear()
        entries.addAll(preserved)
        keyByEventId.clear()
        keyByTransactionId.clear()
        val survivingBodies = HashMap<String, String>(preserved.size)
        for (item in preserved) {
            item.transactionId?.let { keyByTransactionId[it] = item.key }
            survivingBodies[item.key] = originalBodyByKey[item.key] ?: item.body
        }
        originalBodyByKey.clear()
        originalBodyByKey.putAll(survivingBodies)
        editsByTargetEventId.clear()
        targetEventIdByEditEventId.clear()
        reactionsByReactionEventId.clear()
    }

    fun applyEvents(events: List<MatrixRawTimelineEvent>) {
        for (event in events) {
            if (event.eventId.isEmpty() || event.sender.isEmpty()) continue
            when (event.type) {
                "m.room.message" -> applyMessageEvent(event)
                "m.reaction" -> applyReactionEvent(event)
                "m.room.redaction" -> applyRedactionEvent(event)
            }
        }
        trimToCapacity()
    }

    fun clear() {
        entries.clear()
        keyByEventId.clear()
        keyByTransactionId.clear()
        originalBodyByKey.clear()
        editsByTargetEventId.clear()
        targetEventIdByEditEventId.clear()
        reactionsByReactionEventId.clear()
    }

    private fun applyMessageEvent(event: MatrixRawTimelineEvent) {
        if (event.relationType == "m.replace" && event.relatesToEventId != null) {
            val targetEventId = event.relatesToEventId
            val targetKey = keyByEventId[targetEventId] ?: return
            val idx = entries.indexOfFirst { it.key == targetKey }
            if (idx < 0) return
            val target = entries[idx]
            if (target.sender != event.sender ||
                target.isRedacted ||
                event.isRedactedUnsigned ||
                targetEventIdByEditEventId.containsKey(event.eventId)
            ) {
                return
            }
            val candidate = stripEditPrefix(event.newContentBody ?: event.body ?: "")
            val history = editsByTargetEventId.getOrPut(targetEventId) { ArrayList() }
            history.add(EditRecord(event.eventId, candidate, event.originServerTs))
            targetEventIdByEditEventId[event.eventId] = targetEventId
            recomputeEditedMessage(targetEventId)
            return
        }

        if (!event.isRedactedUnsigned) {
            if (event.msgtype == null || event.msgtype !in SUPPORTED_MSG_TYPES) return
        }

        val normalizedBody = if (event.isRedactedUnsigned) {
            ""
        } else {
            normalizeBody(
                event.body ?: "",
                event.attachments,
                hasReplyFallback = event.replyToEventId != null,
            )
        }

        val matchedKey = keyByEventId[event.eventId]
            ?: event.transactionId?.let { keyByTransactionId[it] }
        if (matchedKey != null) {
            val idx = entries.indexOfFirst { it.key == matchedKey }
            if (idx >= 0) {
                val current = entries[idx]
                if (event.isRedactedUnsigned) {
                    entries[idx] = current.copy(
                        eventId = event.eventId,
                        deliveryStatus = MatrixDeliveryStatus.SENT,
                        isRedacted = true,
                        isEdited = false,
                        body = "",
                        attachments = emptyList(),
                    )
                    originalBodyByKey[matchedKey] = ""
                    purgeEditsAndReactions(event.eventId)
                } else {
                    originalBodyByKey[matchedKey] = normalizedBody
                    entries[idx] = current.copy(
                        eventId = event.eventId,
                        deliveryStatus = MatrixDeliveryStatus.SENT,
                        body = if (current.isEdited) current.body else normalizedBody,
                        attachments = if (event.attachments.isNotEmpty()) event.attachments else current.attachments,
                    )
                }
                keyByEventId[event.eventId] = matchedKey
                return
            }
        }

        val uiKey = "evt:${event.eventId}"
        val item = MatrixTimelineMessage(
            key = uiKey,
            eventId = event.eventId,
            transactionId = event.transactionId,
            sender = event.sender,
            senderDisplayName = displayName(event.sender),
            body = normalizedBody,
            originServerTs = event.originServerTs,
            deliveryStatus = MatrixDeliveryStatus.SENT,
            isEdited = false,
            isRedacted = event.isRedactedUnsigned,
            replyToEventId = event.replyToEventId,
            attachments = if (event.isRedactedUnsigned) emptyList() else event.attachments,
        )
        keyByEventId[event.eventId] = uiKey
        originalBodyByKey[uiKey] = normalizedBody
        if (event.transactionId != null) {
            keyByTransactionId[event.transactionId] = uiKey
        }
        entries.add(item)
    }

    private fun recomputeEditedMessage(targetEventId: String) {
        val targetKey = keyByEventId[targetEventId] ?: return
        val idx = entries.indexOfFirst { it.key == targetKey }
        if (idx < 0 || entries[idx].isRedacted) return
        val history = editsByTargetEventId[targetEventId]
        if (!history.isNullOrEmpty()) {
            var winning = history[0]
            for (i in 1 until history.size) {
                val edit = history[i]
                if (edit.originServerTs >= winning.originServerTs) {
                    winning = edit
                }
            }
            entries[idx] = entries[idx].copy(body = winning.body, isEdited = true)
        } else {
            entries[idx] = entries[idx].copy(body = originalBodyByKey[targetKey] ?: "", isEdited = false)
        }
    }

    private fun purgeEditsAndReactions(messageEventId: String) {
        val removedEdits = editsByTargetEventId.remove(messageEventId)
        if (removedEdits != null) {
            for (edit in removedEdits) {
                targetEventIdByEditEventId.remove(edit.editEventId)
            }
        }
        val iter = reactionsByReactionEventId.values.iterator()
        while (iter.hasNext()) {
            if (iter.next().targetEventId == messageEventId) {
                iter.remove()
            }
        }
    }

    private fun applyReactionEvent(event: MatrixRawTimelineEvent) {
        if (event.isRedactedUnsigned ||
            event.relationType != "m.annotation" ||
            event.relatesToEventId.isNullOrEmpty() ||
            event.reactionKey == null ||
            !ReactionKeyValidator.isValid(event.reactionKey) ||
            reactionsByReactionEventId.containsKey(event.eventId)
        ) {
            return
        }
        val targetKey = keyByEventId[event.relatesToEventId]
        if (targetKey != null) {
            val targetIdx = entries.indexOfFirst { it.key == targetKey }
            if (targetIdx >= 0 && entries[targetIdx].isRedacted) return
        }
        while (reactionsByReactionEventId.size >= MAX_TRACKED_REACTIONS) {
            val oldest = reactionsByReactionEventId.keys.iterator()
            if (oldest.hasNext()) {
                oldest.next()
                oldest.remove()
            } else {
                break
            }
        }
        reactionsByReactionEventId[event.eventId] = ReactionRecord(
            reactionEventId = event.eventId,
            targetEventId = event.relatesToEventId,
            sender = event.sender,
            emojiKey = event.reactionKey,
        )
    }

    private fun applyRedactionEvent(event: MatrixRawTimelineEvent) {
        val targetId = event.redactsEventId ?: return
        if (targetId.isEmpty()) return
        if (reactionsByReactionEventId.remove(targetId) != null) {
            return
        }
        val parentMessageId = targetEventIdByEditEventId.remove(targetId)
        if (parentMessageId != null) {
            val history = editsByTargetEventId[parentMessageId]
            if (history != null) {
                history.removeAll { it.editEventId == targetId }
                if (history.isEmpty()) {
                    editsByTargetEventId.remove(parentMessageId)
                }
            }
            recomputeEditedMessage(parentMessageId)
            return
        }
        val targetKey = keyByEventId[targetId] ?: return
        val idx = entries.indexOfFirst { it.key == targetKey }
        if (idx >= 0) {
            entries[idx] = entries[idx].copy(
                isRedacted = true,
                isEdited = false,
                body = "",
                attachments = emptyList(),
                reactions = emptyList(),
            )
            originalBodyByKey[targetKey] = ""
            purgeEditsAndReactions(targetId)
        }
    }

    private fun summarizeReactions(targetEventId: String): List<MatrixReactionSummary> {
        val orderedKeys = ArrayList<String>()
        val sendersByKey = LinkedHashMap<String, MutableSet<String>>()
        val ownReactionByKey = HashMap<String, String>()

        for (record in reactionsByReactionEventId.values) {
            if (record.targetEventId != targetEventId) continue
            val set = sendersByKey.getOrPut(record.emojiKey) {
                orderedKeys.add(record.emojiKey)
                LinkedHashSet()
            }
            set.add(record.sender)
            if (record.sender == ownUserId && !ownReactionByKey.containsKey(record.emojiKey)) {
                ownReactionByKey[record.emojiKey] = record.reactionEventId
            }
        }
        return orderedKeys.mapNotNull { key ->
            val senders = sendersByKey[key]
            if (senders.isNullOrEmpty()) null
            else MatrixReactionSummary(
                key = key,
                count = senders.size,
                isSelectedByMe = senders.contains(ownUserId),
                myReactionEventId = ownReactionByKey[key],
            )
        }
    }

    private fun trimToCapacity() {
        if (entries.size <= MAX_TIMELINE_MESSAGES) return
        val overflow = entries.size - MAX_TIMELINE_MESSAGES
        for (i in 0 until overflow) {
            val dropped = entries[i]
            originalBodyByKey.remove(dropped.key)
            dropped.eventId?.let {
                keyByEventId.remove(it)
                purgeEditsAndReactions(it)
            }
            dropped.transactionId?.let { keyByTransactionId.remove(it) }
        }
        entries.subList(0, overflow).clear()
    }

    companion object {
        const val MAX_TIMELINE_MESSAGES: Int = 250
        const val MAX_TRACKED_REACTIONS: Int = 512
        private val SUPPORTED_MSG_TYPES = setOf(
            "m.text", "m.notice", "m.file", "m.image", "m.audio", "m.video",
        )

        fun displayName(sender: String): String {
            if (!sender.startsWith("@")) return sender
            val colon = sender.indexOf(':')
            if (colon <= 1) return sender
            return sender.substring(1, colon)
        }

        private fun normalizeBody(
            rawBody: String,
            attachments: List<AttachmentMetadataRef>,
            hasReplyFallback: Boolean,
        ): String {
            var text = if (hasReplyFallback) stripReplyFallback(rawBody) else rawBody
            if (attachments.isNotEmpty()) {
                val fallback = AttachmentMetadataRef.fallbackBody(attachments)
                if (text == fallback) {
                    text = ""
                } else if (text.endsWith("\n\n$fallback")) {
                    text = text.substring(0, text.length - (2 + fallback.length))
                }
            }
            return text
        }

        private fun stripReplyFallback(raw: String): String {
            if (!raw.startsWith("> ")) return raw
            val lines = raw.split('\n')
            var idx = 0
            while (idx < lines.size && lines[idx].startsWith(">")) idx++
            if (idx < lines.size && lines[idx].isEmpty()) idx++
            return lines.subList(idx, lines.size).joinToString("\n")
        }

        private fun stripEditPrefix(raw: String): String =
            if (raw.startsWith("* ")) raw.substring(2) else raw
    }
}
