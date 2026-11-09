package io.kodera.android.client

import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.domain.TrustPolicy
import okhttp3.Response

enum class WorkspaceState { NOT_INITIALISED, INITIALISED }
enum class WorkspaceSetupState { PENDING, RUNNING, READY, FAILED }
enum class WorkspaceSetupReason { AWAITING_OWNER_CONFIRMATION, ISSUER_UNTRUSTED, REALM_JOB_FAILED }
enum class WorkspaceChannelLifecycle { ACTIVE, ARCHIVED }

data class WorkspaceSetup(val state: WorkspaceSetupState, val reason: WorkspaceSetupReason?)

/** Server-filtered metadata only. A ready room does not establish current Matrix access. */
data class WorkspaceChannel(val id: String, val kind: ChannelKind, val name: String,
    val templateKey: String?, val topic: String, val lifecycle: WorkspaceChannelLifecycle,
    val roomState: ChannelRoomState)

data class WorkspaceCategory(val id: String, val name: String, val templateKey: String?,
    val channels: List<WorkspaceChannel>)

/** One caller's ordered view; never messages, room identifiers, occupancy or provider authority. */
data class WorkspaceSnapshot(val organisationId: String, val state: WorkspaceState,
    val setup: WorkspaceSetup, val canInitialise: Boolean, val id: String?,
    val categories: List<WorkspaceCategory>, val uncategorisedChannels: List<WorkspaceChannel>)

sealed interface WorkspaceFailure {
    data object ProtocolViolation : WorkspaceFailure
    data object Forbidden : WorkspaceFailure
    data object NotFound : WorkspaceFailure
    data object ServiceUnavailable : WorkspaceFailure
    data object IdentityUnavailable : WorkspaceFailure
    data class Transport(val reason: TransportFailure) : WorkspaceFailure
}

sealed interface WorkspaceOutcome {
    data class Loaded(val workspace: WorkspaceSnapshot) : WorkspaceOutcome
    data object SignedOut : WorkspaceOutcome
    data class Unavailable(val failure: WorkspaceFailure) : WorkspaceOutcome
}

/**
 * An unconditional, uncached `getWorkspace` read through the signed-in session's [CoreRequester].
 * The caller supplies an organisation from its current membership; Core authorises it again.
 * This client owns no requester, token, cache or provider connection. [fetch] blocks off the main
 * thread. A consumer must fence an already-sent answer against the session before presenting it.
 */
