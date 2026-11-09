package io.kodera.android.domain

data class CoreIdentity(val organisationId: String, val issuer: String, val subject: String)

data class MatrixIdentity(val userId: String, val deviceId: String, val homeserverOrigin: String)

/** Identity correlation only. No bearer/refresh secret or verified-session claim is stored. */
class AccountContext private constructor(
    val coreIdentity: CoreIdentity,
    val matrixIdentity: MatrixIdentity,
    val generation: Long
) {
    companion object {
        fun bind(
            discovery: ValidatedDiscovery, descriptor: ValidatedDescriptor, coreIdentity: CoreIdentity,
            matrixIdentity: MatrixIdentity, generation: Long
        ): AccountContext {
            val subject = coreIdentity.subject
            val allowed = "abcdefghijklmnopqrstuvwxyz0123456789._=-/+"
            if (subject.length !in 1..255 || subject.any { it !in allowed }) {
                throw DomainFailure(DomainError.UNSUPPORTED_SUBJECT)
            }
            if (generation <= 0) throw DomainFailure(DomainError.STALE_GENERATION)
            if (descriptor.coreIdentity != coreIdentity || descriptor.descriptor.organisationId != coreIdentity.organisationId ||
                discovery.selection.organisationId != coreIdentity.organisationId || discovery.selection.issuer != coreIdentity.issuer) {
                throw DomainFailure(DomainError.IDENTITY_MISMATCH)
            }
            if (matrixIdentity.userId != "@$subject:${descriptor.descriptor.matrixServerName}" ||
                matrixIdentity.deviceId.isEmpty() || matrixIdentity.homeserverOrigin != descriptor.descriptor.homeserverOrigin) {
                throw DomainFailure(DomainError.IDENTITY_MISMATCH)
            }
            return AccountContext(coreIdentity, matrixIdentity, generation)
        }
    }

    fun accepts(coreIdentity: CoreIdentity, generation: Long): Boolean =
        generation > 0 && this.generation == generation && this.coreIdentity == coreIdentity

    override fun equals(other: Any?): Boolean = other is AccountContext &&
        coreIdentity == other.coreIdentity && matrixIdentity == other.matrixIdentity && generation == other.generation
    override fun hashCode(): Int = listOf(coreIdentity, matrixIdentity, generation).hashCode()
}

class SessionContext {
    var generation: Long = 1
        private set
    var account: AccountContext? = null
        private set

    fun activate(account: AccountContext) {
        if (generation <= 0 || account.generation != generation) throw DomainFailure(DomainError.STALE_GENERATION)
        if (this.account != null && this.account != account) throw DomainFailure(DomainError.IDENTITY_MISMATCH)
        this.account = account
    }

    fun signOut() {
        account = null
        // Zero stays fenced on exhaustion; an old generation is never reused.
        generation = if (generation == 0L || generation == Long.MAX_VALUE) 0 else generation + 1
    }
}
