package io.kodera.android.client

import io.kodera.android.domain.DiscoveryTrust
import io.kodera.android.domain.LoopbackPolicy
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okio.BufferedSink
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Proxy
import java.net.Socket
import java.net.SocketAddress
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/** Protected anonymous origins only; construction establishes no reachability or identity. */
class CoreDiscoveryConfiguration private constructor(val trust: DiscoveryTrust) {
    companion object {
        fun configured(coreApiOrigin: String, admittedIssuerOrigins: Set<String>,
                       loopback: LoopbackPolicy = LoopbackPolicy.REFUSE): CoreDiscoveryConfiguration {
            require(!coreApiOrigin.endsWith('/')) { "Bare Core origin required" }
            return CoreDiscoveryConfiguration(DiscoveryTrust.configured(coreApiOrigin, admittedIssuerOrigins, loopback))
        }
    }
}

/** Test routing only. Public construction cannot configure sockets, proxy or trust. */
internal data class ClientTestRoute(val originPort: Int, val socketFactory: SSLSocketFactory,
    val trustManager: X509TrustManager, val proxyPort: Int? = null)
interface DiscoveryOperation { fun cancel() }

/** What one discovery looks up: exactly one of the two members `RealmDiscoveryRequest` allows. */
sealed interface DiscoveryQuery {
    /** A canonical organisation slug, sent as typed: no URL parsing or case repair. */
    data class Slug(val slug: String) : DiscoveryQuery
    /** An approved ASCII email. Core uses only its domain, against verified organisation domains. */
    data class Email(val email: String) : DiscoveryQuery {
        override fun toString(): String = "Email(redacted)"
    }
}

/**
 * Anonymous discovery only (`discoverRealm`, `POST /api/v1/auth/discover`, contract `contracts/v0.26.0`): one
 * actual Call, with at most one superseding pending lookup, bound to the configured Core origin, with no bearer,
 * cookie, cache, redirect or retry. The request sends `Content-Type: application/json` and a fresh
 * `Idempotency-Key`, which Core checks from the headers before any quota charge, and never `Origin` or
 * `Sec-Fetch-Site`: Core refuses a browser's cross-site request on those, and a request carrying neither is a
 * native client's. A lookup is one request, so a quota answer (429 `rate-limited`) reaches the caller as it came.
 */
class CoreDiscoveryClient(private val configuration: CoreDiscoveryConfiguration?) : AutoCloseable {
    private val lock = Any()
    private var route: ClientTestRoute? = null
    private var timeoutMillis = 15000L
    private var callTimeoutMillis = 15000L
    private var platformTrust = false
    private var callbackExecutor: ExecutorService? = null
    private var beforePublish: (() -> Unit)? = null
    private var runtime: OkHttpClient? = null
    private var active: Operation? = null
    private var pending: Operation? = null
    private var closed = false

