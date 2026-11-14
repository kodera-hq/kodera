package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

enum class CallWakeupError {
    INVALID_PAYLOAD_FORMAT,
    CLEARTEXT_PAYLOAD_FORBIDDEN,
    UNEXPECTED_PUSH_FIELD,
    INVALID_WAKEUP_ID,
    INVALID_ORGANISATION_ID,
    INVALID_ROOM_HASH,
    INVALID_EPOCH_MS,
    STALE_EPOCH_MS,
    INVALID_CALL_DESCRIPTOR,
    REPLAY_WAKEUP,
    ORGANISATION_MISMATCH,
    INVALID_TRANSITION,
    STOPPED,
}

class CallWakeupFailure(
    val reason: CallWakeupError,
    val detail: String? = null,
) : Exception(if (detail != null) "${reason.name}:$detail" else reason.name)

enum class CallPushAdmissionPolicy {
    /** Rejects any push envelope carrying cleartext room/caller/message fields or unknown fields. */
    REJECT_CLEARTEXT,

    /** Strips untrusted relay fields while admitting only validated opaque wakeup identifiers. */
    STRIP_UNTRUSTED_RELAY_FIELDS,
}

enum class PushRelayTransport(val wire: String) {
    UNIFIED_PUSH("unifiedpush"),
    FCM("fcm"),
}

data class PayloadFreePushResult(
    val envelope: PayloadFreePushEnvelope,
    val strippedFieldNames: Set<String>,
)

/**
 * Strict payload-free UnifiedPush / FCM wakeup envelope.
 * Zero message plaintext, caller display names, room titles, or media grants may traverse push relays.
 */
