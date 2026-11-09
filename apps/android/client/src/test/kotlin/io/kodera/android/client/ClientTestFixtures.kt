package io.kodera.android.client

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.*
import java.io.*
import java.net.*
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.Semaphore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import javax.net.ssl.*

internal object Fixtures {
    const val REQUEST_ID = "fixture-request-1"
    /**
     * The contract's own examples (`RealmDiscoveryResult.examples` at `contracts/v0.26.0`, the discovery-*.json
     * resources verbatim) put realms on `https://id.kodera.io`, so that is the one configured issuer origin.
     */
    fun configuration() = CoreDiscoveryConfiguration.configured("https://core.test", setOf("https://id.kodera.io"))
    fun data(name: String = "one"): ByteArray = checkNotNull(javaClass.getResourceAsStream("/discovery-$name.json")).use { it.readBytes() }
    fun objectValue(name: String = "one"): JsonObject = JsonParser.parseString(data(name).toString(Charsets.UTF_8)).asJsonObject
    fun bytes(value: JsonObject) = value.toString().toByteArray(Charsets.UTF_8)
    fun headers(problem: Boolean = false) = listOf("Content-Type" to (if (problem) "application/problem+json" else "application/json"), "Cache-Control" to "no-store", "X-Request-Id" to REQUEST_ID)
    fun problem(status: Int = 400, type: String = "malformed-request", retry: String? = null): ByteArray =
        ("""{"type":"https://kodera.io/problems/$type","title":"PRIVATE TITLE SENTINEL","detail":"PRIVATE DETAIL SENTINEL","status":$status,"request_id":"$REQUEST_ID"${retry?.let { ",\"retry_after_s\":$it" } ?: ""}}""").toByteArray()
    fun refused(block: () -> Unit) {
        try { block(); fail("Malformed or untrusted input was accepted") }
        catch (error: DiscoveryDecodingException) { assertEquals(DiscoveryFailure.ProtocolViolation, error.failure) }
    }
    /**
     * Bound for anything the first TLS exchange of a cold test JVM must finish: keytool, JSSE and OkHttp
     * warm-up on a loaded runner. It bounds only waits for a positive observation, so a correct run
     * returns as soon as the signal arrives, and only a failing run pays the whole bound.
     */
    const val COLD_START_MILLIS = 10_000L
    fun selected(): AnonymousOrganisationMetadata =
        (DiscoveryEnvelope.decode(data(), configuration()) as AnonymousDiscoveryResult.Single).metadata
}

/** Owns the client's OkHttp callback threads, so a test can prove every callback has returned. */
internal class CallbackExecutor {
    val executor: ExecutorService = Executors.newCachedThreadPool { Thread(it, "kodera-client-callback").apply { isDaemon = true } }
    /** After this, no OkHttp callback of the client is running or can still start: no outcome can arrive late. */
    fun drain() {
        executor.shutdown()
        assertTrue("Client callbacks must all return", executor.awaitTermination(Fixtures.COLD_START_MILLIS, TimeUnit.MILLISECONDS))
    }
}

internal class OutcomeProbe {
    val values = CopyOnWriteArrayList<AnonymousDiscoveryOutcome>()
    private val done = CountDownLatch(1)
    fun receive(value: AnonymousDiscoveryOutcome) { values += value; done.countDown() }
    fun await(timeoutMillis: Long = Fixtures.COLD_START_MILLIS): AnonymousDiscoveryOutcome {
        assertTrue("One bounded client terminal expected", done.await(timeoutMillis, TimeUnit.MILLISECONDS))
        assertEquals("Exactly one callback", 1, values.size)
        return values.single()
    }
}
internal data class RecordedRequest(val method: String, val target: String, val headers: Map<String, String>, val body: ByteArray, val connectionId: Int)
internal data class WireReply(val status: Int = 200, val body: ByteArray = Fixtures.data("zero"),
    val headers: List<Pair<String, String>> = Fixtures.headers(), val declaredLength: Long? = null,
    val chunked: Boolean = false, val hold: CountDownLatch? = null, val drop: Boolean = false,
    val keepAlive: Boolean = false, val afterHeaders: CountDownLatch? = null)

