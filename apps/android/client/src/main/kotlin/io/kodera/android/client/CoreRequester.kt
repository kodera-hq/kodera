package io.kodera.android.client

import io.kodera.android.domain.DomainFailure
import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.LoopbackPolicy
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Why an access token could not be supplied. */
enum class AccessTokenFailure {
    /** The grant is gone (refused refresh, revoked, never signed in). The stored state is already wiped. */
    SIGNED_OUT,
    /** The identity provider could not be reached; the stored state is kept. */
    UNAVAILABLE,
}

class AccessTokenException(val failure: AccessTokenFailure) : Exception(failure.name)

/** A currently valid access token, and the session (the sign-in generation) it was issued in. Secret. */
class AccessToken(val value: String, val session: Long) {
    override fun toString(): String = "AccessToken(<redacted>)"
}

/** The sign-in owner, seen from Core clients. Implementations never log or expose tokens otherwise. */
interface AccessTokenProvider {
    /**
     * A currently valid access token, refreshed first when it has expired or when [forceRefresh] is
     * set. Blocks; never call it on the main thread.
     * @throws AccessTokenException
     */
    fun accessToken(forceRefresh: Boolean): AccessToken
    /**
     * Core refused [token] even freshly refreshed: end the session it was issued in, wiped locally and
     * not revoked (only an explicit sign-out revokes). A no-op when that session has already ended or
     * been replaced. Blocks.
     */
    fun endSession(token: AccessToken)
}

/** What one authorised Core request came to. [Answered] carries what the caller's reader made of it. */
internal sealed interface CoreReply<out T> {
    /** Core answered with a status other than 401 or 403, and the caller's reader mapped the response. */
    data class Answered<T>(val value: T) : CoreReply<T>
    /** 403: no access. It is not retried, and the session is kept. */
    data object Forbidden : CoreReply<Nothing>
    /** The session ended: Core refused a freshly refreshed token, or the refresh itself was refused. */
    data object SignedOut : CoreReply<Nothing>
    /** The identity provider could not be reached for a token; nothing was sent to Core. */
    data object IdentityUnavailable : CoreReply<Nothing>
    /** The request could not be built (a token OkHttp refuses); nothing was sent. */
    data object Unsendable : CoreReply<Nothing>
    /**
     * The path could leave the Core origin ([CoreRequester.staysOnOrigin]). It was refused before any
     * token was asked for, and nothing was sent.
     */
    data object PathRefused : CoreReply<Nothing>
    /**
     * The exchange did not complete; or, as [TransportFailure.OTHER], the calling thread was interrupted
     * before a session end, or the requester was closed.
     */
    data class Transport(val reason: TransportFailure) : CoreReply<Nothing>
}

/** Test gates run outside the service lock; only client tests can install them. */
internal class SendAdmissionGates(val before: () -> Unit = {}, val after: () -> Unit = {})

/**
 * The one path every authorised Core request takes, so the refusal policy lives in one place.
 *
 * It is bound to one Core origin, validated once at construction with [IssuerAdmission.validateOrigin],
 * and a request names only a path on it: a path [staysOnOrigin] does not admit is refused before any
 * token is asked for. With no redirect followed, the bearer token goes to that origin and nowhere else.
 * The app builds one requester per signed-in session, so one OkHttp client and connection pool, hands
 * it to every Core client of that session, and closes it once when the session ends. A request started
 * after [close] asks for no token and sends nothing. One in flight stops at its next check: before the
 * forced refresh, before each send, and before a local session end. A request already sent is not
 * cancelled; its answer comes back, but nothing more is sent or ended for it.
 *
 * A real sign-in service is captured once as its exact accepted receipt; an absent or retired owner
 * never falls back to the service's latest token. R admits provider work after refresh serialization;
 * S admits each send with the same receipt and full token generation. Already-admitted work can finish
 * with its original grant/token after retirement. No network or observer runs under the service lock.
 *
 * The bearer comes from the sign-in owner. A 401 earns exactly one forced refresh and one retry; a
 * second 401 ends the session the refused token was issued in, locally and without revoking, and never
 * one that replaced it. A 403 is "no access", with no retry and no sign-out. Requests go out on the
 * shared bounded policy ([CoreDiscoveryClient.buildPolicy]): no cookie, cache, redirect, retry or
 * authenticator. Blocks; call it off the main thread.
 */