    /**
     * Test seams only. [callbackExecutor] runs every OkHttp callback, so a test can prove all of them have
     * returned; [beforePublishForTest] runs on the callback thread after a reply is decoded and before its
     * outcome is published, so a test can force cancel() into that window. Neither changes an outcome.
     * [callTimeoutMillis] bounds the whole call apart from the per-step [timeoutMillis], so a test can keep
     * one step short without a cold first handshake running out of the call's time.
     */
    internal constructor(configuration: CoreDiscoveryConfiguration?, route: ClientTestRoute,
        timeoutMillis: Long, usePlatformTrustForTest: Boolean = false,
        callbackExecutor: ExecutorService? = null, beforePublishForTest: (() -> Unit)? = null,
        callTimeoutMillis: Long = timeoutMillis) : this(configuration) {
        require(timeoutMillis in 1..15000 && callTimeoutMillis in 1..15000)
        this.route = route; this.timeoutMillis = timeoutMillis; this.callTimeoutMillis = callTimeoutMillis
        platformTrust = usePlatformTrustForTest
        this.callbackExecutor = callbackExecutor; beforePublish = beforePublishForTest
    }
    private inner class Operation(val query: DiscoveryQuery, val completion: (AnonymousDiscoveryOutcome) -> Unit) : DiscoveryOperation {
        var call: Call? = null
        var cancelled = false
        var terminal = false
        override fun cancel() { cancelOperation(this) }
    }
    fun discover(slug: String, completion: (AnonymousDiscoveryOutcome) -> Unit): DiscoveryOperation =
        discover(DiscoveryQuery.Slug(slug), completion)
    fun discover(query: DiscoveryQuery, completion: (AnonymousDiscoveryOutcome) -> Unit): DiscoveryOperation {
        val operation = Operation(query, completion)
        val valid = when (query) {
            is DiscoveryQuery.Slug -> DiscoveryEnvelope.canonicalSlug(query.slug)
            is DiscoveryQuery.Email -> DiscoveryEnvelope.approvedEmail(query.email)
        }
        var immediate: AnonymousDiscoveryOutcome? = null
        var replaced: Operation? = null
        var cancel: Call? = null
        var emptyActive: Operation? = null
        var startNow = false
        synchronized(lock) {
            when {
                closed || configuration == null -> immediate = AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.NotConfigured)
                !valid -> immediate = AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.InvalidInput)
                active == null -> { active = operation; startNow = true }
                else -> {
                    replaced = pending
                    replaced?.let { it.cancelled = true; it.terminal = true }
                    pending = operation
                    active!!.let { old -> old.cancelled = true; cancel = old.call; if (old.call == null) emptyActive = old }
                }
            }
            if (immediate != null) operation.terminal = true
        }
        cancel?.cancel()
        replaced?.let { deliver(it, AnonymousDiscoveryOutcome.Cancelled) }
        emptyActive?.let { finish(it, AnonymousDiscoveryOutcome.Cancelled) }
        immediate?.let { deliver(operation, it) }
        if (startNow) start(operation)
        return operation
    }
    private fun start(operation: Operation) {
        try {
            val call = synchronized(lock) {
                if (operation.terminal || active !== operation) return
                if (closed || operation.cancelled) null else {
                    val client = runtime ?: buildPolicy(route, timeoutMillis, platformTrust, callbackExecutor, callTimeoutMillis).also { runtime = it }
                    // Both members are validated ASCII without a quote, backslash or control: no escaping is needed.
                    val bytes = when (val query = operation.query) {
                        is DiscoveryQuery.Slug -> "{\"slug\":\"${query.slug}\"}"
                        is DiscoveryQuery.Email -> "{\"email\":\"${query.email}\"}"
                    }.toByteArray(Charsets.UTF_8)
                    check(bytes.size <= 4096)
                    val body = object : RequestBody() {
                        override fun contentType() = "application/json".toMediaType()
                        override fun contentLength() = bytes.size.toLong()
                        override fun isOneShot() = true
                        override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
                    }
                    val request = Request.Builder().url(checkNotNull(configuration).trust.coreApiOrigin + "/api/v1/auth/discover")
                        .post(body).header("Accept", "application/json, application/problem+json")
                        .header("Accept-Encoding", "identity").header("Cache-Control", "no-store")
                        .header("Idempotency-Key", UUID.randomUUID().toString()).build()
                    client.newCall(request).also { operation.call = it }
                }
            }
            if (call == null) { finish(operation, AnonymousDiscoveryOutcome.Cancelled); return }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { finish(operation, failure(e)) }
                override fun onResponse(call: Call, response: Response) {
                    val requestedSlug = (operation.query as? DiscoveryQuery.Slug)?.slug
                    val outcome = try { response.use { decode(it, requestedSlug, call) } }
                    catch (error: DiscoveryDecodingException) { AnonymousDiscoveryOutcome.Failure(error.failure) }
                    catch (error: IOException) { failure(error) }
                    catch (_: Exception) { AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation) }
                    // Response/use completes before finish may admit the next Call.
                    beforePublish?.invoke()
                    finish(operation, outcome)
                }
            })
        } catch (_: Exception) { finish(operation, AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(TransportFailure.OTHER))) }
    }
    private fun cancelOperation(operation: Operation) {
        var call: Call? = null
        var finishActive = false
        var finishPending = false
        synchronized(lock) {
            if (operation.terminal) return
            operation.cancelled = true
            if (pending === operation) { pending = null; operation.terminal = true; finishPending = true }
            else if (active === operation) { call = operation.call; finishActive = call == null }
        }
        call?.cancel()
        if (finishPending) deliver(operation, AnonymousDiscoveryOutcome.Cancelled)
        if (finishActive) finish(operation, AnonymousDiscoveryOutcome.Cancelled)
    }
    private fun finish(operation: Operation, outcome: AnonymousDiscoveryOutcome) {
        var next: Operation? = null
        var retiredRuntime: OkHttpClient? = null
        val delivered = synchronized(lock) {
            if (operation.terminal) return
            operation.terminal = true; operation.call = null
            if (active === operation) active = null
            val value = if (closed || operation.cancelled) AnonymousDiscoveryOutcome.Cancelled else outcome
            if (!closed && pending != null) { next = pending; pending = null; active = next }
            if (closed && active == null) { retiredRuntime = runtime; runtime = null }
            value
        }
        try { deliver(operation, delivered) }
        finally { retiredRuntime?.let(::release); next?.let(::start) }
    }
    private fun deliver(operation: Operation, outcome: AnonymousDiscoveryOutcome) {
        // Application callback faults must not retain network resources or the pending-operation slot.
        try { operation.completion(outcome) } catch (_: RuntimeException) { }
    }
    override fun close() {
        var cancelledPending: Operation? = null
        var emptyActive: Operation? = null
        var cancel: Call? = null
        var retiredRuntime: OkHttpClient? = null
        synchronized(lock) {
            closed = true
            cancelledPending = pending; pending = null
            cancelledPending?.let { it.cancelled = true; it.terminal = true }
            active?.let { it.cancelled = true; cancel = it.call; if (it.call == null) emptyActive = it }
            if (active == null) { retiredRuntime = runtime; runtime = null }
        }
        cancel?.cancel()
        emptyActive?.let { finish(it, AnonymousDiscoveryOutcome.Cancelled) }
        cancelledPending?.let { deliver(it, AnonymousDiscoveryOutcome.Cancelled) }
        retiredRuntime?.let(::release)
    }
    private fun decode(response: Response, requestedSlug: String?, call: Call): AnonymousDiscoveryOutcome {
        if (response.code == 401 || response.code == 407) return AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(TransportFailure.AUTHENTICATION_CHALLENGE))
        // Exactly the statuses `discoverRealm` documents; any other is not this service.
        if (response.code !in setOf(200, 400, 403, 413, 415, 422, 429, 500, 503)) return AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.UnsupportedService)
        val headers = (0 until response.headers.size).map { response.headers.name(it) to response.headers.value(it) }
        DiscoveryProblem.validateHeaders(headers, response.code != 200)
        val body = response.body
        if (body.contentLength() > 65536) { call.cancel(); refused() }
        val output = ByteArrayOutputStream()
        body.byteStream().use { input ->
            val buffer = ByteArray(4096)
            while (true) {
                val n = input.read(buffer, 0, minOf(buffer.size, 65536 - output.size() + 1))
                if (n < 0) break
                if (output.size() + n > 65536) { call.cancel(); refused() }
                output.write(buffer, 0, n)
            }
        }
        val bytes = output.toByteArray()
        if (response.code == 200) {
            val result = DiscoveryEnvelope.decode(bytes, checkNotNull(configuration))
            // A slug answers with that organisation or none; an email with whichever its domain belongs to.
            if (requestedSlug != null && result is AnonymousDiscoveryResult.Single &&
                result.metadata.organisationSlug != requestedSlug) refused()
            return AnonymousDiscoveryOutcome.Result(result)
        }
        return AnonymousDiscoveryOutcome.Failure(DiscoveryProblem.decode(bytes, response.code, headers))
    }
    private fun failure(error: IOException): AnonymousDiscoveryOutcome = AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.Transport(when (error) {
        is SSLException -> TransportFailure.TLS
        is InterruptedIOException -> TransportFailure.TIMEOUT
        is UnknownHostException, is ConnectException, is NoRouteToHostException -> TransportFailure.OFFLINE
        else -> TransportFailure.OTHER
    }))
    private fun release(client: OkHttpClient) { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

    internal companion object {
        fun anonymousPolicyForTests(route: ClientTestRoute, timeoutMillis: Long): OkHttpClient = buildPolicy(route, timeoutMillis, false)
        /** The bounded policy every Core and identity call shares: no cookies, cache, redirects or retries. */
        fun buildPolicy(route: ClientTestRoute?, timeout: Long, platformTrust: Boolean,
                        callbackExecutor: ExecutorService? = null, callTimeout: Long = timeout): OkHttpClient {
            require(timeout in 1..15000 && callTimeout in 1..15000)
            require(callbackExecutor == null || route != null) { "Callback executor is a test seam" }
            val builder = OkHttpClient.Builder().authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
                .cookieJar(CookieJar.NO_COOKIES).cache(null).followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false).fastFallback(false)
                .callTimeout(callTimeout, TimeUnit.MILLISECONDS).connectTimeout(timeout, TimeUnit.MILLISECONDS)
                .readTimeout(timeout, TimeUnit.MILLISECONDS).writeTimeout(timeout, TimeUnit.MILLISECONDS)
            if (callbackExecutor != null) builder.dispatcher(Dispatcher(callbackExecutor))
            if (route != null) {
                require(route.originPort in 1..65535 && (route.proxyPort == null || route.proxyPort in 1..65535))
                builder.dns(object : okhttp3.Dns {
                    override fun lookup(hostname: String): List<InetAddress> {
                        if (hostname != "core.test") throw UnknownHostException("Unadmitted fixture destination")
                        return listOf(InetAddress.getLoopbackAddress())
                    }
                })
                builder.socketFactory(FixtureSockets(route.originPort, route.proxyPort))
                builder.proxy(route.proxyPort?.let { Proxy(Proxy.Type.HTTP, InetSocketAddress(InetAddress.getLoopbackAddress(), it)) } ?: Proxy.NO_PROXY)
                if (!platformTrust) builder.sslSocketFactory(route.socketFactory, route.trustManager)
            }
            return builder.build()
        }
    }
}