@ConsistentCopyVisibility
data class PayloadFreePushEnvelope private constructor(
    val wakeupId: String,
    val organisationId: String,
    val roomHash: String,
    val epochMs: Long,
    val transport: PushRelayTransport? = null,
) {
    val orgId: String get() = organisationId
    val syncHint: String get() = roomHash

    fun validateEpochSkew(nowEpochMs: Long, maxSkewMs: Long = DEFAULT_MAX_EPOCH_SKEW_MS) {
        if (nowEpochMs <= 0L || maxSkewMs < 0L) {
            throw CallWakeupFailure(CallWakeupError.INVALID_EPOCH_MS)
        }
        val delta = if (epochMs >= nowEpochMs) epochMs - nowEpochMs else nowEpochMs - epochMs
        if (delta > maxSkewMs) {
            throw CallWakeupFailure(CallWakeupError.STALE_EPOCH_MS)
        }
    }

    companion object {
        const val MAXIMUM_ENVELOPE_BYTES: Int = 4096
        const val MAXIMUM_ROOM_HASH_BYTES: Int = 128
        const val DEFAULT_MAX_EPOCH_SKEW_MS: Long = 300_000L
        private const val MAXIMUM_EPOCH_MS: Long = 4_102_444_800_000L // 2100-01-01T00:00:00Z

        private val ADMITTED_FIELDS = setOf(
            "wakeup_id",
            "org_id",
            "organisation_id",
            "room_hash",
            "sync_hint",
            "epoch_ms",
            "transport",
        )

        private val FORBIDDEN_CLEARTEXT_MARKERS = setOf(
            "notification",
            "room_title",
            "roomtitle",
            "room_name",
            "roomname",
            "channel_name",
            "channelname",
            "sender",
            "sender_name",
            "sendername",
            "sender_display_name",
            "caller",
            "caller_name",
            "callername",
            "display_name",
            "displayname",
            "message",
            "body",
            "plaintext",
            "text",
            "content",
            "topic",
            "subject",
            "title",
            "subtitle",
            "alert",
            "avatar_url",
            "matrix_event",
            "sdp",
            "livekit_token",
            "access_token",
            "auth_token",
        )

        fun create(
            wakeupId: String,
            organisationId: String,
            roomHash: String,
            epochMs: Long,
            transport: PushRelayTransport? = null,
        ): PayloadFreePushEnvelope {
            if (!TrustPolicy.canonicalNonNilUUID(wakeupId)) {
                throw CallWakeupFailure(CallWakeupError.INVALID_WAKEUP_ID)
            }
            if (!TrustPolicy.canonicalNonNilUUID(organisationId)) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
            }
            if (!isValidOpaqueRoomHash(roomHash)) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ROOM_HASH)
            }
            if (epochMs !in 1L..MAXIMUM_EPOCH_MS) {
                throw CallWakeupFailure(CallWakeupError.INVALID_EPOCH_MS)
            }
            return PayloadFreePushEnvelope(wakeupId, organisationId, roomHash, epochMs, transport)
        }

        fun admit(
            jsonBytes: ByteArray,
            policy: CallPushAdmissionPolicy = CallPushAdmissionPolicy.REJECT_CLEARTEXT,
        ): PayloadFreePushResult {
            if (jsonBytes.isEmpty() || jsonBytes.size > MAXIMUM_ENVELOPE_BYTES) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            val parsed = StrictPushJsonParser.parseTopObject(jsonBytes)
            return admitParsedMap(parsed, policy)
        }

        fun admit(
            jsonText: String,
            policy: CallPushAdmissionPolicy = CallPushAdmissionPolicy.REJECT_CLEARTEXT,
        ): PayloadFreePushResult {
            val encoded = jsonText.toByteArray(Charsets.UTF_8)
            if (String(encoded, Charsets.UTF_8) != jsonText) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            return admit(encoded, policy)
        }

        /** Admits a flat string map delivered by Android FCM `RemoteMessage.data` or UnifiedPush intent extras. */
        fun admitDataMap(
            fields: Map<String, String>,
            policy: CallPushAdmissionPolicy = CallPushAdmissionPolicy.REJECT_CLEARTEXT,
        ): PayloadFreePushResult {
            if (fields.isEmpty() || fields.size > 32) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            val converted = LinkedHashMap<String, PushJsonValue>(fields.size)
            for ((k, v) in fields) {
                converted[k] = PushJsonValue.Text(v)
            }
            return admitParsedMap(converted, policy)
        }

        private fun admitParsedMap(
            topObject: Map<String, PushJsonValue>,
            policy: CallPushAdmissionPolicy,
        ): PayloadFreePushResult {
            val stripped = LinkedHashSet<String>()
            val effectiveFields = LinkedHashMap<String, PushJsonValue>()

            for ((key, value) in topObject) {
                if (isForbiddenCleartextKey(key)) {
                    when (policy) {
                        CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                            throw CallWakeupFailure(CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN, key)
                        CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                            stripped.add(key)
                            continue
                        }
                    }
                }
                if (key == "data" && value is PushJsonValue.Obj) {
                    for ((nestedKey, nestedVal) in value.entries) {
                        val qualified = "data.$nestedKey"
                        if (isForbiddenCleartextKey(nestedKey)) {
                            when (policy) {
                                CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                                    throw CallWakeupFailure(CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN, qualified)
                                CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                                    stripped.add(qualified)
                                    continue
                                }
                            }
                        }
                        if (nestedVal is PushJsonValue.Obj) {
                            val leaked = firstForbiddenNestedKey(nestedVal.entries)
                            if (leaked != null) {
                                when (policy) {
                                    CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                                        throw CallWakeupFailure(
                                            CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN,
                                            "$qualified.$leaked"
                                        )
                                    CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                                        stripped.add("$qualified.$leaked")
                                        stripped.add(qualified)
                                        continue
                                    }
                                }
                            }
                        }
                        if (nestedKey !in ADMITTED_FIELDS) {
                            when (policy) {
                                CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                                    throw CallWakeupFailure(CallWakeupError.UNEXPECTED_PUSH_FIELD, qualified)
                                CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                                    stripped.add(qualified)
                                    continue
                                }
                            }
                        }
                        if (effectiveFields.containsKey(nestedKey) && effectiveFields[nestedKey] != nestedVal) {
                            throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                        }
                        effectiveFields[nestedKey] = nestedVal
                    }
                    continue
                }
                if (value is PushJsonValue.Obj) {
                    val leaked = firstForbiddenNestedKey(value.entries)
                    if (leaked != null) {
                        val qualified = "$key.$leaked"
                        when (policy) {
                            CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                                throw CallWakeupFailure(CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN, qualified)
                            CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                                stripped.add(qualified)
                                stripped.add(key)
                                continue
                            }
                        }
                    }
                }
                if (key !in ADMITTED_FIELDS) {
                    when (policy) {
                        CallPushAdmissionPolicy.REJECT_CLEARTEXT ->
                            throw CallWakeupFailure(CallWakeupError.UNEXPECTED_PUSH_FIELD, key)
                        CallPushAdmissionPolicy.STRIP_UNTRUSTED_RELAY_FIELDS -> {
                            stripped.add(key)
                            continue
                        }
                    }
                }
                if (effectiveFields.containsKey(key) && effectiveFields[key] != value) {
                    throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                }
                effectiveFields[key] = value
            }

            val wakeupId = (effectiveFields["wakeup_id"] as? PushJsonValue.Text)?.value
                ?: throw CallWakeupFailure(CallWakeupError.INVALID_WAKEUP_ID)

            val orgPrimary = (effectiveFields["org_id"] as? PushJsonValue.Text)?.value
            val orgAlias = (effectiveFields["organisation_id"] as? PushJsonValue.Text)?.value
            if (effectiveFields.containsKey("org_id") && orgPrimary == null) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
            }
            if (effectiveFields.containsKey("organisation_id") && orgAlias == null) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
            }
            if (orgPrimary != null && orgAlias != null && orgPrimary != orgAlias) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
            }
            val organisationId = orgPrimary ?: orgAlias
                ?: throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)

            val hashPrimary = (effectiveFields["room_hash"] as? PushJsonValue.Text)?.value
            val hashAlias = (effectiveFields["sync_hint"] as? PushJsonValue.Text)?.value
            if (effectiveFields.containsKey("room_hash") && hashPrimary == null) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ROOM_HASH)
            }
            if (effectiveFields.containsKey("sync_hint") && hashAlias == null) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ROOM_HASH)
            }
            if (hashPrimary != null && hashAlias != null && hashPrimary != hashAlias) {
                throw CallWakeupFailure(CallWakeupError.INVALID_ROOM_HASH)
            }
            val roomHash = hashPrimary ?: hashAlias
                ?: throw CallWakeupFailure(CallWakeupError.INVALID_ROOM_HASH)

            val epochMs = when (val rawEpoch = effectiveFields["epoch_ms"]) {
                is PushJsonValue.Whole -> rawEpoch.value
                is PushJsonValue.Text -> parseCanonicalPositiveLong(rawEpoch.value)
                    ?: throw CallWakeupFailure(CallWakeupError.INVALID_EPOCH_MS)
                else -> throw CallWakeupFailure(CallWakeupError.INVALID_EPOCH_MS)
            }

            val transport = when (val rawTransport = effectiveFields["transport"]) {
                null -> null
                is PushJsonValue.Text -> PushRelayTransport.entries.firstOrNull {
                    it.wire == rawTransport.value.lowercase()
                } ?: throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                else -> throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }

            val envelope = create(
                wakeupId = wakeupId,
                organisationId = organisationId,
                roomHash = roomHash,
                epochMs = epochMs,
                transport = transport,
            )
            return PayloadFreePushResult(envelope, stripped)
        }

        private fun parseCanonicalPositiveLong(raw: String): Long? {
            if (raw.isEmpty() || raw.length > 16 || raw.first() !in '1'..'9' || raw.any { it !in '0'..'9' }) {
                return null
            }
            return raw.toLongOrNull()
        }

        private fun isForbiddenCleartextKey(key: String): Boolean {
            val normalized = key.trim().lowercase().replace('-', '_')
            return normalized in FORBIDDEN_CLEARTEXT_MARKERS
        }

        private fun firstForbiddenNestedKey(entries: Map<String, PushJsonValue>): String? {
            for (key in entries.keys.sorted()) {
                if (isForbiddenCleartextKey(key)) return key
                val child = entries[key]
                if (child is PushJsonValue.Obj) {
                    val nested = firstForbiddenNestedKey(child.entries)
                    if (nested != null) return "$key.$nested"
                }
            }
            return null
        }

        internal fun isValidOpaqueRoomHash(value: String): Boolean {
            val bytes = value.toByteArray(Charsets.UTF_8)
            if (bytes.size !in 1..MAXIMUM_ROOM_HASH_BYTES || String(bytes, Charsets.UTF_8) != value) {
                return false
            }
            return bytes.all { byte ->
                val u = byte.toInt() and 0xFF
                u in 0x30..0x39 || u in 0x41..0x5A || u in 0x61..0x7A ||
                    u == 0x2D || u == 0x2E || u == 0x5F || u == 0x3A
            }
        }
    }
}

