package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

enum class MatrixInvitationError {
    EMPTY_INPUT,
    EXCEEDS_MAXIMUM_LENGTH,
    INVALID_CHARACTER,
    MISSING_SIGIL,
    INVALID_LOCALPART,
    INVALID_DOMAIN,
    INVALID_PORT,
    UNSUPPORTED_SCHEME,
    UNSUPPORTED_HOST,
    AUTHORITY_NOT_ALLOWED,
    UNSUPPORTED_ACTION,
    MISSING_ROOM_TARGET,
    INVALID_VIA_SERVER,
}

class MatrixInvitationFailure(val reason: MatrixInvitationError) : Exception(reason.name)

/**
 * Validated federated Matrix server name (`hostname[:port]`).
 * Rejects single-label hosts, pure numeric hosts, trailing/leading dots or hyphens, and non-canonical ports.
 */
@ConsistentCopyVisibility
data class MatrixServerName private constructor(
    val host: String,
    val port: Int?,
) {
    val rawValue: String get() = if (port != null) "$host:$port" else host

    override fun toString(): String = rawValue

    companion object {
        const val MAXIMUM_HOST_LENGTH: Int = 253

        fun parse(raw: String): MatrixServerName {
            if (raw.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            if (raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_HOST_LENGTH + 6 || !TrustPolicy.isVisibleASCII(raw)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            }
            val colonIndex = raw.indexOf(':')
            val hostPart: String
            val portPart: Int?
            if (colonIndex >= 0) {
                if (raw.indexOf(':', colonIndex + 1) >= 0) {
                    throw MatrixInvitationFailure(MatrixInvitationError.INVALID_PORT)
                }
                hostPart = raw.substring(0, colonIndex)
                val portText = raw.substring(colonIndex + 1)
                if (portText.isEmpty() || portText.length > 5 || portText.first() !in '1'..'9' ||
                    portText.any { it !in '0'..'9' }
                ) {
                    throw MatrixInvitationFailure(MatrixInvitationError.INVALID_PORT)
                }
                val parsed = portText.toIntOrNull()
                if (parsed == null || parsed !in 1..65535) {
                    throw MatrixInvitationFailure(MatrixInvitationError.INVALID_PORT)
                }
                portPart = parsed
            } else {
                hostPart = raw
                portPart = null
            }
            val normalizedHost = hostPart.lowercase()
            if (!TrustPolicy.validDNSName(normalizedHost)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            }
            return MatrixServerName(normalizedHost, portPart)
        }
    }
}

/** Validated Matrix User ID (`@localpart:domain`), bounded to 255 UTF-8 bytes per Matrix specification. */
@ConsistentCopyVisibility
data class MatrixUserId private constructor(
    val localpart: String,
    val serverName: MatrixServerName,
) {
    val rawValue: String get() = "@$localpart:${serverName.rawValue}"

    override fun toString(): String = rawValue

    companion object {
        const val MAXIMUM_BYTES: Int = 255

        fun parse(raw: String): MatrixUserId {
            if (raw.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.EMPTY_INPUT)
            if (raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            if (!TrustPolicy.isVisibleASCII(raw)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            if (!raw.startsWith('@')) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_SIGIL)
            }
            val remainder = raw.substring(1)
            val colon = remainder.indexOf(':')
            if (colon < 0) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            val local = remainder.substring(0, colon)
            val domain = remainder.substring(colon + 1)
            if (local.isEmpty() || !isValidUserLocalpart(local)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_LOCALPART)
            }
            val server = MatrixServerName.parse(domain)
            val normalized = "@$local:${server.rawValue}"
            if (normalized.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            return MatrixUserId(local, server)
        }

        private fun isValidUserLocalpart(value: String): Boolean =
            value.all { ch -> ch.code in 0x21..0x7E && ch != ':' }
    }
}

/** Validated canonical Matrix room alias (`#alias:domain`), bounded to 255 UTF-8 bytes. */
@ConsistentCopyVisibility
data class MatrixRoomAlias private constructor(
    val aliasLocalpart: String,
    val serverName: MatrixServerName,
) {
    val rawValue: String get() = "#$aliasLocalpart:${serverName.rawValue}"
    val matrixUriPath: String get() = "$aliasLocalpart:${serverName.rawValue}"

    override fun toString(): String = rawValue

    companion object {
        const val MAXIMUM_BYTES: Int = 255

        fun parse(raw: String): MatrixRoomAlias {
            if (raw.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.EMPTY_INPUT)
            if (raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            if (!TrustPolicy.isVisibleASCII(raw)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            if (!raw.startsWith('#')) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_SIGIL)
            }
            val remainder = raw.substring(1)
            val colon = remainder.indexOf(':')
            if (colon < 0) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            val local = remainder.substring(0, colon)
            val domain = remainder.substring(colon + 1)
            if (local.isEmpty() || !isValidAliasLocalpart(local)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_LOCALPART)
            }
            val server = MatrixServerName.parse(domain)
            val normalized = "#$local:${server.rawValue}"
            if (normalized.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            return MatrixRoomAlias(local, server)
        }

        fun suggested(channelSlug: String, serverName: MatrixServerName): MatrixRoomAlias {
            val slug = channelSlug.trim()
                .lowercase()
                .split(Regex("\\s+"))
                .filter { it.isNotEmpty() }
                .joinToString("-")
            return parse("#$slug:${serverName.rawValue}")
        }

        private fun isValidAliasLocalpart(value: String): Boolean =
            value.all { ch ->
                ch.code in 0x21..0x7E && ch != ':' && ch != '#' && ch != '/' && ch != '?' && ch != '&'
            }
    }
}

/** Validated Matrix room identifier (`!opaque:domain`), bounded to 255 UTF-8 bytes. */
@ConsistentCopyVisibility
data class MatrixRoomId private constructor(
    val opaqueId: String,
    val serverName: MatrixServerName,
) {
    val rawValue: String get() = "!$opaqueId:${serverName.rawValue}"
    val matrixUriPath: String get() = "$opaqueId:${serverName.rawValue}"

    override fun toString(): String = rawValue

    companion object {
        const val MAXIMUM_BYTES: Int = 255

        fun parse(raw: String): MatrixRoomId {
            if (raw.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.EMPTY_INPUT)
            if (raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            if (!TrustPolicy.isVisibleASCII(raw)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            if (!raw.startsWith('!')) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_SIGIL)
            }
            val remainder = raw.substring(1)
            val colon = remainder.indexOf(':')
            if (colon < 0) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_DOMAIN)
            val opaque = remainder.substring(0, colon)
            val domain = remainder.substring(colon + 1)
            if (opaque.isEmpty() || !isValidOpaqueId(opaque)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_LOCALPART)
            }
            val server = MatrixServerName.parse(domain)
            val normalized = "!$opaque:${server.rawValue}"
            if (normalized.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            return MatrixRoomId(opaque, server)
        }

        private fun isValidOpaqueId(value: String): Boolean =
            value.all { ch ->
                ch in '0'..'9' || ch in 'A'..'Z' || ch in 'a'..'z' ||
                    ch == '-' || ch == '.' || ch == '_' || ch == '='
            }
    }
}

