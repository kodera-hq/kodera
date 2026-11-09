package io.kodera.android.client

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/me`'s own mapping. The bearer, the 401 and 403 policy and the transport are [CoreRequester]'s, and
 * [CoreRequesterTests] prove them.
 */
class CoreMeClientTests {
    private val member = """{
        "id": "11111111-2222-4333-8444-555555555555",
        "email": "member@example.test",
        "display_name": "Synthetic Member",
        "locale": "fr",
        "staff": false,
        "identities": [],
        "organisations": [{
            "organisation": {"id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f", "slug": "kodera-dev", "name": "Synthetic organisation", "realm": "kodera-dev"},
            "membership_id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
            "role": "org_member",
            "state": "active"
        }]
    }"""
    private val headers = listOf("Content-Type" to "application/json", "Cache-Control" to "no-store")

    private fun memberObject(): JsonObject = JsonParser.parseString(member).asJsonObject
    private fun ok(body: String) = WireReply(200, body.toByteArray(), headers)
    private fun status(code: Int) = WireReply(code, """{"type":"about:blank","status":$code}""".toByteArray(),
        listOf("Content-Type" to "application/problem+json"))

    private fun fetch(tokens: FakeTokens, reply: (RecordedRequest) -> WireReply): Pair<MeOutcome, List<RecordedRequest>> =
        WireFixture(reply = reply).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), 2000).use { requester ->
                CoreMeClient(requester).fetch() to wire.requests.toList()
            }
        }

    @Test fun testSuccessMapsTheMemberAndSendsTheBearerToken() {
        val tokens = FakeTokens()
        val (outcome, requests) = fetch(tokens) { ok(member) }
        val profile = (outcome as MeOutcome.Member).profile
        assertEquals("Synthetic Member", profile.displayName)
        assertEquals("member@example.test", profile.email)
        assertEquals("Synthetic organisation", profile.organisation("kodera-dev")?.name)
        assertEquals(null, profile.organisation("other-org"))
        val request = requests.single()
        assertEquals("GET", request.method)
        assertEquals("/api/v1/me", request.target)
        assertEquals("core.test", request.headers["host"])
        assertEquals("Bearer synthetic-access-1", request.headers["authorization"])
        assertEquals("no-store", request.headers["cache-control"])
        for (name in listOf("cookie", "if-none-match", "proxy-authorization")) assertTrue(name, name !in request.headers)
        assertEquals(0, tokens.forcedRefreshes.get())
    }

    @Test fun testNullDisplayNameAndRealmAreAccepted() {
        val body = memberObject().apply {
            add("display_name", JsonNull.INSTANCE)
            getAsJsonArray("organisations")[0].asJsonObject.getAsJsonObject("organisation").add("realm", JsonNull.INSTANCE)
        }
        val profile = (fetch(FakeTokens()) { ok(body.toString()) }.first as MeOutcome.Member).profile
        assertEquals(null, profile.displayName)
        assertEquals(null, profile.organisations.single().realm)
    }

    @Test fun testAnEmptyDisplayNameIsNoName() {
        val body = memberObject().apply { addProperty("display_name", "") }
        assertEquals(null, (fetch(FakeTokens()) { ok(body.toString()) }.first as MeOutcome.Member).profile.displayName)
    }

    @Test fun testMalformedBodiesAreProtocolViolations() {
        fun mutated(edit: JsonObject.() -> Unit) = memberObject().apply(edit).toString()
        fun organisation(edit: JsonObject.() -> Unit) = mutated {
            getAsJsonArray("organisations")[0].asJsonObject.getAsJsonObject("organisation").edit()
        }
        val bodies = listOf(
            "not json", "[]", "{}", """{"id":1}""", member.replaceFirst("{", "{\"id\":\"x\",") /* duplicate key */,
            mutated { addProperty("id", "11111111-2222-4333-8444-55555555555") },
            mutated { addProperty("id", "11111111-2222-4333-8444-AAAAAAAAAAAA") },
            mutated { addProperty("email", "no-at-sign") },
            mutated { remove("email") },
            mutated { addProperty("display_name", "x".repeat(201)) },
            mutated { addProperty("organisations", "none") },
            mutated { add("organisations", JsonArray().apply { repeat(101) { add(memberObject().getAsJsonArray("organisations")[0]) } }) },
            organisation { addProperty("slug", "Bad_Slug") },
            organisation { addProperty("id", "not-a-uuid") },
            organisation { addProperty("name", "") },
            organisation { addProperty("realm", "r".repeat(65)) },
            mutated { getAsJsonArray("organisations")[0].asJsonObject.remove("role") },
            mutated { getAsJsonArray("organisations")[0].asJsonObject.addProperty("state", "") },
            "{\"a\":\"" + "x".repeat(70000) + "\"}",
        )
        for (body in bodies) {
            val (outcome, _) = fetch(FakeTokens()) { ok(body) }
            assertEquals(body.take(80), MeOutcome.Unavailable(MeFailure.ProtocolViolation), outcome)
        }
    }

    @Test fun testStatusesMapToWhatTheAppShows() {
        for ((code, failure) in listOf(403 to MeFailure.Forbidden, 429 to MeFailure.ServiceUnavailable,
                500 to MeFailure.ServiceUnavailable, 503 to MeFailure.ServiceUnavailable, 304 to MeFailure.ProtocolViolation,
                404 to MeFailure.ProtocolViolation)) {
            val tokens = FakeTokens()
            val (outcome, _) = fetch(tokens) { status(code) }
            assertEquals("$code", MeOutcome.Unavailable(failure), outcome)
            assertEquals(0, tokens.signOuts.get())
        }
    }

    /** The requester's session outcomes reach the app unchanged. */
    @Test fun testSessionOutcomesMapThrough() {
        assertEquals(MeOutcome.SignedOut, fetch(FakeTokens()) { status(401) }.first)
        assertEquals(MeOutcome.SignedOut, fetch(FakeTokens(refusesRefresh = true)) { status(401) }.first)
        assertEquals(MeOutcome.Unavailable(MeFailure.IdentityUnavailable), fetch(FakeTokens(unavailable = true)) { ok(member) }.first)
        assertEquals(MeOutcome.Unavailable(MeFailure.ProtocolViolation), fetch(FakeTokens(prefix = "synthetic\naccess-")) { ok(member) }.first)
    }

    @Test fun testRedirectIsNeverFollowedWithTheToken() {
        val (outcome, requests) = fetch(FakeTokens()) {
            WireReply(302, ByteArray(0), listOf("Location" to "https://core.test/elsewhere"))
        }
        assertEquals(MeOutcome.Unavailable(MeFailure.ProtocolViolation), outcome)
        assertEquals(1, requests.size)
    }

    @Test fun testOfflineIsATransportFailure() {
        // The fixture is closed before the call: nothing listens on its port any more.
        val route = WireFixture().use { it.route() }
        CoreRequester("https://core.test", FakeTokens(), route, 1000).use { requester ->
            val outcome = CoreMeClient(requester).fetch()
            assertTrue("$outcome", outcome is MeOutcome.Unavailable && outcome.failure is MeFailure.Transport)
        }
    }
    @Test fun testNilMemberAndOrganisationAreRefusedThroughTheRequester() {
        val nil = "00000000-0000-0000-0000-000000000000"
        val invalid = listOf(
            memberObject().apply { addProperty("id", nil) },
            memberObject().apply { getAsJsonArray("organisations")[0].asJsonObject
                .getAsJsonObject("organisation").addProperty("id", nil) })
        for (body in invalid) {
            val (outcome, requests) = fetch(FakeTokens()) { ok(body.toString()) }
            assertEquals(MeOutcome.Unavailable(MeFailure.ProtocolViolation), outcome)
            assertEquals(1, requests.size)
        }
    }

}
