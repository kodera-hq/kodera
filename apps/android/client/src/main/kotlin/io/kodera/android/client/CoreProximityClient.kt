package io.kodera.android.client

import io.kodera.android.domain.TrustPolicy

/** Volatile workspace radio material; intentionally has no diagnostic data-class representation. */
class ProximityBootstrap(val workspaceId: String, val scopeTag: String, val epoch: Long,
    val epochExpiresAtUnixSeconds: Long, epochMacKey: ByteArray) {
    val epochMacKey: ByteArray = epochMacKey.copyOf()
    override fun toString(): String = "ProximityBootstrap(<redacted>)"
}

/** Access remains subject to Core's current workspace membership on every explicit bootstrap. */
class CoreProximityClient(private val requester: CoreRequester,
    private val clockUnixSeconds: () -> Long = { System.currentTimeMillis() / 1_000L }) {
    fun bootstrap(workspaceId: String): ProximityBootstrap? {
        if (!TrustPolicy.canonicalNonNilUUID(workspaceId)) return null
        val body = "{\"workspace_id\":\"$workspaceId\",\"event_scope\":\"default\"}".toByteArray(Charsets.UTF_8)
        return when (val reply = requester.post("/api/v1/proximity/bootstrap", body) { response ->
            if (response.code != 200) null else {
                val bytes = CoreRequester.bounded(response.body.byteStream())
                if (bytes == null) null else try { decode(bytes, workspaceId, clockUnixSeconds()) }
                catch (_: DiscoveryDecodingException) { null }
            }
        }) {
            is CoreReply.Answered -> reply.value
            else -> null
        }
    }

    internal companion object {
        fun decode(data: ByteArray, workspaceId: String, nowUnixSeconds: Long = System.currentTimeMillis() / 1_000L): ProximityBootstrap {
            if (!TrustPolicy.canonicalNonNilUUID(workspaceId)) refused()
            val fields = StrictJson.parse(data).objectValue()
            if (fields.keys != setOf("workspace_id", "event_scope", "epoch_mac_key", "epoch", "epoch_expires_at", "epoch_rotation_seconds")) refused()
            if (fields.getValue("workspace_id").stringValue() != workspaceId || fields.getValue("event_scope").stringValue() != "default") refused()
            val epoch = fields.getValue("epoch").integerValue()
            val expires = fields.getValue("epoch_expires_at").integerValue()
            if (nowUnixSeconds < 0 || fields.getValue("epoch_rotation_seconds").integerValue() != 900L || epoch !in 0..0xFFFF_FFFFL ||
                epoch != nowUnixSeconds / 900L || expires != (epoch + 1) * 900L || expires <= nowUnixSeconds) refused()
            val hex = fields.getValue("epoch_mac_key").stringValue()
            if (hex.length != 64 || !hex.all { it in '0'..'9' || it in 'a'..'f' }) refused()
            val key = ByteArray(32) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
            if (key.all { it == 0.toByte() }) refused()
            return ProximityBootstrap(workspaceId, "default", epoch, expires, key)
        }
    }
}