/** Validated incoming wakeup correlated to an Android `ConnectionService` / `TelecomManager` call ID. */
data class IncomingCallWakeup(
    val envelope: PayloadFreePushEnvelope,
    val connectionId: String = envelope.wakeupId,
) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(connectionId)) {
            throw CallWakeupFailure(CallWakeupError.INVALID_WAKEUP_ID)
        }
    }

    val wakeupId: String get() = envelope.wakeupId
    val organisationId: String get() = envelope.organisationId
    val roomHash: String get() = envelope.roomHash
    val epochMs: Long get() = envelope.epochMs
}

/** Encrypted call descriptor resolved strictly over an authenticated Core / MatrixRTC session. */
@ConsistentCopyVisibility
data class VerifiedCallDescriptor private constructor(
    val wakeupId: String,
    val organisationId: String,
    val roomId: String,
    val liveKitRoomName: String,
    val callerLabel: String,
    val hasVideo: Boolean,
) {
    companion object {
        fun create(
            wakeupId: String,
            organisationId: String,
            roomId: String,
            liveKitRoomName: String,
            callerLabel: String,
            hasVideo: Boolean,
        ): VerifiedCallDescriptor {
            if (!TrustPolicy.canonicalNonNilUUID(wakeupId) ||
                !TrustPolicy.canonicalNonNilUUID(organisationId) ||
                !TrustPolicy.boundedScopeChannelId(roomId) ||
                !PayloadFreePushEnvelope.isValidOpaqueRoomHash(liveKitRoomName) ||
                !TrustPolicy.boundedScalarText(callerLabel, requireTrimmed = true)
            ) {
                throw CallWakeupFailure(CallWakeupError.INVALID_CALL_DESCRIPTOR)
            }
            return VerifiedCallDescriptor(
                wakeupId = wakeupId,
                organisationId = organisationId,
                roomId = roomId,
                liveKitRoomName = liveKitRoomName,
                callerLabel = callerLabel,
                hasVideo = hasVideo,
            )
        }
    }
}

