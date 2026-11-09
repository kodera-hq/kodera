package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.Collections

enum class WorkspacePreferencesError { INVALID_THEME, INVALID_PROFILE, INVALID_POLICY, INVALID_DOCUMENT, REVISION_EXHAUSTED, UNPROVISIONED, STALE_CONTEXT, STOPPED, OBSERVER_LIMIT }
class WorkspacePreferencesFailure(val reason: WorkspacePreferencesError) : Exception(reason.name)
internal fun preferenceRefusal(reason: WorkspacePreferencesError = WorkspacePreferencesError.INVALID_THEME): Nothing = throw WorkspacePreferencesFailure(reason)

enum class KoderaThemeMode(val wireValue: String) { LIGHT("light"), DARK("dark"), BLACK("black") }
const val KODERA_MONOGRAM_BG_HEX: Long = 0xFF000000L

/** Scalar-safe metadata rejection; exact text is retained, without normalization. */
internal fun preferenceText(value: String, maximumScalars: Int, maximumBytes: Int = maximumScalars * 4): Boolean {
    if (value.length !in 1..maximumScalars * 2 || value.isBlank() || value != value.trim()) return false
    var offset = 0
    var count = 0
    while (offset < value.length) {
        val char = value[offset]
        val point = Character.codePointAt(value, offset)
        if (Character.isISOControl(point) || Character.getType(point) == Character.FORMAT.toInt() || point == 0x2028 || point == 0x2029) return false
        if (char.isHighSurrogate()) {
            if (offset + 1 == value.length || !value[offset + 1].isLowSurrogate()) return false
            offset += 2
        } else {
            if (char.isLowSurrogate()) return false
            offset++
        }
        if (++count > maximumScalars) return false
    }
    return value.toByteArray(Charsets.UTF_8).size <= maximumBytes
}

/** Canonical CSS RGB only; no CSS expression, alpha, URL or extra token survives admission. */
data class ShareableThemeTokens(val page: String, val surface: String, val sunken: String, val action: String, val ink: String) {
    init { for (value in listOf(page, surface, sunken, action, ink)) rgbComponents(value) }
    companion object {
        fun rgbComponents(value: String): List<Int> {
            if (value.length > 18) preferenceRefusal()
            val match = Regex("rgb\\((0|[1-9][0-9]{0,2}), (0|[1-9][0-9]{0,2}), (0|[1-9][0-9]{0,2})\\)").matchEntire(value) ?: preferenceRefusal()
            val channels = match.groupValues.drop(1).map { it.toInt() }
            if (channels.any { it > 255 }) preferenceRefusal()
            return channels
        }
    }
}

data class ShareableThemeSpec(val id: String, val name: String, val author: String, val baseMode: KoderaThemeMode, val tokens: ShareableThemeTokens) {
    init {
        if (id.length !in 1..64 || id.any { it !in 'a'..'z' && it !in '0'..'9' && it != '-' } ||
            !preferenceText(name, 64, 64) || !preferenceText(author, 64, 64)) preferenceRefusal()
    }
}

