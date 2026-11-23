package io.kodera.android.client

import io.kodera.android.domain.AttachmentMimeType
import io.kodera.android.domain.KoderaMobileFfiBridge
import io.kodera.android.domain.KoderaMobileFfiError
import io.kodera.android.domain.KoderaMobileFfiFailure
import io.kodera.android.domain.LoopbackPolicy
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

class MatrixRoomAndWakeupTests {
    private val orgId = "00000000-0000-4000-8000-000000000001"
    private val channelId = "00000000-0000-4000-8000-000000000010"
    private val deviceId = "01935800-0000-7000-8000-000000000042"
    private val attachmentId = "01935800-0000-7000-8000-000000000077"
    private val txn1 = "01935651-787b-7102-8304-05060708090a"
    private val txn2 = "01935651-787b-7102-8304-05060708090b"
    private val roomId = "!roomAlpha:atelier.matrix.kodera.io"

    @Test
    fun transportBootstrapUsesInjectedWorkspaceAndPreservesConfidentiality() {
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
            for (confidentiality in listOf(false, true, null)) {
                val channel = WorkspaceChannel(
                    channelId, io.kodera.android.domain.ChannelKind.TEXT, "general", null, "",
                    WorkspaceChannelLifecycle.ACTIVE, io.kodera.android.domain.ChannelRoomState.READY,
                    confidentiality,
                )
                val snapshot = WorkspaceSnapshot(
                    orgId, WorkspaceState.INITIALISED, WorkspaceSetup(WorkspaceSetupState.READY, null),
                    false, "00000000-0000-4000-8000-000000000020", emptyList(), listOf(channel),
                )
                val requests = mutableListOf<String>()
                val stub = MatrixHttpStub { request ->
                    val path = java.net.URI(request.url).path
                    requests += path
                    when {
                        path == "/.well-known/matrix/client" -> MatrixHttpReply(404)
                        path.startsWith("/_matrix/client/v3/directory/room/") ->
                            MatrixHttpReply(200, """{"room_id":"$roomId"}""".toByteArray())
                        path.endsWith("/join") -> MatrixHttpReply(200, """{"room_id":"$roomId"}""".toByteArray())
                        path == "/_matrix/client/v3/sync" -> MatrixHttpReply(200,
                            """{"next_batch":"s1","rooms":{"join":{"$roomId":{"state":{"events":[]},"timeline":{"events":[]}}}}}""".toByteArray())
                        else -> error("Unexpected Matrix request: $path")
                    }
                }
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, httpStub = stub).use { client ->
                    MatrixChannelConversationTransport(
                        ownUserId = "@member:atelier.matrix.kodera.io", roomClient = client,
                        organisationSlug = "atelier", matrixDomain = "matrix.kodera.io",
                        matrixServerName = "atelier.matrix.kodera.io", matrixAccessToken = "token",
                        fetchWorkspace = { requestedOrg ->
                            assertEquals(orgId, requestedOrg)
                            WorkspaceOutcome.Loaded(snapshot)
                        },
                    ).use { transport ->
                        val boot = transport.bootstrapRoom(orgId, channelId)
                        assertEquals(roomId, boot.roomId)
                        assertEquals(confidentiality == false, roomId in boot.initialBatch.plaintextAllowedRooms)
                        assertEquals(4, requests.size)
                    }
                }
            }
        }
    }

    @Test
    fun injectedWorkspaceAuthorityFailuresStopBootstrapBeforeHTTP() {
        val archived = WorkspaceChannel(
            channelId, io.kodera.android.domain.ChannelKind.TEXT, "general", null, "",
            WorkspaceChannelLifecycle.ARCHIVED, io.kodera.android.domain.ChannelRoomState.READY, false,
        )
        val snapshot = WorkspaceSnapshot(
            orgId, WorkspaceState.INITIALISED, WorkspaceSetup(WorkspaceSetupState.READY, null),
            false, "00000000-0000-4000-8000-000000000020", emptyList(), listOf(archived),
        )
        val cases = listOf(
            WorkspaceOutcome.SignedOut to MatrixClientError.SIGNED_OUT,
            WorkspaceOutcome.Unavailable(WorkspaceFailure.Forbidden) to MatrixClientError.FORBIDDEN,
            WorkspaceOutcome.Unavailable(WorkspaceFailure.NotFound) to MatrixClientError.NOT_FOUND,
            WorkspaceOutcome.Unavailable(WorkspaceFailure.ServiceUnavailable) to MatrixClientError.SERVICE_UNAVAILABLE,
            WorkspaceOutcome.Unavailable(WorkspaceFailure.IdentityUnavailable) to MatrixClientError.IDENTITY_UNAVAILABLE,
            WorkspaceOutcome.Unavailable(WorkspaceFailure.ProtocolViolation) to MatrixClientError.PROTOCOL_VIOLATION,
            WorkspaceOutcome.Loaded(snapshot) to MatrixClientError.FORBIDDEN,
        )
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
            MatrixRoomClient(requester, LoopbackPolicy.REFUSE,
                httpStub = MatrixHttpStub { error("Authority failure must stop before HTTP") },
            ).use { client ->
                for ((outcome, expected) in cases) {
                    MatrixChannelConversationTransport(
                        ownUserId = "@member:atelier.matrix.kodera.io", roomClient = client,
                        organisationSlug = "atelier", matrixDomain = "matrix.kodera.io",
                        matrixServerName = "atelier.matrix.kodera.io", matrixAccessToken = "token",
                        fetchWorkspace = { outcome },
                    ).let { transport ->
                        val failure = assertThrows(MatrixClientException::class.java) {
                            transport.bootstrapRoom(orgId, channelId)
                        }
                        assertEquals(expected, failure.reason)
                    }
                }
            }
        }
    }

    @Test
    fun plaintextMutationsRefuseUnknownConfidentialAndEncryptedRoomsWithoutHTTP() {
        val origin = "https://atelier.matrix.kodera.io"
        val tokens = FakeTokens()
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, tokens).use { requester ->
            for (boundary in listOf("unknown", "unknown-core", "missing-state", "malformed-state", "confidential", "m.room.encryption", "io.kodera.room.security", "io.kodera.room.confidential")) {
                val requests = CopyOnWriteArrayList<Request>()
                val state = if (boundary in listOf("confidential", "unknown-core", "missing-state")) "[]" else if (boundary == "malformed-state") "[{}]" else """[{"type":"$boundary","state_key":"","content":{"algorithm":"m.megolm.v1.aes-sha2"}}]"""
                val stateField = if (boundary == "missing-state") "" else """"state":{"events":$state},"""
                val interceptor = Interceptor { chain ->
                    val req = chain.request()
                    requests += req
                    Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                        .body("""{"next_batch":"s1","rooms":{"join":{"$roomId":{${stateField}"timeline":{"events":[]}}}}}""".toResponseBody("application/json".toMediaType())).build()
                }
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, interceptor).use { client ->
                    if (boundary != "unknown") {
                        client.bindChannelSecurity(orgId, channelId, origin, roomId, if (boundary == "unknown-core") null else boundary == "confidential")
                        assertTrue(client.sync(origin, "token", roomId = roomId).plaintextAllowedRooms.isEmpty())
                    }
                    requests.clear()
                    val payload = AttachmentUploadPayload("secret.ogg", AttachmentMimeType.OGG_AUDIO, byteArrayOf(1))
                    for (operation in listOf<() -> Unit>(
                        { client.sendTextMessage(origin, "token", roomId, txn1, "secret") },
                        { client.editMessage(origin, "token", roomId, txn1, "\$event", "secret") },
                        { client.sendReaction(origin, "token", roomId, txn1, "\$event", "👍") },
                        { client.uploadChannelAttachment(orgId, channelId, payload) },
                    )) {
                        val failure = assertThrows(MatrixClientException::class.java) { operation() }
                        assertEquals(MatrixClientError.PLAINTEXT_FORBIDDEN, failure.reason)
                        assertTrue(requests.isEmpty())
                        assertEquals(0, tokens.requested.get())
                    }
                }
            }
        }
    }

    @Test
    fun syncExposesRoomAuthorityLossAndRetainsItAfterLeave() {
        val origin = "https://atelier.matrix.kodera.io"
        var rooms = """{"join":{"$roomId":{"state":{"events":[]},"timeline":{"events":[]}}}}"""
        val interceptor = Interceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"next_batch":"s1","rooms":$rooms}""".toResponseBody("application/json".toMediaType())).build()
        }
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
            MatrixRoomClient(requester, LoopbackPolicy.REFUSE, interceptor).use { client ->
                client.bindChannelSecurity(orgId, channelId, origin, roomId, false)
                assertTrue(client.sync(origin, "token", roomId = roomId).authorityLostRooms.isEmpty())
                rooms = "{}"
                assertTrue(client.sync(origin, "token", roomId = roomId, since = "one").authorityLostRooms.isEmpty())
                rooms = """{"leave":{"!other:example.org":{}}}"""
                assertTrue(client.sync(origin, "token", roomId = roomId, since = "two").authorityLostRooms.isEmpty())
                rooms = """{"leave":{"$roomId":{}}}"""
                val left = client.sync(origin, "token", roomId = roomId, since = "three")
                assertEquals(setOf(roomId), left.authorityLostRooms); assertTrue(left.plaintextAllowedRooms.isEmpty())
                rooms = "{}"
                assertEquals(setOf(roomId), client.sync(origin, "token", roomId = roomId, since = "four").authorityLostRooms)
                assertEquals(setOf(roomId), client.sync(origin, "token", roomId = roomId).authorityLostRooms)
            }
        }
    }

    @Test
    fun malformedIncrementalStateRevokesPlaintextWithoutSendHTTP() {
        val origin = "https://atelier.matrix.kodera.io"
        for (malformed in listOf("""{"events":null}""", "123", "\"bad\"", "null", """{"events":{}}""")) {
            var state = """{"events":[]}"""
            val requests = CopyOnWriteArrayList<Request>()
            val interceptor = Interceptor { chain ->
                val req = chain.request()
                requests += req
                Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body("""{"next_batch":"s1","rooms":{"join":{"$roomId":{"state":$state,"timeline":{"events":[]}}}}}""".toResponseBody("application/json".toMediaType())).build()
            }
            CoreRequester("https://core.test", LoopbackPolicy.REFUSE, FakeTokens()).use { requester ->
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, interceptor).use { client ->
                    client.bindChannelSecurity(orgId, channelId, origin, roomId, false)
                    val initial = client.sync(origin, "token", roomId = roomId)
                    assertEquals(setOf(roomId), initial.plaintextAllowedRooms)
                    state = "{}"
                    val empty = client.sync(origin, "token", roomId = roomId, since = initial.nextBatch)
                    assertEquals(setOf(roomId), empty.plaintextAllowedRooms)
                    state = malformed
                    assertEquals(MatrixClientError.PROTOCOL_VIOLATION, assertThrows(MatrixClientException::class.java) {
                        client.sync(origin, "token", roomId = roomId, since = empty.nextBatch)
                    }.reason)
                    requests.clear()
                    assertEquals(MatrixClientError.PLAINTEXT_FORBIDDEN, assertThrows(MatrixClientException::class.java) {
                        client.sendTextMessage(origin, "token", roomId, txn1, "secret")
                    }.reason)
                    assertTrue(requests.isEmpty())
                }
            }
        }
    }

    @Test
    fun joinAndScopedSyncHaveBoundedResponsesAndTypedAdmissionFailure() {
        val origin = "https://atelier.matrix.kodera.io"
        var code = 200
        var body = """{"room_id":"$roomId"}"""
        val requests = CopyOnWriteArrayList<Request>()
        val interceptor = Interceptor { chain ->
            val req = chain.request()
            requests += req
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("OK")
            .body(body.toResponseBody("application/json".toMediaType())).build()
        }
        val tokens = FakeTokens()
        CoreRequester("https://core.test", LoopbackPolicy.REFUSE, tokens).use { requester ->
            MatrixRoomClient(requester, LoopbackPolicy.REFUSE, interceptor).use { client ->
                repeat(2) { client.joinRoom(origin, "token", roomId) }
                assertEquals("POST", requests.last().method)
                assertTrue(requests.last().url.encodedPath.endsWith("/%21roomAlpha%3Aatelier.matrix.kodera.io/join"))
                code = 403
                assertEquals(MatrixClientError.FORBIDDEN, assertThrows(MatrixClientException::class.java) { client.joinRoom(origin, "token", roomId) }.reason)
                code = 200
                body = """{"next_batch":"s1","padding":"${"x".repeat(70_000)}","rooms":{"join":{"$roomId":{"state":{"events":[]},"timeline":{"events":[]}}}}}"""
                client.bindChannelSecurity(orgId, channelId, origin, roomId, false)
                assertEquals(setOf(roomId), client.sync(origin, "token", roomId = roomId).plaintextAllowedRooms)
                val filter = StrictJson.parse(requests.last().url.queryParameter("filter")!!.toByteArray(), 4096).objectValue()
                val room = (filter["room"] as JsonValue.ObjectValue).fields
                assertEquals(listOf(JsonValue.StringValue(roomId)), (room["rooms"] as JsonValue.ArrayValue).values)
                client.updateChannelSecurity(orgId, channelId, true)
                requests.clear()
                assertEquals(MatrixClientError.PLAINTEXT_FORBIDDEN, assertThrows(MatrixClientException::class.java) { client.sendTextMessage(origin, "token", roomId, txn1, "secret") }.reason)
                assertTrue(requests.isEmpty())

                body = " ".repeat(262_145)
                assertEquals(MatrixClientError.PROTOCOL_VIOLATION, assertThrows(MatrixClientException::class.java) { client.sync(origin, "token", roomId = roomId) }.reason)
            }
        }
    }


    @Test
    fun coreRoomClassificationMustBeExplicitAndConsistent() {
        val channel = """{"id":"$channelId","kind":"text","name":"general","template_key":null,"topic":"","lifecycle":"active","room_state":"ready"%s}"""
        for ((field, expected) in listOf(
            ",\"isConfidential\":false" to false,
            ",\"isConfidential\":true" to true,
            "" to null,
        )) {
            val payload = """{"organisation_id":"$orgId","state":"initialised","setup":{"state":"ready","reason":null},"can_initialise":false,"id":"00000000-0000-4000-8000-000000000020","categories":[],"uncategorised_channels":[${channel.format(field)}]}"""
            assertEquals(expected, CoreWorkspaceClient.decode(payload.toByteArray(), orgId).uncategorisedChannels.single().isConfidential)
            if (expected == false) {
                val inconsistent = payload.replace("\"isConfidential\":false", "\"isConfidential\":false,\"confidential\":true")
                assertThrows(DiscoveryDecodingException::class.java) { CoreWorkspaceClient.decode(inconsistent.toByteArray(), orgId) }
            }
        }
    }

    private class SoftwareSessionKeys(initial: ByteArray) : SessionKeys {
        private var key: SecretKey? = SecretKeySpec(initial, "AES")
        override fun existing(): SecretKey? = key
        override fun getOrCreate(): SecretKey = key ?: error("destroyed")
        override fun destroy() { key = null }
    }

    @Test
    fun rustSessionVaultPersistsKdv1WireAtomicallyAndWipesCleanly() {
        val tempDir = Files.createTempDirectory("rust-vault-test").toFile()
        try {
            val vaultFile = tempDir.resolve("session/rust-vault.bin")
            val fixtureKey = KoderaMobileFfiBridge.decodeHex(
                "0303030303030303030303030303030303030303030303030303030303030303"
            )
            val fixtureNonce = KoderaMobileFfiBridge.decodeHex("040404040404040404040404")
            val fixturePlaintext = KoderaMobileFfiBridge.decodeHex(
                "7b226d61747269785f646576696365223a224445563031222c2273796e635f6261746368223a227337325f31227d"
            )
            val expectedSealedHex =
                "4b4456310404040404040404040404043b057eacd9ec6e66c670e52818375c52ab5ecb2915f376c0044a74e84dedb63ec20d57b46369ca342e00df2d0fc950af88af858d2f28ff54f368dc958396"

            val vault = RustSessionVault(vaultFile, SoftwareSessionKeys(fixtureKey))
            assertNull(vault.open(orgId, deviceId))

            val sealed = vault.seal(orgId, deviceId, fixturePlaintext, deterministicNonceForTest = fixtureNonce)
            assertEquals(expectedSealedHex, KoderaMobileFfiBridge.encodeHex(sealed))
            assertTrue(vaultFile.isFile)
            assertArrayEquals(fixturePlaintext, vault.open(orgId, deviceId))

            val crossOrg = assertThrows(KoderaMobileFfiFailure::class.java) {
                vault.open("00000000-0000-4000-8000-000000000002", deviceId)
            }
            assertEquals(KoderaMobileFfiError.AUTHENTICATION_FAILED, crossOrg.reason)

            vault.wipe()
            assertFalse(vaultFile.exists())
            assertNull(vault.open(orgId, deviceId))

            // Key destruction failure during wipe must surface TokenStoreException ("not wiped"), never be swallowed.
            val failingVaultFile = tempDir.resolve("session/failing-vault.bin")
            val failingVault = RustSessionVault(
                failingVaultFile,
                object : SessionKeys {
                    private val inner = SecretKeySpec(fixtureKey, "AES")
                    override fun existing(): SecretKey = inner
                    override fun getOrCreate(): SecretKey = inner
                    override fun destroy() {
                        throw RuntimeException("keystore locked")
                    }
                },
            )
            failingVault.seal(orgId, deviceId, fixturePlaintext)
            assertThrows(TokenStoreException::class.java) {
                failingVault.wipe()
            }
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun coreRequesterAdmitsPaginationQueryPutAndDeleteAndRefusesInjectionBeforeTokenFetch() {
        WireFixture(reply = { req ->
            when (req.method) {
                "PUT", "DELETE" -> WireReply(status = 204, body = ByteArray(0), headers = emptyList())
                else -> WireReply(status = 200, body = """{"data":[],"has_more":false,"next_cursor":null}""".toByteArray())
            }
        }).use { wire ->
            val tokens = FakeTokens()
            CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                val getReply = requester.get(
                    path = "/api/v1/notifications",
                    query = listOf("limit" to "50", "cursor" to "sig_v1:1tGabc:token-01"),
                ) { it.code }
                assertEquals(CoreReply.Answered(200), getReply)
                assertEquals("/api/v1/notifications?limit=50&cursor=sig_v1%3A1tGabc%3Atoken-01", wire.requests.last().target)

                val putReply = requester.put("/api/v1/resource", """{"ok":true}""".toByteArray()) { it.code }
                assertEquals(CoreReply.Answered(204), putReply)
                assertEquals("PUT", wire.requests.last().method)

                val delReply = requester.delete("/api/v1/resource") { it.code }
                assertEquals(CoreReply.Answered(204), delReply)
                assertEquals("DELETE", wire.requests.last().method)
            }

            // Invalid queries must fail closed before requesting any access token.
            val badQueries = listOf(
                listOf("unknown" to "1"),
                listOf("limit" to "0"),
                listOf("limit" to "201"),
                listOf("limit" to "05"),
                listOf("limit" to "10", "limit" to "20"),
                listOf("cursor" to "abc&admin=1"),
                listOf("cursor" to "abc#frag"),
            )
            for (badQuery in badQueries) {
                val guardedTokens = FakeTokens()
                val beforeCount = wire.requests.size
                CoreRequester("https://core.test", guardedTokens, wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                    val reply = requester.get("/api/v1/notifications", badQuery) { it.code }
                    assertEquals(CoreReply.PathRefused, reply)
                }
                assertEquals(0, guardedTokens.requested.get())
                assertEquals(beforeCount, wire.requests.size)
            }
        }
    }

    @Test
    fun timelineReducerPreservesOptimisticUiKeyVerifiesEditSenderAndHandlesReactionsAndRedactions() {
        val reducer = MatrixTimelineReducer("@alice:atelier.matrix.kodera.io")

        val optimistic = reducer.enqueueOptimisticSend(
            transactionId = txn1,
            body = "Bonjour l'équipe",
            nowMs = 1_700_000_000_000L,
        )
        assertEquals("txn:$txn1", optimistic.key)
        assertEquals(MatrixDeliveryStatus.SENDING, reducer.messages().first().deliveryStatus)

        reducer.markOptimisticFailed(txn1)
        assertEquals(MatrixDeliveryStatus.FAILED, reducer.messages().first().deliveryStatus)

        reducer.markOptimisticRetrying(txn1)
        assertEquals(MatrixDeliveryStatus.SENDING, reducer.messages().first().deliveryStatus)

        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$msg1",
                    sender = "@alice:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_100L,
                    msgtype = "m.text",
                    body = "Bonjour l'équipe",
                    transactionId = txn1,
                ),
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$msg2",
                    sender = "@bob:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_200L,
                    msgtype = "m.text",
                    body = "> <@alice:atelier.matrix.kodera.io> Bonjour l'équipe\n\nPrêt pour la revue",
                    replyToEventId = "\$msg1",
                ),
            )
        )
        val afterSync = reducer.messages()
        assertEquals(2, afterSync.size)
        assertEquals("txn:$txn1", afterSync[0].key)
        assertEquals("\$msg1", afterSync[0].eventId)
        assertEquals(MatrixDeliveryStatus.SENT, afterSync[0].deliveryStatus)
        assertEquals("Prêt pour la revue", afterSync[1].body)
        assertEquals("alice", afterSync[1].replyPreview?.sender)

        // Spoofed edit from Mallory is ignored; genuine edit from Alice succeeds.
        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$spoof",
                    sender = "@mallory:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_300L,
                    msgtype = "m.text",
                    body = "* Spoofed",
                    newContentBody = "Spoofed",
                    relationType = "m.replace",
                    relatesToEventId = "\$msg1",
                ),
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$edit1",
                    sender = "@alice:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_400L,
                    msgtype = "m.text",
                    body = "* Bonjour l'équipe (mis à jour)",
                    newContentBody = "Bonjour l'équipe (mis à jour)",
                    relationType = "m.replace",
                    relatesToEventId = "\$msg1",
                ),
            )
        )
        assertEquals("Bonjour l'équipe (mis à jour)", reducer.messages()[0].body)
        assertTrue(reducer.messages()[0].isEdited)

        // Reactions + redactions.
        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.reaction",
                    eventId = "\$react1",
                    sender = "@alice:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_500L,
                    relationType = "m.annotation",
                    relatesToEventId = "\$msg1",
                    reactionKey = "🚀",
                ),
                MatrixRawTimelineEvent(
                    type = "m.reaction",
                    eventId = "\$reactBad",
                    sender = "@bob:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_501L,
                    relationType = "m.annotation",
                    relatesToEventId = "\$msg1",
                    reactionKey = "🚀🔥",
                ),
            )
        )
        assertEquals(1, reducer.messages()[0].reactions.size)
        assertEquals("🚀", reducer.messages()[0].reactions[0].key)
        assertTrue(reducer.messages()[0].reactions[0].isSelectedByMe)

        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.redaction",
                    eventId = "\$redactMsg1",
                    sender = "@alice:atelier.matrix.kodera.io",
                    originServerTs = 1_700_000_000_600L,
                    redactsEventId = "\$msg1",
                )
            )
        )
        assertTrue(reducer.messages()[0].isRedacted)
        assertEquals("", reducer.messages()[0].body)
        assertTrue(reducer.messages()[0].reactions.isEmpty())
    }

    @Test
    fun matrixRoomClientAndPushWakeupCoordinatorEndToEnd() {
        val fileBytes = "rapport-kodera".toByteArray(Charsets.UTF_8)
        val expectedSha = MatrixRoomClient.sha256LowercaseHex(fileBytes)

        val matrixRequests = CopyOnWriteArrayList<Request>()
        var wellKnownStatus = 200

        val matrixInterceptor = Interceptor { chain ->
            val req = chain.request()
            matrixRequests += req
            val path = req.url.encodedPath
            val (code, bodyJson) = when {
                path == "/.well-known/matrix/client" -> {
                    if (wellKnownStatus == 200) {
                        200 to """{"m.homeserver":{"base_url":"https://hs.atelier.matrix.kodera.io/"}}"""
                    } else {
                        404 to "{}"
                    }
                }
                path.startsWith("/_matrix/client/v3/directory/room/") -> {
                    200 to """{"room_id":"$roomId"}"""
                }
                path == "/_matrix/client/v3/sync" -> {
                    200 to """
                        {
                          "next_batch": "s72_99",
                          "rooms": {
                            "join": {
                              "$roomId": {
                                "state": {"events": []},
                                "timeline": {
                                  "events": [
                                    {
                                      "type": "m.room.message",
                                      "event_id": "${'$'}ev1",
                                      "sender": "@alice:atelier.matrix.kodera.io",
                                      "origin_server_ts": 1700000000000,
                                      "content": { "msgtype": "m.text", "body": "Salut" }
                                    }
                                  ]
                                }
                              }
                            }
                          }
                        }
                    """.trimIndent()
                }
                path == "/put-object-01" -> {
                    200 to ""
                }
                path.contains("/send/m.room.message/") -> {
                    200 to """{"event_id":"${'$'}sentWithAttachment"}"""
                }
                else -> 404 to "{}"
            }
            Response.Builder()
                .request(req)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message("OK")
                .body(bodyJson.toResponseBody("application/json".toMediaType()))
                .build()
        }

        WireFixture(reply = { req ->
            when {
                req.method == "POST" && req.target.endsWith("/workspace/attachments/uploads") -> {
                    WireReply(
                        status = 201,
                        body = """
                            {
                              "attachmentId": "$attachmentId",
                              "uploadUrl": "https://storage.kodera.io/put-object-01",
                              "method": "PUT",
                              "headers": { "Content-Type": "text/plain" },
                              "expiresAt": "2026-12-01T00:00:00Z"
                            }
                        """.trimIndent().toByteArray(Charsets.UTF_8),
                    )
                }
                req.method == "POST" && req.target.endsWith("/workspace/attachments/$attachmentId/complete") -> {
                    WireReply(
                        status = 200,
                        body = """
                            {
                              "id": "$attachmentId",
                              "filename": "notes.txt",
                              "contentType": "text/plain",
                              "sizeBytes": ${fileBytes.size},
                              "sha256": "$expectedSha",
                              "downloadUrl": "https://storage.kodera.io/get-object-01",
                              "expiresAt": "2026-12-01T00:05:00Z",
                              "disposition": "attachment"
                            }
                        """.trimIndent().toByteArray(Charsets.UTF_8),
                    )
                }
                req.method == "PUT" && req.target.startsWith("/api/v1/push/") -> {
                    WireReply(status = 204, body = ByteArray(0), headers = emptyList())
                }
                req.method == "DELETE" && req.target.startsWith("/api/v1/push/") -> {
                    WireReply(status = 204, body = ByteArray(0), headers = emptyList())
                }
                req.method == "GET" && req.target.startsWith("/api/v1/notifications") -> {
                    WireReply(
                        status = 200,
                        body = """
                            {
                              "data": [
                                {
                                  "id": "01935800-0000-7000-8000-000000000401",
                                  "kind": "mention",
                                  "resourceId": "$channelId",
                                  "createdAt": "2026-11-23T00:00:00Z",
                                  "readAt": null
                                }
                              ],
                              "has_more": false,
                              "next_cursor": null
                            }
                        """.trimIndent().toByteArray(Charsets.UTF_8),
                    )
                }
                else -> WireReply(status = 404, body = "{}".toByteArray())
            }
        }).use { wire ->
            CoreRequester("https://core.test", FakeTokens(), wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, matrixInterceptor).use { matrixClient ->
                    // 1. Discovery 200 + 404 fallback.
                    assertEquals(
                        "https://hs.atelier.matrix.kodera.io",
                        matrixClient.discoverHomeserverOrigin("atelier", "matrix.kodera.io"),
                    )
                    wellKnownStatus = 404
                    val fallbackOrigin = matrixClient.discoverHomeserverOrigin("atelier", "matrix.kodera.io")
                    assertEquals("https://atelier.matrix.kodera.io", fallbackOrigin)

                    // 2. Canonical alias resolution + bounded /sync.
                    val resolved = matrixClient.resolveChannelRoomId(
                        homeserverOrigin = fallbackOrigin,
                        matrixAccessToken = "mtx_tok_01",
                        channelId = channelId,
                        serverName = "atelier.matrix.kodera.io",
                    )
                    assertEquals(roomId, resolved.rawValue)

                    matrixClient.bindChannelSecurity(orgId, channelId, fallbackOrigin, roomId, false)
                    val syncBatch = matrixClient.sync(fallbackOrigin, "mtx_tok_01", roomId = roomId)
                    assertEquals("s72_99", syncBatch.nextBatch)
                    assertEquals(1, syncBatch.roomEvents[roomId]?.size)

                    // 3. 3-step attachment upload + message send.
                    val ref = matrixClient.uploadChannelAttachment(
                        organisationId = orgId,
                        channelId = channelId,
                        payload = AttachmentUploadPayload("notes.txt", AttachmentMimeType.PLAIN_TEXT, fileBytes),
                    )
                    assertEquals(attachmentId, ref.id)

                    val putStorageReq = matrixRequests.first { it.url.encodedPath == "/put-object-01" }
                    assertNull("Presigned PUT must never leak Authorization", putStorageReq.header("Authorization"))
                    assertNotNull(wire.requests.first().headers["idempotency-key"])

                    val sentId = matrixClient.sendTextMessage(
                        homeserverOrigin = fallbackOrigin,
                        matrixAccessToken = "mtx_tok_01",
                        roomId = roomId,
                        transactionId = txn2,
                        body = "",
                        attachments = listOf(ref),
                    )
                    assertEquals("\$sentWithAttachment", sentId)
                }

                // 4. PushWakeupCoordinator: register with an explicit Android platform, reject cleartext, catch-up, revoke on signOut.
                val wakeupCoordinator = PushWakeupCoordinator(requester)
                wakeupCoordinator.registerDeviceWakeup(
                    deviceId = deviceId,
                    endpoint = "https://push.kodera.io/w/device-42",
                    p256dh = "A".repeat(87),
                    auth = "B".repeat(22),
                )
                val putPushObj = StrictJson.parse(wire.requests.last().body).objectValue()
                assertEquals(setOf("endpoint", "p256dh", "auth", "platform"), putPushObj.keys)
                assertFalse(putPushObj.containsKey("surface"))
                assertEquals("android", (putPushObj["platform"] as JsonValue.StringValue).value)
                val registrationsBefore = wire.requests.size
                wakeupCoordinator.registerDeviceWakeup(deviceId, "https://push.kodera.io/device-01", "A".repeat(87), "B".repeat(22))
                assertEquals(registrationsBefore + 1, wire.requests.size)


                val beforeRejectCount = wire.requests.size
                val leaky = """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"$orgId","body":"secret"}"""
                    .toByteArray(Charsets.UTF_8)
                val rejected = assertThrows(PushWakeupException::class.java) {
                    wakeupCoordinator.handleIncomingWakeup(leaky, expectedOrganisationId = orgId)
                }
                assertEquals(PushWakeupError.PAYLOAD_REJECTED, rejected.reason)

                val nestedTransportLeaky =
                    """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"$orgId","sync_hint":"sync_v1_42","transport":{"body":"secret"}}"""
                        .toByteArray(Charsets.UTF_8)
                val rejectedNested = assertThrows(PushWakeupException::class.java) {
                    wakeupCoordinator.handleIncomingWakeup(nestedTransportLeaky, expectedOrganisationId = orgId)
                }
                assertEquals(PushWakeupError.PAYLOAD_REJECTED, rejectedNested.reason)
                assertEquals("transport.body", rejectedNested.detail)
                assertEquals(beforeRejectCount, wire.requests.size)

                val catchUpCalls = AtomicInteger()
                val validWakeup =
                    """{"wakeup_id":"01935800-0000-7000-8000-000000000301","organisation_id":"$orgId","sync_hint":"sync_v1_42"}"""
                        .toByteArray(Charsets.UTF_8)
                val page = wakeupCoordinator.handleIncomingWakeup(
                    rawPayload = validWakeup,
                    expectedOrganisationId = orgId,
                    inboxLimit = 25,
                ) {
                    catchUpCalls.incrementAndGet()
                }
                assertEquals(1, page.items.size)
                assertEquals(InboxNotificationKind.MENTION, page.items.first().kind)
                assertEquals(1, catchUpCalls.get())

                wakeupCoordinator.revokeOnSignOut(deviceId)
                assertEquals("DELETE", wire.requests.last().method)
            }
        }
    }

    @Test
    fun editRedactionRecomputesPriorBodyPrunesReactionsHandlesLimitedGapAndFencesOidcLogin() {
        val reducer = MatrixTimelineReducer("@alice:atelier.kodera.io")

        // 1. Edit chain: orig -> edit1 -> edit2; redacting edit2 restores edit1; redacting edit1 restores orig.
        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$orig",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 1_000L,
                    msgtype = "m.text",
                    body = "Version originale",
                ),
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$edit1",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 1_100L,
                    msgtype = "m.text",
                    body = "* Version 1",
                    newContentBody = "Version 1",
                    relationType = "m.replace",
                    relatesToEventId = "\$orig",
                ),
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$edit2",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 1_200L,
                    msgtype = "m.text",
                    body = "* Version 2",
                    newContentBody = "Version 2",
                    relationType = "m.replace",
                    relatesToEventId = "\$orig",
                ),
            )
        )
        assertEquals("Version 2", reducer.messages().first().body)
        assertTrue(reducer.messages().first().isEdited)

        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.redaction",
                    eventId = "\$redEdit2",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 1_300L,
                    redactsEventId = "\$edit2",
                )
            )
        )
        assertEquals("Version 1", reducer.messages().first().body)
        assertTrue(reducer.messages().first().isEdited)

        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.redaction",
                    eventId = "\$redEdit1",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 1_400L,
                    redactsEventId = "\$edit1",
                )
            )
        )
        assertEquals("Version originale", reducer.messages().first().body)
        assertFalse(reducer.messages().first().isEdited)

        // 2. Reaction eviction pruning + 512 orphan cap.
        reducer.applyEvents(
            listOf(
                MatrixRawTimelineEvent(
                    type = "m.reaction",
                    eventId = "\$reactOrig",
                    sender = "@bob:atelier.kodera.io",
                    originServerTs = 1_500L,
                    relationType = "m.annotation",
                    relatesToEventId = "\$orig",
                    reactionKey = "👍",
                )
            )
        )
        assertEquals(1, reducer.trackedReactionCount)
        reducer.applyEvents(
            (1..255).map { idx ->
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$m$idx",
                    sender = "@bob:atelier.kodera.io",
                    originServerTs = 2_000L + idx,
                    msgtype = "m.text",
                    body = "Msg $idx",
                )
            }
        )
        assertEquals(MatrixTimelineReducer.MAX_TIMELINE_MESSAGES, reducer.messages().size)
        assertEquals(0, reducer.trackedReactionCount)

        reducer.applyEvents(
            (1..600).map { idx ->
                MatrixRawTimelineEvent(
                    type = "m.reaction",
                    eventId = "\$orphan$idx",
                    sender = "@bob:atelier.kodera.io",
                    originServerTs = 5_000L + idx,
                    relationType = "m.annotation",
                    relatesToEventId = "\$futureEvent",
                    reactionKey = "🎉",
                )
            }
        )
        assertEquals(MatrixTimelineReducer.MAX_TRACKED_REACTIONS, reducer.trackedReactionCount)

        // 3. Limited == true gap reset keeps failed optimistic message while replacing stale pre-gap synced messages.
        reducer.enqueueOptimisticSend(transactionId = txn1, body = "Brouillon local", nowMs = 9_000L)
        reducer.markOptimisticFailed(txn1)
        reducer.applySyncDelta(
            MatrixRoomSyncDelta(
                events = listOf(
                    MatrixRawTimelineEvent(
                        type = "m.room.message",
                        eventId = "\$postGap",
                        sender = "@bob:atelier.kodera.io",
                        originServerTs = 9_500L,
                        msgtype = "m.text",
                        body = "Après coupure",
                    )
                ),
                limited = true,
                prevBatch = "p_gap_1",
            ),
            backfilledEvents = listOf(
                MatrixRawTimelineEvent(
                    type = "m.room.message",
                    eventId = "\$backfill1",
                    sender = "@alice:atelier.kodera.io",
                    originServerTs = 9_400L,
                    msgtype = "m.text",
                    body = "Historique récupéré",
                )
            ),
        )
        assertEquals(listOf("Historique récupéré", "Après coupure", "Brouillon local"), reducer.messages().map { it.body })
        assertEquals(MatrixDeliveryStatus.FAILED, reducer.messages().last().deliveryStatus)

        // 4. SessionFence + Synapse OIDC SSO (`m.login.token`) + OIDC `sub` != MemberProfile.id + vault lock + logout.
        val ssoRedirect = MatrixRoomClient.buildSsoRedirectRequest(
            homeserverOrigin = "https://atelier.kodera.io",
            explicitState = "fixed_state_0123456789abcdef",
            loopback = LoopbackPolicy.REFUSE,
        )
        assertTrue(ssoRedirect.ssoRedirectUrl.startsWith("https://atelier.kodera.io/_matrix/client/v3/login/sso/redirect?redirectUrl="))
        val parsedGrant = MatrixRoomClient.consumeSsoCallbackUri(
            "io.kodera.app:/oauth2redirect?state=fixed_state_0123456789abcdef&loginToken=syt_single_use_tok&keep=1",
            ssoRedirect.state,
        )
        assertEquals("syt_single_use_tok", parsedGrant.loginToken)
        assertEquals("io.kodera.app:/oauth2redirect?keep=1", parsedGrant.redactedCallbackUri)
        assertFalse(parsedGrant.redactedCallbackUri.contains("syt_single_use_tok"))
        assertFalse(parsedGrant.redactedCallbackUri.contains("fixed_state"))

        val stateMismatch = assertThrows(MatrixClientException::class.java) {
            MatrixRoomClient.consumeSsoCallbackUri(
                "io.kodera.app:/oauth2redirect?state=wrong_state_0123456789abcdef&loginToken=syt_single_use_tok",
                ssoRedirect.state,
            )
        }
        assertEquals(MatrixClientError.FORBIDDEN, stateMismatch.reason)

        val fence = SessionFence()
        val memberProfilePersonId = "11111111-2222-4333-8444-555555555555"
        val oidcSub = "oidc-sub-77777777-8888-4999-8000-aaaaaaaaaaaa"
        var returnMismatchedPersonIdNextLogin = true
        var lastLoginRequestBody = ""
        val logoutAuthHeaders = CopyOnWriteArrayList<String>()
        var storedVaultBytes: ByteArray? = null
        val matrixHits = CopyOnWriteArrayList<String>()
        var messagesUnauthorizedOnce = true

        val interceptor = Interceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            matrixHits += path
            val (code, json) = when {
                path == "/.well-known/matrix/client" -> 404 to "{}"
                path == "/_matrix/client/v3/login" -> {
                    val buf = okio.Buffer()
                    req.body?.writeTo(buf)
                    lastLoginRequestBody = buf.readUtf8()
                    if (returnMismatchedPersonIdNextLogin) {
                        returnMismatchedPersonIdNextLogin = false
                        200 to """{"user_id":"@$memberProfilePersonId:atelier.kodera.io","access_token":"mtx_leaked_bad","refresh_token":"mtx_ref_bad","device_id":"$deviceId"}"""
                    } else {
                        200 to """{"user_id":"@$oidcSub:atelier.kodera.io","access_token":"mtx_live_1","refresh_token":"mtx_ref_1","device_id":"$deviceId"}"""
                    }
                }
                path.startsWith("/_matrix/client/v3/directory/room/") -> 200 to
                    """{"room_id":"!roomAlpha:atelier.kodera.io"}"""
                path.endsWith("/join") -> 200 to """{"room_id":"!roomAlpha:atelier.kodera.io"}"""
                path == "/_matrix/client/v3/sync" -> 200 to """
                    {
                      "next_batch": "s_next_2",
                      "rooms": {
                        "join": {
                          "!roomAlpha:atelier.kodera.io": {
                            "timeline": { "limited": true, "prev_batch": "s_prev_1", "events": [] }
                          }
                        }
                      }
                    }
                """.trimIndent()
                path.endsWith("/messages") -> {
                    if (messagesUnauthorizedOnce) {
                        messagesUnauthorizedOnce = false
                        401 to """{"errcode":"M_UNKNOWN_TOKEN"}"""
                    } else {
                        200 to """{"chunk":[]}"""
                    }
                }
                path == "/_matrix/client/v3/refresh" -> 200 to
                    """{"access_token":"mtx_live_2","refresh_token":"mtx_ref_2"}"""
                path == "/_matrix/client/v3/logout" -> {
                    logoutAuthHeaders += (req.header("Authorization") ?: "")
                    200 to "{}"
                }
                else -> 404 to "{}"
            }
            Response.Builder()
                .request(req)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message("OK")
                .body(json.toResponseBody("application/json".toMediaType()))
                .build()
        }

        WireFixture(reply = { WireReply(status = 200, body = """{"organisation_id":"00000000-0000-4000-8000-000000000001","state":"initialised","setup":{"state":"ready","reason":null},"can_initialise":false,"id":"00000000-0000-4000-8000-000000000020","categories":[],"uncategorised_channels":[{"id":"00000000-0000-4000-8000-000000000010","kind":"text","name":"general","template_key":null,"topic":"","lifecycle":"active","room_state":"ready","isConfidential":false}]}""".toByteArray()) }).use { wire ->
            CoreRequester("https://core.test", FakeTokens(), wire.route(), Fixtures.COLD_START_MILLIS).use { requester ->
                assertEquals("kodera.io", MatrixRoomClient.deriveMatrixDomain("https://api.kodera.io", LoopbackPolicy.REFUSE))
                MatrixRoomClient(requester, LoopbackPolicy.REFUSE, interceptor, fence = fence).use { client ->
                    // Mismatched `@<memberProfilePersonId>:...` MUST immediately call `/_matrix/client/v3/logout` and refuse!
                    val mismatchErr = assertThrows(MatrixClientException::class.java) {
                        client.authenticateWithSso(
                            homeserverOrigin = "https://atelier.kodera.io",
                            serverName = "atelier.kodera.io",
                            deviceId = deviceId,
                            expectedSubject = oidcSub,
                            ssoAuthorizer = { req ->
                                MatrixRoomClient.consumeSsoCallbackUri(
                                    "${req.callbackUri}&loginToken=sso_tok_bad",
                                    req.state,
                                )
                            },
                        )
                    }
                    assertEquals(MatrixClientError.FORBIDDEN, mismatchErr.reason)
                    assertEquals(listOf("Bearer mtx_leaked_bad"), logoutAuthHeaders.toList())

                    val transientForegroundSyncFence = SessionFence()
                    val transport = MatrixChannelConversationTransport(
                        roomClient = client,
                        organisationId = orgId,
                        organisationSlug = "atelier",
                        matrixDomain = "kodera.io",
                        vaultDeviceId = deviceId,
                        initialExpectedSubject = oidcSub,
                        expectedSubjectProvider = { oidcSub },
                        ssoAuthorizer = { req ->
                            // Simulate Activity backgrounding when the SSO Custom Tab launches,
                            // which invalidates the foreground `/sync` cycle fence while keeping `fence` active.
                            transientForegroundSyncFence.invalidate()
                            MatrixRoomClient.consumeSsoCallbackUri(
                                "${req.callbackUri}&loginToken=sso_tok_valid_01",
                                req.state,
                            )
                        },
                        loadVault = { _, _ -> storedVaultBytes },
                        saveVault = { _, _, bytes ->
                            storedVaultBytes = bytes
                            true
                        },
                    )
                    val boot = transport.bootstrapRoom(orgId, channelId, transientForegroundSyncFence)
                    assertTrue(transientForegroundSyncFence.isInvalidated)
                    assertTrue(lastLoginRequestBody.contains(""""type":"m.login.token""""))
                    assertTrue(lastLoginRequestBody.contains(""""token":"sso_tok_valid_01""""))
                    assertTrue(lastLoginRequestBody.contains(""""refresh_token":true"""))
                    assertEquals("!roomAlpha:atelier.kodera.io", boot.roomId)
                    assertEquals(true, boot.initialBatch.roomDeltas["!roomAlpha:atelier.kodera.io"]?.limited)
                    assertEquals("s_prev_1", boot.initialBatch.roomDeltas["!roomAlpha:atelier.kodera.io"]?.prevBatch)
                    assertEquals("@$oidcSub:atelier.kodera.io", transport.ownUserId)
                    assertNotNull(storedVaultBytes)

                    val backfilled = transport.backfillRoomMessages("!roomAlpha:atelier.kodera.io", "s_prev_1", 10)
                    assertTrue(backfilled.isEmpty())
                    assertTrue(matrixHits.contains("/_matrix/client/v3/refresh"))

                    assertTrue(transport.logoutIfAuthenticated())
                    assertEquals(listOf("Bearer mtx_leaked_bad", "Bearer mtx_live_2"), logoutAuthHeaders.toList())

                    val hitsBeforeFence = matrixHits.size
                    fence.invalidate()
                    val fencedErr = assertThrows(MatrixClientException::class.java) {
                        client.sync("https://atelier.kodera.io", "mtx_live_2", roomId = roomId)
                    }
                    assertEquals(MatrixClientError.SIGNED_OUT, fencedErr.reason)
                    assertEquals(hitsBeforeFence, matrixHits.size)
                }
            }
        }

        // 5. Regression (Item 4): Concurrent `sealIfActive` vs `retireAndWipe` never recreates a wiped vault.
        val tempVaultDir = java.nio.file.Files.createTempDirectory("kodera-vault-race").toFile()
        try {
            repeat(25) { round ->
                val vaultFile = java.io.File(tempVaultDir, "vault-$round.bin")
                val inMemKeys = object : SessionKeys {
                    @Volatile private var k: javax.crypto.SecretKey? = null
                    override fun existing(): javax.crypto.SecretKey? = k
                    override fun getOrCreate(): javax.crypto.SecretKey =
                        k ?: javax.crypto.KeyGenerator.getInstance("AES").run {
                            init(256)
                            generateKey().also { k = it }
                        }
                    override fun destroy() {
                        k = null
                    }
                }
                val vault = RustSessionVault(vaultFile, inMemKeys)
                val raceFence = SessionFence()
                val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
                val tasks = ArrayList<java.util.concurrent.Future<*>>()
                val sampleBytes = """{"access_token":"mtx_race"}""".toByteArray(Charsets.UTF_8)
                repeat(16) {
                    tasks += pool.submit {
                        runCatching {
                            vault.sealIfActive(orgId, deviceId, sampleBytes) { !raceFence.isInvalidated }
                        }
                    }
                }
                tasks += pool.submit {
                    vault.retireAndWipe { raceFence.invalidate() }
                }
                repeat(16) {
                    tasks += pool.submit {
                        runCatching {
                            vault.sealIfActive(orgId, deviceId, sampleBytes) { !raceFence.isInvalidated }
                        }
                    }
                }
                tasks.forEach { it.get(5, java.util.concurrent.TimeUnit.SECONDS) }
                pool.shutdownNow()
                assertTrue(raceFence.isInvalidated)
                assertFalse("Vault file must never remain after retireAndWipe", vaultFile.exists())
                assertEquals(null, vault.open(orgId, deviceId))
            }
        } finally {
            tempVaultDir.deleteRecursively()
        }
    }
}