class CoreWorkspaceClient(private val requester: CoreRequester) {
    fun fetch(organisationId: String): WorkspaceOutcome {
        // Refuse before asking for a token, including path/encoding attempts in the identifier.
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) return unavailable(WorkspaceFailure.ProtocolViolation)
        return when (val reply = requester.get("/api/v1/organisations/$organisationId/workspace") { read(it, organisationId) }) {
            is CoreReply.Answered -> reply.value
            CoreReply.Forbidden -> unavailable(WorkspaceFailure.Forbidden)
            CoreReply.SignedOut -> WorkspaceOutcome.SignedOut
            CoreReply.IdentityUnavailable -> unavailable(WorkspaceFailure.IdentityUnavailable)
            CoreReply.Unsendable, CoreReply.PathRefused -> unavailable(WorkspaceFailure.ProtocolViolation)
            is CoreReply.Transport -> unavailable(WorkspaceFailure.Transport(reply.reason))
        }
    }

    private fun read(response: Response, organisationId: String): WorkspaceOutcome = when (response.code) {
        200 -> {
            val body = CoreRequester.bounded(response.body.byteStream())
            if (body == null) unavailable(WorkspaceFailure.ProtocolViolation)
            else try { WorkspaceOutcome.Loaded(decode(body, organisationId)) }
                catch (_: DiscoveryDecodingException) { unavailable(WorkspaceFailure.ProtocolViolation) }
        }
        404 -> unavailable(WorkspaceFailure.NotFound)
        429, in 500..599 -> unavailable(WorkspaceFailure.ServiceUnavailable)
        // There is no cached view or conditional request: even a bodyless 304 is a protocol failure.
        else -> unavailable(WorkspaceFailure.ProtocolViolation)
    }

    internal companion object {
        private fun unavailable(failure: WorkspaceFailure) = WorkspaceOutcome.Unavailable(failure)

        fun decode(data: ByteArray, organisationId: String): WorkspaceSnapshot {
            val root = StrictJson.parse(data).objectValue()
            fields(root, "organisation_id", "state", "setup", "can_initialise", "id", "categories", "uncategorised_channels")
            val returnedOrganisation = uuid(root.getValue("organisation_id"))
            if (!TrustPolicy.canonicalNonNilUUID(organisationId) || returnedOrganisation != organisationId) refused()
            val state = when (root.getValue("state").stringValue()) {
                "not_initialised" -> WorkspaceState.NOT_INITIALISED
                "initialised" -> WorkspaceState.INITIALISED
                else -> refused()
            }
            val setup = setup(root.getValue("setup"))
            val canInitialise = (root.getValue("can_initialise") as? JsonValue.BooleanValue)?.value ?: refused()
            val id = root.getValue("id").let { if (it == JsonValue.NullValue) null else uuid(it) }
            val categories = root.getValue("categories").arrayValue().map(::category)
            val uncategorised = root.getValue("uncategorised_channels").arrayValue().map(::channel)
            if (state == WorkspaceState.NOT_INITIALISED) {
                if (id != null || categories.isNotEmpty() || uncategorised.isNotEmpty()) refused()
            } else if (id == null || canInitialise) refused()
            if (canInitialise && setup.state != WorkspaceSetupState.READY) refused()
            return WorkspaceSnapshot(returnedOrganisation, state, setup, canInitialise, id,
                immutableCopy(categories), immutableCopy(uncategorised))
        }

        private fun setup(value: JsonValue): WorkspaceSetup {
            val objectValue = value.objectValue()
            fields(objectValue, "state", "reason")
            val state = when (objectValue.getValue("state").stringValue()) {
                "pending" -> WorkspaceSetupState.PENDING
                "running" -> WorkspaceSetupState.RUNNING
                "ready" -> WorkspaceSetupState.READY
                "failed" -> WorkspaceSetupState.FAILED
                else -> refused()
            }
            val reason = when (val raw = objectValue.getValue("reason")) {
                JsonValue.NullValue -> null
                else -> when (raw.stringValue()) {
                    "awaiting_owner_confirmation" -> WorkspaceSetupReason.AWAITING_OWNER_CONFIRMATION
                    "issuer_untrusted" -> WorkspaceSetupReason.ISSUER_UNTRUSTED
                    "realm_job_failed" -> WorkspaceSetupReason.REALM_JOB_FAILED
                    else -> refused()
                }
            }
            if (reason == WorkspaceSetupReason.AWAITING_OWNER_CONFIRMATION && state != WorkspaceSetupState.PENDING) refused()
            if (reason in setOf(WorkspaceSetupReason.ISSUER_UNTRUSTED, WorkspaceSetupReason.REALM_JOB_FAILED) &&
                state != WorkspaceSetupState.FAILED) refused()
            return WorkspaceSetup(state, reason)
        }

        private fun category(value: JsonValue): WorkspaceCategory {
            val objectValue = value.objectValue()
            fields(objectValue, "id", "name", "template_key", "channels")
            return WorkspaceCategory(uuid(objectValue.getValue("id")), name(objectValue.getValue("name")),
                templateKey(objectValue.getValue("template_key")),
                immutableCopy(objectValue.getValue("channels").arrayValue().map(::channel)))
        }

        private fun channel(value: JsonValue): WorkspaceChannel {
            val objectValue = value.objectValue()
            fields(objectValue, "id", "kind", "name", "template_key", "topic", "lifecycle", "room_state")
            val kind = when (objectValue.getValue("kind").stringValue()) {
                "text" -> ChannelKind.TEXT
                "audio" -> ChannelKind.AUDIO
                else -> refused()
            }
            val lifecycle = when (objectValue.getValue("lifecycle").stringValue()) {
                "active" -> WorkspaceChannelLifecycle.ACTIVE
                "archived" -> WorkspaceChannelLifecycle.ARCHIVED
                else -> refused()
            }
            val roomState = when (objectValue.getValue("room_state").stringValue()) {
                "pending" -> ChannelRoomState.PENDING
                "ready" -> ChannelRoomState.READY
                "failed" -> ChannelRoomState.FAILED
                else -> refused()
            }
            val topic = objectValue.getValue("topic").stringValue()
            if (topic.scalarCount() > 1024) refused()
            return WorkspaceChannel(uuid(objectValue.getValue("id")), kind, name(objectValue.getValue("name")),
                templateKey(objectValue.getValue("template_key")), topic, lifecycle, roomState)
        }

        private fun fields(value: Map<String, JsonValue>, vararg names: String) {
            if (value.keys != names.toSet()) refused()
        }

        private fun uuid(value: JsonValue): String = value.stringValue().also { if (!TrustPolicy.canonicalNonNilUUID(it)) refused() }

        private fun name(value: JsonValue): String = value.stringValue().also {
            if (it.isBlank() || it.scalarCount() !in 1..100) refused()
        }

        private fun templateKey(value: JsonValue): String? = if (value == JsonValue.NullValue) null
            else value.stringValue().also { if (!Regex("[a-z][a-z0-9_]{0,31}").matches(it)) refused() }
    }
}