/** Finite, owned loopback fixture; the production client must still perform a real TLS/HTTP exchange. */
internal class WireFixture(val tls: Boolean = true, private val reply: (RecordedRequest) -> WireReply = { WireReply() }) : AutoCloseable {
    private val context: SSLContext? = if (tls) tlsContext() else null
    private val server: ServerSocket = (context?.serverSocketFactory ?: ServerSocketFactoryHolder.plain)
        .createServerSocket(0, 8, InetAddress.getLoopbackAddress()).also { it.soTimeout = 100 }
    val port: Int get() = server.localPort
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val errors = CopyOnWriteArrayList<Throwable>()
    private val accepted = CopyOnWriteArrayList<Socket>()
    private val calibrationSockets = CopyOnWriteArrayList<Socket>()
    private val connectionWorkers = CopyOnWriteArrayList<Thread>()
    private val workerSlots = Semaphore(2)
    private val nextConnectionId = AtomicInteger()
    private val peerClosed = ConcurrentHashMap.newKeySet<Int>()
    /** Signalled on every recorded request and observed peer close; waits never poll. */
    private val observedLock = ReentrantLock()
    private val observed = observedLock.newCondition()
    @Volatile private var closed = false
    val released = CountDownLatch(1)
    private val worker = Thread({ serve() }, "kodera-client-fixture").apply { start() }
    fun route(proxyPort: Int? = null): ClientTestRoute {
        val ctx = context ?: tlsContext()
        return ClientTestRoute(port, ctx.socketFactory, trustManager(), proxyPort)
    }
    /** The default call timeout must outlast a cold first TLS exchange; timeout tests pass their own. */
    fun client(timeoutMillis: Long = Fixtures.COLD_START_MILLIS, proxyPort: Int? = null, callbacks: ExecutorService? = null,
               beforePublish: (() -> Unit)? = null, callTimeoutMillis: Long = timeoutMillis) =
        CoreDiscoveryClient(Fixtures.configuration(), route(proxyPort), timeoutMillis,
            callbackExecutor = callbacks, beforePublishForTest = beforePublish, callTimeoutMillis = callTimeoutMillis)
    fun awaitRequests(count: Int = 1) {
        assertTrue("Actual fixture request required: expected $count, saw ${requests.size}", awaitObserved { requests.size >= count })
    }
    /** Positive observation of this exact peer's FIN/reset while its reply is still withheld. */
    fun awaitPeerClosed(request: RecordedRequest) {
        assertTrue("Exact active peer must close before held reply release", awaitObserved { peerClosed.contains(request.connectionId) })
    }
    private fun signalObserved() = observedLock.withLock { observed.signalAll() }
    private fun awaitObserved(condition: () -> Boolean): Boolean = observedLock.withLock {
        var left = TimeUnit.MILLISECONDS.toNanos(Fixtures.COLD_START_MILLIS)
        while (!condition()) {
            if (left <= 0) return false
            left = observed.awaitNanos(left)
        }
        true
    }
    fun hasObservedPeerClose(request: RecordedRequest): Boolean = peerClosed.contains(request.connectionId)
    /** Isolated calibration only: fixed loopback TLS destination and core.test hostname validation. */
    fun openCalibrationRequest(slug: String): Socket {
        require(tls && slug in setOf("alpha", "bravo"))
        val raw = Socket().also { calibrationSockets += it; it.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), port), 650) }
        val socket = checkNotNull(context).socketFactory.createSocket(raw, "core.test", 443, true) as SSLSocket
        calibrationSockets += socket; socket.soTimeout = 650
        socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
        socket.startHandshake()
        val body = "{\"slug\":\"$slug\"}".toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply {
            write(("POST /api/v1/auth/discover HTTP/1.1\r\nHost: core.test\r\nContent-Length: ${body.size}\r\n\r\n").toByteArray(Charsets.US_ASCII))
            write(body); flush()
        }
        return socket
    }
    private fun serve() {
        while (!closed) {
            try {
                val socket = server.accept().also { it.soTimeout = POLL_MILLIS; accepted += it }
                if (!workerSlots.tryAcquire()) {
                    errors += IllegalStateException("More than two concurrent fixture exchanges")
                    socket.close(); continue
                }
                val id = nextConnectionId.incrementAndGet()
                val connectionWorker = Thread({
                    try { socket.use { serveConnection(it, id) } }
                    catch (_: SocketTimeoutException) { }
                    catch (_: SocketException) { }
                    catch (_: SSLException) { }
                    catch (error: Throwable) { if (!closed) errors += error }
                    finally { workerSlots.release() }
                }, "kodera-client-peer-$id")
                connectionWorkers += connectionWorker; connectionWorker.start()
            } catch (_: SocketTimeoutException) { }
            catch (_: SocketException) { }
            catch (error: Throwable) { if (!closed) errors += error }
        }
    }
    private fun serveConnection(socket: Socket, id: Int) {
        val input = socket.getInputStream()
        // The short poll keeps held replies responsive to close(), but it must not bound a peer
        // that is still mid-handshake or mid-request: a cold or loaded JVM can pause longer than
        // 100 ms there, and the fixture then hung up on a live client ("Broken pipe").
        var firstRequest = true
        while (!closed) {
            socket.soTimeout = if (firstRequest) REQUEST_MILLIS else POLL_MILLIS
            val request = readRequest(input, id) { socket.soTimeout = REQUEST_MILLIS } ?: return
            socket.soTimeout = POLL_MILLIS
            firstRequest = false
            requests += request; signalObserved()
            val response = reply(request)
            if (response.hold != null && !waitForReleaseOrPeerClose(input, id, response.hold)) return
            if (response.drop) return
            writeReply(socket.getOutputStream(), response)
            if (!response.keepAlive) return
        }
    }
    private fun waitForReleaseOrPeerClose(input: InputStream, id: Int, gate: CountDownLatch): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1500)
        while (!closed && gate.count > 0 && System.nanoTime() < deadline) {
            try {
                val next = input.read()
                if (next < 0) { peerClosed += id; signalObserved(); return false }
                error("Unexpected pipelined bytes during held response")
            } catch (_: SocketTimeoutException) { }
            catch (_: SocketException) { if (!closed) { peerClosed += id; signalObserved() }; return false }
            catch (_: SSLException) { if (!closed) { peerClosed += id; signalObserved() }; return false }
        }
        return !closed
    }
    private fun readRequest(input: InputStream, connectionId: Int, started: () -> Unit): RecordedRequest? {
        var begun = false
        fun line(): String? {
            val bytes = ByteArrayOutputStream()
            while (bytes.size() < 8192) {
                val c = input.read(); if (c < 0) return if (bytes.size() == 0) null else error("Truncated request")
                if (!begun) { begun = true; started() }
                if (c == 10) return bytes.toString("US-ASCII").removeSuffix("\r")
                bytes.write(c)
            }
            error("Request header bound exceeded")
        }
        val first = line() ?: return null
        val parts = first.split(' '); check(parts.size == 3)
        val headers = linkedMapOf<String, String>()
        var total = first.length
        while (true) {
            val text = line() ?: error("Truncated headers"); total += text.length; check(total <= 16384)
            if (text.isEmpty()) break
            val pair = text.split(':', limit = 2); check(pair.size == 2)
            headers[pair[0].lowercase()] = pair[1].trim()
        }
        val length = headers["content-length"]?.toInt() ?: 0; check(length in 0..4096)
        val body = ByteArray(length); var read = 0
        while (read < length) { val n = input.read(body, read, length - read); check(n > 0); read += n }
        return RecordedRequest(parts[0], parts[1], headers, body, connectionId)
    }
    private fun writeReply(out: OutputStream, response: WireReply) {
        val headers = response.headers + if (response.chunked) listOf("Transfer-Encoding" to "chunked")
            else listOf("Content-Length" to (response.declaredLength ?: response.body.size.toLong()).toString())
        val text = "HTTP/1.1 ${response.status} Fixture\r\n" + headers.joinToString("") { "${it.first}: ${it.second}\r\n" } +
            "Connection: ${if (response.keepAlive) "keep-alive" else "close"}\r\n\r\n"
        out.write(text.toByteArray(Charsets.US_ASCII)); out.flush()
        response.afterHeaders?.await(1500, TimeUnit.MILLISECONDS)
        if (response.chunked) {
            for (chunk in response.body.asList().chunked(1024)) {
                out.write("${chunk.size.toString(16)}\r\n".toByteArray()); out.write(chunk.toByteArray()); out.write("\r\n".toByteArray()); out.flush()
            }
            out.write("0\r\n\r\n".toByteArray())
        } else out.write(response.body)
        out.flush()
    }
    override fun close() {
        closed = true; released.countDown(); server.close(); accepted.forEach { runCatching { it.close() } }
        // Join accept first so no worker can be appended after the worker snapshot.
        worker.join(1800); check(!worker.isAlive) { "Owned fixture accept loop did not terminate" }
        calibrationSockets.forEach { runCatching { it.close() } }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1800)
        connectionWorkers.forEach { thread ->
            val remaining = TimeUnit.NANOSECONDS.toMillis((deadline - System.nanoTime()).coerceAtLeast(0))
            if (remaining > 0) thread.join(remaining)
        }
        check(connectionWorkers.none { it.isAlive }) { "Owned fixture peer worker did not terminate" }
        errors.firstOrNull()?.let { throw IllegalStateException("Fixture worker failed", it) }
    }
    companion object {
        private const val POLL_MILLIS = 100
        // A cold JVM's first server-side handshake read must not outlast the fixture's patience.
        private const val REQUEST_MILLIS = Fixtures.COLD_START_MILLIS.toInt()
        private val identity: Pair<KeyStore, CharArray> by lazy { generateIdentity() }
        /** One throwaway self-signed `core.test` identity per test JVM, made by the running JDK's keytool. */
        private fun generateIdentity(): Pair<KeyStore, CharArray> {
            val directory = Files.createTempDirectory("kodera-tls-fixture")
            val path = directory.resolve("fixture.p12")
            val password = UUID.randomUUID().toString()
            val executable = if (System.getProperty("os.name").startsWith("Windows")) "keytool.exe" else "keytool"
            val keytool = Path.of(System.getProperty("java.home"), "bin", executable).toString()
            try {
                val process = ProcessBuilder(keytool, "-genkeypair", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048",
                    "-storetype", "PKCS12", "-keystore", path.toString(), "-storepass:env", "KODERA_FIXTURE_STOREPASS",
                    "-dname", "CN=core.test", "-ext", "SAN=dns:core.test", "-validity", "1", "-noprompt")
                    .redirectErrorStream(true).apply { environment()["KODERA_FIXTURE_STOREPASS"] = password }.start()
                val output = process.inputStream.readBytes().toString(Charsets.UTF_8)
                check(process.waitFor(60, TimeUnit.SECONDS) && process.exitValue() == 0) { "keytool failed: $output" }
                val chars = password.toCharArray()
                return KeyStore.getInstance("PKCS12").apply { Files.newInputStream(path).use { load(it, chars) } } to chars
            } finally {
                Files.deleteIfExists(path); Files.deleteIfExists(directory)
            }
        }
        private fun trustManager(): X509TrustManager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(identity.first) }
            .trustManagers.filterIsInstance<X509TrustManager>().single()
        private fun tlsContext(): SSLContext {
            val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(identity.first, identity.second) }
            return SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, arrayOf(trustManager()), null) }
        }
    }
}
private object ServerSocketFactoryHolder { val plain: javax.net.ServerSocketFactory = javax.net.ServerSocketFactory.getDefault() }