/** Strict, bounded interoperable theme metadata. It grants no script, navigation or CSS authority. */
object ShareableThemeCodec {
    const val PREFIX = "kodera-theme:v1:"
    const val MAX_CODE_BYTES = 2048
    val CURATED_PRESETS: List<ShareableThemeSpec> = Collections.unmodifiableList(listOf(
        ShareableThemeSpec("preset-real-black-oled", "Real Black OLED", "Kodera Design System", KoderaThemeMode.BLACK,
            ShareableThemeTokens("rgb(0, 0, 0)", "rgb(11, 12, 14)", "rgb(6, 6, 7)", "rgb(67, 97, 238)", "rgb(241, 244, 248)")),
        ShareableThemeSpec("preset-cobalt-polaire", "Polar Cobalt", "Kodera Design System", KoderaThemeMode.LIGHT,
            ShareableThemeTokens("rgb(255, 255, 255)", "rgb(255, 255, 255)", "rgb(238, 242, 246)", "rgb(43, 75, 219)", "rgb(30, 41, 51)")),
        ShareableThemeSpec("preset-terminal-ambre", "Amber Terminal", "Kodera Design System", KoderaThemeMode.BLACK,
            ShareableThemeTokens("rgb(0, 0, 0)", "rgb(16, 14, 10)", "rgb(10, 8, 5)", "rgb(216, 155, 60)", "rgb(245, 230, 200)")),
        ShareableThemeSpec("preset-foret-souveraine", "Sovereign Forest", "Kodera Design System", KoderaThemeMode.DARK,
            ShareableThemeTokens("rgb(8, 16, 12)", "rgb(14, 26, 20)", "rgb(10, 19, 14)", "rgb(53, 169, 106)", "rgb(235, 245, 239)"))
    ))
    fun encode(spec: ShareableThemeSpec): String {
        val t = spec.tokens
        val json = "{\"v\":1,\"id\":${quotePreference(spec.id)},\"name\":${quotePreference(spec.name)},\"author\":${quotePreference(spec.author)},\"baseMode\":${quotePreference(spec.baseMode.wireValue)},\"tokens\":{\"--c-page\":${quotePreference(t.page)},\"--c-surface\":${quotePreference(t.surface)},\"--c-sunken\":${quotePreference(t.sunken)},\"--c-action\":${quotePreference(t.action)},\"--c-ink\":${quotePreference(t.ink)}}}"
        val code = PREFIX + Base64.getEncoder().encodeToString(json.toByteArray(Charsets.UTF_8))
        if (code.length > MAX_CODE_BYTES) preferenceRefusal()
        return code
    }
    fun decode(code: String): ShareableThemeSpec {
        if (code.length > MAX_CODE_BYTES || !code.startsWith(PREFIX) || code.any { it.code > 127 }) preferenceRefusal()
        val encoded = code.substring(PREFIX.length)
        val data = try { Base64.getDecoder().decode(encoded) } catch (_: IllegalArgumentException) { preferenceRefusal() }
        if (Base64.getEncoder().encodeToString(data) != encoded) preferenceRefusal()
        val json = try { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString() } catch (_: Exception) { preferenceRefusal() }
        val fields = ThemeJsonReader(json).parse()
        if (fields.keys != setOf("v", "id", "name", "author", "baseMode", "tokens") || fields["v"] != ThemeJsonValue.Version) preferenceRefusal()
        fun string(key: String) = (fields[key] as? ThemeJsonValue.Text)?.value ?: preferenceRefusal()
        val tokens = (fields["tokens"] as? ThemeJsonValue.Object)?.fields ?: preferenceRefusal()
        if (tokens.keys != setOf("--c-page", "--c-surface", "--c-sunken", "--c-action", "--c-ink")) preferenceRefusal()
        fun token(key: String) = (tokens[key] as? ThemeJsonValue.Text)?.value ?: preferenceRefusal()
        val mode = KoderaThemeMode.entries.firstOrNull { it.wireValue == string("baseMode") } ?: preferenceRefusal()
        return ShareableThemeSpec(string("id"), string("name"), string("author"), mode,
            ShareableThemeTokens(token("--c-page"), token("--c-surface"), token("--c-sunken"), token("--c-action"), token("--c-ink")))
    }
}

internal fun quotePreference(value: String): String = buildString {
    append('"')
    for (char in value) when (char) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> append(char)
    }
    append('"')
}

private sealed interface ThemeJsonValue {
    data class Text(val value: String) : ThemeJsonValue
    data class Object(val fields: Map<String, ThemeJsonValue>) : ThemeJsonValue
    data object Version : ThemeJsonValue
}

/** Only two schema object levels and six fields; no array, recursion or permissive JSON coercion. */
private class ThemeJsonReader(private val raw: String) {
    private var offset = 0
    fun parse(): Map<String, ThemeJsonValue> {
        val result = objectValue(false)
        whitespace()
        if (offset != raw.length) preferenceRefusal()
        return result
    }
    private fun whitespace() { while (offset < raw.length && raw[offset] in " \r\n\t") offset++ }
    private fun expect(char: Char) { whitespace(); if (offset >= raw.length || raw[offset++] != char) preferenceRefusal() }
    private fun objectValue(nested: Boolean): Map<String, ThemeJsonValue> {
        expect('{')
        val result = linkedMapOf<String, ThemeJsonValue>()
        whitespace()
        if (offset < raw.length && raw[offset] == '}') { offset++; return result }
        while (true) {
            if (result.size == 6) preferenceRefusal()
            val key = string()
            if (result.containsKey(key)) preferenceRefusal()
            expect(':'); whitespace()
            val value = when (raw.getOrNull(offset)) {
                '"' -> ThemeJsonValue.Text(string())
                '{' -> if (!nested) ThemeJsonValue.Object(objectValue(true)) else preferenceRefusal()
                '1' -> { offset++; ThemeJsonValue.Version }
                else -> preferenceRefusal()
            }
            result[key] = value
            whitespace()
            when (raw.getOrNull(offset++)) {
                '}' -> return result
                ',' -> Unit
                else -> preferenceRefusal()
            }
        }
    }
    private fun string(): String {
        expect('"')
        val value = StringBuilder()
        while (offset < raw.length) {
            val char = raw[offset++]
            if (char == '"') {
                val result = value.toString()
                if (!preferenceText(result, 2048, 2048)) preferenceRefusal()
                return result
            }
            if (char.code < 32) preferenceRefusal()
            if (char != '\\') value.append(char) else {
                when (val escaped = raw.getOrNull(offset++)) {
                    '"', '\\', '/' -> value.append(escaped)
                    'u' -> {
                        if (offset + 4 > raw.length) preferenceRefusal()
                        val digits = raw.substring(offset, offset + 4)
                        if (digits.any { it !in "0123456789abcdefABCDEF" }) preferenceRefusal()
                        value.append(digits.toInt(16).toChar()); offset += 4
                    }
                    else -> preferenceRefusal()
                }
            }
        }
        preferenceRefusal()
    }
}

