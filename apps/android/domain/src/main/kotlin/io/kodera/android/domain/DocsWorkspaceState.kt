package io.kodera.android.domain

import java.net.URI
import java.net.URISyntaxException
import java.util.Collections

enum class DocsWorkspaceError { INVALID_SCOPE, INVALID_PAD, INVALID_URL, INVALID_PADS, UNAUTHORISED_UPDATE, NOT_PREVIEWING, STOPPED }
class DocsWorkspaceFailure(val reason: DocsWorkspaceError) : Exception(reason.name)

/** A local correlation scope, not authenticated Docs service authority or channel membership. */
data class DocsWorkspaceScope(val organisationId: String, val channelId: String) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || !TrustPolicy.boundedScopeChannelId(channelId)) {
            throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_SCOPE)
        }
    }
}

/** Validated read-only metadata; URL admission does not establish reachability or permission. */
data class DocsPadSummary(val scope: DocsWorkspaceScope, val id: String, val title: String,
    val httpsUrl: String, val updatedAtEpochSeconds: Long) {
    init {
        if (id.toByteArray(Charsets.UTF_8).size !in 1..MAX_ID_BYTES || !TrustPolicy.isVisibleASCII(id) || !TrustPolicy.boundedScalarText(title, requireTrimmed = true) ||
            updatedAtEpochSeconds < 0) {
            throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PAD)
        }
        validateDocsUrl(httpsUrl)
    }

    val host: String get() = URI(httpsUrl).host
    val path: String get() = URI(httpsUrl).rawPath

    companion object {
        const val MAX_ID_BYTES = 128
        /** Check raw input before URI parsing can conceal separators or normalize a path. */
        private fun validateDocsUrl(value: String) {
            fun refuse(): Nothing = throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_URL)
            if (value.length !in 1..2048 || !value.startsWith("https://") || !TrustPolicy.isVisibleASCII(value) ||
                value.any { it == '%' || it == '\\' || it == '?' || it == '#' }) refuse()
            val uri = try { URI(value) } catch (_: URISyntaxException) { refuse() }
            val host = uri.host ?: refuse()
            val path = uri.rawPath ?: refuse()
            val tld = host.substringAfterLast('.')
            if (uri.scheme != "https" || uri.rawUserInfo != null || uri.port !in listOf(-1, 443) || uri.rawQuery != null ||
                uri.rawFragment != null || uri.rawAuthority !in listOf(host, "$host:443") || host == "localhost" ||
                host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
                !TrustPolicy.validDNSName(host) || tld.length < 2 || tld.any { it !in 'a'..'z' } ||
                !path.startsWith('/') || path.length <= 1 || path.any {
                    it !in 'a'..'z' && it !in 'A'..'Z' && it !in '0'..'9' && it !in "-._~/"
                } ||
                "//" in path || path.split('/').any { it == "." || it == ".." }) refuse()
        }
    }
}

enum class DocsWorkspacePhase { UNPROVISIONED, LOCAL_PREVIEW_ONLY, STOPPED }

/** Immutable metadata preview. No phase represents a fetched or authenticated collaborative pad. */
class DocsWorkspaceState private constructor(val scope: DocsWorkspaceScope, val phase: DocsWorkspacePhase,
    val pads: List<DocsPadSummary>) {
    fun localPreview(values: List<DocsPadSummary>): DocsWorkspaceState {
        if (phase == DocsWorkspacePhase.STOPPED) throw DocsWorkspaceFailure(DocsWorkspaceError.STOPPED)
        return DocsWorkspaceState(scope, DocsWorkspacePhase.LOCAL_PREVIEW_ONLY, validatedPads(scope, values))
    }
    fun replacingPads(values: List<DocsPadSummary>): DocsWorkspaceState {
        if (phase != DocsWorkspacePhase.LOCAL_PREVIEW_ONLY) throw DocsWorkspaceFailure(DocsWorkspaceError.NOT_PREVIEWING)
        return DocsWorkspaceState(scope, phase, validatedPads(scope, values))
    }
    companion object {
        const val MAX_PADS = 32
        fun unprovisioned(scope: DocsWorkspaceScope) = DocsWorkspaceState(scope, DocsWorkspacePhase.UNPROVISIONED, emptyList())
        fun stopped(scope: DocsWorkspaceScope) = DocsWorkspaceState(scope, DocsWorkspacePhase.STOPPED, emptyList())
        private fun validatedPads(scope: DocsWorkspaceScope, values: List<DocsPadSummary>): List<DocsPadSummary> {
            val count = values.size
            if (count !in 1..MAX_PADS) throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PADS)
            // Validate the exact retained bounded snapshot, never a caller-controlled iterator.
            val owned = try { List(count) { values[it] } } catch (_: IndexOutOfBoundsException) {
                throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PADS)
            } catch (_: ConcurrentModificationException) {
                throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PADS)
            }
            if (owned.any { it.scope != scope } || owned.map { it.id }.toSet().size != count) {
                throw DocsWorkspaceFailure(DocsWorkspaceError.INVALID_PADS)
            }
            return Collections.unmodifiableList(owned.sortedWith(
                compareByDescending<DocsPadSummary> { it.updatedAtEpochSeconds }.thenBy { it.id }))
        }
    }
}