enum class CallAudioRoute {
    EARPIECE,
    SPEAKER,
    BLUETOOTH,
    WIRED_HEADSET,
}

enum class CallEndReason {
    LOCAL_HANGUP,
    REMOTE_ENDED,
    UNANSWERED_TIMEOUT,
    ORGANISATION_CHANGED,
}

enum class CallRejectionReason {
    USER_DECLINED,
    UNTRUSTED_PUSH_PAYLOAD,
    CLEARTEXT_PUSH_FORBIDDEN,
    REPLAY_WAKEUP,
    STALE_WAKEUP_EPOCH,
    ORGANISATION_MISMATCH,
    UNAUTHENTICATED_SESSION,
    CALL_RESOLUTION_FAILED,
    TELECOM_REJECTED,
}

/**
 * Android `ConnectionService` / `TelecomManager` lifecycle states:
 * `Idle`, `WakeupPending`, `Ringing`, `Connecting`, `Connected`, `OnHold`, `Ended`, `Rejected`.
 */
sealed interface TelecomCallPhase {
    data object Idle : TelecomCallPhase
    data class WakeupPending(val wakeup: IncomingCallWakeup) : TelecomCallPhase
    data class Ringing(val wakeup: IncomingCallWakeup, val descriptor: VerifiedCallDescriptor) : TelecomCallPhase
    data class Connecting(val wakeup: IncomingCallWakeup, val descriptor: VerifiedCallDescriptor) : TelecomCallPhase
    data class Connected(
        val wakeup: IncomingCallWakeup,
        val descriptor: VerifiedCallDescriptor,
        val isMuted: Boolean,
        val isVideoEnabled: Boolean,
        val audioRoute: CallAudioRoute,
    ) : TelecomCallPhase

    data class OnHold(
        val wakeup: IncomingCallWakeup,
        val descriptor: VerifiedCallDescriptor,
        val isMuted: Boolean,
        val isVideoEnabled: Boolean,
        val audioRoute: CallAudioRoute,
    ) : TelecomCallPhase

    data class Ended(val reason: CallEndReason) : TelecomCallPhase
    data class Rejected(val reason: CallRejectionReason) : TelecomCallPhase
}

/**
 * Deterministic state machine for Android `ConnectionService` / `TelecomManager` calls and
 * payload-free UnifiedPush/FCM wakeups.
 */
class CallSessionState(organisationId: String? = null) {
    companion object {
        const val MAXIMUM_TRACKED_WAKEUPS: Int = 128
    }

