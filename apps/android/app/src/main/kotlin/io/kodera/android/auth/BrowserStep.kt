package io.kodera.android.auth

import android.content.Intent
import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** What the session owner asks of the browser step. [AppAuthBackend] in the app; a fake in host tests. */
internal interface BrowserAuthorization {
    fun attach(presenter: AuthorizationPresenter)
    fun detach(presenter: AuthorizationPresenter)
    /** The browser step's Activity result. False when no open browser step waits for it. */
    fun onAuthorizationResult(data: Intent?): Boolean
    /** Cancels the sign-in in flight, at whatever step it is. False when there is none. */
    fun cancelAuthorization(): Boolean
}

/**
 * The one sign-in that may hold the browser at a time, and the bounded wait for its answer. Pure JVM,
 * so host tests drive it with strings; the AppAuth adapter holds one for Activity results.
 *
 * A sign-in claims the step before discovery and releases it after the code exchange, so [cancel]
 * reaches it at every step. Only a claim whose browser is open takes an answer: a result left over
 * from an earlier sign-in is never read as this one's.
 */
internal class BrowserStep<T : Any>(private val limitMillis: Long = LIMIT_MILLIS) {
    class Claim<V : Any> internal constructor() {
        internal val answered = CountDownLatch(1)
        internal var result: V? = null
        internal var awaiting = false
        @Volatile var cancelled = false
            internal set
    }

    private val lock = Any()
    private var current: Claim<T>? = null
    private var closed = false

    /** This sign-in's claim; null when the step is closed or another sign-in holds it. */
    fun claim(): Claim<T>? = synchronized(lock) {
        if (closed || current != null) null else Claim<T>().also { current = it }
    }

    /** The browser is about to open for [claim]: from now on an answer is its own. */
    fun presenting(claim: Claim<T>) {
        synchronized(lock) { if (current === claim && !claim.cancelled) claim.awaiting = true }
    }

    /** The browser's answer. False when no claim with an open browser waits for it. */
    fun deliver(result: T?): Boolean = synchronized(lock) {
        val waiting = current
        if (waiting == null || !waiting.awaiting) false
        else {
            waiting.awaiting = false
            waiting.result = result
            waiting.answered.countDown()
            true
        }
    }

    /** Cancels the claim in flight at whatever step it is. False when there is none to cancel. */
    fun cancel(): Boolean = synchronized(lock) {
        val waiting = current
        if (waiting == null || waiting.cancelled) false
        else {
            waiting.cancelled = true
            waiting.awaiting = false
            waiting.answered.countDown()
            true
        }
    }

    /** No claim is granted again, and the one in flight is cancelled. */
    fun close() {
        synchronized(lock) { closed = true }
        cancel()
    }

    /**
     * Waits for the browser's answer to [claim], at most [limitMillis]. Past it the claim is cancelled,
     * so an answer that still arrives is not taken (the interface reports an interrupted sign-in).
     * @throws BackendException with [BackendFailure.CANCELLED] when cancelled, timed out or answered
     *   without data.
     */
    fun await(claim: Claim<T>): T {
        val answered = try { claim.answered.await(limitMillis, TimeUnit.MILLISECONDS) }
            catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
        val result = synchronized(lock) {
            claim.awaiting = false
            if (!answered) claim.cancelled = true
            if (claim.cancelled) null else claim.result
        }
        return result ?: throw BackendException(BackendFailure.CANCELLED)
    }

    /** Between a sign-in's steps: refuses to go on once [claim] was cancelled. */
    fun ensureLive(claim: Claim<T>) {
        if (claim.cancelled) throw BackendException(BackendFailure.CANCELLED)
    }

    /** The sign-in is over, whatever its outcome: the step is free for the next one. */
    fun release(claim: Claim<T>) {
        synchronized(lock) { if (current === claim) current = null }
    }

    companion object {
        /**
         * How long the browser step may stay open. A member who closes the tab answers at once
         * (AppAuth reports a cancel); this bounds the case where no answer ever comes. Parity with
         * kodera-ios's browser watchdog.
         */
        const val LIMIT_MILLIS = 600_000L
    }
}
