package io.kodera.android.client

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreWorkspaceClientTests {
    private val organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    private val otherOrganisation = "11111111-2222-4333-8444-555555555555"
    private val workspaceId = "0192f3a4-5b6c-7d8e-9f01-23456789abcd"
    private val categoryId = "0192f3a4-5b6c-7d8e-9f01-23456789abce"
    private val channelId = "0192f3a4-5b6c-7d8e-9f01-23456789abcf"
    private val secondChannelId = "0192f3a4-5b6c-7d8e-9f01-23456789abd0"
    private val thirdChannelId = "0192f3a4-5b6c-7d8e-9f01-23456789abd1"
    private val headers = listOf("Content-Type" to "application/json", "Cache-Control" to "no-store",
        "ETag" to "\"synthetic-view\"")

    private fun tree(): JsonObject = JsonParser.parseString("""{
        "organisation_id":"$organisation", "state":"initialised",
        "setup":{"state":"ready","reason":null}, "can_initialise":false, "id":"$workspaceId",
        "categories":[{"id":"$categoryId","name":"Stored category","template_key":"future_section",
            "channels":[{"id":"$channelId","kind":"text","name":"Stored channel","template_key":"general",
                "topic":"A topic","lifecycle":"active","room_state":"ready"},
                {"id":"$secondChannelId","kind":"audio","name":"Lounge","template_key":null,
                "topic":"","lifecycle":"archived","room_state":"pending"}]}],
        "uncategorised_channels":[{"id":"$thirdChannelId","kind":"text","name":"Elsewhere","template_key":null,
            "topic":"","lifecycle":"active","room_state":"failed"}]
    }""").asJsonObject

    private fun uninitialised(): JsonObject = tree().apply {
        addProperty("state", "not_initialised"); add("id", JsonNull.INSTANCE)
        add("categories", JsonArray()); add("uncategorised_channels", JsonArray())
    }

    private fun JsonObject.firstCategory(): JsonObject = getAsJsonArray("categories")[0].asJsonObject
    private fun JsonObject.firstChannel(): JsonObject = firstCategory().getAsJsonArray("channels")[0].asJsonObject
    private fun decode(value: JsonObject) = CoreWorkspaceClient.decode(value.toString().toByteArray(), organisation)
    private fun refused(value: JsonObject) = assertThrows(DiscoveryDecodingException::class.java) { decode(value) }
    private fun ok(value: JsonObject = tree()) = WireReply(200, value.toString().toByteArray(), headers)
    private fun status(code: Int) = WireReply(code, ByteArray(0))

    /** Pad a complete valid Workspace with legal JSON whitespace, measuring UTF-8 bytes first. */
    private fun paddedWorkspace(size: Int): ByteArray {
        val body = tree().apply { firstChannel().addProperty("topic", "UTF-8: \u00E9 \uD83D\uDE00") }
            .toString().toByteArray(Charsets.UTF_8)
        require(size >= body.size)
        return body.copyOf(size).apply { fill(' '.code.toByte(), fromIndex = body.size) }
    }

    private fun fetch(tokens: FakeTokens = FakeTokens(), reply: (RecordedRequest) -> WireReply): Pair<WorkspaceOutcome, List<RecordedRequest>> =
        WireFixture(reply = reply).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                CoreWorkspaceClient(requester).fetch(organisation) to wire.requests.toList()
            }
        }

    @Test fun testTheReadPreservesTheFilteredTreeWithoutProviderAuthority() {
        val tree = decode(tree())
        assertEquals(organisation, tree.organisationId)
        assertEquals(workspaceId, tree.id)
        assertEquals(WorkspaceState.INITIALISED, tree.state)
        assertEquals(WorkspaceSetup(WorkspaceSetupState.READY, null), tree.setup)
        assertFalse(tree.canInitialise)
        val category = tree.categories.single()
        assertEquals(categoryId, category.id)
        assertEquals("Stored category", category.name)
        assertEquals("future_section", category.templateKey) // template identifiers are an open set
        assertEquals(listOf(channelId, secondChannelId), category.channels.map { it.id })
        val first = category.channels.first()
        assertEquals(ChannelKind.TEXT, first.kind)
        assertEquals("Stored channel", first.name)
        assertEquals("general", first.templateKey)
        assertEquals("A topic", first.topic)
        assertEquals(WorkspaceChannelLifecycle.ACTIVE, first.lifecycle)
        assertEquals(ChannelRoomState.READY, first.roomState)
        val second = category.channels.last()
        assertEquals(ChannelKind.AUDIO, second.kind)
        assertEquals(null, second.templateKey)
        assertEquals(WorkspaceChannelLifecycle.ARCHIVED, second.lifecycle)
        assertEquals(ChannelRoomState.PENDING, second.roomState)
        assertEquals(thirdChannelId, tree.uncategorisedChannels.single().id)
        assertEquals(ChannelRoomState.FAILED, tree.uncategorisedChannels.single().roomState)
    }

    @Test fun testUninitialisedAndInitialisedEmptyViewsRemainDistinct() {
        val notStarted = decode(uninitialised().apply { addProperty("can_initialise", true) })
        assertEquals(WorkspaceState.NOT_INITIALISED, notStarted.state)
        assertEquals(null, notStarted.id)
        assertTrue(notStarted.canInitialise)
        assertTrue(notStarted.categories.isEmpty())
        assertTrue(notStarted.uncategorisedChannels.isEmpty())
        val empty = decode(tree().apply { add("categories", JsonArray()); add("uncategorised_channels", JsonArray()) })
        assertEquals(WorkspaceState.INITIALISED, empty.state)
        assertEquals(workspaceId, empty.id)
        assertTrue(empty.categories.isEmpty())
    }

    @Test fun testEverySetupStateAndDocumentedReasonIsPreserved() {
        for ((state, expected) in listOf("pending" to WorkspaceSetupState.PENDING, "running" to WorkspaceSetupState.RUNNING,
                "ready" to WorkspaceSetupState.READY, "failed" to WorkspaceSetupState.FAILED)) {
            assertEquals(WorkspaceSetup(expected, null), decode(uninitialised().apply {
                getAsJsonObject("setup").addProperty("state", state)
            }).setup)
        }
        for ((reason, state, expected) in listOf(
                Triple("awaiting_owner_confirmation", "pending", WorkspaceSetupReason.AWAITING_OWNER_CONFIRMATION),
                Triple("issuer_untrusted", "failed", WorkspaceSetupReason.ISSUER_UNTRUSTED),
                Triple("realm_job_failed", "failed", WorkspaceSetupReason.REALM_JOB_FAILED))) {
            assertEquals(expected, decode(uninitialised().apply {
                getAsJsonObject("setup").apply { addProperty("state", state); addProperty("reason", reason) }
            }).setup.reason)
        }
    }

    @Test fun testTheReturnedOrganisationMustBeTheRequestedOne() {
        refused(tree().apply { addProperty("organisation_id", otherOrganisation) })
        assertThrows(DiscoveryDecodingException::class.java) {
            CoreWorkspaceClient.decode(tree().toString().toByteArray(), "not-an-id")
        }
    }

    @Test fun testUnknownRoomStateIsRefusedInsteadOfBecomingReady() {
        refused(tree().apply { firstChannel().addProperty("room_state", "new-state") })
    }

    @Test fun testRequiredFieldsAndAdditionalPropertiesAreEnforcedAtEveryLevel() {
        val levels: List<(JsonObject) -> JsonObject> = listOf({ it }, { it.getAsJsonObject("setup") },
            { it.firstCategory() }, { it.firstChannel() })
        for (level in levels) {
            val keys = level(tree()).keySet().toList()
            for (key in keys) refused(tree().apply { level(this).remove(key) })
            refused(tree().apply { level(this).addProperty("unexpected", "not-a-contract-field") })
        }
    }

    @Test fun testClosedEnumsTypesAndIdentityFieldsAreStrict() {
        val changes: List<JsonObject.() -> Unit> = listOf(
            { addProperty("organisation_id", "bad") }, { addProperty("id", "bad") },
            { addProperty("state", "future") }, { addProperty("can_initialise", "false") },
            { getAsJsonObject("setup").addProperty("state", "future") },
            { getAsJsonObject("setup").addProperty("reason", "future") },
            { getAsJsonObject("setup").addProperty("reason", false) },
            { addProperty("categories", "none") }, { addProperty("uncategorised_channels", false) },
            { firstCategory().addProperty("id", "bad") }, { firstCategory().addProperty("channels", "none") },
            { firstChannel().addProperty("id", "bad") }, { firstChannel().addProperty("kind", "video") },
            { firstChannel().addProperty("lifecycle", "deleted") },
            { firstChannel().add("topic", JsonNull.INSTANCE) }, { firstChannel().addProperty("name", 1) },
            { firstCategory().addProperty("template_key", "Bad-Key") },
            { firstChannel().addProperty("template_key", "a".repeat(33)) },
            { firstChannel().addProperty("template_key", false) },
        )
        for (change in changes) refused(tree().apply(change))
    }

    @Test fun testContradictoryWorkspaceAndSetupStatesAreRefused() {
        refused(uninitialised().apply { addProperty("id", workspaceId) })
        refused(tree().apply { addProperty("state", "not_initialised"); add("id", JsonNull.INSTANCE) })
        refused(tree().apply { add("id", JsonNull.INSTANCE) })
        refused(tree().apply { addProperty("can_initialise", true) })
        refused(uninitialised().apply {
            addProperty("can_initialise", true); getAsJsonObject("setup").addProperty("state", "running")
        })
        refused(tree().apply { getAsJsonObject("setup").addProperty("reason", "awaiting_owner_confirmation") })
        refused(tree().apply { getAsJsonObject("setup").addProperty("reason", "issuer_untrusted") })
    }

    @Test fun testNamesAndTopicsUseUnicodeScalarBoundsWithoutChangingStoredText() {
        val hundred = "\uD83D\uDE00".repeat(100)
        val topic = "\uD83D\uDE00".repeat(1024)
        val result = decode(tree().apply {
            firstCategory().addProperty("name", hundred); firstCategory().add("template_key", JsonNull.INSTANCE)
            firstChannel().addProperty("name", "  Stored text  "); firstChannel().addProperty("topic", topic)
        })
        assertEquals(hundred, result.categories.single().name)
        assertEquals(null, result.categories.single().templateKey)
        assertEquals("  Stored text  ", result.categories.single().channels.first().name)
        assertEquals(topic, result.categories.single().channels.first().topic)
        for (name in listOf("", " \t", hundred + "x")) {
            refused(tree().apply { firstCategory().addProperty("name", name) })
            refused(tree().apply { firstChannel().addProperty("name", name) })
        }
        refused(tree().apply { firstChannel().addProperty("topic", topic + "x") })
    }

    @Test fun testMalformedAndDuplicateBodiesProduceNoPartialSnapshot() {
        val body = tree().toString()
        for (raw in listOf("not json", "[]", "{}", body + " {}",
                body.replaceFirst("{", "{\"state\":\"initialised\","),
                body.replace("\"topic\":\"A topic\"", "\"topic\":\"A topic\",\"topic\":\"other\""))) {
            assertThrows(DiscoveryDecodingException::class.java) {
                CoreWorkspaceClient.decode(raw.toByteArray(), organisation)
            }
        }
    }

    @Test fun testValidWorkspaceByteBoundaryIsEnforcedByTheDecoder() {
        val withinLimit = paddedWorkspace(65_536)
        val overLimit = paddedWorkspace(65_537)
        assertEquals(65_536, withinLimit.size)
        assertEquals(65_537, overLimit.size)
        val result = CoreWorkspaceClient.decode(withinLimit, organisation)
        assertEquals(organisation, result.organisationId)
        assertEquals(channelId, result.categories.single().channels.first().id)
        assertEquals("UTF-8: \u00E9 \uD83D\uDE00", result.categories.single().channels.first().topic)
        assertThrows(DiscoveryDecodingException::class.java) {
            CoreWorkspaceClient.decode(overLimit, organisation)
        }
    }

    @Test fun testValidWorkspaceByteBoundaryIsEnforcedThroughTransport() {
        for (size in listOf(65_536, 65_537)) {
            val body = paddedWorkspace(size)
            assertEquals(size, body.size)
            val (outcome, requests) = fetch { WireReply(200, body, headers, chunked = true) }
            assertEquals(1, requests.size)
            if (size == 65_536) {
                val workspace = (outcome as WorkspaceOutcome.Loaded).workspace
                assertEquals(organisation, workspace.organisationId)
                assertEquals(channelId, workspace.categories.single().channels.first().id)
                assertEquals("UTF-8: \u00E9 \uD83D\uDE00", workspace.categories.single().channels.first().topic)
            } else {
                // The otherwise-valid tree must not be returned, even partially, past the byte cap.
                assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation), outcome)
            }
        }
    }

    @Test fun testDecodedListsCannotBeMutatedByAnotherConsumer() {
        val result = decode(tree())
        assertThrows(UnsupportedOperationException::class.java) { (result.categories as MutableList<*>).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (result.categories.single().channels as MutableList<*>).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (result.uncategorisedChannels as MutableList<*>).clear() }
    }

    @Test fun testInvalidOrganisationIsRefusedBeforeAnyTokenOrRequest() {
        val tokens = FakeTokens()
        WireFixture().use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                for (id in listOf("bad", "00000000-0000-0000-0000-000000000000", "$organisation/../other", "$organisation%2fother", organisation.uppercase())) {
                    assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation), CoreWorkspaceClient(requester).fetch(id))
                }
                assertEquals(0, tokens.requested.get())
                assertTrue(wire.requests.isEmpty())
            }
        }
    }

    @Test fun testUnconditionalGetUsesOnlyTheSessionRequesterAndDoesNotReuseAView() = withGlobalSpies { spies ->
        val tokens = FakeTokens()
        WireFixture(reply = { request ->
            if (request.headers["authorization"] == "Bearer synthetic-access-1") ok()
            else status(404)
        }).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                val client = CoreWorkspaceClient(requester)
                assertTrue(client.fetch(organisation) is WorkspaceOutcome.Loaded)
                assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.NotFound), client.fetch(organisation))
                assertEquals(2, wire.requests.size)
                for (request in wire.requests) {
                    assertEquals("GET", request.method)
                    assertEquals("/api/v1/organisations/$organisation/workspace", request.target)
                    assertEquals("core.test", request.headers["host"])
                    assertEquals("no-store", request.headers["cache-control"])
                    assertTrue(request.body.isEmpty())
                    for (header in listOf("if-none-match", "if-modified-since", "cookie", "proxy-authorization")) {
                        assertFalse(header, header in request.headers)
                    }
                }
                assertEquals(2, tokens.requested.get())
                assertEquals(0, tokens.forcedRefreshes.get())
            }
        }
        spies.assertUnused()
    }

    @Test fun testUnsolicited304IsNeverAnEmptyAuthorisedWorkspace() {
        val (outcome, requests) = fetch { status(304) }
        assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation), outcome)
        assertEquals(1, requests.size)
    }

    @Test fun testStatusFailuresAreSafeAndNeverRetried() {
        for ((code, failure) in listOf(403 to WorkspaceFailure.Forbidden, 404 to WorkspaceFailure.NotFound,
                429 to WorkspaceFailure.ServiceUnavailable, 500 to WorkspaceFailure.ServiceUnavailable,
                503 to WorkspaceFailure.ServiceUnavailable, 204 to WorkspaceFailure.ProtocolViolation)) {
            val tokens = FakeTokens()
            val (outcome, requests) = fetch(tokens) { status(code) }
            assertEquals("$code", WorkspaceOutcome.Unavailable(failure), outcome)
            assertEquals(1, requests.size)
            assertEquals(0, tokens.forcedRefreshes.get())
            assertEquals(0, tokens.signOuts.get())
        }
    }

    @Test fun test401RefreshesOnceAndASecond401EndsOnlyTheServingSession() {
        val refreshed = FakeTokens()
        val (success, requests) = fetch(refreshed) { request ->
            if (request.headers["authorization"] == "Bearer synthetic-access-1") status(401) else ok()
        }
        assertTrue(success is WorkspaceOutcome.Loaded)
        assertEquals(2, requests.size)
        assertEquals(1, refreshed.forcedRefreshes.get())
        assertEquals(0, refreshed.signOuts.get())
        val refused = FakeTokens()
        val (ended, refusals) = fetch(refused) { status(401) }
        assertEquals(WorkspaceOutcome.SignedOut, ended)
        assertEquals(2, refusals.size)
        assertEquals(1, refused.signOuts.get())
        assertEquals(102L, refused.ended.single().session)
    }

    @Test fun testRequesterFailuresPassThroughWithoutAnAnonymousFallback() {
        val unavailable = FakeTokens(unavailable = true)
        val (outcome, requests) = fetch(unavailable) { ok() }
        assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.IdentityUnavailable), outcome)
        assertTrue(requests.isEmpty())
        assertEquals(WorkspaceOutcome.SignedOut, fetch(FakeTokens(refusesRefresh = true)) { status(401) }.first)
        assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation),
            fetch(FakeTokens(prefix = "synthetic\naccess-")) { ok() }.first)
        WireFixture().use { wire ->
            val tokens = FakeTokens()
            val requester = CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS)
            requester.close()
            assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.Transport(TransportFailure.OTHER)),
                CoreWorkspaceClient(requester).fetch(organisation))
            assertEquals(0, tokens.requested.get())
            assertTrue(wire.requests.isEmpty())
        }
    }

    @Test fun testRedirectAndBadWireBodyCannotBecomeAWorkspace() {
        val (redirect, requests) = fetch { WireReply(302, ByteArray(0), listOf("Location" to "https://other.test/tree")) }
        assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation), redirect)
        assertEquals(1, requests.size)
        assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation),
            fetch { WireReply(200, "not json".toByteArray(), headers) }.first)
    }
    @Test fun testNilWorkspaceCategoryAndChannelEntitiesAreRefused() {
        val nil = "00000000-0000-0000-0000-000000000000"
        for (edit in listOf<JsonObject.() -> Unit>(
            { addProperty("organisation_id", nil) }, { addProperty("id", nil) },
            { firstCategory().addProperty("id", nil) }, { firstChannel().addProperty("id", nil) },
            { getAsJsonArray("uncategorised_channels")[0].asJsonObject.addProperty("id", nil) })) {
            val (outcome, requests) = fetch { ok(tree().apply(edit)) }
            assertEquals(WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation), outcome)
            assertEquals(1, requests.size)
        }
    }

}
