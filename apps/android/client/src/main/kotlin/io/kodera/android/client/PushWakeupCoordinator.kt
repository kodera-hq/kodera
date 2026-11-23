package io.kodera.android.client

import com.google.gson.JsonObject
import io.kodera.android.domain.KoderaMobileFfiFailure
import io.kodera.android.domain.MatrixServerName
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.ZeroPayloadWakeupEnvelope
import java.net.URI

enum class InboxNotificationKind(val wireValue: String) {
    MENTION("mention"),
    INVITATION("invitation"),
    MODERATION("moderation"),
    DOCUMENT("document");

    companion object {
        fun fromWire(raw: String): InboxNotificationKind? =
            entries.firstOrNull { it.wireValue == raw }
    }
}

data class InboxNotificationItem(
    val id: String,
    val kind: InboxNotificationKind,
    val resourceId: String,
    val createdAt: String,
    val readAt: String?,
)

data class InboxNotificationPage(
    val items: List<InboxNotificationItem>,
    val hasMore: Boolean,
    val nextCursor: String?,
)

enum class PushWakeupError {
    INVALID_INPUT,
    PAYLOAD_REJECTED,
    ORGANISATION_MISMATCH,
    PROTOCOL_VIOLATION,
    FORBIDDEN,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    SIGNED_OUT,
    IDENTITY_UNAVAILABLE,
    TRANSPORT,
}

class PushWakeupException(
    val reason: PushWakeupError,
    val detail: String? = null,
) : Exception(if (detail != null) "${reason.name}:$detail" else reason.name)

/**
 * Coordinates device wakeup endpoint registration (`endpoint`, `p256dh`, `auth`), strict zero-cleartext
 * push envelope admission, authenticated `/api/v1/notifications` + Matrix `/sync` catch-up,
 * and sign-out endpoint revocation.
 */
class PushWakeupCoordinator(private val requester: CoreRequester) {

    fun registerDeviceWakeup(
        deviceId: String,
        endpoint: String,
        p256dh: String,
        auth: String,
    ) {
        if (!TrustPolicy.canonicalNonNilUUID(deviceId) ||
            !isValidHttpsWakeupEndpoint(endpoint) ||
            !isValidBase64Url(p256dh, exactLength = 87) ||
            !isValidBase64Url(auth, exactLength = 22)
        ) {
            throw PushWakeupException(PushWakeupError.INVALID_INPUT)
        }
        val bodyBytes = JsonObject().apply {
            addProperty("endpoint", endpoint)
            addProperty("p256dh", p256dh)
            addProperty("auth", auth)
        }.toString().toByteArray(Charsets.UTF_8)

        val reply = requester.put(
            path = deviceWakeupPath(deviceId),
            jsonBody = bodyBytes,
        ) { it.code }
        when (reply) {
            is CoreReply.Answered -> when (reply.value) {
                200, 204 -> Unit
                429 -> throw PushWakeupException(PushWakeupError.RATE_LIMITED)
                in 500..599 -> throw PushWakeupException(PushWakeupError.SERVICE_UNAVAILABLE)
                else -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            }
            CoreReply.Forbidden -> throw PushWakeupException(PushWakeupError.FORBIDDEN)
            CoreReply.SignedOut -> throw PushWakeupException(PushWakeupError.SIGNED_OUT)
            CoreReply.IdentityUnavailable -> throw PushWakeupException(PushWakeupError.IDENTITY_UNAVAILABLE)
            CoreReply.PathRefused, CoreReply.Unsendable -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            is CoreReply.Transport -> throw PushWakeupException(PushWakeupError.TRANSPORT, reply.reason.name)
        }
    }

    fun revokeOnSignOut(deviceId: String) {
        if (!TrustPolicy.canonicalNonNilUUID(deviceId)) {
            throw PushWakeupException(PushWakeupError.INVALID_INPUT)
        }
        val reply = requester.delete(path = deviceWakeupPath(deviceId)) { it.code }
        when (reply) {
            is CoreReply.Answered -> when (reply.value) {
                200, 204, 404 -> Unit
                429 -> throw PushWakeupException(PushWakeupError.RATE_LIMITED)
                in 500..599 -> throw PushWakeupException(PushWakeupError.SERVICE_UNAVAILABLE)
                else -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            }
            CoreReply.Forbidden -> throw PushWakeupException(PushWakeupError.FORBIDDEN)
            CoreReply.SignedOut -> throw PushWakeupException(PushWakeupError.SIGNED_OUT)
            CoreReply.IdentityUnavailable -> throw PushWakeupException(PushWakeupError.IDENTITY_UNAVAILABLE)
            CoreReply.PathRefused, CoreReply.Unsendable -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            is CoreReply.Transport -> throw PushWakeupException(PushWakeupError.TRANSPORT, reply.reason.name)
        }
    }

