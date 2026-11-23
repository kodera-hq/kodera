package io.kodera.android.client

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import io.kodera.android.domain.AttachmentMetadataRef
import io.kodera.android.domain.AttachmentMimeType
import io.kodera.android.domain.DomainFailure
import io.kodera.android.domain.IssuerAdmission
import io.kodera.android.domain.Kdv1SessionVaultCodec
import io.kodera.android.domain.KoderaMobileFfiBridge
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.domain.MatrixRoomAlias
import io.kodera.android.domain.MatrixRoomId
import io.kodera.android.domain.MatrixServerName
import io.kodera.android.domain.MatrixUserId
import io.kodera.android.domain.ReactionKeyValidator
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.UuidV7Identifier
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLException

enum class MatrixClientError {
    INVALID_INPUT,
    PLAINTEXT_FORBIDDEN,
    PROTOCOL_VIOLATION,
    UNAUTHORIZED,
    FORBIDDEN,
    NOT_FOUND,
    RATE_LIMITED,
    PAYLOAD_TOO_LARGE,
    SERVICE_UNAVAILABLE,
    SIGNED_OUT,
    IDENTITY_UNAVAILABLE,
    TRANSPORT,
}

class MatrixClientException(
    val reason: MatrixClientError,
    val transportFailure: TransportFailure? = null,
) : Exception(reason.name)

/**
 * Thread-safe session/owner generation fence checked before and after every Matrix HTTP exchange,
 * cancelling active OkHttp calls immediately on sign-out, organisation switch, or conversation teardown.
 */
class SessionFence {
    val generation: Long = NEXT_GENERATION.incrementAndGet()
    private val lock = Any()
    private var invalidated = false
    private var nextToken = 0L
    private val cancelHandlers = LinkedHashMap<Long, () -> Unit>()

    val isInvalidated: Boolean
        get() = synchronized(lock) { invalidated }

    fun checkActive() {
        if (isInvalidated) {
            throw MatrixClientException(MatrixClientError.SIGNED_OUT)
        }
    }

    fun registerCancellation(handler: () -> Unit): Long? {
        var runImmediately = false
        val token = synchronized(lock) {
            if (invalidated) {
                runImmediately = true
                null
            } else {
                val id = ++nextToken
                cancelHandlers[id] = handler
                id
            }
        }
        if (runImmediately) handler()
        return token
    }

    fun unregisterCancellation(token: Long?) {
        if (token != null) {
            synchronized(lock) { cancelHandlers.remove(token) }
        }
    }

    fun invalidate() {
        val handlers = synchronized(lock) {
            if (invalidated) return
            invalidated = true
            val list = cancelHandlers.values.toList()
            cancelHandlers.clear()
            list
        }
        for (h in handlers) {
            runCatching { h() }
        }
    }

    companion object {
        private val NEXT_GENERATION = AtomicLong(0L)
    }
}

/** Synapse OIDC SSO redirect request targeting `{homeserverOrigin}/_matrix/client/v3/login/sso/redirect?redirectUrl=...`. */
data class MatrixSsoRedirectRequest(
    val homeserverOrigin: String,
    val ssoRedirectUrl: String,
    val callbackUri: String,
    val state: String,
)

/** Verified single-use `loginToken` extracted from the Synapse SSO callback with `loginToken` and `state` stripped. */
data class MatrixSsoTokenGrant(
    val loginToken: String,
    val redactedCallbackUri: String,
)

/** Injectable Synapse SSO authorizer seam (backed in production by `AppAuthBackend` Custom Tabs callback handling). */
fun interface MatrixSsoAuthorizer {
    fun authorize(request: MatrixSsoRedirectRequest): MatrixSsoTokenGrant
}

/** Pure-JVM HTTP inspection seam allowing `:app` host tests to assert real OkHttp Matrix calls without importing OkHttp. */
data class MatrixHttpInspection(
    val method: String,
    val url: String,
    val authorizationHeader: String?,
    val bodyUtf8: String?,
)

class MatrixHttpReply(
    val statusCode: Int,
    bodyBytes: ByteArray = "{}".toByteArray(Charsets.UTF_8),
    val headers: Map<String, String> = mapOf("Content-Type" to "application/json"),
) {
    private val ownedBytes = bodyBytes.copyOf()
    fun bytes(): ByteArray = ownedBytes.copyOf()
}

fun interface MatrixHttpStub {
    fun handle(request: MatrixHttpInspection): MatrixHttpReply
}

/** Matrix device session credentials sealed inside `RustSessionVault` (`KDV1`). */
data class PersistedMatrixSession(
    val homeserverOrigin: String,
    val serverName: String,
    val userId: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String?,
) {
    init {
        if (homeserverOrigin.isEmpty() ||
            runCatching { MatrixServerName.parse(serverName) }.isFailure ||
            runCatching { MatrixUserId.parse(userId) }.isFailure ||
            !Kdv1SessionVaultCodec.isValidVaultDeviceId(deviceId) ||
            accessToken.isEmpty() ||
            accessToken.length > 4096 ||
            !TrustPolicy.isVisibleASCII(accessToken) ||
            (refreshToken != null && (refreshToken.isEmpty() || refreshToken.length > 4096 || !TrustPolicy.isVisibleASCII(refreshToken)))
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
    }

    fun encodeVaultBytes(): ByteArray {
        val obj = JsonObject().apply {
            addProperty("version", 1)
            addProperty("homeserver_origin", homeserverOrigin)
            addProperty("server_name", serverName)
            addProperty("user_id", userId)
            addProperty("device_id", deviceId)
            addProperty("access_token", accessToken)
            if (refreshToken != null) {
                addProperty("refresh_token", refreshToken)
            }
        }
        return obj.toString().toByteArray(Charsets.UTF_8)
    }

    companion object {
        fun decodeVaultBytes(bytes: ByteArray): PersistedMatrixSession {
            val root = try {
                StrictJson.parse(bytes, MatrixRoomClient.JSON_BYTE_LIMIT).objectValue()
            } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val version = try { root["version"]?.integerValue() } catch (_: Exception) { null }
            val homeserverOrigin = (root["homeserver_origin"] as? JsonValue.StringValue)?.value
            val serverName = (root["server_name"] as? JsonValue.StringValue)?.value
            val userId = (root["user_id"] as? JsonValue.StringValue)?.value
            val deviceId = (root["device_id"] as? JsonValue.StringValue)?.value
            val accessToken = (root["access_token"] as? JsonValue.StringValue)?.value
            if (version != 1L || homeserverOrigin == null || serverName == null ||
                userId == null || deviceId == null || accessToken == null
            ) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val refreshToken = when (val rawRef = root["refresh_token"]) {
                null, JsonValue.NullValue -> null
                is JsonValue.StringValue -> rawRef.value
                else -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            return PersistedMatrixSession(
                homeserverOrigin = homeserverOrigin,
                serverName = serverName,
                userId = userId,
                deviceId = deviceId,
                accessToken = accessToken,
                refreshToken = refreshToken,
            )
        }
    }
}

data class MatrixSyncBatch(
    val nextBatch: String,
    val roomEvents: Map<String, List<MatrixRawTimelineEvent>>,
    val roomDeltas: Map<String, MatrixRoomSyncDelta> = roomEvents.mapValues { MatrixRoomSyncDelta(it.value) },
    val plaintextAllowedRooms: Set<String> = emptySet(),
) {
    companion object {
        fun fromDeltas(nextBatch: String, deltas: Map<String, MatrixRoomSyncDelta>): MatrixSyncBatch =
            MatrixSyncBatch(
                nextBatch = nextBatch,
                roomEvents = deltas.mapValues { it.value.events },
                roomDeltas = deltas,
            )
    }
}

class AttachmentUploadPayload(
    rawFilename: String,
    val contentType: AttachmentMimeType,
    rawBytes: ByteArray,
) {
    val filename: String
    private val bytes: ByteArray

    init {
        if (rawBytes.isEmpty() || rawBytes.size > AttachmentMetadataRef.MAX_SIZE_BYTES) {
            throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
        }
        val cleaned = AttachmentMetadataRef.cleanFilename(rawFilename)
        if (cleaned.isEmpty() || cleaned.length > AttachmentMetadataRef.MAX_FILENAME_LENGTH) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        filename = cleaned
        bytes = rawBytes.copyOf()
    }

    val sizeBytes: Int get() = bytes.size
    fun dataBytes(): ByteArray = bytes.copyOf()
}

data class BootstrappedMatrixRoom(
    val roomId: String,
    val initialBatch: MatrixSyncBatch,
)

/** High-level conversation transport consumed by `:app` without exposing raw URLs in `:app`. */
interface ChannelConversationTransport {
    val ownUserId: String
    fun updateChannelSecurity(organisationId: String, channelId: String, isConfidential: Boolean?) {}
    fun bootstrapRoom(organisationId: String, channelId: String): BootstrappedMatrixRoom
    fun bootstrapRoom(
        organisationId: String,
        channelId: String,
        syncFence: SessionFence?,
    ): BootstrappedMatrixRoom = bootstrapRoom(organisationId, channelId)

    fun syncRoom(roomId: String, since: String?): MatrixSyncBatch
    fun syncRoom(
        roomId: String,
        since: String?,
        syncFence: SessionFence?,
    ): MatrixSyncBatch = syncRoom(roomId, since)

    fun sendMessage(
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String?,
        attachments: List<AttachmentMetadataRef>,
    ): String
    fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String): String
    fun redactEvent(roomId: String, transactionId: String, targetEventId: String): String
    fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String): String
    fun uploadAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload,
    ): AttachmentMetadataRef
    fun backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int = MatrixRoomClient.SYNC_TIMELINE_LIMIT,
    ): List<MatrixRawTimelineEvent> = emptyList()
    fun backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int = MatrixRoomClient.SYNC_TIMELINE_LIMIT,
        syncFence: SessionFence?,
    ): List<MatrixRawTimelineEvent> = backfillRoomMessages(roomId, fromToken, limit)
}

