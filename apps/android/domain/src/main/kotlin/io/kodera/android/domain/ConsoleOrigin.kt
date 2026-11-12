package io.kodera.android.domain

/**
 * The Console's configured origin, validated and held. The app does not open it: the Console is where
 * the organisation's commercial pages live, and this companion app links to no page outside sign-in. An owner finishes
 * setting up their organisation on the web on their own; the app never consumes an owner claim itself.
 */
object ConsoleOrigin {
    /**
     * The configured origin, unchanged, when it passes [IssuerAdmission.validateOrigin], the validator of
     * every other configured origin: HTTPS, or plain-HTTP loopback with [LoopbackPolicy.ADMIT_FOR_DEVELOPMENT]
     * only. Null when it is unset or refused. No screen offers a Console action either way.
     */
    fun admit(configured: String, loopback: LoopbackPolicy): String? {
        if (configured.isEmpty()) return null
        return try { IssuerAdmission.validateOrigin(configured, loopback); configured } catch (_: DomainFailure) { null }
    }
}
