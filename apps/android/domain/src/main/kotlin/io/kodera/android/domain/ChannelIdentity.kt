package io.kodera.android.domain

enum class ChannelKind { TEXT, AUDIO }
enum class ChannelRoomState { PENDING, READY, FAILED }

data class ChannelReference(
    val organisationId: String, val channelId: String, val kind: ChannelKind, val roomState: ChannelRoomState
)

/** Exact alias correlation only; current Matrix membership remains a service gate. */
object ChannelIdentity {
    fun alias(reference: ChannelReference, descriptor: ValidatedDescriptor): String {
        if (reference.organisationId != descriptor.coreIdentity.organisationId) {
            throw DomainFailure(DomainError.MISMATCHED_ORGANISATION)
        }
        if (!TrustPolicy.canonicalNonNilUUID(reference.channelId)) throw DomainFailure(DomainError.INVALID_CHANNEL)
        return "#kodera-ch-${reference.channelId}:${descriptor.descriptor.matrixServerName}"
    }

    fun matchesResolvedAlias(value: String, reference: ChannelReference, descriptor: ValidatedDescriptor): Boolean =
        value == alias(reference, descriptor)
}