internal class GlobalSpies {
    val serverAuth = AtomicInteger(); val proxyAuth = AtomicInteger()
    val cookieGet = AtomicInteger(); val cookiePut = AtomicInteger()
    val cacheGet = AtomicInteger(); val cachePut = AtomicInteger()
    fun assertUnused() {
        assertEquals("SERVER authenticator must not be consulted", 0, serverAuth.get())
        assertEquals("PROXY authenticator must not be consulted", 0, proxyAuth.get())
        assertEquals("CookieHandler.get", 0, cookieGet.get()); assertEquals("CookieHandler.put", 0, cookiePut.get())
        assertEquals("ResponseCache.get", 0, cacheGet.get()); assertEquals("ResponseCache.put", 0, cachePut.get())
    }
}
internal fun <T> withGlobalSpies(block: (GlobalSpies) -> T): T {
    val previousAuth = Authenticator.getDefault(); val previousCookie = CookieHandler.getDefault(); val previousCache = ResponseCache.getDefault()
    val spies = GlobalSpies()
    try {
        Authenticator.setDefault(object : Authenticator() {
            override fun getPasswordAuthentication(): PasswordAuthentication {
                if (requestorType == RequestorType.PROXY) spies.proxyAuth.incrementAndGet() else spies.serverAuth.incrementAndGet()
                return PasswordAuthentication("fixture-only", "fixture-only".toCharArray())
            }
        })
        CookieHandler.setDefault(object : CookieHandler() {
            override fun get(uri: URI?, requestHeaders: MutableMap<String, MutableList<String>>?): MutableMap<String, MutableList<String>> {
                spies.cookieGet.incrementAndGet(); return linkedMapOf("Cookie" to mutableListOf("fixture-only=present"))
            }
            override fun put(uri: URI?, responseHeaders: MutableMap<String, MutableList<String>>?) { spies.cookiePut.incrementAndGet() }
        })
        ResponseCache.setDefault(object : ResponseCache() {
            override fun get(uri: URI?, method: String?, headers: MutableMap<String, MutableList<String>>?): CacheResponse? {
                spies.cacheGet.incrementAndGet()
                if (uri?.path == "/cache-write-calibration") return null
                return object : CacheResponse() {
                    override fun getHeaders(): MutableMap<String, MutableList<String>> = linkedMapOf("Content-Type" to mutableListOf("application/json"))
                    override fun getBody(): InputStream = ByteArrayInputStream(Fixtures.data("zero"))
                }
            }
            override fun put(uri: URI?, connection: URLConnection?): CacheRequest? { spies.cachePut.incrementAndGet(); return null }
        })
        return block(spies)
    } finally { ResponseCache.setDefault(previousCache); CookieHandler.setDefault(previousCookie); Authenticator.setDefault(previousAuth) }
}
internal fun assertAnonymous(request: RecordedRequest) {
    for (name in listOf("authorization", "proxy-authorization", "cookie", "cookie2", "if-none-match", "if-modified-since")) {
        assertFalse("Forbidden anonymous request header: $name", request.headers.containsKey(name))
    }
}
