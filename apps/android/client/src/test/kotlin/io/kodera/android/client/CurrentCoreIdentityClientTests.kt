package io.kodera.android.client

import com.google.gson.JsonNull
import com.google.gson.JsonObject
import io.kodera.android.client.CurrentCoreIdentityClient.Disposition
import io.kodera.android.client.CurrentCoreIdentityClient.ExecutionKind
import io.kodera.android.client.CurrentCoreIdentityClient.Failure
import io.kodera.android.client.CurrentCoreIdentityClient.Outcome
import io.kodera.android.client.CurrentCoreIdentityClient.OwnerHandle
import io.kodera.android.client.CurrentCoreIdentityClient.OwnerSnapshot
import io.kodera.android.client.CurrentCoreIdentityClient.ReadHandle
import io.kodera.android.client.CurrentCoreIdentityClient.State
import io.kodera.android.domain.LoopbackPolicy
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.function.Function

/** Real requester/decoder/reducer tests; no App owner or provider authentication claim. */
class CurrentCoreIdentityClientTests {
    private val realm = "kodera-dev"
    private val issuer = "https://id.kodera.io/realms/$realm"
    private val session = Session(issuer, realm)
    private val organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    private val otherOrganisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e60"
    private val identity = "11111111-2222-4333-8444-555555555555"
    private val otherIdentity = "22222222-2222-4333-8444-555555555555"
    private val newIdentity = "99999999-2222-4333-8444-555555555555"
    private val configuration = SignInConfiguration("kodera-android", setOf("https://id.kodera.io"), LoopbackPolicy.REFUSE)

    private fun member(id: String, slug: String, identityId: String) = JsonObject().apply {
        add("organisation", JsonObject().apply {
            addProperty("id", id); addProperty("slug", slug); addProperty("name", "Synthetic organisation"); addProperty("realm", slug)
        })
        addProperty("membership_id", if (identityId == newIdentity) newIdentity else otherIdentity)
        addProperty("role", "org_member"); addProperty("state", "active"); addProperty("identity_id", identityId)
    }
    private fun identityValue(id: String, slug: String, subject: String) = JsonObject().apply {
        addProperty("id", id); addProperty("issuer", "https://id.kodera.io/realms/$slug")
        addProperty("realm", slug); addProperty("subject", subject); addProperty("email", "synthetic@example.test")
    }
    private fun me(subject: String = "Case-Sensitive|Subject", linked: Boolean = true) = JsonObject().apply {
        val currentId = if (subject == "New-Subject") newIdentity else identity
        addProperty("id", if (subject == "New-Subject") "88888888-2222-4333-8444-555555555555" else "33333333-2222-4333-8444-555555555555")
        addProperty("staff", false); addProperty("email", "synthetic@example.test")
        add("identities", com.google.gson.JsonArray().apply {
            if (linked) add(identityValue(otherIdentity, "other-team", "Linked-Subject"))
            add(identityValue(currentId, realm, subject))
        })
        add("organisations", com.google.gson.JsonArray().apply {
            if (linked) add(member(otherOrganisation, "other-team", otherIdentity))
            add(member(organisation, realm, currentId))
        })
    }
    private fun currentMember(root: JsonObject) = root.getAsJsonArray("organisations").last().asJsonObject
    private fun currentIdentity(root: JsonObject) = root.getAsJsonArray("identities").last().asJsonObject
    private fun bytes(root: JsonObject) = root.toString().toByteArray(Charsets.UTF_8)
    private fun decode(root: JsonObject, target: String = organisation) = CurrentCoreIdentityClient.decode(bytes(root), session, target)
    private fun expectedFailure(root: JsonObject, failure: Failure = Failure.ProtocolViolation) {
        assertEquals(Outcome.Unavailable(failure), decode(root))
    }
    private fun padded(size: Int, multibyte: Boolean): ByteArray {
        val root = me().apply { addProperty("extension", "") }
        val count = size - bytes(root).size
        check(count >= 0)
        val padding = if (multibyte) "é".repeat(count / 2) + "x".repeat(count % 2) else "x".repeat(count)
        root.addProperty("extension", padding)
        return bytes(root).also { assertEquals(size, it.size) }
    }

    private class Queue : Executor {
        val tasks = ConcurrentLinkedQueue<Runnable>()
        @Volatile var reject = false
        override fun execute(command: Runnable) {
            if (reject) throw RejectedExecutionException("synthetic executor refusal")
            tasks.add(command)
        }
    }
    private class Port(var value: OwnerSnapshot?) : CurrentCoreIdentityClient.OwnerPort {
        var capture: (() -> Unit)? = null
        var check: (() -> Unit)? = null
        var checks = 0
        override fun current(): OwnerSnapshot? { capture?.invoke(); return value }
        override fun isCurrent(snapshot: OwnerSnapshot): Boolean {
            checks++; check?.invoke()
            val now = value ?: return false
            return now.marker === snapshot.marker && now.requester === snapshot.requester &&
                now.session == snapshot.session && now.organisationId == snapshot.organisationId
        }
    }
    private inner class Fixture(
        initial: ByteArray = bytes(me()),
        val tokens: AccessTokenProvider = FakeTokens(),
    ) : AutoCloseable {
        var body = initial
        var status = 200
        var reply: ((RecordedRequest) -> WireReply)? = null
        val wire = WireFixture { request -> reply?.invoke(request) ?: WireReply(status, body) }
        val requesters = mutableListOf<CoreRequester>()
        fun requester() = CoreRequester("https://core.test", tokens, wire.route(), Fixtures.COLD_START_MILLIS).also { requesters += it }
        val workers = Queue()
        val delivery = Queue()
        val serial = ThreadLocal.withInitial { false }
        val states = mutableListOf<State>()
        var onState: ((ReadHandle, State) -> Unit)? = null
        @Volatile var beforeDelivery: ((Outcome) -> Unit)? = null
        val port = Port(OwnerSnapshot(Any(), requester(), session, organisation))
        val client: CurrentCoreIdentityClient
        init {
            serial.set(true)
            client = CurrentCoreIdentityClient(configuration, port, workers, delivery,
                { serial.get() }, { handle, state -> states += state; onState?.invoke(handle, state) },
                { beforeDelivery?.invoke(it) })
        }
        fun accept(): OwnerHandle = checkNotNull(client.acceptCurrentOwner())
        fun begin(owner: OwnerHandle = accept()): ReadHandle = checkNotNull(client.beginRead(owner))
        fun runWorker() {
            val previous = serial.get(); serial.set(false)
            try { checkNotNull(workers.tasks.poll()).run() } finally { serial.set(previous) }
        }
        fun deliver() {
            while (true) { val task = delivery.tasks.poll() ?: break; task.run() }
        }
        fun finish(handle: ReadHandle): Disposition { runWorker(); deliver(); return settled(handle) }
        fun replace(subject: String = "New-Subject"): OwnerHandle {
            body = bytes(me(subject, linked = false))
            port.value = OwnerSnapshot(Any(), requester(), Session(issuer, realm), organisation)
            return accept()
        }
        fun subject(): String? = (client.state as? State.Resolved)?.identity?.subject
        override fun close() {
            client.close()
            requesters.forEach { it.close() }
            workers.reject = false; delivery.reject = false
            while (workers.tasks.isNotEmpty()) runWorker()
            deliver(); wire.close()
        }
    }
    private fun settled(handle: ReadHandle): Disposition {
        val promise = handle.completion.toCompletableFuture()
        assertTrue("whole worker and queued reduction must finish", promise.isDone)
        return promise.get(Fixtures.COLD_START_MILLIS, TimeUnit.MILLISECONDS)
    }
    private fun exceptional(handle: ReadHandle, kind: ExecutionKind) {
        val promise = handle.completion.toCompletableFuture()
        assertTrue("exception must settle, never hang", promise.isDone)
        val failure = assertThrows(ExecutionException::class.java) { promise.get() }.cause
        assertTrue(failure is CurrentCoreIdentityClient.ReadExecutionException)
        assertEquals(kind, (failure as CurrentCoreIdentityClient.ReadExecutionException).kind)
    }
    private fun await(gate: CountDownLatch) = assertTrue("positive worker observation", gate.await(Fixtures.COLD_START_MILLIS, TimeUnit.MILLISECONDS))

