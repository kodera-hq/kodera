package io.kodera.android.domain

/**
 * Where a signed-in member with no organisation yet is sent: the Console, opened in the browser at exactly
 * its configured origin. An owner finishes setting up their organisation there; the app never consumes an
 * owner claim itself.
 */
object ConsoleOrigin {
    /**
     * The configured origin, unchanged, when it passes [IssuerAdmission.validateOrigin], the validator of
     * every other configured origin: HTTPS, or plain-HTTP loopback with [LoopbackPolicy.ADMIT_FOR_DEVELOPMENT]
     * only. Null when it is unset or refused, and then the app offers no Console action.
     */
    fun admit(configured: String, loopback: LoopbackPolicy): String? {
        if (configured.isEmpty()) return null
        return try { IssuerAdmission.validateOrigin(configured, loopback); configured } catch (_: DomainFailure) { null }
    }
}
