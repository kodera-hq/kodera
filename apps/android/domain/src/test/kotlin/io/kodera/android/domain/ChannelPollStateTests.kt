package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.roundToInt

class ChannelPollStateTests {
    private val scope = ChannelPollScope("11111111-1111-4111-8111-111111111111", "text-one")
    private fun preview(multiple: Boolean = false) = ChannelPollState.unprovisioned(scope)
        .localPreview("Choose a meeting time", listOf("Morning", "Afternoon", "Evening"), multiple)
    private fun refuses(reason: ChannelPollError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: ChannelPollFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun scopeRequiresCanonicalOrganisationAndStrictUtf8Channel() {
        for (org in listOf("", "org", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", " " + scope.organisationId)) {
            refuses(ChannelPollError.INVALID_SCOPE) { ChannelPollScope(org, "text") }
        }
        for (channel in listOf("", " ", " text", "text ", "text\n", "x\u202e", "\ud800", "a".repeat(256))) {
            refuses(ChannelPollError.INVALID_SCOPE) { ChannelPollScope(scope.organisationId, channel) }
        }
        assertEquals(255, ChannelPollScope(scope.organisationId, "🧭".repeat(63) + "abc").channelId.toByteArray().size)
        refuses(ChannelPollError.INVALID_SCOPE) { ChannelPollScope(scope.organisationId, "🧭".repeat(64)) }
    }
    @Test fun questionsAndOptionsValidateUtf8BoundsControlsAndMalformedSurrogates() {
        val base = ChannelPollState.unprovisioned(scope)
        for (question in listOf("", " ", " Question", "Question ", "Question\n", "q\u200d", "\ud800", "\udfff", "a".repeat(281))) {
            refuses(ChannelPollError.INVALID_POLL) { base.localPreview(question, listOf("A", "B"), false) }
        }
        assertEquals(280, base.localPreview("é".repeat(140), listOf("A", "B"), false).question.toByteArray().size)
        for (label in listOf("", " ", " Label", "Label ", "Label\u0000", "label\u202e", "\ud800", "é".repeat(61))) {
            refuses(ChannelPollError.INVALID_POLL) { base.localPreview("Question", listOf(label, "Other"), false) }
        }
        assertEquals(120, base.localPreview("Question", listOf("é".repeat(60), "Other"), true).options.first().label.toByteArray().size)
        assertEquals(2, base.localPreview("Question", listOf("é", "e\u0301"), false).options.size)
    }
    @Test fun optionCountUniquenessAndOwnedSnapshotAreBoundedBeforeCopy() {
        val base = ChannelPollState.unprovisioned(scope)
        for (bad in listOf(emptyList(), listOf("A"), listOf("A", "A"), (1..11).map { it.toString() })) {
            refuses(ChannelPollError.INVALID_POLL) { base.localPreview("Question", bad, false) }
        }
        val huge = object : AbstractList<String>() {
            override val size: Int = Int.MAX_VALUE
            override fun get(index: Int): String = error("must bound before traversal")
        }
        refuses(ChannelPollError.INVALID_POLL) { base.localPreview("Question", huge, false) }
        val labels = (1..10).map { "Choice $it" }.toMutableList()
        val state = base.localPreview("Question", labels, true)
        labels.clear()
        assertEquals((0..9).toList(), state.options.map { it.id })
        assertEquals(10, state.options.size)
        try { (state.options as MutableList).clear(); fail("mutable snapshot") } catch (_: UnsupportedOperationException) { }
    }
    @Test fun validationAppliesToTheExactRetainedSnapshotOfAChangingSource() {
        var reads = 0
        val changing = object : AbstractList<String>() {
            override val size: Int = 2
            override fun get(index: Int): String = if (++reads <= 4) "Choice $index" else ""
        }
        val state = ChannelPollState.unprovisioned(scope).localPreview("Question", changing, false)
        assertEquals(2, state.options.map { it.label }.toSet().size)
        assertTrue(state.options.all { it.label.isNotBlank() })
    }
    @Test fun changingSizeAndHostileIteratorCannotExpandTheBoundedCopy() {
        var sizeReads = 0
        var elementReads = 0
        val changing = object : AbstractList<String>() {
            override val size: Int get() = if (++sizeReads == 1) 2 else Int.MAX_VALUE
            override fun get(index: Int): String { elementReads++; return "Choice $index" }
            override fun iterator(): Iterator<String> = error("must never traverse an unbounded iterator")
        }
        val state = ChannelPollState.unprovisioned(scope).localPreview("Question", changing, false)
        assertEquals(1, sizeReads)
        assertEquals(2, elementReads)
        assertEquals(2, state.options.size)
        for (failure in listOf(IndexOutOfBoundsException(), ConcurrentModificationException())) {
            val shrinking = object : AbstractList<String>() {
                override val size: Int = 2
                override fun get(index: Int): String = throw failure
            }
            refuses(ChannelPollError.INVALID_POLL) {
                ChannelPollState.unprovisioned(scope).localPreview("Question", shrinking, false)
            }
        }
    }
    @Test fun singleChoiceReplacesAndRepeatedSelectionNeverDoubleCounts() {
        val empty = preview()
        assertEquals(0, empty.totalVotes)
        assertTrue(empty.options.all { it.percentage == 0 && it.voteCount == 0 && !it.isSelectedByCurrentUser })
        val first = empty.togglingOption(0)
        val repeated = first.togglingOption(0)
        assertEquals(first.options, repeated.options)
        assertEquals(1, repeated.totalVotes)
        val changed = repeated.togglingOption(2)
        assertEquals(listOf(false, false, true), changed.options.map { it.isSelectedByCurrentUser })
        assertEquals(listOf(0, 0, 100), changed.options.map { it.percentage })
        assertEquals(0, empty.totalVotes)
    }
    @Test fun multipleChoiceCountsOneVoterAndLastDeselectionRemovesBallot() {
        val selected = preview(true).togglingOption(0).togglingOption(1)
        assertEquals(1, selected.totalVotes)
        assertEquals(listOf(100, 100, 0), selected.options.map { it.percentage })
        assertEquals(200, selected.options.sumOf { it.percentage })
        val last = selected.togglingOption(0).togglingOption(1)
        assertEquals(0, last.totalVotes)
        assertTrue(last.options.all { it.voteCount == 0 && it.percentage == 0 })
        assertEquals(1, selected.totalVotes)
    }
    @Test fun roundingMatchesIndependentReferenceAndRejectsUnboundedCounts() {
        assertEquals(33, ChannelPollState.percentage(1, 3))
        assertEquals(67, ChannelPollState.percentage(2, 3))
        assertEquals(13, ChannelPollState.percentage(1, 8))
        assertEquals(0, ChannelPollState.percentage(0, 0))
        for (total in 1..512) for (count in 0..total) {
            val actual = ChannelPollState.percentage(count, total)
            assertEquals((100.0 * count / total).roundToInt(), actual)
            assertTrue(actual in 0..100)
        }
        for ((count, total) in listOf(-1 to 1, 1 to 0, 2 to 1, 0 to -1, 1 to 513, Int.MAX_VALUE to 512, 0 to Int.MAX_VALUE)) {
            refuses(ChannelPollError.INVALID_COUNTS) { ChannelPollState.percentage(count, total) }
        }
    }
    @Test fun invalidVotesAndClosedMutationsCannotChangeResults() {
        val state = preview(true).togglingOption(1)
        val before = state.options
        for (id in listOf(Int.MIN_VALUE, -1, 3, Int.MAX_VALUE)) {
            refuses(ChannelPollError.INVALID_OPTION) { state.togglingOption(id) }
            assertEquals(before, state.options)
        }
        val closed = state.closing()
        assertTrue(closed.isClosed)
        refuses(ChannelPollError.CLOSED) { closed.togglingOption(0) }
        refuses(ChannelPollError.CLOSED) { closed.closing() }
        assertEquals(before, closed.options)
        assertEquals(1, closed.totalVotes)
    }
    @Test fun unavailableAndStoppedStatesHaveNoPollAndCannotVote() {
        for (state in listOf(ChannelPollState.unprovisioned(scope), ChannelPollState.stopped(scope))) {
            assertTrue(state.options.isEmpty()); assertEquals("", state.question); assertEquals(0, state.totalVotes)
            refuses(ChannelPollError.NOT_PREVIEWING) { state.togglingOption(0) }
            refuses(ChannelPollError.NOT_PREVIEWING) { state.closing() }
        }
        refuses(ChannelPollError.STOPPED) { ChannelPollState.stopped(scope).localPreview("Question", listOf("A", "B"), false) }
    }
}