class CoreRequester private constructor(coreApiOrigin: String, loopback: LoopbackPolicy,
    private val tokens: AccessTokenProvider, route: ClientTestRoute?, timeoutMillis: Long,
    private val owner: AcceptedOwner? = (tokens as? SignInService)?.captureAcceptedOwner(),
    private val ownerRequired: Boolean = tokens is SignInService,
    private val admissions: SendAdmissionGates = SendAdmissionGates()) : AutoCloseable {
    private val origin: String
    private val http: OkHttpClient
    @Volatile private var closed = false

    init {
        try { IssuerAdmission.validateOrigin(coreApiOrigin, loopback) }
        catch (error: DomainFailure) { throw IllegalArgumentException("Core origin refused", error) }
        origin = coreApiOrigin
        http = CoreDiscoveryClient.buildPolicy(route, timeoutMillis, false)
    }

    /** @throws IllegalArgumentException when [coreApiOrigin] is not admissible under [loopback]. */
    constructor(coreApiOrigin: String, loopback: LoopbackPolicy, tokens: AccessTokenProvider) :
        this(coreApiOrigin, loopback, tokens, null, 15000)

    /** Uses the exact acceptance returned by sign-in/restore, even if it retired before construction. */
    constructor(coreApiOrigin: String, loopback: LoopbackPolicy, owner: AcceptedOwner) :
        this(coreApiOrigin, loopback, owner.service, null, 15000, owner, true)

    // Internal test seam; production callers cannot supply a fixture route or admission gates.
    internal constructor(coreApiOrigin: String, tokens: AccessTokenProvider, route: ClientTestRoute, timeoutMillis: Long,
        admissions: SendAdmissionGates = SendAdmissionGates()) :
        this(coreApiOrigin, LoopbackPolicy.REFUSE, tokens, route, timeoutMillis, admissions = admissions)

    /** Whether [close] has run; a closed requester starts nothing more. */
    val isClosed: Boolean get() = closed

    /**
     * `GET` of [path] on the Core origin, such as `/api/v1/me`. [read] maps every answer but 401 and
     * 403, inside the response's lifetime; an [IOException] it throws (reading the body) is a transport
     * failure.
     */
    internal fun <T> get(path: String, read: (Response) -> T): CoreReply<T> {
        return send(path, null, read)
    }

    /** Bounded JSON POST through the same accepted-owner and response policy as GET. */
    internal fun <T> post(path: String, jsonBody: ByteArray, read: (Response) -> T): CoreReply<T> {
        if (jsonBody.size > BODY_LIMIT) return CoreReply.Unsendable
        return send(path, jsonBody.copyOf(), read)
    }

    private fun <T> send(path: String, jsonBody: ByteArray?, read: (Response) -> T): CoreReply<T> {
        if (!staysOnOrigin(path)) return CoreReply.PathRefused
        if (closed) return CoreReply.Transport(TransportFailure.OTHER)
        val url = origin + path
        val first = try { accessToken(false) } catch (error: AccessTokenException) { return reply(error) }
        when (val result = attempt(url, first, jsonBody, read)) {
            is Attempt.Done -> return result.reply
            Attempt.Unauthorized -> Unit
        }
        // The refreshed grant may belong to a session that replaced this one: a closed requester asks for
        // nothing more.
        if (closed) return CoreReply.Transport(TransportFailure.OTHER)
        val second = try { accessToken(true) } catch (error: AccessTokenException) { return reply(error) }
        return when (val result = attempt(url, second, jsonBody, read)) {
            is Attempt.Done -> result.reply
            Attempt.Unauthorized -> endSession(second)
        }
    }

    /**
     * Core refused a freshly refreshed token: the session [token] was issued in ends locally. Fenced by
     * that session, so a sign-in that replaced it in the meantime is left alone; and a caller whose
     * thread was interrupted by then, or whose requester was closed, has moved on, so it ends nothing. A
     * late local end would otherwise wipe, without revoking, a session the member is signing out of.
     */
    internal fun endSession(token: AccessToken): CoreReply<Nothing> {
        if (Thread.currentThread().isInterrupted || closed) return CoreReply.Transport(TransportFailure.OTHER)
        if (ownerRequired) owner?.let { it.service.endSessionFor(it, token) } else tokens.endSession(token)
        return CoreReply.SignedOut
    }

    private fun accessToken(forceRefresh: Boolean): AccessToken {
        if (!ownerRequired) return tokens.accessToken(forceRefresh)
        val captured = owner ?: throw AccessTokenException(AccessTokenFailure.SIGNED_OUT)
        return captured.service.accessTokenFor(captured, forceRefresh)
    }

    override fun close() {
        closed = true
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
    }

    private fun reply(error: AccessTokenException): CoreReply<Nothing> = when (error.failure) {
        AccessTokenFailure.SIGNED_OUT -> CoreReply.SignedOut
        AccessTokenFailure.UNAVAILABLE -> CoreReply.IdentityUnavailable
    }

    private sealed interface Attempt<out T> {
        data class Done<T>(val reply: CoreReply<T>) : Attempt<T>
        data object Unauthorized : Attempt<Nothing>
    }

    private fun <T> attempt(url: String, token: AccessToken, jsonBody: ByteArray?, read: (Response) -> T): Attempt<T> {
        // Checked before each send: the requester may have been closed while the token was fetched.
        if (closed) return Attempt.Done(CoreReply.Transport(TransportFailure.OTHER))
        val request = try {
            Request.Builder().url(url).apply {
                if (jsonBody == null) get() else post(jsonBody.toRequestBody("application/json".toMediaType()))
            }.header("Authorization", "Bearer ${token.value}")
                .header("Accept", "application/json, application/problem+json")
                .header("Accept-Encoding", "identity").header("Cache-Control", "no-store").build()
        } catch (_: IllegalArgumentException) { return Attempt.Done(CoreReply.Unsendable) }
        admissions.before()
        if (closed) return Attempt.Done(CoreReply.Transport(TransportFailure.OTHER))
        if (ownerRequired && (owner == null || !owner.service.admitSend(owner, token))) return Attempt.Done(CoreReply.SignedOut)
        // S has admitted exactly this token/attempt. Already-admitted work may finish after retirement.
        admissions.after()
        return try {
            http.newCall(request).execute().use { response ->
                when (response.code) {
                    401 -> Attempt.Unauthorized
                    403 -> Attempt.Done(CoreReply.Forbidden)
                    // A redirect is never followed: it reaches the reader as itself.
                    else -> Attempt.Done(CoreReply.Answered(read(response)))
                }
            }
        } catch (error: IOException) { Attempt.Done(CoreReply.Transport(reason(error))) }
    }

    private fun reason(error: IOException): TransportFailure = when (error) {
        is SSLException -> TransportFailure.TLS
        is InterruptedIOException -> TransportFailure.TIMEOUT
        is UnknownHostException, is ConnectException, is NoRouteToHostException -> TransportFailure.OFFLINE
        else -> TransportFailure.OTHER
    }

    internal companion object {
        const val BODY_LIMIT = 65536

        /**
         * A path is `/` and one or more segments of unreserved characters (RFC 3986: letters, digits,
         * `-`, `.`, `_`, `~`), with no empty, `.` or `..` segment. Everything else is refused: an absolute
         * URL or a path without its leading `/` (which would extend the host), `//host`, dot segments
         * (which OkHttp would resolve), and `@`, `\` (which OkHttp reads as `/`), `:`, `%` (every encoded
         * variant), `?`, `#`, whitespace and non-ASCII. A query, when a Core call needs one, is added here
         * with its own rule.
         */
        fun staysOnOrigin(path: String): Boolean {
            if (!path.startsWith("/")) return false
            for (segment in path.substring(1).split('/')) {
                if (segment.isEmpty()) return false
                if (segment == "." || segment == "..") return false
                if (!segment.all(::isUnreserved)) return false
            }
            return true
        }

        private fun isUnreserved(c: Char): Boolean =
            c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '-' || c == '.' || c == '_' || c == '~'

        /** The whole body, or null past [BODY_LIMIT]. */
        fun bounded(input: InputStream): ByteArray? = input.use {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (true) {
                val n = it.read(buffer)
                if (n < 0) break
                if (output.size() + n > BODY_LIMIT) return null
                output.write(buffer, 0, n)
            }
            output.toByteArray()
        }
    }
}