    private class WrongIssuerIdentityAccepted(cause: AssertionError) : AssertionError("Synthetic wrong issuer accepted", cause)
    private class DanglingMembershipLinkAccepted(cause: AssertionError) : AssertionError("Synthetic forbidden membership binding accepted", cause)

    @Test fun testWrongIssuerCannotBeAdmittedAsCurrentIdentity() {
        val subject = "Case-Sensitive|Subject"
        val control = (decode(me(subject)) as Outcome.Identity).identity
        assertEquals(issuer, control.issuer); assertEquals(identity, control.id); assertEquals(subject, control.subject)
        val wrongIssuer = "https://other.test/realms/$realm"
        val payload = me(subject).apply { currentIdentity(this).addProperty("issuer", wrongIssuer) }
        val actual = decode(payload)
        try { assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), actual) }
        catch (failure: AssertionError) {
            val observed = (actual as? Outcome.Identity)?.identity
            if (observed != null && observed.id == identity && observed.issuer == wrongIssuer &&
                observed.realm == realm && observed.subject == subject && observed.organisationId == organisation) {
                throw WrongIssuerIdentityAccepted(failure)
            }
            throw failure
        }
        assertEquals(control, (decode(me(subject)) as Outcome.Identity).identity)
    }
    @Test fun testDanglingMembershipLinkCannotAdmitTheOtherwiseCurrentIdentity() {
        val subject = "Case-Sensitive|Subject"
        val control = (decode(me(subject)) as Outcome.Identity).identity
        assertEquals(issuer, control.issuer); assertEquals(identity, control.id); assertEquals(subject, control.subject)
        val payload = me(subject).apply { currentMember(this).addProperty("identity_id", newIdentity) }
        val actualLink = currentMember(payload).get("identity_id").asString
        val actual = decode(payload)
        try { assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), actual) }
        catch (failure: AssertionError) {
            val observed = (actual as? Outcome.Identity)?.identity
            if (observed != null && actualLink == newIdentity && actualLink != observed.id &&
                observed.id == identity && observed.issuer == issuer && observed.realm == realm &&
                observed.subject == subject && observed.organisationId == organisation) {
                throw DanglingMembershipLinkAccepted(failure)
            }
            throw failure
        }
        assertEquals(control, (decode(me(subject)) as Outcome.Identity).identity)
    }

    @Test fun testLinkedIdentityFirstStillSelectsTheExactCurrentIdentity() {
        val result = decode(me()) as Outcome.Identity
        assertEquals(organisation, result.identity.organisationId)
        assertEquals(issuer, result.identity.issuer)
        assertEquals("Case-Sensitive|Subject", result.identity.subject)
        val root = me(); val entries = root.getAsJsonArray("identities"); val first = entries.remove(0); entries.add(first)
        assertEquals(result, decode(root))
    }
    @Test fun testMinimalProjectionDeliberatelyIgnoresUnusedFieldTypes() {
        val root = me().apply {
            remove("email"); addProperty("display_name", 42)
            getAsJsonArray("identities").forEach { it.asJsonObject.add("email", JsonNull.INSTANCE) }
            getAsJsonArray("organisations").forEach {
                it.asJsonObject.remove("role"); it.asJsonObject.addProperty("membership_id", 42)
                it.asJsonObject.getAsJsonObject("organisation").remove("name")
            }
        }
        assertTrue(decode(root) is Outcome.Identity)
    }
    @Test fun testExactCoreSubjectCaseAndPrintableBoundariesArePreserved() {
        for (value in listOf("A", "a", "!", "~", "Case-Sensitive|Subject", "a".repeat(255))) {
            assertEquals(value, (decode(me(value)) as Outcome.Identity).identity.subject)
        }
        for (value in listOf("", "a".repeat(256), "é", "with space", "\u0000")) expectedFailure(me(value))
    }
    @Test fun testRequiredConsumedRootAndIdentityFieldsRefuseMalformedValues() {
        val changes = listOf<(JsonObject) -> Unit>(
            { it.remove("id") }, { it.addProperty("id", "not-uuid") }, { it.addProperty("staff", true) },
            { it.add("staff", JsonNull.INSTANCE) }, { it.remove("identities") }, { it.addProperty("organisations", 1) },
            { currentIdentity(it).remove("realm") }, { currentIdentity(it).addProperty("id", "BAD") },
            { currentIdentity(it).addProperty("issuer", "") }, { currentIdentity(it).addProperty("subject", 3) },
        )
        changes.forEach { change -> expectedFailure(me().also(change)) }
    }
    @Test fun testMembershipConsumedFieldsHaveFrozenTypesAndClosedState() {
        val changes = listOf<(JsonObject) -> Unit>(
            { currentMember(it).remove("organisation") }, { currentMember(it).add("organisation", JsonNull.INSTANCE) },
            { currentMember(it).getAsJsonObject("organisation").remove("id") },
            { currentMember(it).getAsJsonObject("organisation").addProperty("slug", "Bad_Slug") },
            { currentMember(it).getAsJsonObject("organisation").addProperty("realm", 4) },
            { currentMember(it).getAsJsonObject("organisation").addProperty("realm", "other-team") },
            { currentMember(it).remove("state") }, { currentMember(it).addProperty("state", "Active") },
            { it.getAsJsonArray("organisations")[0].asJsonObject.addProperty("state", "future") },
            { currentMember(it).add("identity_id", JsonNull.INSTANCE) }, { currentMember(it).addProperty("identity_id", 4) },
            { currentMember(it).addProperty("identity_id", "BAD") },
        )
        changes.forEach { change -> expectedFailure(me().also(change)) }
    }
    @Test fun testMissingAndNullRealmAreIneligibleOnlyForTheirOwnEntry() {
        for (nullRealm in listOf(false, true)) {
            val root = me(); val org = currentMember(root).getAsJsonObject("organisation")
            if (nullRealm) org.add("realm", JsonNull.INSTANCE) else org.remove("realm")
            expectedFailure(root, Failure.NotEligible)
            val other = me(); other.getAsJsonArray("organisations")[0].asJsonObject.getAsJsonObject("organisation").add("realm", JsonNull.INSTANCE)
            assertTrue(decode(other) is Outcome.Identity)
        }
    }
    @Test fun testRealmCardinalityIsCheckedBeforeTargetAndActiveFiltering() {
        for (state in listOf("active", "invited", "suspended", "removed")) {
            val root = me(linked = false)
            val duplicate = member(otherOrganisation, realm, identity).apply { addProperty("state", state) }
            root.getAsJsonArray("organisations").add(duplicate)
            expectedFailure(root)
        }
    }
    @Test fun testKnownInactiveMembershipAndDifferentTargetDoNotAdmitIdentity() {
        for (state in listOf("invited", "suspended", "removed")) expectedFailure(me().apply { currentMember(this).addProperty("state", state) }, Failure.NotEligible)
        assertEquals(Outcome.Unavailable(Failure.NotEligible), decode(me(), otherOrganisation))
    }
    @Test fun testMissingLinkDiffersFromMalformedOrContradictoryLink() {
        expectedFailure(me().apply { currentMember(this).remove("identity_id") }, Failure.NotEligible)
        expectedFailure(me().apply { currentMember(this).addProperty("identity_id", newIdentity) })
        expectedFailure(me().apply { currentMember(this).addProperty("identity_id", otherIdentity) })
        expectedFailure(me().apply { currentIdentity(this).addProperty("issuer", "https://other.test/realms/$realm") })
        expectedFailure(me().apply { currentIdentity(this).addProperty("realm", "other-team") })
    }
    @Test fun testForgedWireDuplicateIdsOrIssuersAreNotDeduplicated() {
        val sameIssuer = me(); sameIssuer.getAsJsonArray("identities").add(identityValue(newIdentity, realm, "Other-Subject")); expectedFailure(sameIssuer)
        val sameId = me(); sameId.getAsJsonArray("identities").add(identityValue(identity, "other-new", "Other-Subject")); expectedFailure(sameId)
        val sameOrg = me(); sameOrg.getAsJsonArray("organisations").add(currentMember(sameOrg).deepCopy()); expectedFailure(sameOrg)
    }
    @Test fun testCompleteMeByteLimitsApplyToDecoderWithIgnoredMultibyteExtensions() {
        for (multi in listOf(false, true)) {
            assertTrue(CurrentCoreIdentityClient.decode(padded(65536, multi), session, organisation) is Outcome.Identity)
            assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), CurrentCoreIdentityClient.decode(padded(65537, multi), session, organisation))
        }
    }
    @Test fun testGlobalGrammarChecksStillCoverIgnoredExtensions() {
        val base = me().toString().dropLast(1)
        fun parse(extra: String) = CurrentCoreIdentityClient.decode((base + ",\"extension\":" + extra + "}").toByteArray(), session, organisation)
        assertTrue(parse("[".repeat(11) + "0" + "]".repeat(11)) is Outcome.Identity)
        for (value in listOf("[".repeat(12) + "0" + "]".repeat(12), "{\"a\":1,\"\\u0061\":2}", "\"\\ud800\"")) {
            assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), parse(value))
        }
        assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), CurrentCoreIdentityClient.decode((me().toString() + "{}").toByteArray(), session, organisation))
        val invalid = (base + ",\"extension\":\"").toByteArray() + byteArrayOf(0xc3.toByte(), 0x28) + "\"}".toByteArray()
        assertEquals(Outcome.Unavailable(Failure.ProtocolViolation), CurrentCoreIdentityClient.decode(invalid, session, organisation))
    }
    @Test fun testRealRequesterCarriesOneUnconditionalBoundedMeRequest() = Fixture().use { f ->
        val handle = f.begin(); assertSame(handle, f.client.beginRead(f.accept()))
        assertFalse(handle.completion.toCompletableFuture().isDone)
        f.runWorker(); assertFalse(handle.completion.toCompletableFuture().isDone)
        f.deliver(); assertTrue(settled(handle) is Disposition.Delivered)
        assertEquals("Case-Sensitive|Subject", f.subject())
        val request = f.wire.requests.single()
        assertEquals("GET", request.method); assertEquals("/api/v1/me", request.target)
        assertEquals("Bearer synthetic-access-1", request.headers["authorization"])
        assertEquals("core.test", request.headers["host"]); assertEquals("no-store", request.headers["cache-control"])
        assertTrue("if-none-match" !in request.headers); assertTrue("cookie" !in request.headers)
        val next = f.begin(); assertNull(f.subject()); f.finish(next); assertEquals(2, f.wire.requests.size)
    }
    @Test fun testRealTransportCompleteByteBoundary() {
        for (size in listOf(65536, 65537)) Fixture(padded(size, true)).use { f ->
            f.finish(f.begin())
            if (size == 65536) assertNotNull(f.subject()) else assertEquals(Failure.ProtocolViolation, (f.client.state as State.Unavailable).failure)
        }
    }
    @Test fun testStatusesRefuseForgedSuccessBodiesWithoutFallback() {
        for ((status, expected) in listOf(403 to Failure.Forbidden, 429 to Failure.ServiceUnavailable, 503 to Failure.ServiceUnavailable,
            302 to Failure.ProtocolViolation, 304 to Failure.ProtocolViolation, 404 to Failure.ProtocolViolation)) {
            val tokens = FakeTokens()
            Fixture(tokens = tokens).use { f ->
                f.status = status; f.finish(f.begin())
                assertEquals(expected, (f.client.state as State.Unavailable).failure)
                assertEquals(1, f.wire.requests.size); assertEquals(0, tokens.forcedRefreshes.get()); assertEquals(0, tokens.signOuts.get())
            }
        }
    }
    @Test fun testOne401RefreshKeepsIdentityAndSecond401RelaysOnlyItsReadOutcome() {
        val tokens = FakeTokens()
        Fixture(tokens = tokens).use { f ->
            var first = true
            f.reply = { if (first) { first = false; WireReply(401, bytes(me())) } else WireReply(200, bytes(me())) }
            f.finish(f.begin()); assertNotNull(f.subject()); assertEquals(1, tokens.forcedRefreshes.get()); assertEquals(0, tokens.signOuts.get())
        }
        val ended = FakeTokens()
        Fixture(tokens = ended).use { f -> f.status = 401; f.finish(f.begin()); assertTrue(f.client.state is State.SignedOut); assertEquals(1, ended.signOuts.get()); assertEquals(2, f.wire.requests.size) }
    }
    @Test fun testIdentityUnavailableAndUnsendablePreserveRequesterMapping() {
        Fixture(tokens = FakeTokens(unavailable = true)).use { f -> f.finish(f.begin()); assertEquals(Failure.IdentityUnavailable, (f.client.state as State.Unavailable).failure); assertTrue(f.wire.requests.isEmpty()) }
        Fixture(tokens = FakeTokens(prefix = "synthetic\n")).use { f -> f.finish(f.begin()); assertEquals(Failure.ProtocolViolation, (f.client.state as State.Unavailable).failure); assertTrue(f.wire.requests.isEmpty()) }
    }
    @Test fun testInvalidBindingSendsNoTokenOrRequestAndCannotReuseForeignHandle() = Fixture().use { f ->
        val owner = f.accept()
        Fixture().use { other -> assertNull(f.client.beginRead(other.accept())) }
        f.port.value = OwnerSnapshot(Any(), f.port.value!!.requester, Session(issuer, "wrong-realm"), organisation)
        assertNull(f.client.acceptCurrentOwner()); assertNull(f.client.beginRead(owner))
        assertEquals(0, (f.tokens as FakeTokens).requested.get()); assertTrue(f.wire.requests.isEmpty())
    }
    @Test fun testCancelEndAndCloseDropOnlyTheirReadAndNeverCloseBorrowedRequester() {
        for (action in listOf("cancel", "end", "close")) Fixture().use { f ->
            val owner = f.accept(); val handle = f.begin(owner); f.runWorker()
            when (action) { "cancel" -> f.client.cancelRead(handle); "end" -> f.client.end(owner); else -> f.client.close() }
            assertFalse(f.port.value!!.requester.isClosed); assertFalse(handle.completion.toCompletableFuture().isDone)
            f.deliver(); assertTrue(settled(handle) is Disposition.Dropped); assertNull(f.subject())
            if (action == "end") assertNull(f.client.beginRead(owner))
            assertTrue(CoreMeClient(f.port.value!!.requester).fetch() is MeOutcome.Member)
        }
    }
    @Test fun testAllHeldReadOutcomesRespectEveryRetirementAction() {
        for (status in listOf(200, 403, 401)) for (action in listOf("cancel", "end", "close")) Fixture().use { f ->
            f.status = status
            val owner = f.accept(); val handle = f.begin(owner); f.runWorker()
            val notifications = f.states.size
            when (action) { "cancel" -> f.client.cancelRead(handle); "end" -> f.client.end(owner); else -> f.client.close() }
            assertFalse(handle.completion.toCompletableFuture().isDone)
            f.deliver(); assertTrue(settled(handle) is Disposition.Dropped)
            assertEquals(notifications, f.states.size); assertNull(f.subject())
            assertFalse(f.port.value!!.requester.isClosed)
        }
    }
    @Test fun testCompletionCopiesCannotCompleteOrCancelThePrivateOperation() = Fixture().use { f ->
        val handle = f.begin()
        val forged = handle.completion.toCompletableFuture()
        assertTrue(forged.complete(Disposition.Dropped(CurrentCoreIdentityClient.DropReason.CLOSED)))
        val cancelled = handle.completion.toCompletableFuture(); assertTrue(cancelled.cancel(false))
        assertFalse(handle.completion.toCompletableFuture().isDone)
        f.finish(handle); assertNotNull(f.subject())
    }
    @Test fun testStableFacadeAndObtrudedCopiesStayPendingThroughWorkerAndFinalDrop() = Fixture().use { f ->
        val handle = f.begin(); val facade = handle.completion
        assertSame(facade, handle.completion); assertFalse(facade is CompletableFuture<*>)
        val copies = List(4) { facade.toCompletableFuture() }
        for (i in copies.indices) for (j in 0 until i) assertNotSame(copies[i], copies[j])
        val fake = Disposition.Dropped(CurrentCoreIdentityClient.DropReason.CLOSED)
        assertTrue(copies[0].complete(fake)); assertTrue(copies[1].cancel(false))
        copies[2].obtrudeValue(fake); copies[3].obtrudeException(IllegalStateException("synthetic copy failure"))
        var calls = 0
        var observed: Disposition? = null
        val observer = facade.thenAccept { calls++; observed = it }.toCompletableFuture()
        val untouched = facade.toCompletableFuture()
        assertEquals(0, calls); assertFalse(observer.isDone); assertFalse(untouched.isDone)
        f.client.cancelRead(handle)
        assertFalse(facade.toCompletableFuture().isDone)
        f.runWorker()
        assertEquals(0, calls); assertFalse(observer.isDone); assertFalse(untouched.isDone)
        f.deliver()
        val actual = settled(handle)
        assertEquals(Disposition.Dropped(CurrentCoreIdentityClient.DropReason.CANCELLED), actual)
        assertEquals(actual, observed); assertEquals(actual, untouched.get()); assertEquals(1, calls)
        assertTrue(observer.isDone); assertEquals(actual, facade.toCompletableFuture().get())
    }
    @Test fun testCopyObtrusionCannotReplaceTrueExceptionalCompletion() = Fixture().use { f ->
        val original = IllegalArgumentException("synthetic original worker failure")
        f.beforeDelivery = { throw original }
        val handle = f.begin(); val facade = handle.completion
        val valueCopy = facade.toCompletableFuture(); val errorCopy = facade.toCompletableFuture()
        valueCopy.obtrudeValue(Disposition.Dropped(CurrentCoreIdentityClient.DropReason.CLOSED))
        errorCopy.obtrudeException(IllegalStateException("synthetic fabricated exception"))
        var observed: Throwable? = null
        val dependent = facade.whenComplete { _, error -> observed = error }.toCompletableFuture()
        f.runWorker(); assertNull(observed); assertFalse(dependent.isDone); assertFalse(facade.toCompletableFuture().isDone)
        f.deliver(); exceptional(handle, ExecutionKind.WORKER)
        assertTrue(observed is CurrentCoreIdentityClient.ReadExecutionException)
        assertSame(original, observed!!.cause)
        val actual = assertThrows(ExecutionException::class.java) { dependent.get() }.cause!!
        assertSame(original, actual.cause)
        val later = assertThrows(ExecutionException::class.java) { facade.toCompletableFuture().get() }.cause!!
        assertSame(original, later.cause); assertEquals(ExecutionKind.WORKER, (later as CurrentCoreIdentityClient.ReadExecutionException).kind)
    }
    @Test fun testManipulatedAndThrowingDependentsCannotPoisonOtherObservers() = Fixture().use { f ->
        val handle = f.begin(); val facade = handle.completion
        var calls = 0
        val safe = facade.thenApply { calls++; it }.toCompletableFuture()
        val changed = facade.thenApply { "synthetic dependent" }.toCompletableFuture()
        changed.obtrudeValue("synthetic fabricated value")
        val original = IllegalStateException("synthetic dependent failure")
        val throwing = facade.thenApply<Disposition> { throw original }.toCompletableFuture()
        assertFalse(safe.isDone); assertFalse(throwing.isDone); assertFalse(facade.toCompletableFuture().isDone)
        val actual = f.finish(handle)
        assertTrue(actual is Disposition.Delivered); assertEquals(actual, safe.get()); assertEquals(1, calls)
        assertSame(original, assertThrows(ExecutionException::class.java) { throwing.get() }.cause)
        assertEquals(actual, facade.toCompletableFuture().get()); assertNotNull(f.subject())
    }

    // Original/newer calls are compiled witnesses ONLY. They are inspected, never invoked.
    private class Api31ReferenceWitness {
        fun stage(source: CompletableFuture<Any>): CompletionStage<Any> = source.minimalCompletionStage()
    }
    private class NewerDefaultReferenceWitness {
        fun stage(source: CompletionStage<Any>, fallback: Function<Throwable, Any>): CompletionStage<Any> = source.exceptionallyAsync(fallback)
    }
    private class UnknownReferenceWitness {
        fun stage(source: CompletableFuture<Any>): Any? = source.getNow(null)
    }
    private class UnknownSignatureWitness {
        fun stage(source: java.util.concurrent.Flow.Publisher<*>): Any = source
    }
    private class OriginalVoidSignatureWitness {
        fun stage(source: CompletionStage<Void>): CompletionStage<Void> = source
    }

    /** Small classfile audit for this completion ABI, not a general bytecode verifier. */
    private object CompletionApi24 {
        class Refused(val reference: String) : IllegalArgumentException("Completion API reference refused")
        data class Member(val owner: String, val name: String, val descriptor: String)
        data class PairIndex(val first: Int, val second: Int)
        data class ClassIndex(val name: Int)
        data class Reference(val tag: Int, val owner: Int, val nameType: Int)
        data class Index(val tag: Int, val value: Int)
        data class Handle(val kind: Int, val reference: Int)
        data class Signature(val access: Int, val name: String, val descriptor: String)
        data class File(val owner: String, val members: List<Member>, val methods: List<Signature>,
            val fields: List<Signature>, val classes: Set<String>, val genericSignatures: List<String>)
        private const val stage = "Ljava/util/concurrent/CompletionStage;"
        private const val future = "Ljava/util/concurrent/CompletableFuture;"
        private const val function = "Ljava/util/function/Function;"
        private const val consumer = "Ljava/util/function/Consumer;"
        private const val biFunction = "Ljava/util/function/BiFunction;"
        private const val biConsumer = "Ljava/util/function/BiConsumer;"
        private const val executor = "Ljava/util/concurrent/Executor;"
        private const val runnable = "Ljava/lang/Runnable;"
        val surface: Set<Pair<String, String>> = buildSet {
            for ((name, parameters) in listOf("thenApply" to function, "thenAccept" to consumer, "thenRun" to runnable,
                "thenCombine" to stage + biFunction, "thenAcceptBoth" to stage + biConsumer, "runAfterBoth" to stage + runnable,
                "applyToEither" to stage + function, "acceptEither" to stage + consumer, "runAfterEither" to stage + runnable,
                "thenCompose" to function, "whenComplete" to biConsumer, "handle" to biFunction)) {
                add(name to "($parameters)$stage"); add(name + "Async" to "($parameters)$stage")
                add(name + "Async" to "($parameters$executor)$stage")
            }
            add("exceptionally" to "($function)$stage"); add("toCompletableFuture" to "()$future")
        }
        private val allowed: Set<Member> = buildSet {
            for ((name, descriptor) in surface) {
                add(Member("java/util/concurrent/CompletionStage", name, descriptor))
                add(Member("java/util/concurrent/CompletableFuture", name, descriptor.replace(")$stage", ")$future")))
            }
            add(Member("java/util/concurrent/CompletableFuture", "<init>", "()V"))
            add(Member("java/util/concurrent/CompletableFuture", "complete", "(Ljava/lang/Object;)Z"))
            add(Member("java/util/concurrent/CompletableFuture", "completeExceptionally", "(Ljava/lang/Throwable;)Z"))
            add(Member("java/lang/Object", "<init>", "()V"))
            add(Member("java/lang/Throwable", "addSuppressed", "(Ljava/lang/Throwable;)V"))
        }
        private val platformTypes = setOf("java/lang/Object", "java/lang/String", "java/lang/Throwable", "java/lang/Runnable", "java/lang/Void",
            "java/util/concurrent/CompletableFuture", "java/util/concurrent/CompletionStage", "java/util/concurrent/Executor",
            "java/util/function/Function", "java/util/function/Consumer", "java/util/function/BiFunction", "java/util/function/BiConsumer")

        fun bytes(type: Class<*>): ByteArray = resource(type.name.replace('.', '/'))
        private fun resource(owner: String): ByteArray = CurrentCoreIdentityClientTests::class.java.classLoader
            .getResourceAsStream("$owner.class")?.use {
                it.readNBytes(65537).also { data -> if (data.size > 65536) throw Refused("class byte budget") }
            } ?: throw Refused("missing class resource")

        fun parse(bytes: ByteArray): File {
            if (bytes.size > 65536) throw Refused("class byte budget")
            try {
                val input = DataInputStream(ByteArrayInputStream(bytes))
                if (input.readInt() != 0xcafebabe.toInt()) throw Refused("class magic")
                input.readUnsignedShort()
                if (input.readUnsignedShort() !in 45..61) throw Refused("class version")
                val count = input.readUnsignedShort()
                if (count !in 1..4096) throw Refused("constant pool budget")
                val pool = arrayOfNulls<Any>(count)
                var index = 1
                while (index < count) {
                    pool[index] = when (val tag = input.readUnsignedByte()) {
                        1 -> input.readUTF()
                        3, 4 -> input.readInt()
                        5, 6 -> { val value = input.readLong(); index++; if (index >= count) throw Refused("wide pool entry"); value }
                        7 -> ClassIndex(input.readUnsignedShort())
                        8, 16 -> Index(tag, input.readUnsignedShort())
                        9, 10, 11 -> Reference(tag, input.readUnsignedShort(), input.readUnsignedShort())
                        12 -> PairIndex(input.readUnsignedShort(), input.readUnsignedShort())
                        15 -> Handle(input.readUnsignedByte(), input.readUnsignedShort())
                        17, 18 -> throw Refused("unexpected dynamic completion helper")
                        else -> throw Refused("unsupported constant tag $tag")
                    }
                    index++
                }
                fun value(at: Int): Any = pool.getOrNull(at) ?: throw Refused("pool index")
                fun text(at: Int): String = value(at) as? String ?: throw Refused("UTF entry")
                fun owner(at: Int): String = text((value(at) as? ClassIndex ?: throw Refused("class entry")).name)
                for (entry in pool) when (entry) {
                    is Index -> text(entry.value)
                    is PairIndex -> { text(entry.first); text(entry.second) }
                    is Handle -> {
                        val target = value(entry.reference) as? Reference ?: throw Refused("method handle reference")
                        val tags = when (entry.kind) { in 1..4 -> setOf(9); 5, 8 -> setOf(10); 6, 7 -> setOf(10, 11); 9 -> setOf(11); else -> emptySet() }
                        if (target.tag !in tags) throw Refused("method handle kind")
                    }
                    else -> Unit
                }
                val genericSignatures = mutableListOf<String>()
                fun attributes() {
                    repeat(input.readUnsignedShort()) {
                        val attribute = text(input.readUnsignedShort())
                        val length = input.readInt()
                        if (length < 0 || length > input.available()) throw Refused("attribute length")
                        if (attribute == "Signature") {
                            if (length != 2) throw Refused("signature attribute")
                            genericSignatures += text(input.readUnsignedShort())
                        } else if (input.skipBytes(length) != length) throw Refused("attribute truncation")
                    }
                }
                fun signatures(): List<Signature> = List(input.readUnsignedShort()) {
                    Signature(input.readUnsignedShort(), text(input.readUnsignedShort()), text(input.readUnsignedShort())).also { attributes() }
                }
                input.readUnsignedShort(); val name = owner(input.readUnsignedShort()); input.readUnsignedShort()
                repeat(input.readUnsignedShort()) { owner(input.readUnsignedShort()) }
                val fields = signatures(); val methods = signatures(); attributes()
                if (input.available() != 0) throw Refused("trailing class bytes")
                val members = pool.filterIsInstance<Reference>().map {
                    val pair = value(it.nameType) as? PairIndex ?: throw Refused("member name/type")
                    Member(owner(it.owner), text(pair.first), text(pair.second))
                }
                return File(name, members, methods, fields, pool.filterIsInstance<ClassIndex>().map { text(it.name) }.toSet(), genericSignatures)
            } catch (error: Refused) { throw error }
            catch (_: Exception) { throw Refused("malformed class resource") }
        }

        fun check(file: File) {
            for (member in file.members) if (member.owner.startsWith("java/") && member !in allowed) {
                throw Refused("${member.owner}.${member.name}${member.descriptor}")
            }
            val descriptors = (file.fields + file.methods).map { it.descriptor } + file.genericSignatures + file.classes
            val types = file.classes + descriptors.flatMap { descriptor ->
                Regex("L([^;<]+)").findAll(descriptor).map { it.groupValues[1] }.toList()
            }
            for (type in types) if (type.startsWith("java/") && type !in platformTypes) throw Refused(type)
        }

        fun audit(handle: ReadHandle): Int {
            val handleName = handle.javaClass.name.replace('.', '/')
            val facadeName = handle.completion.javaClass.name.replace('.', '/')
            val queue = java.util.ArrayDeque<String>().apply { add(handleName); add(facadeName) }
            val visited = mutableSetOf<String>()
            while (queue.isNotEmpty()) {
                val owner = queue.removeFirst()
                if (!visited.add(owner)) continue
                if (visited.size > 16) throw Refused("completion helper budget")
                val file = parse(resource(owner)); if (file.owner != owner) throw Refused("resource owner")
                check(file)
                if (owner == facadeName) {
                    if (file.methods.filter { it.name != "<init>" }.map { it.name to it.descriptor }.toSet() != surface) throw Refused("facade API24 surface")
                }
                for (field in file.fields) if (field.descriptor == future && field.access and 2 == 0) throw Refused("exposed promise")
                if (owner == handleName && file.methods.any { it.name != "<init>" && it.descriptor.endsWith(future) }) throw Refused("promise getter")
                for (type in file.classes + file.members.map { it.owner }) {
                    if (type.startsWith(handleName + "$") || type.startsWith(facadeName + "$")) queue.add(type)
                }
            }
            return visited.size
        }
    }

    @Test fun testCompiledCompletionSurfaceUsesOnlyTheAuditedApi24Members() = Fixture().use { f ->
        val handle = f.begin()
        assertEquals(38, CompletionApi24.surface.size)
        assertTrue("ReadHandle, facade and actual emitted helper are inspected", CompletionApi24.audit(handle) >= 3)
    }
    @Test fun testCompiledApiGuardRejectsOriginalNewerAndUnknownRealReferences() {
        val original = CompletionApi24.parse(CompletionApi24.bytes(OriginalVoidSignatureWitness::class.java))
        assertTrue(original.genericSignatures.any { it.contains("Ljava/lang/Void;") })
        CompletionApi24.check(original)
        for ((type, name) in listOf(Api31ReferenceWitness::class.java to "minimalCompletionStage",
            NewerDefaultReferenceWitness::class.java to "exceptionallyAsync", UnknownReferenceWitness::class.java to "getNow")) {
            val file = CompletionApi24.parse(CompletionApi24.bytes(type))
            assertTrue("compiled member reference witness must exist", file.members.any { it.name == name })
            val refused = assertThrows(CompletionApi24.Refused::class.java) { CompletionApi24.check(file) }
            assertTrue(refused.reference.contains(name))
        }
        val valid = CompletionApi24.bytes(Api31ReferenceWitness::class.java)
        val signature = CompletionApi24.parse(CompletionApi24.bytes(UnknownSignatureWitness::class.java))
        assertTrue(assertThrows(CompletionApi24.Refused::class.java) { CompletionApi24.check(signature) }.reference.contains("Flow"))
        assertThrows(CompletionApi24.Refused::class.java) { CompletionApi24.parse(valid.copyOf(valid.size - 1)) }
        assertThrows(CompletionApi24.Refused::class.java) { CompletionApi24.parse(ByteArray(65537)) }
    }

    private class OldIdentityPublishedAfterNewIdentity(cause: AssertionError) : AssertionError("Synthetic old identity replaced new identity", cause)
    @Test fun testDecodedOldIdentityCannotReplaceSamePublicFieldNewOwner() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Fixture(bytes(me("Old-Subject", linked = false))).use { f ->
            f.beforeDelivery = { outcome -> if (outcome is Outcome.Identity && outcome.identity.subject == "Old-Subject") { entered.countDown(); release.await() } }
            val oldOwner = f.accept(); val old = f.begin(oldOwner)
            val thread = Thread({ f.runWorker() }, "identity-old-worker")
            try {
                thread.start(); await(entered)
                val newOwner = f.replace(); val fresh = f.begin(newOwner); f.finish(fresh)
                assertEquals("New-Subject", f.subject())
                f.client.cancelRead(old); f.client.end(oldOwner)
                release.countDown(); thread.join(Fixtures.COLD_START_MILLIS); assertFalse(thread.isAlive)
                f.deliver(); val oldDisposition = settled(old)
                val observed = f.subject()
                try { assertEquals("New-Subject", observed) }
                catch (failure: AssertionError) { if (observed == "Old-Subject") throw OldIdentityPublishedAfterNewIdentity(failure); throw failure }
                assertTrue(oldDisposition is Disposition.Dropped)
                assertFalse(f.port.value!!.requester.isClosed)
            } finally { release.countDown(); thread.join(Fixtures.COLD_START_MILLIS) }
        }
    }
    @Test fun testObsoleteFailureAndSignedOutCannotClearNewOwner() {
        for (status in listOf(403, 401)) Fixture().use { f ->
            f.status = status; val oldOwner = f.accept(); val old = f.begin(oldOwner); f.runWorker()
            f.status = 200; val freshOwner = f.replace(); val fresh = f.begin(freshOwner); f.runWorker()
            val oldDelivery = checkNotNull(f.delivery.tasks.poll()); f.deliver(); settled(fresh)
            assertEquals("New-Subject", f.subject()); oldDelivery.run(); assertTrue(settled(old) is Disposition.Dropped)
            assertEquals("New-Subject", f.subject()); assertFalse(f.port.value!!.requester.isClosed)
        }
    }
    @Test fun testSameOwnerCancelledReadCannotReplaceItsNewReadTicket() = Fixture().use { f ->
        val owner = f.accept(); val old = f.begin(owner); f.runWorker(); f.client.cancelRead(old)
        f.body = bytes(me("New-Subject", linked = false)); val fresh = f.begin(owner); f.runWorker()
        val oldDelivery = checkNotNull(f.delivery.tasks.poll()); f.deliver(); settled(fresh); oldDelivery.run(); settled(old)
        assertEquals("New-Subject", f.subject())
    }
    @Test fun testWorkerFailureSettlesExceptionallyAndExplicitRetryWorks() = Fixture().use { f ->
        f.beforeDelivery = { throw IllegalStateException("synthetic worker failure") }
        val failed = f.begin(); f.runWorker(); assertFalse(failed.completion.toCompletableFuture().isDone); f.deliver()
        exceptional(failed, ExecutionKind.WORKER); assertNull(f.subject())
        f.beforeDelivery = null; f.finish(f.begin()); assertNotNull(f.subject())
    }
    @Test fun testWorkerRejectionStartsNoWorkAndDoesNotCloseSharedResources() = Fixture().use { f ->
        f.workers.reject = true; val failed = f.begin(); exceptional(failed, ExecutionKind.WORKER_REJECTED)
        assertEquals(0, (f.tokens as FakeTokens).requested.get()); assertFalse(f.port.value!!.requester.isClosed)
        f.workers.reject = false; f.finish(f.begin()); assertNotNull(f.subject())
    }
    @Test fun testDeliveryRejectionSettlesWithoutWrongThreadCallbackAndCanRecover() = Fixture().use { f ->
        val handle = f.begin(); val count = f.states.size; f.delivery.reject = true; f.runWorker()
        exceptional(handle, ExecutionKind.DELIVERY_REJECTED); assertEquals(count, f.states.size)
        assertEquals(Failure.Execution(ExecutionKind.DELIVERY_REJECTED), (f.client.state as State.Unavailable).failure)
        f.delivery.reject = false; f.finish(f.begin()); assertNotNull(f.subject())
    }
    @Test fun testStaleWorkerAndDeliveryFailureDoNotPoisonNewOwner() {
        for (rejection in listOf(false, true)) Fixture().use { f ->
            val old = f.begin(); val owner = f.replace()
            if (rejection) f.delivery.reject = true else f.beforeDelivery = { throw IllegalStateException("old worker") }
            f.runWorker(); f.delivery.reject = false; f.beforeDelivery = null
            val fresh = f.begin(owner); f.finish(fresh); f.deliver()
            exceptional(old, if (rejection) ExecutionKind.DELIVERY_REJECTED else ExecutionKind.WORKER)
            assertEquals("New-Subject", f.subject())
        }
    }
    @Test fun testLoadingObserverThrowWaitsForTheWholeWorkerAndDrop() = Fixture().use { f ->
        f.onState = { _, state -> if (state is State.Loading) throw IllegalStateException("loading observer") }
        val handle = f.begin(); assertFalse(handle.completion.toCompletableFuture().isDone)
        f.onState = null; f.runWorker(); assertFalse(handle.completion.toCompletableFuture().isDone); f.deliver()
        exceptional(handle, ExecutionKind.OBSERVER); assertNull(f.subject())
        f.finish(f.begin()); assertNotNull(f.subject())
    }
    @Test fun testFinalObserverThrowClearsOnlyItsCurrentReadAndNeverRecurses() = Fixture().use { f ->
        var calls = 0
        f.onState = { _, state -> if (state is State.Resolved) { calls++; throw IllegalStateException("final observer") } }
        val handle = f.begin(); f.runWorker(); f.deliver(); exceptional(handle, ExecutionKind.OBSERVER)
        assertEquals(1, calls); assertNull(f.subject()); assertTrue(f.client.state is State.Unavailable)
    }
    @Test fun testObserverMayAcceptBeginNewOwnerThenEndCancelOldAndThrow() {
        for (onLoading in listOf(false, true)) Fixture().use { f ->
            var fresh: ReadHandle? = null
            f.onState = { old, state ->
                if (fresh == null && ((onLoading && state is State.Loading) || (!onLoading && state is State.Resolved))) {
                    f.onState = null
                    val owner = f.replace(); fresh = f.begin(owner)
                    f.client.end(old.owner); f.client.cancelRead(old)
                    throw IllegalStateException("old observer after new owner")
                }
            }
            val old = f.begin()
            f.runWorker(); f.deliver()
            f.finish(checkNotNull(fresh)); exceptional(old, ExecutionKind.OBSERVER)
            assertEquals("New-Subject", f.subject()); assertFalse(f.port.value!!.requester.isClosed)
        }
    }
    @Test fun testObserverCloseCannotBeUndoneByOldFinalization() {
        for (loading in listOf(false, true)) Fixture().use { f ->
            f.onState = { _, state -> if ((loading && state is State.Loading) || (!loading && state is State.Resolved)) f.client.close() }
            val handle = f.begin(); f.runWorker(); f.deliver(); settled(handle)
            assertTrue(f.client.state is State.Closed); assertNull(f.client.acceptCurrentOwner()); assertFalse(f.port.value!!.requester.isClosed)
        }
    }
    @Test fun testOwnerPortCaptureReentryIsStickyEvenIfPortCatchesIt() = Fixture().use { f ->
        f.port.capture = { try { f.client.close() } catch (_: CurrentCoreIdentityClient.OwnerPortContractException) { } }
        assertThrows(CurrentCoreIdentityClient.OwnerPortContractException::class.java) { f.client.acceptCurrentOwner() }
        assertTrue(f.client.state is State.Closed); assertTrue(f.wire.requests.isEmpty()); assertFalse(f.port.value!!.requester.isClosed)
    }
    @Test fun testOwnerPortCaptureThrowStartsNoWorkerAndPermanentlyClosesReader() = Fixture().use { f ->
        f.port.capture = { throw IllegalStateException("synthetic capture failure") }
        assertThrows(CurrentCoreIdentityClient.OwnerPortContractException::class.java) { f.client.acceptCurrentOwner() }
        f.port.capture = null
        assertTrue(f.client.state is State.Closed); assertNull(f.client.acceptCurrentOwner())
        assertTrue(f.workers.tasks.isEmpty()); assertEquals(0, (f.tokens as FakeTokens).requested.get())
    }
    @Test fun testStalePrivateTicketShortCircuitsBeforeAThrowingOwnerPort() = Fixture().use { f ->
        val old = f.begin(); f.runWorker(); val owner = f.replace()
        f.port.check = { throw IllegalStateException("must not consult port for old ticket") }
        f.deliver(); assertTrue(settled(old) is Disposition.Dropped)
        assertFalse(f.client.state is State.Closed)
        f.port.check = null; f.finish(f.begin(owner)); assertEquals("New-Subject", f.subject())
    }
    @Test fun testOwnerPortThrowDuringPublishSettlesItsHandleAndClosesOnlyReader() = Fixture().use { f ->
        val handle = f.begin(); f.runWorker(); f.port.check = { throw IllegalStateException("synthetic port violation") }
        f.deliver(); exceptional(handle, ExecutionKind.OWNER_PORT)
        assertTrue(f.client.state is State.Closed); assertFalse(f.port.value!!.requester.isClosed)
    }
    @Test fun testOwnerPortPublishReentryCannotAcceptIdentityOrSuppressViolation() = Fixture().use { f ->
        val handle = f.begin(); f.runWorker()
        f.port.check = { try { f.client.acceptCurrentOwner() } catch (_: CurrentCoreIdentityClient.OwnerPortContractException) { } }
        f.deliver(); exceptional(handle, ExecutionKind.OWNER_PORT); assertTrue(f.client.state is State.Closed); assertNull(f.subject())
    }
    @Test fun testCompletionCannotBeSettledBeforeTheBeginObserverReturns() = Fixture().use { f ->
        f.delivery.reject = true
        f.onState = { handle, state -> if (state is State.Loading) {
            val thread = Thread({ f.runWorker() }, "identity-fast-worker")
            thread.start(); thread.join(Fixtures.COLD_START_MILLIS); assertFalse(thread.isAlive)
            assertFalse("begin observer is still executing", handle.completion.toCompletableFuture().isDone)
        } }
        val handle = f.begin(); exceptional(handle, ExecutionKind.DELIVERY_REJECTED); assertNull(f.subject())
    }
    @Test fun testFirstObserverFailureRetainsSecondaryWorkerAndDeliveryFailures() = Fixture().use { f ->
        val original = IllegalStateException("synthetic original observer")
        f.onState = { _, _ -> throw original }
        val handle = f.begin()
        f.beforeDelivery = { throw IllegalArgumentException("synthetic secondary worker") }
        f.delivery.reject = true; f.runWorker()
        exceptional(handle, ExecutionKind.OBSERVER)
        val failure = assertThrows(ExecutionException::class.java) { handle.completion.toCompletableFuture().get() }.cause!!
        assertSame(original, failure.cause); assertEquals(2, failure.suppressed.size)
        assertNull(f.subject())
    }
    @Test fun testOutcomeAndStateStringsDoNotExposeSubjectOrResponseData() = Fixture().use { f ->
        val handle = f.begin(); f.finish(handle)
        assertFalse(f.client.state.toString().contains("Case-Sensitive|Subject"))
        assertFalse(decode(me()).toString().contains("Case-Sensitive|Subject"))
        assertFalse(handle.toString().contains("synthetic-access"))
    }
    @Test fun nilMemberIdentityAndMembershipEntitiesNeverBecomeCurrentIdentity() {
        val nil = "00000000-0000-0000-0000-000000000000"
        val edits = listOf<JsonObject.() -> Unit>(
            { addProperty("id", nil) },
            { currentIdentity(this).addProperty("id", nil) },
            { currentMember(this).getAsJsonObject("organisation").addProperty("id", nil) },
            { currentMember(this).addProperty("identity_id", nil) })
        for (edit in edits) expectedFailure(me().apply(edit))
    }

}
