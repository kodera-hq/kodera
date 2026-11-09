package io.kodera.android.client

import io.kodera.android.domain.TrustPolicy
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.FutureTask
import java.util.function.BiConsumer
import java.util.function.BiFunction
import java.util.function.Consumer
import java.util.function.Function

/**
 * An unwired, serially owned reader of Core's current identity projection. A truthful [OwnerPort]
 * must capture and retire the real session owner coherently; neither a response nor this local
 * handle establishes authentication provenance. All lifecycle calls, [state] reads and delivery
 * tasks must use the same serial context. Workers must run elsewhere. Borrowed executors must run
 * accepted tasks once eventually, or reject synchronously; silent discard is unsupported.
 */
class CurrentCoreIdentityClient internal constructor(
    private val configuration: SignInConfiguration,
    private val owners: OwnerPort,
    private val workers: Executor,
    private val delivery: Executor,
    private val isOnSerial: () -> Boolean,
    private val onReadState: (ReadHandle, State) -> Unit,
    private val beforeDeliveryForTest: (Outcome) -> Unit,
) : AutoCloseable {
    constructor(configuration: SignInConfiguration, owners: OwnerPort, workers: Executor,
        delivery: Executor, isOnSerial: () -> Boolean, onReadState: (ReadHandle, State) -> Unit) :
        this(configuration, owners, workers, delivery, isOnSerial, onReadState, {})

    /** Local context, not an authentication certificate. A retired marker must never be reused. */
    class OwnerSnapshot(val marker: Any, val requester: CoreRequester, val session: Session,
        val organisationId: String) {
        override fun toString(): String = "OwnerSnapshot(<redacted>)"
    }

    /** Bounded, pure, synchronous and nonreentrant; never acquire a token or mutate the owner here. */
    interface OwnerPort {
        fun current(): OwnerSnapshot?
        fun isCurrent(snapshot: OwnerSnapshot): Boolean
    }

    class OwnerHandle internal constructor(internal val snapshot: OwnerSnapshot) {
        internal var ended = false
        override fun toString(): String = "OwnerHandle(<local>)"
    }

    /** Plain Core observation. Subject spelling is preserved; provider compatibility is unproved. */
    data class CoreIdentity(val id: String, val issuer: String, val realm: String, val subject: String,
        val organisationId: String) {
        override fun toString(): String = "CoreIdentity(<redacted>)"
    }

    sealed interface Failure {
        data object ProtocolViolation : Failure
        data object NotEligible : Failure
        data object Forbidden : Failure
        data object ServiceUnavailable : Failure
        data object IdentityUnavailable : Failure
        data class Transport(val reason: TransportFailure) : Failure
        data class Execution(val kind: ExecutionKind) : Failure
    }

    sealed interface Outcome {
        data class Identity(val identity: CoreIdentity) : Outcome {
            override fun toString(): String = "Identity(<redacted>)"
        }
        data class Unavailable(val failure: Failure) : Outcome
        data object SignedOut : Outcome
    }

    sealed interface State {
        data object Idle : State
        data class Loading(val owner: OwnerHandle) : State
        data class Resolved(val owner: OwnerHandle, val identity: CoreIdentity) : State
        data class Unavailable(val owner: OwnerHandle?, val failure: Failure) : State
        data class SignedOut(val owner: OwnerHandle) : State
        data class Closed(val cause: ExecutionKind? = null) : State
    }

    enum class ExecutionKind { WORKER, WORKER_REJECTED, DELIVERY_REJECTED, OBSERVER, OWNER_PORT }
    enum class DeliveryKind { IDENTITY, UNAVAILABLE, SIGNED_OUT }
    enum class DropReason { CANCELLED, SUPERSEDED, ENDED, CLOSED, NOT_CURRENT, EXECUTION }
    sealed interface Disposition {
        data class Delivered(val kind: DeliveryKind) : Disposition
        data class Dropped(val reason: DropReason) : Disposition
    }

    /** The original exception is for explicit handling, never presentation or logging as UI copy. */
    class ReadExecutionException(val kind: ExecutionKind, cause: Throwable) :
        Exception("Identity read execution failed", cause)
    class OwnerPortContractException(cause: Throwable? = null) :
        IllegalStateException("Identity owner port contract violated", cause)

    /** Completion acknowledges begin, terminated callable AND final reduction/drop, never just fetch. */
    class ReadHandle internal constructor(val owner: OwnerHandle) {
        private val promise = CompletableFuture<Disposition>()
        val completion: CompletionStage<Disposition> = ReadOnlyCompletion(promise)
        private var beginDone = false
        private var workerDone = false
        private var reductionDone = false
        private var failure: ReadExecutionException? = null
        private var disposition: Disposition = Disposition.Dropped(DropReason.NOT_CURRENT)
        internal var drop: DropReason? = null // Serial context only; never consulted by a worker.

        @Synchronized internal fun fail(kind: ExecutionKind, cause: Throwable) {
            val next = ReadExecutionException(kind, cause)
            val first = failure
            if (first == null) failure = next else first.addSuppressed(next)
        }
        @Synchronized internal fun failureKind(): ExecutionKind? = failure?.kind
        @Synchronized internal fun began() { beginDone = true; settle() }
        @Synchronized internal fun worked() { workerDone = true; settle() }
        @Synchronized internal fun reduced(value: Disposition) { disposition = value; reductionDone = true; settle() }
        private fun settle() {
            if (!beginDone || !workerDone || !reductionDone) return
            val error = failure
            if (error == null) promise.complete(disposition) else promise.completeExceptionally(error)
        }
        override fun toString(): String = "ReadHandle(<local>)"
    }

    /**
     * The original 38 API24 CompletionStage members, explicit for compiled reference inspection.
     * The stable facade cannot be cast to a mutable future. Every conversion returns an isolated
     * dependent; changing it never settles or cancels the private promise. Newer platform default
     * methods are not invoked here. This does not establish an API26 device execution proof.
     */
    private class ReadOnlyCompletion<T>(private val promise: CompletableFuture<T>) : CompletionStage<T> {
        override fun <U> thenApply(fn: Function<in T, out U>): CompletionStage<U> = promise.thenApply(fn)
        override fun <U> thenApplyAsync(fn: Function<in T, out U>): CompletionStage<U> = promise.thenApplyAsync(fn)
        override fun <U> thenApplyAsync(fn: Function<in T, out U>, executor: Executor): CompletionStage<U> = promise.thenApplyAsync(fn, executor)
        override fun thenAccept(action: Consumer<in T>): CompletionStage<Void> = promise.thenAccept(action)
        override fun thenAcceptAsync(action: Consumer<in T>): CompletionStage<Void> = promise.thenAcceptAsync(action)
        override fun thenAcceptAsync(action: Consumer<in T>, executor: Executor): CompletionStage<Void> = promise.thenAcceptAsync(action, executor)
        override fun thenRun(action: Runnable): CompletionStage<Void> = promise.thenRun(action)
        override fun thenRunAsync(action: Runnable): CompletionStage<Void> = promise.thenRunAsync(action)
        override fun thenRunAsync(action: Runnable, executor: Executor): CompletionStage<Void> = promise.thenRunAsync(action, executor)
        override fun <U, V> thenCombine(other: CompletionStage<out U>, fn: BiFunction<in T, in U, out V>): CompletionStage<V> = promise.thenCombine(other, fn)
        override fun <U, V> thenCombineAsync(other: CompletionStage<out U>, fn: BiFunction<in T, in U, out V>): CompletionStage<V> = promise.thenCombineAsync(other, fn)
        override fun <U, V> thenCombineAsync(other: CompletionStage<out U>, fn: BiFunction<in T, in U, out V>, executor: Executor): CompletionStage<V> = promise.thenCombineAsync(other, fn, executor)
        override fun <U> thenAcceptBoth(other: CompletionStage<out U>, action: BiConsumer<in T, in U>): CompletionStage<Void> = promise.thenAcceptBoth(other, action)
        override fun <U> thenAcceptBothAsync(other: CompletionStage<out U>, action: BiConsumer<in T, in U>): CompletionStage<Void> = promise.thenAcceptBothAsync(other, action)
        override fun <U> thenAcceptBothAsync(other: CompletionStage<out U>, action: BiConsumer<in T, in U>, executor: Executor): CompletionStage<Void> = promise.thenAcceptBothAsync(other, action, executor)
        override fun runAfterBoth(other: CompletionStage<*>, action: Runnable): CompletionStage<Void> = promise.runAfterBoth(other, action)
        override fun runAfterBothAsync(other: CompletionStage<*>, action: Runnable): CompletionStage<Void> = promise.runAfterBothAsync(other, action)
        override fun runAfterBothAsync(other: CompletionStage<*>, action: Runnable, executor: Executor): CompletionStage<Void> = promise.runAfterBothAsync(other, action, executor)
        override fun <U> applyToEither(other: CompletionStage<out T>, fn: Function<in T, U>): CompletionStage<U> = promise.applyToEither(other, fn)
        override fun <U> applyToEitherAsync(other: CompletionStage<out T>, fn: Function<in T, U>): CompletionStage<U> = promise.applyToEitherAsync(other, fn)
        override fun <U> applyToEitherAsync(other: CompletionStage<out T>, fn: Function<in T, U>, executor: Executor): CompletionStage<U> = promise.applyToEitherAsync(other, fn, executor)
        override fun acceptEither(other: CompletionStage<out T>, action: Consumer<in T>): CompletionStage<Void> = promise.acceptEither(other, action)
        override fun acceptEitherAsync(other: CompletionStage<out T>, action: Consumer<in T>): CompletionStage<Void> = promise.acceptEitherAsync(other, action)
        override fun acceptEitherAsync(other: CompletionStage<out T>, action: Consumer<in T>, executor: Executor): CompletionStage<Void> = promise.acceptEitherAsync(other, action, executor)
        override fun runAfterEither(other: CompletionStage<*>, action: Runnable): CompletionStage<Void> = promise.runAfterEither(other, action)
        override fun runAfterEitherAsync(other: CompletionStage<*>, action: Runnable): CompletionStage<Void> = promise.runAfterEitherAsync(other, action)
        override fun runAfterEitherAsync(other: CompletionStage<*>, action: Runnable, executor: Executor): CompletionStage<Void> = promise.runAfterEitherAsync(other, action, executor)
        override fun <U> thenCompose(fn: Function<in T, out CompletionStage<U>>): CompletionStage<U> = promise.thenCompose(fn)
        override fun <U> thenComposeAsync(fn: Function<in T, out CompletionStage<U>>): CompletionStage<U> = promise.thenComposeAsync(fn)
        override fun <U> thenComposeAsync(fn: Function<in T, out CompletionStage<U>>, executor: Executor): CompletionStage<U> = promise.thenComposeAsync(fn, executor)
        override fun exceptionally(fn: Function<Throwable, out T>): CompletionStage<T> = promise.exceptionally(fn)
        override fun whenComplete(action: BiConsumer<in T, in Throwable>): CompletionStage<T> = promise.whenComplete(action)
        override fun whenCompleteAsync(action: BiConsumer<in T, in Throwable>): CompletionStage<T> = promise.whenCompleteAsync(action)
        override fun whenCompleteAsync(action: BiConsumer<in T, in Throwable>, executor: Executor): CompletionStage<T> = promise.whenCompleteAsync(action, executor)
        override fun <U> handle(fn: BiFunction<in T, Throwable, out U>): CompletionStage<U> = promise.handle(fn)
        override fun <U> handleAsync(fn: BiFunction<in T, Throwable, out U>): CompletionStage<U> = promise.handleAsync(fn)
        override fun <U> handleAsync(fn: BiFunction<in T, Throwable, out U>, executor: Executor): CompletionStage<U> = promise.handleAsync(fn, executor)
        override fun toCompletableFuture(): CompletableFuture<T> = promise.thenApply(object : Function<T, T> {
            override fun apply(value: T): T = value
        })
    }

    private var closed = false
    private var owner: OwnerHandle? = null
    private var read: ReadHandle? = null
    private var presentation: State = State.Idle
    private var inPort = false
    private var portViolation = false

    val state: State get() { enter(); reconcile(); return presentation }

    fun acceptCurrentOwner(): OwnerHandle? {
        enter(); reconcile()
        if (closed) return null
        val snapshot = port { owners.current() }
        if (snapshot == null || !valid(snapshot)) {
            retire(DropReason.ENDED); presentation = State.Idle
            return null
        }
        val previous = owner
        if (previous != null && !previous.ended && same(previous.snapshot, snapshot)) return previous
        retire(DropReason.SUPERSEDED)
        return OwnerHandle(snapshot).also { owner = it; presentation = State.Idle }
    }

    fun beginRead(accepted: OwnerHandle): ReadHandle? {
        enter(); reconcile()
        if (closed || owner !== accepted || accepted.ended) return null
        if (!valid(accepted.snapshot) || !port { owners.isCurrent(accepted.snapshot) }) {
            retire(DropReason.ENDED); presentation = State.Idle
            return null
        }
        read?.let { if (presentation is State.Loading) return it }
        val handle = ReadHandle(accepted)
        read = handle
        presentation = State.Loading(accepted)
        val task = object : FutureTask<Outcome>({
            check(!isOnSerial()) { "Identity worker requires a separate context" }
            fetch(accepted.snapshot).also(beforeDeliveryForTest)
        }) {
            override fun done() {
                // FutureTask invokes done only after the callable terminates. This get never waits.
                val outcome = try { get() } catch (error: ExecutionException) {
                    handle.fail(ExecutionKind.WORKER, error.cause ?: error); null
                } catch (error: Throwable) { handle.fail(ExecutionKind.WORKER, error); null }
                handle.worked()
                try { delivery.execute { reduce(handle, outcome) } }
                catch (error: Throwable) {
                    handle.fail(ExecutionKind.DELIVERY_REJECTED, error)
                    // No presentation mutation or observer fallback on this worker thread.
                    handle.reduced(Disposition.Dropped(DropReason.EXECUTION))
                }
            }
        }
        try {
            try { workers.execute(task) }
            catch (error: Throwable) {
                handle.fail(ExecutionKind.WORKER_REJECTED, error)
                handle.worked()
                reduce(handle, null)
                return handle
            }
            // Work is already scheduled. Reentry can retire it, but cannot schedule it again.
            notify(handle, State.Loading(accepted))
            return handle
        } finally { handle.began() }
    }

    fun cancelRead(handle: ReadHandle) {
        enter(); reconcile()
        if (!closed && read === handle) {
            handle.drop = DropReason.CANCELLED; read = null; presentation = State.Idle
        }
    }

    fun end(accepted: OwnerHandle) {
        enter(); reconcile()
        if (!closed && owner === accepted) { retire(DropReason.ENDED); presentation = State.Idle }
    }

    override fun close() {
        enter()
        if (!closed) closeLocal(null)
    }

    private fun enter() {
        if (inPort) {
            portViolation = true
            throw OwnerPortContractException()
        }
        check(isOnSerial()) { "Identity reader requires its serial context" }
    }

    private fun <T> port(call: () -> T): T {
        inPort = true; portViolation = false
        val result: T
        try {
            result = call()
            if (portViolation) throw OwnerPortContractException()
        } catch (error: Throwable) {
            closeLocal(ExecutionKind.OWNER_PORT)
            throw OwnerPortContractException(error)
        } finally { inPort = false }
        return result
    }

    private fun same(a: OwnerSnapshot, b: OwnerSnapshot): Boolean =
        a.marker === b.marker && a.requester === b.requester && a.session == b.session &&
            a.organisationId == b.organisationId

    private fun valid(snapshot: OwnerSnapshot): Boolean {
        if (snapshot.requester.isClosed || !TrustPolicy.canonicalNonNilUUID(snapshot.organisationId)) return false
        val admitted = try { configuration.admit(snapshot.session.issuer) } catch (_: SignInException) { return false }
        return admitted.realm == snapshot.session.realm
    }

    private fun retire(reason: DropReason) {
        owner?.ended = true
        read?.drop = reason
        read = null; owner = null
    }

    private fun closeLocal(cause: ExecutionKind?) {
        retire(DropReason.CLOSED); closed = true; presentation = State.Closed(cause)
    }

    /** Only the exact current handle can reconcile a worker-side delivery rejection. No callback. */
    private fun reconcile() {
        val current = read ?: return
        val failure = current.failureKind() ?: return
        if (!closed && owner === current.owner && !current.owner.ended) {
            presentation = State.Unavailable(current.owner, Failure.Execution(failure))
        }
    }

    /** The complete data-publication fence, intentionally in one place with no later stale guard. */
    private fun mayPublish(handle: ReadHandle): Boolean {
        val captured = handle.owner.snapshot
        return !closed && owner === handle.owner && !handle.owner.ended && read === handle &&
            presentation is State.Loading && handle.failureKind() == null &&
            captured.requester === owner?.snapshot?.requester && !captured.requester.isClosed &&
            captured.session == owner?.snapshot?.session && captured.organisationId == owner?.snapshot?.organisationId &&
            port { owners.isCurrent(captured) }
    }

    private fun reduce(handle: ReadHandle, outcome: Outcome?) {
        enter()
        var disposition: Disposition = Disposition.Dropped(handle.drop ?: DropReason.NOT_CURRENT)
        try {
            if (handle.failureKind() != null) { reconcile(); return }
            val allowed = try { mayPublish(handle) } catch (error: OwnerPortContractException) {
                handle.fail(ExecutionKind.OWNER_PORT, error); return
            }
            if (!allowed) return
            val value = checkNotNull(outcome)
            val next = when (value) {
                is Outcome.Identity -> State.Resolved(handle.owner, value.identity)
                is Outcome.Unavailable -> State.Unavailable(handle.owner, value.failure)
                Outcome.SignedOut -> State.SignedOut(handle.owner)
            }
            presentation = next
            if (notify(handle, next)) disposition = Disposition.Delivered(when (value) {
                is Outcome.Identity -> DeliveryKind.IDENTITY
                is Outcome.Unavailable -> DeliveryKind.UNAVAILABLE
                Outcome.SignedOut -> DeliveryKind.SIGNED_OUT
            })
        } finally { handle.reduced(disposition) }
    }

    private fun notify(handle: ReadHandle, next: State): Boolean {
        return try { onReadState(handle, next); true }
        catch (error: Throwable) {
            handle.fail(ExecutionKind.OBSERVER, error)
            // Observer reentry may already have installed G2 or closed this reader.
            if (!closed && read === handle && owner === handle.owner && !handle.owner.ended) {
                presentation = State.Unavailable(handle.owner, Failure.Execution(checkNotNull(handle.failureKind())))
            }
            false
        }
    }

    private fun fetch(snapshot: OwnerSnapshot): Outcome = when (val reply = snapshot.requester.get("/api/v1/me") { response ->
        when (response.code) {
            200 -> CoreRequester.bounded(response.body.byteStream())?.let { decode(it, snapshot.session, snapshot.organisationId) }
                ?: Outcome.Unavailable(Failure.ProtocolViolation)
            429, in 500..599 -> Outcome.Unavailable(Failure.ServiceUnavailable)
            else -> Outcome.Unavailable(Failure.ProtocolViolation)
        }
    }) {
        is CoreReply.Answered -> reply.value
        CoreReply.Forbidden -> Outcome.Unavailable(Failure.Forbidden)
        CoreReply.SignedOut -> Outcome.SignedOut
        CoreReply.IdentityUnavailable -> Outcome.Unavailable(Failure.IdentityUnavailable)
        CoreReply.Unsendable, CoreReply.PathRefused -> Outcome.Unavailable(Failure.ProtocolViolation)
        is CoreReply.Transport -> Outcome.Unavailable(Failure.Transport(reply.reason))
    }

    internal companion object {
        /** Minimal consumed projection; ignored fields still pass the global strict JSON parser. */
        fun decode(data: ByteArray, session: Session, organisationId: String): Outcome = try {
            val root = StrictJson.parse(data).objectValue()
            if (!TrustPolicy.canonicalNonNilUUID(root["id"]?.stringValue() ?: refused()) ||
                root["staff"] != JsonValue.BooleanValue(false)) refused()
            val ids = hashSetOf<String>()
            val issuers = hashSetOf<String>()
            val identities = root["identities"]?.arrayValue()?.associate { entry ->
                val value = entry.objectValue()
                val id = value["id"]?.stringValue() ?: refused()
                val issuer = value["issuer"]?.stringValue() ?: refused()
                val realm = value["realm"]?.stringValue() ?: refused()
                val subject = value["subject"]?.stringValue() ?: refused()
                if (!TrustPolicy.canonicalNonNilUUID(id) || !ids.add(id) || !issuers.add(issuer) ||
                    issuer.length !in 1..2048 || issuer.any { it.code !in 33..126 } ||
                    !TrustPolicy.canonicalSlug(realm) || subject.length !in 1..255 || subject.any { it.code !in 33..126 }) refused()
                id to CoreIdentity(id, issuer, realm, subject, organisationId)
            } ?: refused()
            val entries = root["organisations"]?.arrayValue() ?: refused()
            if (entries.size > 100) refused()
            val orgIds = hashSetOf<String>()
            var matches = 0
            var target: String? = null
            var active = false
            var link: String? = null
            for (entry in entries) {
                val membership = entry.objectValue()
                val org = membership["organisation"]?.objectValue() ?: refused()
                val id = org["id"]?.stringValue() ?: refused()
                val slug = org["slug"]?.stringValue() ?: refused()
                val realm = org["realm"]?.takeUnless { it == JsonValue.NullValue }?.stringValue()
                val state = membership["state"]?.stringValue() ?: refused()
                val identityId = membership["identity_id"]?.stringValue()
                if (!TrustPolicy.canonicalNonNilUUID(id) || !orgIds.add(id) || !TrustPolicy.canonicalSlug(slug) ||
                    (realm != null && (!TrustPolicy.canonicalSlug(realm) || realm != slug)) ||
                    state !in setOf("invited", "active", "suspended", "removed") ||
                    (identityId != null && !TrustPolicy.canonicalNonNilUUID(identityId))) refused()
                if (realm == session.realm) { matches++; target = id; active = state == "active"; link = identityId }
            }
            if (matches > 1) refused()
            if (matches == 0 || target != organisationId || !active || link == null) Outcome.Unavailable(Failure.NotEligible)
            else {
                val selected = identities[link] ?: refused()
                if (selected.issuer != session.issuer || selected.realm != session.realm) refused()
                Outcome.Identity(selected)
            }
        } catch (_: DiscoveryDecodingException) { Outcome.Unavailable(Failure.ProtocolViolation) }
    }
}