sealed interface MatrixInvitationTarget {
    data class RoomAlias(
        val alias: MatrixRoomAlias,
        val via: List<MatrixServerName>,
    ) : MatrixInvitationTarget

    data class RoomIdentifier(
        val roomId: MatrixRoomId,
        val suggestedAlias: MatrixRoomAlias?,
        val via: List<MatrixServerName>,
    ) : MatrixInvitationTarget

    data class DirectUser(
        val userId: MatrixUserId,
    ) : MatrixInvitationTarget
}

/**
 * Universal Matrix invitation URI builder and parser supporting:
 * - canonical `matrix.to` web links (`https://matrix.to/#/...`)
 * - RFC / MSC2312 `matrix:r/<alias>:<domain>?action=join&via=...` (`matrix:roomid/...`, `matrix:u/...`)
 * - canonical `#alias:domain` and `!opaque:domain`
 * - direct `@localpart:domain`
 */
data class UniversalMatrixInvitation(
    val target: MatrixInvitationTarget,
) {
    val canonicalIdentifier: String
        get() = when (target) {
            is MatrixInvitationTarget.RoomAlias -> target.alias.rawValue
            is MatrixInvitationTarget.RoomIdentifier -> target.roomId.rawValue
            is MatrixInvitationTarget.DirectUser -> target.userId.rawValue
        }

    val displayAlias: String?
        get() = when (target) {
            is MatrixInvitationTarget.RoomAlias -> target.alias.rawValue
            is MatrixInvitationTarget.RoomIdentifier -> target.suggestedAlias?.rawValue
            is MatrixInvitationTarget.DirectUser -> null
        }

    val isSuggestedAlias: Boolean
        get() = target is MatrixInvitationTarget.RoomIdentifier

    val viaServers: List<MatrixServerName>
        get() = when (target) {
            is MatrixInvitationTarget.RoomAlias -> target.via
            is MatrixInvitationTarget.RoomIdentifier -> target.via
            is MatrixInvitationTarget.DirectUser -> emptyList()
        }

    val matrixToUrlString: String
        get() {
            val encodedId = encodeComponent(canonicalIdentifier)
            val viaQuery = viaServers.joinToString("&") { "via=${encodeComponent(it.rawValue)}" }
            return if (viaQuery.isEmpty()) {
                "$MATRIX_TO_BASE$encodedId"
            } else {
                "$MATRIX_TO_BASE$encodedId?$viaQuery"
            }
        }

    val matrixUriString: String
        get() = when (target) {
            is MatrixInvitationTarget.RoomAlias -> {
                val path = encodeMatrixPath(target.alias.matrixUriPath)
                val suffix = target.via.joinToString("") { "&via=${encodeComponent(it.rawValue)}" }
                "matrix:r/$path?action=join$suffix"
            }
            is MatrixInvitationTarget.RoomIdentifier -> {
                val path = encodeMatrixPath(target.roomId.matrixUriPath)
                val suffix = target.via.joinToString("") { "&via=${encodeComponent(it.rawValue)}" }
                "matrix:roomid/$path?action=join$suffix"
            }
            is MatrixInvitationTarget.DirectUser -> {
                val path = encodeMatrixPath("${target.userId.localpart}:${target.userId.serverName.rawValue}")
                "matrix:u/$path?action=chat"
            }
        }

    companion object {
        const val MAXIMUM_URI_BYTES: Int = 1024
        const val MAXIMUM_VIA_SERVERS: Int = 8
        private const val MATRIX_TO_SCHEME = "https"
        private const val MATRIX_TO_HOST = "matrix.to"
        private const val MATRIX_TO_BASE = "$MATRIX_TO_SCHEME://$MATRIX_TO_HOST/#/"

        fun forRoomAlias(alias: MatrixRoomAlias, via: List<MatrixServerName> = emptyList()): UniversalMatrixInvitation {
            val uniqueVia = deduplicateVia(via)
            return UniversalMatrixInvitation(MatrixInvitationTarget.RoomAlias(alias, uniqueVia)).validatedSize()
        }

        fun forRoom(
            roomId: MatrixRoomId,
            canonicalAlias: MatrixRoomAlias?,
            channelSlug: String,
            serverName: MatrixServerName,
        ): UniversalMatrixInvitation {
            if (canonicalAlias != null) {
                return forRoomAlias(canonicalAlias, listOf(serverName))
            }
            val suggested = MatrixRoomAlias.suggested(channelSlug, serverName)
            return UniversalMatrixInvitation(
                MatrixInvitationTarget.RoomIdentifier(roomId, suggested, listOf(serverName))
            ).validatedSize()
        }

        fun forDirectUser(userId: MatrixUserId): UniversalMatrixInvitation =
            UniversalMatrixInvitation(MatrixInvitationTarget.DirectUser(userId)).validatedSize()

        fun parse(raw: String): UniversalMatrixInvitation {
            if (raw.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.EMPTY_INPUT)
            if (raw.toByteArray(Charsets.UTF_8).size > MAXIMUM_URI_BYTES) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            if (!TrustPolicy.isVisibleASCII(raw)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            return when {
                raw.startsWith('#') -> forRoomAlias(MatrixRoomAlias.parse(raw))
                raw.startsWith('!') -> UniversalMatrixInvitation(
                    MatrixInvitationTarget.RoomIdentifier(MatrixRoomId.parse(raw), null, emptyList())
                )
                raw.startsWith('@') -> forDirectUser(MatrixUserId.parse(raw))
                raw.startsWith("matrix:") -> parseMatrixScheme(raw)
                raw.startsWith("$MATRIX_TO_SCHEME://") -> parseMatrixToUrl(raw)
                raw.contains("://") || raw.contains(':') -> throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_SCHEME)
                else -> throw MatrixInvitationFailure(MatrixInvitationError.MISSING_SIGIL)
            }
        }

        private fun parseMatrixToUrl(raw: String): UniversalMatrixInvitation {
            val remainder = raw.removePrefix("$MATRIX_TO_SCHEME://")
            val slash = remainder.indexOf('/')
            if (slash < 0) throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
            val host = remainder.substring(0, slash).lowercase()
            if (host != MATRIX_TO_HOST) {
                throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_HOST)
            }
            val afterHost = remainder.substring(slash)
            if (!afterHost.startsWith("/#/")) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
            }
            val fragment = afterHost.removePrefix("/#/")
            if (fragment.isEmpty()) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
            }
            val question = fragment.indexOf('?')
            val encodedTarget: String
            val queryPart: String?
            if (question >= 0) {
                encodedTarget = fragment.substring(0, question)
                queryPart = fragment.substring(question + 1)
                if (queryPart.contains('?') || queryPart.contains('#')) {
                    throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
                }
            } else {
                encodedTarget = fragment
                queryPart = null
            }
            if (encodedTarget.isEmpty() || encodedTarget.contains('/')) {
                throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
            }
            val decodedTarget = decodePercentStrict(encodedTarget)
            val via = parseQueryViaAndAction(queryPart, expectedAction = null)
            return when {
                decodedTarget.startsWith('#') -> forRoomAlias(MatrixRoomAlias.parse(decodedTarget), via)
                decodedTarget.startsWith('!') -> UniversalMatrixInvitation(
                    MatrixInvitationTarget.RoomIdentifier(MatrixRoomId.parse(decodedTarget), null, via)
                ).validatedSize()
                decodedTarget.startsWith('@') -> {
                    if (via.isNotEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_VIA_SERVER)
                    forDirectUser(MatrixUserId.parse(decodedTarget))
                }
                else -> throw MatrixInvitationFailure(MatrixInvitationError.MISSING_SIGIL)
            }
        }

        private fun parseMatrixScheme(raw: String): UniversalMatrixInvitation {
            val remainder = raw.removePrefix("matrix:")
            if (remainder.startsWith('/')) {
                throw MatrixInvitationFailure(MatrixInvitationError.AUTHORITY_NOT_ALLOWED)
            }
            if (remainder.contains('#')) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            val question = remainder.indexOf('?')
            val pathPart: String
            val queryPart: String?
            if (question >= 0) {
                pathPart = remainder.substring(0, question)
                queryPart = remainder.substring(question + 1)
                if (queryPart.contains('?')) {
                    throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
                }
            } else {
                pathPart = remainder
                queryPart = null
            }

            if (pathPart.startsWith("r/")) {
                val encoded = pathPart.removePrefix("r/")
                if (encoded.isEmpty() || encoded.contains('/')) {
                    throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
                }
                val decoded = decodePercentStrict(encoded)
                val via = parseQueryViaAndAction(queryPart, expectedAction = "join")
                return forRoomAlias(MatrixRoomAlias.parse("#$decoded"), via)
            }
            if (pathPart.startsWith("roomid/")) {
                val encoded = pathPart.removePrefix("roomid/")
                if (encoded.isEmpty() || encoded.contains('/')) {
                    throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
                }
                val decoded = decodePercentStrict(encoded)
                val via = parseQueryViaAndAction(queryPart, expectedAction = "join")
                return UniversalMatrixInvitation(
                    MatrixInvitationTarget.RoomIdentifier(MatrixRoomId.parse("!$decoded"), null, via)
                ).validatedSize()
            }
            if (pathPart.startsWith("u/")) {
                val encoded = pathPart.removePrefix("u/")
                if (encoded.isEmpty() || encoded.contains('/')) {
                    throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
                }
                val decoded = decodePercentStrict(encoded)
                val via = parseQueryViaAndAction(queryPart, expectedAction = "chat")
                if (via.isNotEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.INVALID_VIA_SERVER)
                return forDirectUser(MatrixUserId.parse("@$decoded"))
            }
            throw MatrixInvitationFailure(MatrixInvitationError.MISSING_ROOM_TARGET)
        }

        private fun parseQueryViaAndAction(query: String?, expectedAction: String?): List<MatrixServerName> {
            if (query.isNullOrEmpty()) return emptyList()
            val via = mutableListOf<MatrixServerName>()
            var seenAction = false
            for (pair in query.split('&')) {
                val equals = pair.indexOf('=')
                if (equals <= 0) throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_ACTION)
                val key = pair.substring(0, equals)
                val rawValue = pair.substring(equals + 1)
                if (rawValue.isEmpty()) throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_ACTION)
                val value = decodePercentStrict(rawValue)
                when (key) {
                    "action" -> {
                        if (expectedAction == null || seenAction || value != expectedAction) {
                            throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_ACTION)
                        }
                        seenAction = true
                    }
                    "via" -> {
                        val server = try {
                            MatrixServerName.parse(value)
                        } catch (_: MatrixInvitationFailure) {
                            throw MatrixInvitationFailure(MatrixInvitationError.INVALID_VIA_SERVER)
                        }
                        if (server !in via) {
                            if (via.size >= MAXIMUM_VIA_SERVERS) {
                                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
                            }
                            via.add(server)
                        }
                    }
                    else -> throw MatrixInvitationFailure(MatrixInvitationError.UNSUPPORTED_ACTION)
                }
            }
            return via
        }

        private fun deduplicateVia(via: List<MatrixServerName>): List<MatrixServerName> {
            if (via.size > MAXIMUM_VIA_SERVERS) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            val unique = LinkedHashSet<MatrixServerName>()
            via.forEach { unique.add(it) }
            return unique.toList()
        }

        private fun UniversalMatrixInvitation.validatedSize(): UniversalMatrixInvitation {
            if (matrixToUrlString.toByteArray(Charsets.UTF_8).size > MAXIMUM_URI_BYTES ||
                matrixUriString.toByteArray(Charsets.UTF_8).size > MAXIMUM_URI_BYTES
            ) {
                throw MatrixInvitationFailure(MatrixInvitationError.EXCEEDS_MAXIMUM_LENGTH)
            }
            return this
        }

        private fun encodeComponent(value: String): String =
            percentEncode(value, keepColon = false)

        private fun encodeMatrixPath(value: String): String =
            percentEncode(value, keepColon = true)

        private fun percentEncode(value: String, keepColon: Boolean): String {
            val out = StringBuilder(value.length + 8)
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val u = byte.toInt() and 0xFF
                val unreserved = u in 0x30..0x39 || u in 0x41..0x5A || u in 0x61..0x7A ||
                    u == 0x2D || u == 0x2E || u == 0x5F || u == 0x7E || (keepColon && u == 0x3A)
                if (unreserved) {
                    out.append(u.toChar())
                } else {
                    out.append('%')
                    out.append(HEX[(u ushr 4) and 0x0F])
                    out.append(HEX[u and 0x0F])
                }
            }
            return out.toString()
        }

        private fun decodePercentStrict(encoded: String): String {
            val bytes = ByteArray(encoded.length)
            var outIndex = 0
            var i = 0
            while (i < encoded.length) {
                val ch = encoded[i]
                if (ch == '%') {
                    if (i + 2 >= encoded.length) {
                        throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
                    }
                    val hi = hexDigit(encoded[i + 1])
                    val lo = hexDigit(encoded[i + 2])
                    if (hi < 0 || lo < 0) {
                        throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
                    }
                    bytes[outIndex++] = ((hi shl 4) or lo).toByte()
                    i += 3
                } else {
                    if (ch.code !in 0x21..0x7E) {
                        throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
                    }
                    bytes[outIndex++] = ch.code.toByte()
                    i++
                }
            }
            val decoded = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, 0, outIndex))
                    .toString()
            } catch (_: java.nio.charset.CharacterCodingException) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            if (decoded.isEmpty() || !TrustPolicy.isVisibleASCII(decoded)) {
                throw MatrixInvitationFailure(MatrixInvitationError.INVALID_CHARACTER)
            }
            return decoded
        }

        private fun hexDigit(ch: Char): Int = when (ch) {
            in '0'..'9' -> ch - '0'
            in 'A'..'F' -> ch - 'A' + 10
            in 'a'..'f' -> ch - 'a' + 10
            else -> -1
        }

        private const val HEX = "0123456789ABCDEF"
    }
}