/** Fixed test-only routing preserves core.test Host/SNI and default hostname checking. */
private class FixtureSockets(private val originPort: Int, private val proxyPort: Int?) : SocketFactory() {
    override fun createSocket(): Socket = object : Socket() {
        override fun connect(endpoint: SocketAddress?, timeout: Int) {
            val address = endpoint as? InetSocketAddress ?: throw IOException("Unadmitted fixture destination")
            if (address.address?.isLoopbackAddress != true) throw IOException("Unadmitted fixture destination")
            val target = when (address.port) { 443 -> originPort; proxyPort -> proxyPort; else -> null }
                ?: throw IOException("Unadmitted fixture destination")
            super.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), target), timeout)
        }
    }
    private fun named(host: String, port: Int): InetSocketAddress {
        if (host != "core.test" && host != "127.0.0.1" && host != "localhost") throw IOException("Unadmitted fixture destination")
        return InetSocketAddress(InetAddress.getLoopbackAddress(), port)
    }
    override fun createSocket(host: String, port: Int): Socket = createSocket().apply { connect(named(host, port)) }
    override fun createSocket(host: InetAddress, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = createSocket().apply {
        if (!local.isLoopbackAddress) throw IOException("Unadmitted fixture bind")
        bind(InetSocketAddress(local, localPort)); connect(named(host, port))
    }
    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = createSocket().apply {
        if (!local.isLoopbackAddress) throw IOException("Unadmitted fixture bind")
        bind(InetSocketAddress(local, localPort)); connect(InetSocketAddress(host, port))
    }
}