enum class KoderaRoleRank(val powerLevel: Int) { GUEST(0), MEMBER(10), MODERATOR(50), ADMIN(80), OWNER(100) }
enum class KoderaPresenceStatus { ONLINE, IDLE, DND, OFFLINE }

internal fun canonicalPreferenceUuid(value: String): Boolean =
    TrustPolicy.canonicalNonNilUUID(value)

data class KoderaUserProfile(val userId: String, val displayName: String, val handle: String, val roleTitle: String,
    val presence: KoderaPresenceStatus, val rank: KoderaRoleRank) {
    init {
        if (!canonicalPreferenceUuid(userId) || !preferenceText(displayName, 64, 64) || !preferenceText(roleTitle, 64, 64) ||
            handle.length !in 1..32 || handle.any { it !in 'a'..'z' && it !in '0'..'9' && it !in "._-" }) preferenceRefusal(WorkspacePreferencesError.INVALID_PROFILE)
    }
}

data class ChannelIamDecision(val canRead: Boolean, val canWrite: Boolean, val canManage: Boolean,
    val canCreatePoll: Boolean, val canManageConnectors: Boolean, val canJoinVoice: Boolean)

/** Pure local simulation: caller-selected ranks are never authenticated authorization. */
data class ChannelIamPolicy(val channelId: String, val categoryId: String, val isVoice: Boolean,
    val minReadRank: KoderaRoleRank, val minWriteRank: KoderaRoleRank, val minManageRank: KoderaRoleRank,
    val allowPolls: Boolean, val allowConnectors: Boolean) {
    init { if (!preferenceText(channelId, 255, 255) || !preferenceText(categoryId, 255, 255)) preferenceRefusal(WorkspacePreferencesError.INVALID_POLICY) }
    fun evaluate(rank: KoderaRoleRank): ChannelIamDecision {
        val read = rank.powerLevel >= minReadRank.powerLevel
        val write = read && rank.powerLevel >= minWriteRank.powerLevel
        val manage = read && rank.powerLevel >= minManageRank.powerLevel
        return ChannelIamDecision(read, write, manage, write && allowPolls, manage && allowConnectors, read && isVoice)
    }
}

data class DocsPadDraft(val padId: String, val channelId: String, val title: String, val markdownBody: String,
    val revision: Int, val updatedBy: String) {
    init {
        if (!preferenceText(padId, 128, 128) || !preferenceText(channelId, 255, 255) || !preferenceText(title, 120, 120) || revision < 1 ||
            !canonicalPreferenceUuid(updatedBy) || !validBody(markdownBody)) preferenceRefusal(WorkspacePreferencesError.INVALID_DOCUMENT)
    }
    fun updateContent(newTitle: String, newBody: String, actor: String): DocsPadDraft {
        if (revision == Int.MAX_VALUE) preferenceRefusal(WorkspacePreferencesError.REVISION_EXHAUSTED)
        return DocsPadDraft(padId, channelId, newTitle, newBody, revision + 1, actor)
    }
    fun exportMarkdown(): String = "---\npad_id: ${quotePreference(padId)}\nchannel_id: ${quotePreference(channelId)}\ntitle: ${quotePreference(title)}\nrevision: $revision\nupdated_by: ${quotePreference(updatedBy)}\n---\n\n$markdownBody"
    companion object {
        const val MAX_BODY_BYTES = 65_536
        private fun validBody(value: String): Boolean {
            if (value.length > MAX_BODY_BYTES) return false
            var offset = 0
            while (offset < value.length) {
                val char = value[offset]
                val point = Character.codePointAt(value, offset)
                if ((Character.isISOControl(point) && char !in "\n\r\t") || Character.getType(point) == Character.FORMAT.toInt()) return false
                if (char.isHighSurrogate()) {
                    if (offset + 1 == value.length || !value[offset + 1].isLowSurrogate()) return false
                    offset += 2
                } else { if (char.isLowSurrogate()) return false; offset++ }
            }
            return value.toByteArray(Charsets.UTF_8).size <= MAX_BODY_BYTES
        }
    }
}