    var organisationId: String? = null
        private set

    var phase: TelecomCallPhase = TelecomCallPhase.Idle
        private set

    private val seenWakeupOrder = ArrayDeque<String>()
    private val seenWakeupSet = HashSet<String>()

    init {
        if (organisationId != null && !TrustPolicy.canonicalNonNilUUID(organisationId)) {
            throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
        }
        this.organisationId = organisationId
    }

    val activeConnectionId: String?
        get() = when (val current = phase) {
            is TelecomCallPhase.WakeupPending -> current.wakeup.connectionId
            is TelecomCallPhase.Ringing -> current.wakeup.connectionId
            is TelecomCallPhase.Connecting -> current.wakeup.connectionId
            is TelecomCallPhase.Connected -> current.wakeup.connectionId
            is TelecomCallPhase.OnHold -> current.wakeup.connectionId
            TelecomCallPhase.Idle, is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected -> null
        }

    val isMuted: Boolean
        get() = when (val current = phase) {
            is TelecomCallPhase.Connected -> current.isMuted
            is TelecomCallPhase.OnHold -> current.isMuted
            else -> false
        }

    val isHeld: Boolean
        get() = phase is TelecomCallPhase.OnHold

    val isVideoEnabled: Boolean
        get() = when (val current = phase) {
            is TelecomCallPhase.Ringing -> current.descriptor.hasVideo
            is TelecomCallPhase.Connecting -> current.descriptor.hasVideo
            is TelecomCallPhase.Connected -> current.isVideoEnabled
            is TelecomCallPhase.OnHold -> current.isVideoEnabled
            else -> false
        }

    val audioRoute: CallAudioRoute
        get() = when (val current = phase) {
            is TelecomCallPhase.Connected -> current.audioRoute
            is TelecomCallPhase.OnHold -> current.audioRoute
            else -> CallAudioRoute.EARPIECE
        }

    fun configureOrganisation(incomingOrganisationId: String?) {
        if (incomingOrganisationId != null && !TrustPolicy.canonicalNonNilUUID(incomingOrganisationId)) {
            throw CallWakeupFailure(CallWakeupError.INVALID_ORGANISATION_ID)
        }
        if (organisationId != incomingOrganisationId) {
            phase = when (phase) {
                is TelecomCallPhase.WakeupPending,
                is TelecomCallPhase.Ringing,
                is TelecomCallPhase.Connecting,
                is TelecomCallPhase.Connected,
                is TelecomCallPhase.OnHold -> TelecomCallPhase.Ended(CallEndReason.ORGANISATION_CHANGED)
                TelecomCallPhase.Idle, is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected -> TelecomCallPhase.Idle
            }
            seenWakeupOrder.clear()
            seenWakeupSet.clear()
            organisationId = incomingOrganisationId
        }
    }

