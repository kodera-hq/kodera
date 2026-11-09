package io.kodera.android.domain

import java.util.Collections

enum class ChannelPollError { INVALID_SCOPE, INVALID_POLL, INVALID_OPTION, INVALID_COUNTS, CLOSED, NOT_PREVIEWING, UNAUTHORISED_UPDATE, STOPPED, OBSERVER_LIMIT }
class ChannelPollFailure(val reason: ChannelPollError) : Exception(reason.name)

/** Local correlation metadata, not authenticated channel membership or voting authority. */
data class ChannelPollScope(val organisationId: String, val channelId: String) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || !validPollText(channelId, 255)) {
            throw ChannelPollFailure(ChannelPollError.INVALID_SCOPE)
        }
    }
}

/** Reject malformed UTF-16 before UTF-8 encoding can replace invalid input silently. */
private fun validPollText(value: String, maximumBytes: Int): Boolean {
    if (value.length !in 1..maximumBytes || value.isBlank() || value != value.trim() || value.any { it.isISOControl() }) return false
    var index = 0
    while (index < value.length) {
        val char = value[index]
        val codePoint = Character.codePointAt(value, index)
        if (Character.getType(codePoint) == Character.FORMAT.toInt()) return false
        if (char.isHighSurrogate()) {
            if (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) return false
            index += 2
        } else {
            if (char.isLowSurrogate()) return false
            index++
        }
    }
    return value.toByteArray(Charsets.UTF_8).size <= maximumBytes
}

data class ChannelPollOption(val id: Int, val label: String, val voteCount: Int,
    val isSelectedByCurrentUser: Boolean, val percentage: Int)

enum class ChannelPollPhase { UNPROVISIONED, LOCAL_PREVIEW_ONLY, STOPPED }

/** One explicitly local preview voter. No server results or remote voters are fabricated. */
class ChannelPollState private constructor(val scope: ChannelPollScope, val phase: ChannelPollPhase,
    val question: String = "", val allowsMultipleChoices: Boolean = false,
    private val labels: List<String> = emptyList(), private val selected: Set<Int> = emptySet(),
    val isClosed: Boolean = false) {
    val totalVotes: Int get() = if (selected.isEmpty()) 0 else 1
    val options: List<ChannelPollOption> get() = Collections.unmodifiableList(labels.mapIndexed { id, label ->
        val count = if (id in selected) 1 else 0
        ChannelPollOption(id, label, count, count != 0, percentage(count, totalVotes))
    })

    fun localPreview(question: String, options: List<String>, allowsMultipleChoices: Boolean): ChannelPollState {
        if (phase == ChannelPollPhase.STOPPED) throw ChannelPollFailure(ChannelPollError.STOPPED)
        if (!validPollText(question, 280)) throw ChannelPollFailure(ChannelPollError.INVALID_POLL)
        val count = options.size
        if (count !in 2..10) throw ChannelPollFailure(ChannelPollError.INVALID_POLL)
        // Fixed indexed reads bound the owned copy even if a caller's list changes size or iterator.
        // Exact String equality preserves UTF-8 label identity without Unicode normalization.
        val owned = try { List(count) { options[it] } } catch (_: IndexOutOfBoundsException) {
            throw ChannelPollFailure(ChannelPollError.INVALID_POLL)
        } catch (_: ConcurrentModificationException) {
            throw ChannelPollFailure(ChannelPollError.INVALID_POLL)
        }
        if (owned.any { !validPollText(it, 120) } || owned.toSet().size != count) {
            throw ChannelPollFailure(ChannelPollError.INVALID_POLL)
        }
        return ChannelPollState(scope, ChannelPollPhase.LOCAL_PREVIEW_ONLY, question, allowsMultipleChoices,
            Collections.unmodifiableList(owned))
    }
    fun togglingOption(id: Int): ChannelPollState {
        requireOpen()
        if (id !in labels.indices) throw ChannelPollFailure(ChannelPollError.INVALID_OPTION)
        val next = if (!allowsMultipleChoices) setOf(id) else if (id in selected) selected - id else selected + id
        return ChannelPollState(scope, phase, question, allowsMultipleChoices, labels,
            Collections.unmodifiableSet(next), false)
    }
    fun closing(): ChannelPollState {
        requireOpen()
        return ChannelPollState(scope, phase, question, allowsMultipleChoices, labels, selected, true)
    }
    private fun requireOpen() {
        if (phase != ChannelPollPhase.LOCAL_PREVIEW_ONLY) throw ChannelPollFailure(ChannelPollError.NOT_PREVIEWING)
        if (isClosed) throw ChannelPollFailure(ChannelPollError.CLOSED)
    }
    companion object {
        fun unprovisioned(scope: ChannelPollScope) = ChannelPollState(scope, ChannelPollPhase.UNPROVISIONED)
        fun stopped(scope: ChannelPollScope) = ChannelPollState(scope, ChannelPollPhase.STOPPED)
        /** Half-up per-option share of nonempty voters; multi-choice percentages may sum above 100. */
        fun percentage(voteCount: Int, totalVotes: Int): Int {
            if (totalVotes !in 0..512 || voteCount !in 0..totalVotes) throw ChannelPollFailure(ChannelPollError.INVALID_COUNTS)
            return if (totalVotes == 0) 0 else (voteCount * 100 + totalVotes / 2) / totalVotes
        }
    }
}
