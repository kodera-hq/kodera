package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test

class CoreProximityClientTests {
    private val workspace = "11111111-1111-4111-8111-111111111111"
    private val valid = """{"workspace_id":"$workspace","event_scope":"default","epoch_mac_key":"${"ab".repeat(32)}","epoch":2000,"epoch_expires_at":1800900,"epoch_rotation_seconds":900}"""

    @Test fun bootstrapUsesBoundedPostAndOneRefreshWithSameBody() {
        val tokens = FakeTokens()
        WireFixture(reply = { request ->
            WireReply(if (request.headers["authorization"] == "Bearer synthetic-access-1") 401 else 200,
                valid.toByteArray(), listOf("Content-Type" to "application/json"))
        }).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                val material = CoreProximityClient(requester) { 1_800_000L }.bootstrap(workspace)
                assertNotNull(material)
                assertEquals(workspace, material!!.workspaceId)
                assertArrayEquals(ByteArray(32) { 0xab.toByte() }, material.epochMacKey)
                assertEquals(1_800_900L, material.epochExpiresAtUnixSeconds)
                assertEquals(listOf("POST", "POST"), wire.requests.map { it.method })
                assertEquals(listOf("/api/v1/proximity/bootstrap", "/api/v1/proximity/bootstrap"), wire.requests.map { it.target })
                assertArrayEquals(wire.requests[0].body, wire.requests[1].body)
                assertEquals(1, tokens.forcedRefreshes.get())
                assertEquals("ProximityBootstrap(<redacted>)", material.toString())
            }
        }
    }

    @Test fun bootstrapRefusesCrossWorkspaceWeakKeysUnknownFieldsAndWrongEpochTypes() {
        val changes = listOf(
            valid.replace(workspace, "22222222-2222-4222-8222-222222222222"),
            valid.replace("default", "other"), valid.replace("ab".repeat(32), "00".repeat(32)),
            valid.replace("ab".repeat(32), "AB".repeat(32)), valid.replace("ab".repeat(32), "ab"),
            valid.replace(":900", ":901"), valid.replace(":2000", ":true"), valid.replace(":2000", ":-1"),
            valid.replace(":2000", ":1.5"), valid.replace("}", ",\"extra\":true}"),
            valid.replace("}", ",\"epoch\":2001}"),
            valid.replace(":2000", ":2001"), valid.replace(":2000", ":1999"),
            valid.replace(":1800900", ":1800901"), valid.replace(":1800900", ":1800000"),
            valid.replace("epoch_mac_key", "workspace_beacon_key"),
        )
        changes.forEach { changed ->
            assertThrows(DiscoveryDecodingException::class.java) { CoreProximityClient.decode(changed.toByteArray(), workspace, 1_800_000L) }
        }
    }

    @Test fun oversizePostIsRefusedBeforeAnyTokenOrNetworkCall() {
        val tokens = FakeTokens()
        WireFixture(reply = { WireReply(200) }).use { wire ->
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                assertEquals(CoreReply.Unsendable, requester.post("/api/v1/proximity/bootstrap", ByteArray(65_537)) { it.code })
                assertEquals(0, tokens.requested.get())
                assertTrue(wire.requests.isEmpty())
            }
        }
    }
}