    fun admitWakeup(
        wakeup: IncomingCallWakeup,
        nowEpochMs: Long? = null,
        maxSkewMs: Long = PayloadFreePushEnvelope.DEFAULT_MAX_EPOCH_SKEW_MS,
    ) {
        when (phase) {
            TelecomCallPhase.Idle, is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected -> Unit
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
        val currentOrg = organisationId
        if (currentOrg == null || wakeup.organisationId != currentOrg) {
            phase = TelecomCallPhase.Rejected(CallRejectionReason.ORGANISATION_MISMATCH)
            throw CallWakeupFailure(CallWakeupError.ORGANISATION_MISMATCH)
        }
        if (wakeup.wakeupId in seenWakeupSet) {
            phase = TelecomCallPhase.Rejected(CallRejectionReason.REPLAY_WAKEUP)
            throw CallWakeupFailure(CallWakeupError.REPLAY_WAKEUP)
        }
        if (nowEpochMs != null) {
            try {
                wakeup.envelope.validateEpochSkew(nowEpochMs, maxSkewMs)
            } catch (error: CallWakeupFailure) {
                phase = TelecomCallPhase.Rejected(CallRejectionReason.STALE_WAKEUP_EPOCH)
                throw error
            }
        }
        recordWakeup(wakeup.wakeupId)
        phase = TelecomCallPhase.WakeupPending(wakeup)
    }

    fun attachVerifiedDescriptor(descriptor: VerifiedCallDescriptor) {
        val pending = phase as? TelecomCallPhase.WakeupPending
            ?: throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        val currentOrg = organisationId
        if (currentOrg == null ||
            descriptor.organisationId != currentOrg ||
            descriptor.wakeupId != pending.wakeup.wakeupId
        ) {
            phase = TelecomCallPhase.Rejected(CallRejectionReason.ORGANISATION_MISMATCH)
            throw CallWakeupFailure(CallWakeupError.ORGANISATION_MISMATCH)
        }
        phase = TelecomCallPhase.Ringing(pending.wakeup, descriptor)
    }

    fun beginRinging(
        wakeup: IncomingCallWakeup,
        descriptor: VerifiedCallDescriptor,
        nowEpochMs: Long? = null,
    ) {
        admitWakeup(wakeup, nowEpochMs)
        attachVerifiedDescriptor(descriptor)
    }

    fun acceptAnswer() {
        val current = phase as? TelecomCallPhase.Ringing
            ?: throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        phase = TelecomCallPhase.Connecting(current.wakeup, current.descriptor)
    }

    fun rejectIncoming(reason: CallRejectionReason = CallRejectionReason.USER_DECLINED) {
        when (phase) {
            is TelecomCallPhase.WakeupPending, is TelecomCallPhase.Ringing -> {
                phase = TelecomCallPhase.Rejected(reason)
            }
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun markConnected() {
        val current = phase as? TelecomCallPhase.Connecting
            ?: throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        val defaultRoute = if (current.descriptor.hasVideo) CallAudioRoute.SPEAKER else CallAudioRoute.EARPIECE
        phase = TelecomCallPhase.Connected(
            wakeup = current.wakeup,
            descriptor = current.descriptor,
            isMuted = false,
            isVideoEnabled = current.descriptor.hasVideo,
            audioRoute = defaultRoute,
        )
    }

    fun setMuted(muted: Boolean) {
        phase = when (val current = phase) {
            is TelecomCallPhase.Connected -> current.copy(isMuted = muted)
            is TelecomCallPhase.OnHold -> current.copy(isMuted = muted)
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun setHeld(held: Boolean) {
        phase = when (val current = phase) {
            is TelecomCallPhase.Connected -> if (held) {
                TelecomCallPhase.OnHold(
                    wakeup = current.wakeup,
                    descriptor = current.descriptor,
                    isMuted = current.isMuted,
                    isVideoEnabled = current.isVideoEnabled,
                    audioRoute = current.audioRoute,
                )
            } else {
                current
            }
            is TelecomCallPhase.OnHold -> if (!held) {
                TelecomCallPhase.Connected(
                    wakeup = current.wakeup,
                    descriptor = current.descriptor,
                    isMuted = current.isMuted,
                    isVideoEnabled = current.isVideoEnabled,
                    audioRoute = current.audioRoute,
                )
            } else {
                current
            }
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun setVideoEnabled(enabled: Boolean) {
        phase = when (val current = phase) {
            is TelecomCallPhase.Connected -> current.copy(isVideoEnabled = enabled)
            is TelecomCallPhase.OnHold -> current.copy(isVideoEnabled = enabled)
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun setAudioRoute(route: CallAudioRoute) {
        phase = when (val current = phase) {
            is TelecomCallPhase.Connected -> current.copy(audioRoute = route)
            is TelecomCallPhase.OnHold -> current.copy(audioRoute = route)
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun endCall(reason: CallEndReason) {
        when (phase) {
            is TelecomCallPhase.WakeupPending,
            is TelecomCallPhase.Ringing,
            is TelecomCallPhase.Connecting,
            is TelecomCallPhase.Connected,
            is TelecomCallPhase.OnHold -> phase = TelecomCallPhase.Ended(reason)
            TelecomCallPhase.Idle, is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected ->
                throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    fun recordRejection(reason: CallRejectionReason) {
        phase = TelecomCallPhase.Rejected(reason)
    }

    fun resetToIdle() {
        when (phase) {
            TelecomCallPhase.Idle, is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected -> {
                phase = TelecomCallPhase.Idle
            }
            else -> throw CallWakeupFailure(CallWakeupError.INVALID_TRANSITION)
        }
    }

    private fun recordWakeup(id: String) {
        if (seenWakeupOrder.size == MAXIMUM_TRACKED_WAKEUPS) {
            val evicted = seenWakeupOrder.removeFirst()
            seenWakeupSet.remove(evicted)
        }
        seenWakeupOrder.addLast(id)
        seenWakeupSet.add(id)
    }
}

private sealed interface PushJsonValue {
    data class Text(val value: String) : PushJsonValue
    data class Whole(val value: Long) : PushJsonValue
    data class Flag(val value: Boolean) : PushJsonValue
    data class Obj(val entries: Map<String, PushJsonValue>) : PushJsonValue
}

/**
 * Self-contained strict JSON object parser for push wakeup admission.
 * Rejects duplicate keys (after `\uXXXX` unescaping), non-UTF-8 bytes, arrays, floats, nulls, and deep nesting.
 */
private object StrictPushJsonParser {
    private const val MAX_DEPTH = 4

    fun parseTopObject(bytes: ByteArray): Map<String, PushJsonValue> {
        val decoded = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
        }
        val cursor = Cursor(decoded)
        val obj = cursor.parseObject(depth = 1)
        cursor.skipWhitespace()
        if (!cursor.isAtEnd()) {
            throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
        }
        return obj
    }

    private class Cursor(private val text: String) {
        private var index: Int = 0

        fun isAtEnd(): Boolean = index >= text.length

        fun skipWhitespace() {
            while (index < text.length) {
                when (text[index]) {
                    ' ', '\t', '\r', '\n' -> index++
                    else -> return
                }
            }
        }

        fun parseObject(depth: Int): Map<String, PushJsonValue> {
            if (depth > MAX_DEPTH) throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            skipWhitespace()
            expect('{')
            skipWhitespace()
            val map = LinkedHashMap<String, PushJsonValue>()
            if (tryConsume('}')) return map
            while (true) {
                skipWhitespace()
                val key = parseString()
                if (map.containsKey(key)) {
                    throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                }
                skipWhitespace()
                expect(':')
                skipWhitespace()
                val value = parseValue(depth)
                map[key] = value
                skipWhitespace()
                if (tryConsume('}')) return map
                expect(',')
            }
        }

        private fun parseValue(depth: Int): PushJsonValue {
            if (index >= text.length) throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            return when (text[index]) {
                '"' -> PushJsonValue.Text(parseString())
                '{' -> PushJsonValue.Obj(parseObject(depth + 1))
                't' -> {
                    expectLiteral("true")
                    PushJsonValue.Flag(true)
                }
                'f' -> {
                    expectLiteral("false")
                    PushJsonValue.Flag(false)
                }
                in '0'..'9', '-' -> PushJsonValue.Whole(parseWholeNumber())
                else -> throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
        }

        private fun parseWholeNumber(): Long {
            val start = index
            if (text[index] == '-') index++
            if (index >= text.length || text[index] !in '0'..'9') {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            if (text[index] == '0' && index + 1 < text.length && text[index + 1] in '0'..'9') {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            while (index < text.length && text[index] in '0'..'9') {
                index++
            }
            if (index < text.length && (text[index] == '.' || text[index] == 'e' || text[index] == 'E')) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            return text.substring(start, index).toLongOrNull()
                ?: throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
        }

        private fun parseString(): String {
            expect('"')
            val out = StringBuilder()
            while (index < text.length) {
                val ch = text[index++]
                if (ch == '"') {
                    val result = out.toString()
                    if (String(result.toByteArray(Charsets.UTF_8), Charsets.UTF_8) != result) {
                        throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                    }
                    return result
                }
                if (ch.code < 0x20) {
                    throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                }
                if (ch == '\\') {
                    if (index >= text.length) throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                    when (val esc = text[index++]) {
                        '"', '\\', '/' -> out.append(esc)
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (index + 4 > text.length) {
                                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                            }
                            val codeUnit = text.substring(index, index + 4).toIntOrNull(16)
                                ?: throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                            index += 4
                            out.append(codeUnit.toChar())
                        }
                        else -> throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
                    }
                } else {
                    out.append(ch)
                }
            }
            throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
        }

        private fun expect(expected: Char) {
            if (index >= text.length || text[index] != expected) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            index++
        }

        private fun tryConsume(expected: Char): Boolean {
            if (index < text.length && text[index] == expected) {
                index++
                return true
            }
            return false
        }

        private fun expectLiteral(literal: String) {
            if (!text.startsWith(literal, index)) {
                throw CallWakeupFailure(CallWakeupError.INVALID_PAYLOAD_FORMAT)
            }
            index += literal.length
        }
    }
}