    fun fetchNotificationInbox(limit: Int = 50, cursor: String? = null): InboxNotificationPage {
        if (limit !in 1..200) {
            throw PushWakeupException(PushWakeupError.INVALID_INPUT)
        }
        val query = ArrayList<Pair<String, String>>(2)
        query.add("limit" to limit.toString())
        if (cursor != null) {
            query.add("cursor" to cursor)
        }
        val reply = requester.get(path = "/api/v1/notifications", query = query) { resp ->
            resp.code to MatrixRoomClient.readBounded(resp, MatrixRoomClient.JSON_BYTE_LIMIT)
        }
        return when (reply) {
            is CoreReply.Answered -> {
                val (code, bytes) = reply.value
                when (code) {
                    200 -> decodeInboxPage(bytes ?: throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION))
                    429 -> throw PushWakeupException(PushWakeupError.RATE_LIMITED)
                    in 500..599 -> throw PushWakeupException(PushWakeupError.SERVICE_UNAVAILABLE)
                    else -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                }
            }
            CoreReply.Forbidden -> throw PushWakeupException(PushWakeupError.FORBIDDEN)
            CoreReply.SignedOut -> throw PushWakeupException(PushWakeupError.SIGNED_OUT)
            CoreReply.IdentityUnavailable -> throw PushWakeupException(PushWakeupError.IDENTITY_UNAVAILABLE)
            CoreReply.PathRefused, CoreReply.Unsendable -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            is CoreReply.Transport -> throw PushWakeupException(PushWakeupError.TRANSPORT, reply.reason.name)
        }
    }

    fun handleIncomingWakeup(
        rawPayload: ByteArray,
        expectedOrganisationId: String? = null,
        inboxLimit: Int = 50,
        onMatrixCatchUp: (() -> Unit)? = null,
    ): InboxNotificationPage {
        if (rawPayload.isNotEmpty()) {
            val admitted = try {
                ZeroPayloadWakeupEnvelope.admit(rawPayload)
            } catch (err: KoderaMobileFfiFailure) {
                throw PushWakeupException(PushWakeupError.PAYLOAD_REJECTED, err.detail ?: err.reason.name)
            }
            if (expectedOrganisationId != null) {
                if (!TrustPolicy.canonicalNonNilUUID(expectedOrganisationId)) {
                    throw PushWakeupException(PushWakeupError.INVALID_INPUT)
                }
                if (admitted.organisationId != expectedOrganisationId) {
                    throw PushWakeupException(PushWakeupError.ORGANISATION_MISMATCH)
                }
            }
        }
        val page = fetchNotificationInbox(limit = inboxLimit, cursor = null)
        onMatrixCatchUp?.invoke()
        return page
    }

    companion object {
        const val SURFACE_IDENTIFIER: String = "android"

        private fun deviceWakeupPath(deviceId: String): String =
            "/api/v1/push/subscriptions/$deviceId"

        private fun decodeInboxPage(bytes: ByteArray): InboxNotificationPage {
            val root = try {
                StrictJson.parse(bytes, MatrixRoomClient.JSON_BYTE_LIMIT).objectValue()
            } catch (_: Exception) {
                throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            }
            val rawItems = (root["data"] as? JsonValue.ArrayValue)?.values
                ?: throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            val hasMore = (root["has_more"] as? JsonValue.BooleanValue)?.value
                ?: throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            val nextCursor = when (val c = root["next_cursor"]) {
                null, JsonValue.NullValue -> null
                is JsonValue.StringValue -> {
                    if (c.value.isEmpty() || c.value.length > 512) {
                        throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                    }
                    c.value
                }
                else -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
            }

            val items = ArrayList<InboxNotificationItem>(rawItems.size)
            for (entry in rawItems) {
                val obj = (entry as? JsonValue.ObjectValue)?.fields
                    ?: throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                val id = (obj["id"] as? JsonValue.StringValue)?.value
                val kind = (obj["kind"] as? JsonValue.StringValue)?.value?.let(InboxNotificationKind::fromWire)
                val resourceId = (obj["resourceId"] as? JsonValue.StringValue)?.value
                val createdAt = (obj["createdAt"] as? JsonValue.StringValue)?.value
                if (id == null || !TrustPolicy.canonicalNonNilUUID(id) ||
                    kind == null || resourceId == null || !TrustPolicy.canonicalNonNilUUID(resourceId) ||
                    createdAt.isNullOrEmpty()
                ) {
                    throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                }
                val readAt = when (val r = obj["readAt"]) {
                    null, JsonValue.NullValue -> null
                    is JsonValue.StringValue -> {
                        if (r.value.isEmpty()) throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                        r.value
                    }
                    else -> throw PushWakeupException(PushWakeupError.PROTOCOL_VIOLATION)
                }
                items.add(InboxNotificationItem(id, kind, resourceId, createdAt, readAt))
            }
            return InboxNotificationPage(items, hasMore, nextCursor)
        }

        private fun isValidHttpsWakeupEndpoint(raw: String): Boolean {
            if (!raw.startsWith("https://") || raw.length > 2048 || !TrustPolicy.isVisibleASCII(raw)) return false
            val uri = try { URI(raw) } catch (_: Exception) { return false }
            val host = uri.host ?: return false
            if (uri.scheme?.lowercase() != "https" || uri.rawUserInfo != null || uri.rawFragment != null) return false
            return runCatching { MatrixServerName.parse(host.lowercase()) }.isSuccess
        }

        private fun isValidBase64Url(raw: String, exactLength: Int): Boolean =
            raw.length == exactLength && raw.all {
                it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_'
            }
    }
}