/**
 * Matrix Client-Server v3 room transport + Core-scoped 3-step attachment uploader.
 * Enforces origin validation, zero redirects, credential-free presigned `PUT`, and bounded JSON responses.
 */
class MatrixRoomClient private constructor(
    private val coreRequester: CoreRequester,
    private val loopback: LoopbackPolicy,
    private val fence: SessionFence,
    private val httpClient: OkHttpClient,
) : AutoCloseable {

    private data class RoomSecurity(val corePublic: Boolean, var matrixKnown: Boolean = false, var blocked: Boolean = false)
    private val securityLock = Any()
    private val security = HashMap<String, RoomSecurity>()
    private val channelRooms = HashMap<String, String>()
    private fun securityKey(origin: String, roomId: String) = "$origin/$roomId"

    internal fun bindChannelSecurity(organisationId: String, channelId: String, origin: String, roomId: String, isConfidential: Boolean?) {
        synchronized(securityLock) {
            val key = securityKey(origin, roomId)
            security[key] = RoomSecurity(isConfidential == false, blocked = security[key]?.blocked == true || isConfidential == true)
            channelRooms["$organisationId:$channelId"] = key
        }
    }

    internal fun updateChannelSecurity(organisationId: String, channelId: String, isConfidential: Boolean?) {
        synchronized(securityLock) {
            val key = channelRooms["$organisationId:$channelId"] ?: return
            security[key]?.let { state ->
                security[key] = state.copy(corePublic = isConfidential == false, blocked = state.blocked || isConfidential == true)
            }
        }
    }

    fun requirePlaintextAllowed(origin: String, roomId: String) {
        fence.checkActive()
        synchronized(securityLock) {
            val state = security[securityKey(origin, roomId)]
            if (state == null || !state.corePublic || !state.matrixKnown || state.blocked) {
                throw MatrixClientException(MatrixClientError.PLAINTEXT_FORBIDDEN)
            }
        }
    }

    private fun requireUploadAllowed(organisationId: String, channelId: String) {
        fence.checkActive()
        synchronized(securityLock) {
            val state = channelRooms["$organisationId:$channelId"]?.let { security[it] }
            if (state == null || !state.corePublic || !state.matrixKnown || state.blocked) {
                throw MatrixClientException(MatrixClientError.PLAINTEXT_FORBIDDEN)
            }
        }
    }

    internal fun channelConfidentiality(organisationId: String, channelId: String): Boolean? {
        val result = CoreWorkspaceClient(coreRequester).fetch(organisationId)
        return workspaceChannelConfidentiality(result, channelId)
    }


    fun joinRoom(homeserverOrigin: String, matrixAccessToken: String, roomId: String) {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure) throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        val root = matrixJsonRequest("$homeserverOrigin/_matrix/client/v3/rooms/${percentEncodeSegment(roomId)}/join", "POST", matrixAccessToken, "{}".toByteArray())
        if ((root["room_id"] as? JsonValue.StringValue)?.value != roomId) throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
    }

    constructor(
        coreRequester: CoreRequester,
        loopback: LoopbackPolicy,
        fence: SessionFence = SessionFence(),
        httpStub: MatrixHttpStub? = null,
    ) : this(
        coreRequester = coreRequester,
        loopback = loopback,
        fence = fence,
        httpClient = buildHardenedHttpClient(
            testInterceptor = httpStub?.let(::stubToInterceptor),
            timeoutMillis = 15_000L,
        ),
    )

    internal constructor(
        coreRequester: CoreRequester,
        loopback: LoopbackPolicy,
        testInterceptor: Interceptor,
        fence: SessionFence = SessionFence(),
        timeoutMillis: Long = 5_000L,
    ) : this(
        coreRequester = coreRequester,
        loopback = loopback,
        fence = fence,
        httpClient = buildHardenedHttpClient(testInterceptor = testInterceptor, timeoutMillis = timeoutMillis),
    )

    override fun close() {
        fence.invalidate()
        httpClient.dispatcher.cancelAll()
        httpClient.connectionPool.evictAll()
        httpClient.dispatcher.executorService.shutdown()
    }

    /**
     * Discovers the Matrix homeserver origin via `/.well-known/matrix/client` on `{organisationSlug}.{matrixDomain}`,
     * falling back to `https://{organisationSlug}.{matrixDomain}` on HTTP `404`.
     */
    fun discoverHomeserverOrigin(
        organisationSlug: String,
        matrixDomain: String,
        extraFence: SessionFence? = null,
    ): String {
        if (!isValidDnsLabel(organisationSlug) || runCatching { MatrixServerName.parse(matrixDomain.lowercase()) }.isFailure) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val defaultOrigin = "https://${organisationSlug.lowercase()}.${matrixDomain.lowercase()}"
        try {
            IssuerAdmission.validateOrigin(defaultOrigin, loopback)
        } catch (_: DomainFailure) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }

        val request = Request.Builder()
            .url("$defaultOrigin/.well-known/matrix/client")
            .get()
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .build()

        return try {
            executeFencedCall(request, extraFence) { response ->
                if (response.code in 300..399) {
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
                when (response.code) {
                    200 -> {
                        val bodyBytes = readBounded(response, JSON_BYTE_LIMIT)
                            ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        val root = try {
                            StrictJson.parse(bodyBytes, JSON_BYTE_LIMIT).objectValue()
                        } catch (_: Exception) {
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        val rawBase = (root["m.homeserver"] as? JsonValue.ObjectValue)
                            ?.fields?.get("base_url")
                            ?.let { (it as? JsonValue.StringValue)?.value }
                            ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        val normalized = if (rawBase.endsWith("/")) rawBase.dropLast(1) else rawBase
                        try {
                            IssuerAdmission.validateOrigin(normalized, loopback)
                        } catch (_: DomainFailure) {
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        normalized
                    }
                    404 -> defaultOrigin
                    429 -> throw MatrixClientException(MatrixClientError.RATE_LIMITED)
                    in 500..599 -> throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                    else -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
            }
        } catch (err: MatrixClientException) {
            throw err
        } catch (io: IOException) {
            throw MatrixClientException(MatrixClientError.TRANSPORT, mapIoException(io))
        }
    }

    /** Resolves canonical `#kodera-ch-{channelId}:{serverName}` via Matrix directory API. */
    fun resolveChannelRoomId(
        homeserverOrigin: String,
        matrixAccessToken: String,
        channelId: String,
        serverName: String,
        extraFence: SessionFence? = null,
    ): MatrixRoomId {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (!TrustPolicy.canonicalNonNilUUID(channelId)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val validatedServer = try {
            MatrixServerName.parse(serverName)
        } catch (_: Exception) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val alias = try {
            MatrixRoomAlias.parse("#kodera-ch-$channelId:${validatedServer.rawValue}")
        } catch (_: Exception) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val encodedAlias = percentEncodeSegment(alias.rawValue)
        val root = matrixJsonRequest(
            url = "$homeserverOrigin/_matrix/client/v3/directory/room/$encodedAlias",
            method = "GET",
            matrixAccessToken = matrixAccessToken,
            jsonBody = null,
            extraFence = extraFence,
        )
        val rawRoomId = (root["room_id"] as? JsonValue.StringValue)?.value
            ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        return try {
            MatrixRoomId.parse(rawRoomId)
        } catch (_: Exception) {
            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        }
    }

    /** Runs a bounded Matrix `/sync` (`timeline.limit: 25`, security state limit 16, `<= 262,144` bytes). */
    fun sync(
        homeserverOrigin: String,
        matrixAccessToken: String,
        since: String? = null,
        roomId: String,
        extraFence: SessionFence? = null,
    ): MatrixSyncBatch {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (since != null && (since.isEmpty() || since.length > 256 || !TrustPolicy.isVisibleASCII(since))) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure) throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        var completed = false
        try {
            if (since == null) synchronized(securityLock) { security[securityKey(homeserverOrigin, roomId)]?.matrixKnown = false }
            val encodedFilter = percentEncodeSegment(boundedSyncFilterJson(roomId))
            val query = buildString {
                append("filter=").append(encodedFilter).append("&timeout=0")
                if (since != null) {
                    append("&since=").append(percentEncodeSegment(since))
                }
            }
            val root = matrixJsonRequest(
                url = "$homeserverOrigin/_matrix/client/v3/sync?$query",
                method = "GET",
                matrixAccessToken = matrixAccessToken,
                jsonBody = null,
                extraFence = extraFence,
                responseByteLimit = SYNC_RESPONSE_BYTE_LIMIT,
            )
            val nextBatch = (root["next_batch"] as? JsonValue.StringValue)?.value
            if (nextBatch.isNullOrEmpty()) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val roomDeltas = LinkedHashMap<String, MatrixRoomSyncDelta>()
            if (root.containsKey("rooms")) {
                val roomsObj = (root["rooms"] as? JsonValue.ObjectValue)?.fields
                    ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                if (roomsObj.containsKey("leave")) {
                    val leaveObj = (roomsObj["leave"] as? JsonValue.ObjectValue)?.fields
                        ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    if (leaveObj.containsKey(roomId)) {
                        synchronized(securityLock) {
                            security[securityKey(homeserverOrigin, roomId)]?.matrixKnown = false
                        }
                    }
                }
                if (roomsObj.containsKey("join") && roomsObj["join"] !is JsonValue.ObjectValue) {
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
            }
            val joined = ((root["rooms"] as? JsonValue.ObjectValue)?.fields?.get("join") as? JsonValue.ObjectValue)?.fields
            if (joined != null) {
                for ((roomKey, roomVal) in joined) {
                    val roomObject = (roomVal as? JsonValue.ObjectValue)?.fields
                        ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    if (roomKey != roomId) throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    if (((root["rooms"] as? JsonValue.ObjectValue)?.fields?.get("leave") as? JsonValue.ObjectValue)?.fields?.containsKey(roomId) == true) {
                        throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    }
                    if (roomObject.containsKey("timeline")) {
                        val tlObject = (roomObject["timeline"] as? JsonValue.ObjectValue)?.fields
                        if (tlObject == null || (tlObject.containsKey("events") && tlObject["events"] !is JsonValue.ArrayValue)) {
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                    }
                    val timelineObj = (roomObject["timeline"] as? JsonValue.ObjectValue)?.fields
                    val rawEvents = (timelineObj?.get("events") as? JsonValue.ArrayValue)?.values ?: emptyList()
                    if (roomObject.containsKey("state")) {
                        val stateObject = (roomObject["state"] as? JsonValue.ObjectValue)?.fields
                        if (stateObject == null || (stateObject.containsKey("events") && stateObject["events"] !is JsonValue.ArrayValue)) {
                            synchronized(securityLock) {
                                val state = security.getOrPut(securityKey(homeserverOrigin, roomId)) { RoomSecurity(false) }
                                state.matrixKnown = false
                                state.blocked = true
                            }
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                    }
                    val stateEvents = ((roomObject["state"] as? JsonValue.ObjectValue)?.fields?.get("events") as? JsonValue.ArrayValue)?.values
                    if (rawEvents.size > SYNC_TIMELINE_LIMIT || (stateEvents?.size ?: 0) >= 16) throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    for (event in (stateEvents ?: emptyList()) + rawEvents) {
                        val eventObj = (event as? JsonValue.ObjectValue)?.fields
                            ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        if (eventObj.containsKey("type") && eventObj["type"] !is JsonValue.StringValue) {
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                    }
                    synchronized(securityLock) {
                        val state = security.getOrPut(securityKey(homeserverOrigin, roomId)) { RoomSecurity(false) }
                        if (since == null) state.matrixKnown = stateEvents != null
                        // Only security types are requested; unclassified entries also block plaintext.
                        if (!stateEvents.isNullOrEmpty()) state.blocked = true
                        for (event in (stateEvents ?: emptyList()) + rawEvents) {
                            val type = ((event as? JsonValue.ObjectValue)?.fields?.get("type") as? JsonValue.StringValue)?.value
                            if (type in setOf("m.room.encryption", "io.kodera.room.security", "io.kodera.room.confidential")) state.blocked = true
                        }
                    }
                    val limited = (timelineObj?.get("limited") as? JsonValue.BooleanValue)?.value ?: false
                    val prevBatch = (timelineObj?.get("prev_batch") as? JsonValue.StringValue)?.value
                    roomDeltas[roomKey] = MatrixRoomSyncDelta(
                        events = rawEvents.mapNotNull(::decodeTimelineEvent),
                        limited = limited,
                        prevBatch = prevBatch,
                    )
                }
            }
            val allowed = runCatching { requirePlaintextAllowed(homeserverOrigin, roomId) }.isSuccess
            completed = true
            return MatrixSyncBatch.fromDeltas(nextBatch = nextBatch, deltas = roomDeltas).copy(plaintextAllowedRooms = if (allowed) setOf(roomId) else emptySet())
        } finally {
            if (!completed) synchronized(securityLock) { security[securityKey(homeserverOrigin, roomId)]?.matrixKnown = false }
        }
    }


    /** Backfills timeline messages prior to `fromToken` (`dir=b`) when an incremental `/sync` reports `limited: true`. */
    fun fetchRoomMessages(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        fromToken: String,
        limit: Int = SYNC_TIMELINE_LIMIT,
        extraFence: SessionFence? = null,
    ): List<MatrixRawTimelineEvent> {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure ||
            fromToken.isEmpty() ||
            fromToken.length > 256 ||
            !TrustPolicy.isVisibleASCII(fromToken) ||
            limit !in 1..50
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val encodedRoom = percentEncodeSegment(roomId)
        val encodedFrom = percentEncodeSegment(fromToken)
        val root = matrixJsonRequest(
            url = "$homeserverOrigin/_matrix/client/v3/rooms/$encodedRoom/messages?from=$encodedFrom&dir=b&limit=$limit",
            method = "GET",
            matrixAccessToken = matrixAccessToken,
            jsonBody = null,
            extraFence = extraFence,
        )
        val chunk = (root["chunk"] as? JsonValue.ArrayValue)?.values ?: emptyList()
        return chunk.mapNotNull(::decodeTimelineEvent).asReversed()
    }

    /**
     * Authenticates with Synapse via OIDC SSO (`/_matrix/client/v3/login/sso/redirect` -> single-use `loginToken`
     * -> `POST /_matrix/client/v3/login` with `m.login.token` and `refresh_token: true`), validating
     * `@<expectedSubject>:<serverName>` against the OIDC `sub` identity and revoking any issued Matrix token
     * via `/_matrix/client/v3/logout` immediately if validation or session fencing fails.
     *
     * Bound strictly to [fence] (session/conversation lifetime), never a foreground-only `/sync` cycle fence,
     * because opening the SSO Custom Tab backgrounds the host Activity before returning the callback URI.
     */
    fun authenticateWithSso(
        homeserverOrigin: String,
        serverName: String,
        deviceId: String,
        expectedSubject: String,
        ssoAuthorizer: MatrixSsoAuthorizer,
        callbackBaseUri: String = DEFAULT_SSO_CALLBACK_URI,
    ): PersistedMatrixSession {
        fence.checkActive()
        if (runCatching { MatrixServerName.parse(serverName) }.isFailure ||
            !Kdv1SessionVaultCodec.isValidVaultDeviceId(deviceId) ||
            !isValidExpectedOidcSubject(expectedSubject)
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val redirectRequest = buildSsoRedirectRequest(
            homeserverOrigin = homeserverOrigin,
            callbackBaseUri = callbackBaseUri,
            explicitState = null,
            loopback = loopback,
        )
        val grant = ssoAuthorizer.authorize(redirectRequest)
        fence.checkActive()
        if (grant.loginToken.isEmpty() || grant.loginToken.length > 4096 || !TrustPolicy.isVisibleASCII(grant.loginToken)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }

        val loginBody = JsonObject().apply {
            addProperty("type", "m.login.token")
            addProperty("token", grant.loginToken)
            addProperty("refresh_token", true)
            addProperty("initial_device_display_name", "Kodera")
            addProperty("device_id", deviceId)
        }.toString().toByteArray(Charsets.UTF_8)

        val request = Request.Builder()
            .url("$homeserverOrigin/_matrix/client/v3/login")
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .post(loginBody.toRequestBody("application/json".toMediaType()))
            .build()

        val call: Call = httpClient.newCall(request)
        val token1 = fence.registerCancellation { call.cancel() }
        try {
            call.execute().use { response ->
                if (response.code in 300..399) {
                    if (fence.isInvalidated) {
                        throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                    }
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
                when (response.code) {
                    200 -> {
                        val bytes = readBounded(response, JSON_BYTE_LIMIT)
                        if (bytes == null) {
                            if (fence.isInvalidated) {
                                throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                            }
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        val root = try {
                            StrictJson.parse(bytes, JSON_BYTE_LIMIT).objectValue()
                        } catch (_: Exception) {
                            if (fence.isInvalidated) {
                                throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                            }
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        val rawAccessToken = (root["access_token"] as? JsonValue.StringValue)?.value
                        fun refuseAndLogout(reason: MatrixClientError): Nothing {
                            if (!rawAccessToken.isNullOrEmpty()) {
                                logout(homeserverOrigin, rawAccessToken)
                            }
                            throw MatrixClientException(reason)
                        }

                        if (fence.isInvalidated) {
                            refuseAndLogout(MatrixClientError.SIGNED_OUT)
                        }
                        val userId = (root["user_id"] as? JsonValue.StringValue)?.value
                        val accessToken = rawAccessToken
                        val returnedDevice = (root["device_id"] as? JsonValue.StringValue)?.value
                        if (userId == null || accessToken.isNullOrEmpty() || returnedDevice == null) {
                            refuseAndLogout(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        val colon = userId.indexOf(':')
                        if (!userId.startsWith("@") || colon <= 1) {
                            refuseAndLogout(MatrixClientError.FORBIDDEN)
                        }
                        val localpart = userId.substring(1, colon)
                        val hsPart = userId.substring(colon + 1)
                        if (localpart != expectedSubject || hsPart != serverName) {
                            refuseAndLogout(MatrixClientError.FORBIDDEN)
                        }
                        val refreshToken = (root["refresh_token"] as? JsonValue.StringValue)?.value
                        if (refreshToken.isNullOrEmpty()) {
                            refuseAndLogout(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                        return try {
                            PersistedMatrixSession(
                                homeserverOrigin = homeserverOrigin,
                                serverName = serverName,
                                userId = userId,
                                deviceId = returnedDevice,
                                accessToken = accessToken,
                                refreshToken = refreshToken,
                            )
                        } catch (_: Exception) {
                            refuseAndLogout(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                    }
                    401 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.UNAUTHORIZED)
                    }
                    403 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.FORBIDDEN)
                    }
                    404 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.NOT_FOUND)
                    }
                    413 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
                    }
                    429 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.RATE_LIMITED)
                    }
                    in 500..599 -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                    }
                    else -> {
                        if (fence.isInvalidated) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                        throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                    }
                }
            }
        } catch (err: MatrixClientException) {
            throw err
        } catch (io: IOException) {
            if (fence.isInvalidated) {
                throw MatrixClientException(MatrixClientError.SIGNED_OUT)
            }
            throw MatrixClientException(MatrixClientError.TRANSPORT, mapIoException(io))
        } finally {
            fence.unregisterCancellation(token1)
        }
    }

    /** Rotates an expired Matrix access token via `/_matrix/client/v3/refresh`. */
    fun refreshSession(
        homeserverOrigin: String,
        refreshToken: String,
    ): Pair<String, String?> {
        fence.checkActive()
        try {
            IssuerAdmission.validateOrigin(homeserverOrigin, loopback)
        } catch (_: DomainFailure) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        if (refreshToken.isEmpty() || refreshToken.length > 4096 || !TrustPolicy.isVisibleASCII(refreshToken)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val bodyBytes = JsonObject().apply {
            addProperty("refresh_token", refreshToken)
        }.toString().toByteArray(Charsets.UTF_8)
        val root = matrixJsonRequestInternal(
            url = "$homeserverOrigin/_matrix/client/v3/refresh",
            method = "POST",
            bearerToken = null,
            jsonBody = bodyBytes,
        )
        val newAccess = (root["access_token"] as? JsonValue.StringValue)?.value
        if (newAccess.isNullOrEmpty()) {
            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        }
        return newAccess to (root["refresh_token"] as? JsonValue.StringValue)?.value
    }

    /** Best-effort Matrix device logout (`/logout`) on explicit sign-out. */
    fun logout(homeserverOrigin: String, matrixAccessToken: String) {
        if (runCatching { IssuerAdmission.validateOrigin(homeserverOrigin, loopback) }.isFailure ||
            matrixAccessToken.isEmpty() ||
            !TrustPolicy.isVisibleASCII(matrixAccessToken)
        ) {
            return
        }
        val req = Request.Builder()
            .url("$homeserverOrigin/_matrix/client/v3/logout")
            .header("Authorization", "Bearer $matrixAccessToken")
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .post("{}".toByteArray(Charsets.UTF_8).toRequestBody("application/json".toMediaType()))
            .build()
        runCatching {
            httpClient.newCall(req).execute().close()
        }
    }

    fun sendTextMessage(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String? = null,
        attachments: List<AttachmentMetadataRef> = emptyList(),
    ): String {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure ||
            runCatching { UuidV7Identifier.parse(transactionId) }.isFailure ||
            attachments.size > AttachmentMetadataRef.MAX_REFS_PER_MESSAGE
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val trimmedBody = body.trim()
        if (trimmedBody.isEmpty() && attachments.isEmpty()) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        if (replyToEventId != null && !isValidMatrixEventId(replyToEventId)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }

        val effectiveBody = when {
            attachments.isEmpty() -> body
            trimmedBody.isEmpty() -> AttachmentMetadataRef.fallbackBody(attachments)
            else -> "$body\n\n${AttachmentMetadataRef.fallbackBody(attachments)}"
        }

        val payload = JsonObject().apply {
            addProperty("msgtype", "m.text")
            addProperty("body", effectiveBody)
            if (replyToEventId != null) {
                add(
                    "m.relates_to",
                    JsonObject().apply {
                        add("m.in_reply_to", JsonObject().apply { addProperty("event_id", replyToEventId) })
                    },
                )
            }
            if (attachments.isNotEmpty()) {
                val arr = JsonArray()
                for (ref in attachments) {
                    arr.add(
                        JsonObject().apply {
                            addProperty("id", ref.id)
                            addProperty("filename", ref.filename)
                            addProperty("contentType", ref.contentType.wireValue)
                            addProperty("sizeBytes", ref.sizeBytes)
                        },
                    )
                }
                add(AttachmentMetadataRef.MATRIX_FIELD_NAME, arr)
            }
        }
        return putRoomEvent(homeserverOrigin, matrixAccessToken, roomId, "m.room.message", transactionId, payload)
    }

    fun editMessage(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        newBody: String,
    ): String {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure ||
            runCatching { UuidV7Identifier.parse(transactionId) }.isFailure ||
            !isValidMatrixEventId(targetEventId) ||
            newBody.trim().isEmpty()
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val payload = JsonObject().apply {
            addProperty("msgtype", "m.text")
            addProperty("body", "* $newBody")
            add(
                "m.new_content",
                JsonObject().apply {
                    addProperty("msgtype", "m.text")
                    addProperty("body", newBody)
                },
            )
            add(
                "m.relates_to",
                JsonObject().apply {
                    addProperty("rel_type", "m.replace")
                    addProperty("event_id", targetEventId)
                },
            )
        }
        return putRoomEvent(homeserverOrigin, matrixAccessToken, roomId, "m.room.message", transactionId, payload)
    }

    fun redactEvent(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        reason: String? = null,
    ): String {
        requirePlaintextAllowed(homeserverOrigin, roomId)
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure ||
            runCatching { UuidV7Identifier.parse(transactionId) }.isFailure ||
            !isValidMatrixEventId(targetEventId)
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val payload = JsonObject().apply {
            if (!reason.isNullOrEmpty()) {
                if (reason.length > 255) throw MatrixClientException(MatrixClientError.INVALID_INPUT)
                addProperty("reason", reason)
            }
        }
        val bodyBytes = payload.toString().toByteArray(Charsets.UTF_8)
        if (bodyBytes.size > JSON_BYTE_LIMIT) {
            throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
        }
        val encodedRoom = percentEncodeSegment(roomId)
        val encodedTarget = percentEncodeSegment(targetEventId)
        val root = matrixJsonRequest(
            url = "$homeserverOrigin/_matrix/client/v3/rooms/$encodedRoom/redact/$encodedTarget/$transactionId",
            method = "PUT",
            matrixAccessToken = matrixAccessToken,
            jsonBody = bodyBytes,
        )
        val eventId = (root["event_id"] as? JsonValue.StringValue)?.value
        if (eventId == null || !isValidMatrixEventId(eventId)) {
            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        }
        return eventId
    }

    fun sendReaction(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        emojiKey: String,
    ): String {
        validateHomeserverOriginAndToken(homeserverOrigin, matrixAccessToken)
        if (runCatching { MatrixRoomId.parse(roomId) }.isFailure ||
            runCatching { UuidV7Identifier.parse(transactionId) }.isFailure ||
            !isValidMatrixEventId(targetEventId) ||
            !ReactionKeyValidator.isValid(emojiKey)
        ) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val payload = JsonObject().apply {
            add(
                "m.relates_to",
                JsonObject().apply {
                    addProperty("rel_type", "m.annotation")
                    addProperty("event_id", targetEventId)
                    addProperty("key", emojiKey)
                },
            )
        }
        return putRoomEvent(homeserverOrigin, matrixAccessToken, roomId, "m.reaction", transactionId, payload)
    }

    /** Executes the 3-step Core-scoped attachment upload (`POST .../uploads` -> credential-free `PUT` -> `POST .../complete`). */
    fun uploadChannelAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload,
    ): AttachmentMetadataRef {
        requireUploadAllowed(organisationId, channelId)
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || !TrustPolicy.canonicalNonNilUUID(channelId)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        val rawBytes = payload.dataBytes()
        val sha256Hex = sha256LowercaseHex(rawBytes)
        val createIdempotency = UuidV7Identifier.mint().toString()
        val completeIdempotency = UuidV7Identifier.mint().toString()

        val createReqJson = JsonObject().apply {
            addProperty("filename", payload.filename)
            addProperty("contentType", payload.contentType.wireValue)
            addProperty("sizeBytes", rawBytes.size)
            addProperty("sha256", sha256Hex)
            addProperty("channelId", channelId)
        }.toString().toByteArray(Charsets.UTF_8)

        fence.checkActive()
        val createReply = coreRequester.post(
            path = "/api/v1/organisations/$organisationId/workspace/attachments/uploads",
            jsonBody = createReqJson,
            idempotencyKey = createIdempotency,
        ) { resp ->
            resp.code to readBounded(resp, JSON_BYTE_LIMIT)
        }
        val ticketBytes = unwrapCoreReply(createReply, setOf(201))
        val ticket = decodeUploadTicket(ticketBytes, loopback)

        // Step 2: Credential-free presigned PUT (ZERO Authorization, Cookie, or redirect following).
        requireUploadAllowed(organisationId, channelId)
        val putBuilder = Request.Builder()
            .url(ticket.uploadUrl)
            .put(rawBytes.toRequestBody(null))
        for ((headerName, headerVal) in ticket.headers) {
            putBuilder.header(headerName, headerVal)
        }
        try {
            executeFencedCall(putBuilder.build()) { putResp ->
                if (putResp.code in 300..399) {
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
                when (putResp.code) {
                    200, 201, 204 -> Unit
                    413 -> throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
                    429 -> throw MatrixClientException(MatrixClientError.RATE_LIMITED)
                    in 500..599 -> throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                    else -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
            }
        } catch (err: MatrixClientException) {
            throw err
        } catch (io: IOException) {
            throw MatrixClientException(MatrixClientError.TRANSPORT, mapIoException(io))
        }

        // Step 3: Complete upload on Core and verify server-confirmed SHA-256 & byte size.
        requireUploadAllowed(organisationId, channelId)
        val completeReply = coreRequester.post(
            path = "/api/v1/organisations/$organisationId/workspace/attachments/${ticket.attachmentId}/complete",
            jsonBody = "{}".toByteArray(Charsets.UTF_8),
            idempotencyKey = completeIdempotency,
        ) { resp ->
            resp.code to readBounded(resp, JSON_BYTE_LIMIT)
        }
        val completeBytes = unwrapCoreReply(completeReply, setOf(200))
        return decodeCompletedAttachment(completeBytes, ticket.attachmentId, sha256Hex, rawBytes.size)
    }

    private fun putRoomEvent(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        eventType: String,
        transactionId: String,
        payload: JsonObject,
    ): String {
        requirePlaintextAllowed(homeserverOrigin, roomId)
        val bodyBytes = payload.toString().toByteArray(Charsets.UTF_8)
        if (bodyBytes.size > JSON_BYTE_LIMIT) {
            throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
        }
        val encodedRoom = percentEncodeSegment(roomId)
        val encodedType = percentEncodeSegment(eventType)
        val root = matrixJsonRequest(
            url = "$homeserverOrigin/_matrix/client/v3/rooms/$encodedRoom/send/$encodedType/$transactionId",
            method = "PUT",
            matrixAccessToken = matrixAccessToken,
            jsonBody = bodyBytes,
        )
        val eventId = (root["event_id"] as? JsonValue.StringValue)?.value
        if (eventId == null || !isValidMatrixEventId(eventId)) {
            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        }
        return eventId
    }

    private fun matrixJsonRequest(
        url: String,
        method: String,
        matrixAccessToken: String,
        jsonBody: ByteArray?,
        extraFence: SessionFence? = null,
        responseByteLimit: Int = JSON_BYTE_LIMIT,
    ): Map<String, JsonValue> = matrixJsonRequestInternal(
        url = url,
        method = method,
        bearerToken = matrixAccessToken,
        jsonBody = jsonBody,
        extraFence = extraFence,
        responseByteLimit = responseByteLimit,
    )

    private fun matrixJsonRequestInternal(
        url: String,
        method: String,
        bearerToken: String?,
        jsonBody: ByteArray?,
        extraFence: SessionFence? = null,
        responseByteLimit: Int = JSON_BYTE_LIMIT,
    ): Map<String, JsonValue> {
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
        if (bearerToken != null) {
            builder.header("Authorization", "Bearer $bearerToken")
        }
        when (method) {
            "GET" -> builder.get()
            "PUT" -> builder.put((jsonBody ?: ByteArray(0)).toRequestBody("application/json".toMediaType()))
            "POST" -> builder.post((jsonBody ?: ByteArray(0)).toRequestBody("application/json".toMediaType()))
            else -> throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }

        return try {
            executeFencedCall(builder.build(), extraFence) { response ->
                if (response.code in 300..399) {
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
                when (response.code) {
                    200 -> {
                        val bytes = readBounded(response, responseByteLimit)
                            ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        try {
                            StrictJson.parse(bytes, responseByteLimit).objectValue()
                        } catch (_: Exception) {
                            throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                        }
                    }
                    401 -> throw MatrixClientException(MatrixClientError.UNAUTHORIZED)
                    403 -> throw MatrixClientException(MatrixClientError.FORBIDDEN)
                    404 -> throw MatrixClientException(MatrixClientError.NOT_FOUND)
                    413 -> throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
                    429 -> throw MatrixClientException(MatrixClientError.RATE_LIMITED)
                    in 500..599 -> throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                    else -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
            }
        } catch (err: MatrixClientException) {
            throw err
        } catch (io: IOException) {
            if (fence.isInvalidated || extraFence?.isInvalidated == true) {
                throw MatrixClientException(MatrixClientError.SIGNED_OUT)
            }
            throw MatrixClientException(MatrixClientError.TRANSPORT, mapIoException(io))
        }
    }

    private inline fun <T> executeFencedCall(
        request: Request,
        extraFence: SessionFence? = null,
        reader: (Response) -> T,
    ): T {
        fence.checkActive()
        extraFence?.checkActive()
        val call: Call = httpClient.newCall(request)
        val token1 = fence.registerCancellation { call.cancel() }
        val token2 = extraFence?.registerCancellation { call.cancel() }
        try {
            call.execute().use { response ->
                fence.checkActive()
                extraFence?.checkActive()
                return reader(response)
            }
        } finally {
            fence.unregisterCancellation(token1)
            extraFence?.unregisterCancellation(token2)
        }
    }

    private fun validateHomeserverOriginAndToken(homeserverOrigin: String, matrixAccessToken: String) {
        try {
            IssuerAdmission.validateOrigin(homeserverOrigin, loopback)
        } catch (_: DomainFailure) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        if (matrixAccessToken.isEmpty() || matrixAccessToken.length > 4096 || !TrustPolicy.isVisibleASCII(matrixAccessToken)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
    }

    private fun unwrapCoreReply(
        reply: CoreReply<Pair<Int, ByteArray?>>,
        expectedStatuses: Set<Int>,
    ): ByteArray = when (reply) {
        is CoreReply.Answered -> {
            val (code, bytes) = reply.value
            when {
                code in expectedStatuses -> bytes ?: throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                code == 404 -> throw MatrixClientException(MatrixClientError.NOT_FOUND)
                code == 413 -> throw MatrixClientException(MatrixClientError.PAYLOAD_TOO_LARGE)
                code == 429 -> throw MatrixClientException(MatrixClientError.RATE_LIMITED)
                code in 500..599 -> throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                else -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
        }
        CoreReply.Forbidden -> throw MatrixClientException(MatrixClientError.FORBIDDEN)
        CoreReply.SignedOut -> throw MatrixClientException(MatrixClientError.SIGNED_OUT)
        CoreReply.IdentityUnavailable -> throw MatrixClientException(MatrixClientError.IDENTITY_UNAVAILABLE)
        CoreReply.PathRefused, CoreReply.Unsendable -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
        is CoreReply.Transport -> throw MatrixClientException(MatrixClientError.TRANSPORT, reply.reason)
    }

    private data class UploadTicket(
        val attachmentId: String,
        val uploadUrl: String,
        val headers: Map<String, String>,
    )

    companion object {
        const val SYNC_TIMELINE_LIMIT: Int = 25
        const val JSON_BYTE_LIMIT: Int = 65_536
        const val DEFAULT_SSO_CALLBACK_URI: String = "io.kodera.app:/oauth2redirect"
        const val SSO_CALLBACK_SCHEME: String = "io.kodera.app"
        const val SYNC_RESPONSE_BYTE_LIMIT = 262_144
        fun boundedSyncFilterJson(roomId: String): String = JsonObject().apply {
            add("room", JsonObject().apply {
                add("rooms", JsonArray().apply { add(roomId) })
                add("state", JsonObject().apply {
                    addProperty("limit", 16)
                    add("types", JsonArray().apply { add("m.room.encryption"); add("io.kodera.room.security"); add("io.kodera.room.confidential") })
                })
                add("timeline", JsonObject().apply { addProperty("limit", SYNC_TIMELINE_LIMIT) })
                for (section in listOf("ephemeral", "account_data")) add(section, JsonObject().apply { add("types", JsonArray()) })
            })
            for (section in listOf("presence", "account_data")) add(section, JsonObject().apply { add("types", JsonArray()) })
        }.toString()
        private val SSO_CSPRNG = SecureRandom()

        /** Builds `{homeserverOrigin}/_matrix/client/v3/login/sso/redirect?redirectUrl=...` with a 32-byte cryptographic `state`. */
        fun buildSsoRedirectRequest(
            homeserverOrigin: String,
            callbackBaseUri: String = DEFAULT_SSO_CALLBACK_URI,
            explicitState: String? = null,
            loopback: LoopbackPolicy,
        ): MatrixSsoRedirectRequest {
            try {
                IssuerAdmission.validateOrigin(homeserverOrigin, loopback)
            } catch (_: DomainFailure) {
                throw MatrixClientException(MatrixClientError.INVALID_INPUT)
            }
            val parsedCallback = try { URI(callbackBaseUri) } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.INVALID_INPUT)
            }
            if (parsedCallback.scheme != SSO_CALLBACK_SCHEME ||
                parsedCallback.rawAuthority != null ||
                parsedCallback.path != "/oauth2redirect" ||
                parsedCallback.rawFragment != null
            ) {
                throw MatrixClientException(MatrixClientError.INVALID_INPUT)
            }
            val state = if (explicitState != null) {
                if (!isValidSsoState(explicitState)) throw MatrixClientException(MatrixClientError.INVALID_INPUT)
                explicitState
            } else {
                val rand = ByteArray(32).also(SSO_CSPRNG::nextBytes)
                KoderaMobileFfiBridge.encodeHex(rand)
            }
            val keptPairs = parseRawQueryPairs(parsedCallback.rawQuery)
                .filter { (k, _) -> k != "state" && k != "loginToken" }
                .toMutableList()
            keptPairs.add("state" to state)
            val callbackQuery = keptPairs.joinToString("&") { (k, v) ->
                "${percentEncodeSegment(k)}=${percentEncodeSegment(v)}"
            }
            val callbackUri = "$SSO_CALLBACK_SCHEME:/oauth2redirect?$callbackQuery"
            val ssoRedirectUrl =
                "$homeserverOrigin/_matrix/client/v3/login/sso/redirect?redirectUrl=${percentEncodeSegment(callbackUri)}"
            return MatrixSsoRedirectRequest(
                homeserverOrigin = homeserverOrigin,
                ssoRedirectUrl = ssoRedirectUrl,
                callbackUri = callbackUri,
                state = state,
            )
        }

        /**
         * Strips `loginToken` and `state` from [rawCallbackUri] immediately, verifies `state == expectedState`
         * in constant time, and returns the single-use [MatrixSsoTokenGrant].
         */
        fun consumeSsoCallbackUri(
            rawCallbackUri: String,
            expectedState: String,
        ): MatrixSsoTokenGrant {
            if (!isValidSsoState(expectedState) || rawCallbackUri.length > 4096) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val parsed = try { URI(rawCallbackUri) } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            if (parsed.scheme != SSO_CALLBACK_SCHEME ||
                parsed.rawAuthority != null ||
                parsed.path != "/oauth2redirect"
            ) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val pairs = parseRawQueryPairs(parsed.rawQuery)
            val loginToken = pairs.firstOrNull { it.first == "loginToken" }?.second
            val returnedState = pairs.firstOrNull { it.first == "state" }?.second

            // Immediately strip both `loginToken` and `state` before any further validation.
            val remaining = pairs.filter { it.first != "loginToken" && it.first != "state" }
            val redactedUri = if (remaining.isEmpty()) {
                DEFAULT_SSO_CALLBACK_URI
            } else {
                val q = remaining.joinToString("&") { (k, v) ->
                    "${percentEncodeSegment(k)}=${percentEncodeSegment(v)}"
                }
                "$SSO_CALLBACK_SCHEME:/oauth2redirect?$q"
            }

            if (returnedState == null ||
                !MessageDigest.isEqual(
                    returnedState.toByteArray(Charsets.UTF_8),
                    expectedState.toByteArray(Charsets.UTF_8),
                ) ||
                loginToken.isNullOrEmpty() ||
                loginToken.length > 4096 ||
                !TrustPolicy.isVisibleASCII(loginToken)
            ) {
                throw MatrixClientException(MatrixClientError.FORBIDDEN)
            }
            return MatrixSsoTokenGrant(loginToken = loginToken, redactedCallbackUri = redactedUri)
        }

        /** Standalone best-effort Matrix `/logout` usable during sign-out even after a channel screen closed. */
        fun logoutStandalone(
            homeserverOrigin: String,
            matrixAccessToken: String,
            loopback: LoopbackPolicy,
            httpStub: MatrixHttpStub? = null,
            timeoutMillis: Long = 3_000L,
        ) {
            if (runCatching { IssuerAdmission.validateOrigin(homeserverOrigin, loopback) }.isFailure ||
                matrixAccessToken.isEmpty() ||
                !TrustPolicy.isVisibleASCII(matrixAccessToken)
            ) {
                return
            }
            val client = buildHardenedHttpClient(
                testInterceptor = httpStub?.let(::stubToInterceptor),
                timeoutMillis = timeoutMillis,
            )
            try {
                val req = Request.Builder()
                    .url("$homeserverOrigin/_matrix/client/v3/logout")
                    .header("Authorization", "Bearer $matrixAccessToken")
                    .header("Accept", "application/json")
                    .header("Cache-Control", "no-store")
                    .post("{}".toByteArray(Charsets.UTF_8).toRequestBody("application/json".toMediaType()))
                    .build()
                runCatching { client.newCall(req).execute().close() }
            } finally {
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
            }
        }

        private fun stubToInterceptor(stub: MatrixHttpStub): Interceptor = Interceptor { chain ->
            val req = chain.request()
            val bodyUtf8 = req.body?.let { body ->
                val buffer = Buffer()
                body.writeTo(buffer)
                buffer.readUtf8()
            }
            val reply = stub.handle(
                MatrixHttpInspection(
                    method = req.method,
                    url = req.url.toString(),
                    authorizationHeader = req.header("Authorization"),
                    bodyUtf8 = bodyUtf8,
                )
            )
            val contentType = (reply.headers["Content-Type"] ?: "application/json").toMediaType()
            val builder = Response.Builder()
                .request(req)
                .protocol(Protocol.HTTP_1_1)
                .code(reply.statusCode)
                .message("stub")
                .body(reply.bytes().toResponseBody(contentType))
            for ((k, v) in reply.headers) {
                builder.header(k, v)
            }
            builder.build()
        }

        private fun parseRawQueryPairs(rawQuery: String?): List<Pair<String, String>> {
            if (rawQuery.isNullOrEmpty()) return emptyList()
            return rawQuery.split('&').mapNotNull { part ->
                if (part.isEmpty()) return@mapNotNull null
                val eq = part.indexOf('=')
                if (eq < 0) {
                    URLDecoder.decode(part, Charsets.UTF_8) to ""
                } else {
                    URLDecoder.decode(part.substring(0, eq), Charsets.UTF_8) to
                        URLDecoder.decode(part.substring(eq + 1), Charsets.UTF_8)
                }
            }
        }

        private fun isValidSsoState(value: String): Boolean {
            if (value.length !in 16..128) return false
            return value.all { it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' || it == '_' }
        }

        internal fun isValidExpectedOidcSubject(value: String): Boolean {
            if (value.length !in 1..255) return false
            return value.all { it.code in 0x21..0x7E && it != ':' }
        }

        /** Extracts the `"sub"` claim from a 3-segment JWT payload without depending on `android.jar` stubs. */
        fun extractOidcJwtSubject(idToken: String?): String? {
            if (idToken.isNullOrEmpty()) return null
            val parts = idToken.split('.')
            if (parts.size != 3 || parts[1].isEmpty()) return null
            return try {
                val decoded = java.util.Base64.getUrlDecoder().decode(parts[1])
                if (decoded.size > 16_384) return null
                val obj = StrictJson.parse(decoded, 16_384).objectValue()
                val sub = (obj["sub"] as? JsonValue.StringValue)?.value ?: return null
                sub.takeIf { it.length in 1..255 && TrustPolicy.isVisibleASCII(it) }
            } catch (_: Exception) {
                null
            }
        }

        private val FORBIDDEN_PRESIGNED_HEADERS = setOf(
            "authorization", "cookie", "set-cookie", "host", "origin", "referer",
            "content-length", "transfer-encoding", "connection",
        )

        private fun buildHardenedHttpClient(testInterceptor: Interceptor?, timeoutMillis: Long): OkHttpClient =
            OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .cookieJar(CookieJar.NO_COOKIES)
                .cache(null)
                .authenticator(Authenticator.NONE)
                .connectTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .apply {
                    if (testInterceptor != null) addInterceptor(testInterceptor)
                }
                .build()

        internal fun readBounded(response: Response, limit: Int): ByteArray? {
            val declared = response.header("Content-Length")?.toLongOrNull()
            if (declared != null && declared > limit) return null
            val stream: InputStream = response.body.byteStream()
            return stream.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(4096)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > limit) return null
                    out.write(buf, 0, n)
                }
                out.toByteArray()
            }
        }

        private fun decodeUploadTicket(bytes: ByteArray, loopback: LoopbackPolicy): UploadTicket {
            val root = try {
                StrictJson.parse(bytes, JSON_BYTE_LIMIT).objectValue()
            } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val attachmentId = (root["attachmentId"] as? JsonValue.StringValue)?.value
            val rawUrl = (root["uploadUrl"] as? JsonValue.StringValue)?.value
            val method = (root["method"] as? JsonValue.StringValue)?.value
            val rawHeaders = (root["headers"] as? JsonValue.ObjectValue)?.fields
            val expiresAt = (root["expiresAt"] as? JsonValue.StringValue)?.value
            if (attachmentId == null || !TrustPolicy.canonicalNonNilUUID(attachmentId) ||
                rawUrl == null || rawUrl.length > 2048 ||
                method != "PUT" || rawHeaders == null || expiresAt.isNullOrEmpty()
            ) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val uri = try { URI(rawUrl) } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (uri.rawUserInfo != null || uri.rawFragment != null || host.isNullOrEmpty()) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
            if (scheme == "https") {
                // Admitted
            } else if (scheme == "http" && loopback == LoopbackPolicy.ADMIT_FOR_DEVELOPMENT && isLoopback) {
                // Admitted in explicit development policy
            } else {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }

            if (rawHeaders.size > 16) throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            val validatedHeaders = LinkedHashMap<String, String>(rawHeaders.size)
            for ((name, value) in rawHeaders) {
                val lower = name.lowercase()
                val text = (value as? JsonValue.StringValue)?.value
                if (name.isEmpty() || name.length > 128 ||
                    lower in FORBIDDEN_PRESIGNED_HEADERS ||
                    lower.startsWith("proxy-") || lower.startsWith("sec-") ||
                    name.any { it.code !in 0x21..0x7E || it == ':' } ||
                    text == null || text.length > 1024 ||
                    '\r' in text || '\n' in text
                ) {
                    throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
                }
                validatedHeaders[name] = text
            }
            return UploadTicket(attachmentId, rawUrl, validatedHeaders)
        }

        private fun decodeCompletedAttachment(
            bytes: ByteArray,
            expectedId: String,
            expectedSha256: String,
            expectedSizeBytes: Int,
        ): AttachmentMetadataRef {
            val root = try {
                StrictJson.parse(bytes, JSON_BYTE_LIMIT).objectValue()
            } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            val id = (root["id"] as? JsonValue.StringValue)?.value
            val filename = (root["filename"] as? JsonValue.StringValue)?.value
            val rawMime = (root["contentType"] as? JsonValue.StringValue)?.value
            val mime = rawMime?.let(AttachmentMimeType::fromWire)
            val sizeLong = try { root["sizeBytes"]?.integerValue() } catch (_: Exception) { null }
            val sha256 = (root["sha256"] as? JsonValue.StringValue)?.value
            if (id != expectedId || filename == null || mime == null ||
                sizeLong != expectedSizeBytes.toLong() || sha256 != expectedSha256
            ) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
            return try {
                AttachmentMetadataRef.create(id, filename, mime, expectedSizeBytes)
            } catch (_: Exception) {
                throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            }
        }

        internal fun decodeTimelineEvent(value: JsonValue): MatrixRawTimelineEvent? {
            val obj = (value as? JsonValue.ObjectValue)?.fields ?: return null
            val type = (obj["type"] as? JsonValue.StringValue)?.value ?: return null
            val eventId = (obj["event_id"] as? JsonValue.StringValue)?.value ?: return null
            if (!isValidMatrixEventId(eventId)) return null
            val sender = (obj["sender"] as? JsonValue.StringValue)?.value ?: return null
            if (runCatching { MatrixUserId.parse(sender) }.isFailure) return null
            val originServerTs = try { obj["origin_server_ts"]?.integerValue() } catch (_: Exception) { null } ?: return null

            val content = (obj["content"] as? JsonValue.ObjectValue)?.fields
            val unsigned = (obj["unsigned"] as? JsonValue.ObjectValue)?.fields
            val isRedactedUnsigned = unsigned?.get("redacted_because") is JsonValue.ObjectValue
            val transactionId = (unsigned?.get("transaction_id") as? JsonValue.StringValue)?.value

            val msgtype = (content?.get("msgtype") as? JsonValue.StringValue)?.value
            val body = (content?.get("body") as? JsonValue.StringValue)?.value
            val newContentBody = ((content?.get("m.new_content") as? JsonValue.ObjectValue)
                ?.fields?.get("body") as? JsonValue.StringValue)?.value

            val relates = (content?.get("m.relates_to") as? JsonValue.ObjectValue)?.fields
            val relationType = (relates?.get("rel_type") as? JsonValue.StringValue)?.value
            val relatesToEventId = (relates?.get("event_id") as? JsonValue.StringValue)?.value
            val reactionKey = (relates?.get("key") as? JsonValue.StringValue)?.value
            val replyToEventId = ((relates?.get("m.in_reply_to") as? JsonValue.ObjectValue)
                ?.fields?.get("event_id") as? JsonValue.StringValue)?.value
            val redactsEventId = (obj["redacts"] as? JsonValue.StringValue)?.value
                ?: (content?.get("redacts") as? JsonValue.StringValue)?.value

            val attachments = ArrayList<AttachmentMetadataRef>()
            val rawRefs = (content?.get(AttachmentMetadataRef.MATRIX_FIELD_NAME) as? JsonValue.ArrayValue)?.values
            if (rawRefs != null) {
                for (item in rawRefs.take(AttachmentMetadataRef.MAX_REFS_PER_MESSAGE)) {
                    val refObj = (item as? JsonValue.ObjectValue)?.fields ?: continue
                    val id = (refObj["id"] as? JsonValue.StringValue)?.value ?: continue
                    val fname = (refObj["filename"] as? JsonValue.StringValue)?.value ?: continue
                    val mime = (refObj["contentType"] as? JsonValue.StringValue)?.value?.let(AttachmentMimeType::fromWire) ?: continue
                    val size = try { refObj["sizeBytes"]?.integerValue()?.toInt() } catch (_: Exception) { null } ?: continue
                    val validated = runCatching { AttachmentMetadataRef.create(id, fname, mime, size) }.getOrNull() ?: continue
                    attachments.add(validated)
                }
            }

            return MatrixRawTimelineEvent(
                type = type,
                eventId = eventId,
                sender = sender,
                originServerTs = originServerTs,
                msgtype = msgtype,
                body = body,
                newContentBody = newContentBody,
                relationType = relationType,
                relatesToEventId = relatesToEventId,
                reactionKey = reactionKey,
                replyToEventId = replyToEventId,
                redactsEventId = redactsEventId,
                transactionId = transactionId,
                isRedactedUnsigned = isRedactedUnsigned,
                attachments = attachments,
                callId = (content?.get("call_id") as? JsonValue.StringValue)?.value,
                callPartyId = (content?.get("party_id") as? JsonValue.StringValue)?.value,
            )
        }

        /** Derives the deployment Matrix base domain from a validated `coreApiOrigin` (`api.kodera.io` -> `kodera.io`). */
        fun deriveMatrixDomain(coreApiOrigin: String, loopback: LoopbackPolicy): String? {
            val uri = try { URI(coreApiOrigin) } catch (_: Exception) { return null }
            val rawHost = uri.host?.lowercase() ?: return null
            if (rawHost == "localhost" || rawHost == "127.0.0.1" || rawHost == "::1" || rawHost == "[::1]") {
                return if (loopback.admitsLoopback) "kodera.test" else null
            }
            for (prefix in listOf("api.", "core.")) {
                if (rawHost.startsWith(prefix)) {
                    val candidate = rawHost.removePrefix(prefix)
                    if ('.' in candidate && runCatching { MatrixServerName.parse(candidate) }.isSuccess) {
                        return candidate
                    }
                }
            }
            return if ('.' in rawHost && runCatching { MatrixServerName.parse(rawHost) }.isSuccess) rawHost else null
        }

        internal fun sha256LowercaseHex(bytes: ByteArray): String =
            KoderaMobileFfiBridge.encodeHex(MessageDigest.getInstance("SHA-256").digest(bytes))

        private fun isValidMatrixEventId(value: String): Boolean =
            value.startsWith("$") && value.length in 2..255 && TrustPolicy.isVisibleASCII(value)

        private fun isValidDnsLabel(slug: String): Boolean {
            val lower = slug.lowercase()
            if (lower.length !in 1..63 || lower.first() == '-' || lower.last() == '-') return false
            return lower.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }
        }

        private fun percentEncodeSegment(raw: String): String =
            URLEncoder.encode(raw, Charsets.UTF_8).replace("+", "%20")

        private fun mapIoException(error: IOException): TransportFailure = when (error) {
            is SSLException -> TransportFailure.TLS
            is InterruptedIOException -> TransportFailure.TIMEOUT
            is UnknownHostException, is ConnectException, is NoRouteToHostException -> TransportFailure.OFFLINE
            else -> TransportFailure.OTHER
        }
    }
}

/**
 * Live `ChannelConversationTransport` backed by `MatrixRoomClient`, supporting both pre-authenticated
 * tokens and production Synapse OIDC SSO (`m.login.token`) sessions sealed in `RustSessionVault`.
 */
class MatrixChannelConversationTransport private constructor(
    initialOwnUserId: String,
    private val roomClient: MatrixRoomClient,
    private val organisationSlug: String,
    private val matrixDomain: String,
    private val matrixServerName: String,
    private val authStrategy: AuthStrategy,
    private val fetchWorkspace: ((String) -> WorkspaceOutcome)?,
) : ChannelConversationTransport, AutoCloseable {

    private sealed interface AuthStrategy {
        data class StaticToken(val accessToken: String) : AuthStrategy
        data class SsoVault(
            val organisationId: String,
            val vaultDeviceId: String,
            val expectedSubjectProvider: () -> String,
            val ssoAuthorizer: MatrixSsoAuthorizer,
            val loadVault: (String, String) -> ByteArray?,
            val saveVault: (String, String, ByteArray) -> Boolean,
            val onSessionEstablished: ((PersistedMatrixSession) -> Unit)?,
        ) : AuthStrategy
    }

    private val stateLock = Any()
    @Volatile private var currentOwnUserId: String = initialOwnUserId
    private var cachedHomeserverOrigin: String? = null
    private var cachedSession: PersistedMatrixSession? = null

    override val ownUserId: String
        get() = currentOwnUserId

    constructor(
        ownUserId: String,
        roomClient: MatrixRoomClient,
        organisationSlug: String,
        matrixDomain: String,
        matrixServerName: String,
        matrixAccessToken: String,
        fetchWorkspace: ((String) -> WorkspaceOutcome)? = null,
    ) : this(
        initialOwnUserId = ownUserId,
        roomClient = roomClient,
        organisationSlug = organisationSlug.lowercase(),
        matrixDomain = matrixDomain.lowercase(),
        matrixServerName = matrixServerName,
        authStrategy = AuthStrategy.StaticToken(matrixAccessToken),
        fetchWorkspace = fetchWorkspace,
    )

    constructor(
        roomClient: MatrixRoomClient,
        organisationId: String,
        organisationSlug: String,
        matrixDomain: String,
        vaultDeviceId: String,
        initialExpectedSubject: String? = null,
        expectedSubjectProvider: () -> String,
        ssoAuthorizer: MatrixSsoAuthorizer,
        loadVault: (String, String) -> ByteArray?,
        saveVault: (String, String, ByteArray) -> Boolean,
        onSessionEstablished: ((PersistedMatrixSession) -> Unit)? = null,
        fetchWorkspace: ((String) -> WorkspaceOutcome)? = null,
    ) : this(
        initialOwnUserId = "@${initialExpectedSubject ?: "member"}:${organisationSlug.lowercase()}.${matrixDomain.lowercase()}",
        roomClient = roomClient,
        organisationSlug = organisationSlug.lowercase(),
        matrixDomain = matrixDomain.lowercase(),
        matrixServerName = "${organisationSlug.lowercase()}.${matrixDomain.lowercase()}",
        authStrategy = AuthStrategy.SsoVault(
            organisationId = organisationId,
            vaultDeviceId = vaultDeviceId,
            expectedSubjectProvider = expectedSubjectProvider,
            ssoAuthorizer = ssoAuthorizer,
            loadVault = loadVault,
            saveVault = saveVault,
            onSessionEstablished = onSessionEstablished,
        ),
        fetchWorkspace = fetchWorkspace,
    )

    constructor(
        roomClient: MatrixRoomClient,
        organisationId: String,
        organisationSlug: String,
        matrixDomain: String,
        vaultDeviceId: String,
        owner: AcceptedOwner,
        ssoAuthorizer: MatrixSsoAuthorizer,
        loadVault: (String, String) -> ByteArray?,
        saveVault: (String, String, ByteArray) -> Boolean,
        onSessionEstablished: ((PersistedMatrixSession) -> Unit)? = null,
        fetchWorkspace: ((String) -> WorkspaceOutcome)? = null,
    ) : this(
        roomClient = roomClient,
        organisationId = organisationId,
        organisationSlug = organisationSlug,
        matrixDomain = matrixDomain,
        vaultDeviceId = vaultDeviceId,
        initialExpectedSubject = owner.authenticatedSubject(),
        expectedSubjectProvider = {
            if (owner.isRetired) throw MatrixClientException(MatrixClientError.SIGNED_OUT)
            owner.authenticatedSubject()?.takeIf { MatrixRoomClient.isValidExpectedOidcSubject(it) }
                ?: throw MatrixClientException(MatrixClientError.FORBIDDEN)
        },
        ssoAuthorizer = ssoAuthorizer,
        loadVault = loadVault,
        saveVault = saveVault,
        onSessionEstablished = onSessionEstablished,
        fetchWorkspace = fetchWorkspace,
    )

    fun logoutIfAuthenticated(): Boolean {
        val session = synchronized(stateLock) {
            val existing = cachedSession
            cachedSession = null
            existing
        } ?: return false
        roomClient.logout(session.homeserverOrigin, session.accessToken)
        return true
    }

    override fun close() {
        roomClient.close()
    }

    private fun resolveAuthenticatedContext(): Pair<String, String> = when (val strategy = authStrategy) {
        is AuthStrategy.StaticToken -> {
            val existing = synchronized(stateLock) { cachedHomeserverOrigin }
            if (existing != null) {
                existing to strategy.accessToken
            } else {
                val discovered = roomClient.discoverHomeserverOrigin(organisationSlug, matrixDomain)
                synchronized(stateLock) { cachedHomeserverOrigin = discovered }
                discovered to strategy.accessToken
            }
        }
        is AuthStrategy.SsoVault -> {
            val inMem = synchronized(stateLock) { cachedSession }
            if (inMem != null) {
                inMem.homeserverOrigin to inMem.accessToken
            } else {
                val expectedSub = strategy.expectedSubjectProvider()
                val restored = runCatching {
                    strategy.loadVault(strategy.organisationId, strategy.vaultDeviceId)
                        ?.let(PersistedMatrixSession::decodeVaultBytes)
                }.getOrNull()
                if (restored != null &&
                    restored.serverName == matrixServerName &&
                    restored.userId == "@$expectedSub:$matrixServerName"
                ) {
                    synchronized(stateLock) {
                        cachedSession = restored
                        cachedHomeserverOrigin = restored.homeserverOrigin
                        currentOwnUserId = restored.userId
                    }
                    strategy.onSessionEstablished?.invoke(restored)
                    restored.homeserverOrigin to restored.accessToken
                } else {
                    val discovered = roomClient.discoverHomeserverOrigin(organisationSlug, matrixDomain)
                    val authenticated = roomClient.authenticateWithSso(
                        homeserverOrigin = discovered,
                        serverName = matrixServerName,
                        deviceId = strategy.vaultDeviceId,
                        expectedSubject = expectedSub,
                        ssoAuthorizer = strategy.ssoAuthorizer,
                    )
                    val saved = strategy.saveVault(
                        strategy.organisationId,
                        strategy.vaultDeviceId,
                        authenticated.encodeVaultBytes(),
                    )
                    if (!saved) {
                        roomClient.logout(authenticated.homeserverOrigin, authenticated.accessToken)
                        throw MatrixClientException(MatrixClientError.SIGNED_OUT)
                    }
                    synchronized(stateLock) {
                        cachedSession = authenticated
                        cachedHomeserverOrigin = authenticated.homeserverOrigin
                        currentOwnUserId = authenticated.userId
                    }
                    strategy.onSessionEstablished?.invoke(authenticated)
                    authenticated.homeserverOrigin to authenticated.accessToken
                }
            }
        }
    }

    private fun <T> withAuthenticatedRetry(
        syncFence: SessionFence? = null,
        block: (String, String, SessionFence?) -> T,
    ): T {
        val (origin, token) = resolveAuthenticatedContext()
        return try {
            block(origin, token, syncFence)
        } catch (err: MatrixClientException) {
            val strategy = authStrategy as? AuthStrategy.SsoVault ?: throw err
            val current = synchronized(stateLock) { cachedSession }
            if (err.reason != MatrixClientError.UNAUTHORIZED || current == null) {
                throw err
            }
            val expectedSub = strategy.expectedSubjectProvider()
            val refreshToken = current.refreshToken
            var reauthenticatedViaSso = false
            val recovered: PersistedMatrixSession = if (refreshToken != null) {
                try {
                    val (newAccess, newRefresh) = roomClient.refreshSession(current.homeserverOrigin, refreshToken)
                    PersistedMatrixSession(
                        homeserverOrigin = current.homeserverOrigin,
                        serverName = current.serverName,
                        userId = current.userId,
                        deviceId = current.deviceId,
                        accessToken = newAccess,
                        refreshToken = newRefresh ?: refreshToken,
                    )
                } catch (refreshErr: MatrixClientException) {
                    if (refreshErr.reason != MatrixClientError.UNAUTHORIZED &&
                        refreshErr.reason != MatrixClientError.FORBIDDEN
                    ) {
                        throw refreshErr
                    }
                    reauthenticatedViaSso = true
                    roomClient.authenticateWithSso(
                        homeserverOrigin = current.homeserverOrigin,
                        serverName = matrixServerName,
                        deviceId = strategy.vaultDeviceId,
                        expectedSubject = expectedSub,
                        ssoAuthorizer = strategy.ssoAuthorizer,
                    )
                }
            } else {
                reauthenticatedViaSso = true
                roomClient.authenticateWithSso(
                    homeserverOrigin = current.homeserverOrigin,
                    serverName = matrixServerName,
                    deviceId = strategy.vaultDeviceId,
                    expectedSubject = expectedSub,
                    ssoAuthorizer = strategy.ssoAuthorizer,
                )
            }
            val saved = strategy.saveVault(strategy.organisationId, strategy.vaultDeviceId, recovered.encodeVaultBytes())
            if (!saved) {
                roomClient.logout(recovered.homeserverOrigin, recovered.accessToken)
                throw MatrixClientException(MatrixClientError.SIGNED_OUT)
            }
            synchronized(stateLock) {
                cachedSession = recovered
                cachedHomeserverOrigin = recovered.homeserverOrigin
                currentOwnUserId = recovered.userId
            }
            strategy.onSessionEstablished?.invoke(recovered)
            block(recovered.homeserverOrigin, recovered.accessToken, if (reauthenticatedViaSso) null else syncFence)
        }
    }

    override fun updateChannelSecurity(organisationId: String, channelId: String, isConfidential: Boolean?) {
        roomClient.updateChannelSecurity(organisationId, channelId, isConfidential)
    }

    override fun bootstrapRoom(organisationId: String, channelId: String): BootstrappedMatrixRoom =
        bootstrapRoom(organisationId, channelId, null)

    override fun bootstrapRoom(
        organisationId: String,
        channelId: String,
        syncFence: SessionFence?,
    ): BootstrappedMatrixRoom {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) {
            throw MatrixClientException(MatrixClientError.INVALID_INPUT)
        }
        // Bootstrap (`/.well-known` -> SSO Custom Tab + `/login` -> room directory -> initial `/sync`)
        // is fenced strictly by `roomClient.fence` (session/conversation lifetime) so Activity
        // backgrounding during the SSO Custom Tab never invalidates the single-use `loginToken`.
        val confidential = if (fetchWorkspace != null) workspaceChannelConfidentiality(fetchWorkspace.invoke(organisationId), channelId)
            else roomClient.channelConfidentiality(organisationId, channelId)
        return withAuthenticatedRetry(syncFence = null) { origin, token, _ ->
            val roomId = roomClient.resolveChannelRoomId(origin, token, channelId, matrixServerName, extraFence = null)
            roomClient.bindChannelSecurity(organisationId, channelId, origin, roomId.rawValue, confidential)
            roomClient.joinRoom(origin, token, roomId.rawValue)
            val batch = roomClient.sync(origin, token, since = null, roomId = roomId.rawValue, extraFence = null)
            BootstrappedMatrixRoom(roomId.rawValue, batch)
        }
    }

    override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch =
        syncRoom(roomId, since, null)

    override fun syncRoom(
        roomId: String,
        since: String?,
        syncFence: SessionFence?,
    ): MatrixSyncBatch = withAuthenticatedRetry(syncFence) { origin, token, activeSyncFence ->
        roomClient.sync(origin, token, since, roomId = roomId, extraFence = activeSyncFence)
    }

    override fun backfillRoomMessages(roomId: String, fromToken: String, limit: Int): List<MatrixRawTimelineEvent> =
        backfillRoomMessages(roomId, fromToken, limit, null)

    override fun backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int,
        syncFence: SessionFence?,
    ): List<MatrixRawTimelineEvent> = withAuthenticatedRetry(syncFence) { origin, token, activeSyncFence ->
        roomClient.fetchRoomMessages(origin, token, roomId, fromToken, limit, extraFence = activeSyncFence)
    }

    private fun <T> withPlaintextRoom(roomId: String, block: (String, String, SessionFence?) -> T): T {
        val origin = synchronized(stateLock) { cachedHomeserverOrigin } ?: throw MatrixClientException(MatrixClientError.PLAINTEXT_FORBIDDEN)
        roomClient.requirePlaintextAllowed(origin, roomId)
        return withAuthenticatedRetry(block = block)
    }

    override fun sendMessage(
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String?,
        attachments: List<AttachmentMetadataRef>,
    ): String = withPlaintextRoom(roomId) { origin, token, _ ->
        roomClient.sendTextMessage(origin, token, roomId, transactionId, body, replyToEventId, attachments)
    }

    override fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String): String =
        withPlaintextRoom(roomId) { origin, token, _ ->
            roomClient.editMessage(origin, token, roomId, transactionId, targetEventId, newBody)
        }

    override fun redactEvent(roomId: String, transactionId: String, targetEventId: String): String =
        withPlaintextRoom(roomId) { origin, token, _ ->
            roomClient.redactEvent(origin, token, roomId, transactionId, targetEventId)
        }

    override fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String): String =
        withPlaintextRoom(roomId) { origin, token, _ ->
            roomClient.sendReaction(origin, token, roomId, transactionId, targetEventId, emojiKey)
        }

    override fun uploadAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload,
    ): AttachmentMetadataRef = roomClient.uploadChannelAttachment(organisationId, channelId, payload)
}

internal fun workspaceChannelConfidentiality(result: WorkspaceOutcome, channelId: String): Boolean? {
    when (result) {
        WorkspaceOutcome.SignedOut -> throw MatrixClientException(MatrixClientError.SIGNED_OUT)
        is WorkspaceOutcome.Unavailable -> when (val failure = result.failure) {
            WorkspaceFailure.Forbidden -> throw MatrixClientException(MatrixClientError.FORBIDDEN)
            WorkspaceFailure.NotFound -> throw MatrixClientException(MatrixClientError.NOT_FOUND)
            WorkspaceFailure.ProtocolViolation -> throw MatrixClientException(MatrixClientError.PROTOCOL_VIOLATION)
            WorkspaceFailure.ServiceUnavailable -> throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
            WorkspaceFailure.IdentityUnavailable -> throw MatrixClientException(MatrixClientError.IDENTITY_UNAVAILABLE)
            is WorkspaceFailure.Transport -> throw MatrixClientException(MatrixClientError.TRANSPORT, failure.reason)
        }
        is WorkspaceOutcome.Loaded -> Unit
    }
    val channels = result.workspace.uncategorisedChannels + result.workspace.categories.flatMap { it.channels }
    val channel = channels.firstOrNull { it.id == channelId && it.lifecycle == WorkspaceChannelLifecycle.ACTIVE }
        ?: throw MatrixClientException(MatrixClientError.FORBIDDEN)
    return channel.isConfidential
}
