package io.kodera.android.domain

import java.util.Base64
import org.junit.Assert.*
import org.junit.Test

class ThemeAndIamModelsTests {
    private val actor = "11111111-1111-4111-8111-111111111111"
    private val theme get() = ShareableThemeCodec.CURATED_PRESETS.first()
    private val json = """{"v":1,"id":"preset-real-black-oled","name":"Real Black OLED","author":"Kodera Design System","baseMode":"black","tokens":{"--c-page":"rgb(0, 0, 0)","--c-surface":"rgb(11, 12, 14)","--c-sunken":"rgb(6, 6, 7)","--c-action":"rgb(67, 97, 238)","--c-ink":"rgb(241, 244, 248)"}}"""
    private fun encoded(value: String) = ShareableThemeCodec.PREFIX + Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
    private fun refuses(reason: WorkspacePreferencesError = WorkspacePreferencesError.INVALID_THEME, action: () -> Unit) {
        try { action(); fail("expected refusal") } catch (error: WorkspacePreferencesFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun canonicalModesPresetsAndFixtureRoundTripWithoutMetadataDrift() {
        assertEquals(listOf("light", "dark", "black"), KoderaThemeMode.entries.map { it.wireValue })
        assertEquals(0xFF000000L, KODERA_MONOGRAM_BG_HEX)
        assertEquals(listOf("preset-real-black-oled", "preset-cobalt-polaire", "preset-terminal-ambre", "preset-foret-souveraine"), ShareableThemeCodec.CURATED_PRESETS.map { it.id })
        assertEquals(encoded(json), ShareableThemeCodec.encode(theme))
        for (preset in ShareableThemeCodec.CURATED_PRESETS) assertEquals(preset, ShareableThemeCodec.decode(ShareableThemeCodec.encode(preset)))
        try { (ShareableThemeCodec.CURATED_PRESETS as MutableList).clear(); fail("mutable presets") } catch (_: UnsupportedOperationException) { }
    }
    @Test fun sharedThemeShareV1VectorsMatchCuratedPresetsAndRefusals() {
        val candidates = listOf(
            java.io.File("../../packages/kodera-rs/vectors/theme-share-v1.json"),
            java.io.File("../../../packages/kodera-rs/vectors/theme-share-v1.json"),
            java.io.File("packages/kodera-rs/vectors/theme-share-v1.json")
        )
        val vectorFile = candidates.firstOrNull { it.isFile } ?: error("missing theme-share-v1.json")
        fun field(line: String, key: String): String {
            val prefix = "\"$key\":\""
            val start = line.indexOf(prefix)
            check(start >= 0) { "missing $key in $line" }
            val valueStart = start + prefix.length
            val end = line.indexOf('"', valueStart)
            return line.substring(valueStart, end)
        }
        var validCount = 0
        var invalidCount = 0
        for (rawLine in vectorFile.readLines(Charsets.UTF_8)) {
            val line = rawLine.trim()
            if (line.startsWith("{\"id\":")) {
                val id = field(line, "id")
                val code = field(line, "code")
                val preset = ShareableThemeCodec.CURATED_PRESETS.first { it.id == id }
                assertEquals(id, code, ShareableThemeCodec.encode(preset))
                assertEquals(id, preset, ShareableThemeCodec.decode(code))
                validCount += 1
            } else if (line.startsWith("{\"name\":")) {
                val code = field(line, "code")
                refuses { ShareableThemeCodec.decode(code) }
                invalidCount += 1
            }
        }
        assertEquals(4, validCount)
        assertEquals(24, invalidCount)
    }
    @Test fun duplicateUnknownMissingAndWrongTypedJsonFieldsFailClosed() {
        val invalid = listOf(
            json.replace("\"v\":1", "\"v\":1,\"v\":1"),
            json.replace("\"v\":1", "\"v\":1,\"\\u0076\":1"),
            json.replace("\"v\":1", "\"v\":2"), json.replace("\"v\":1", "\"v\":1.0"),
            json.replace("\"v\":1", "\"v\":true"), json.replace("\"v\":1", "\"v\":\"1\""),
            json.replace("\"v\":1", "\"extra\":1,\"v\":1"), json.replace("\"v\":1,", ""),
            json.replace("\"--c-page\":", "\"extra\":"),
            json.replace("\"--c-page\":", "\"--c-page\":\"rgb(0, 0, 0)\",\"--c-page\":"),
            json.replace("\"tokens\":{", "\"tokens\":[{"),
            json + "garbage", json.replace("\"black\"", "\"BLACK\""),
            json.replace("\"Real Black OLED\"", "null"),
            json.replace("\"v\":1", "\"v\":01"), json.replace("\"v\":1", "\"v\":1e0")
        )
        for (value in invalid) refuses { ShareableThemeCodec.decode(encoded(value)) }
    }
    @Test fun shareCodeSizePrefixAlphabetPaddingBitsAndUtf8AreStrict() {
        val code = encoded(json)
        for (value in listOf(" $code", "$code ", code + "\n", code.lowercase(), "x".repeat(2049),
            ShareableThemeCodec.PREFIX + "e30", ShareableThemeCodec.PREFIX + "e31=", ShareableThemeCodec.PREFIX + "e3_=")) {
            refuses { ShareableThemeCodec.decode(value) }
        }
        refuses { ShareableThemeCodec.decode(ShareableThemeCodec.PREFIX + Base64.getEncoder().encodeToString(byteArrayOf(0xc3.toByte(), 0x28))) }
        refuses { ShareableThemeCodec.decode(encoded(json.replace("\"name\":\"Real Black OLED\"", "\"name\":\"\\ud800\""))) }
        assertEquals(theme, ShareableThemeCodec.decode(code))
    }
    @Test fun onlyCanonicalBoundedRgbTokensAreAdmitted() {
        assertEquals(listOf(0, 255, 1), ShareableThemeTokens.rgbComponents("rgb(0, 255, 1)"))
        for (rgb in listOf("rgb(256, 0, 0)", "rgb(-1, 0, 0)", "rgb(01, 0, 0)", "rgb(1,0,0)", "rgba(0, 0, 0, 1)", "url(secret)", "#000000", "rgb(0, 0, 0);color:red")) {
            refuses { theme.copy(tokens = theme.tokens.copy(page = rgb)) }
        }
    }
    @Test fun themeMetadataUsesUtf8BoundsAndRejectsInvisibleOrMalformedText() {
        assertEquals("é".repeat(32), theme.copy(name = "é".repeat(32)).name)
        for (text in listOf("", " ", " lead", "trail ", "a\n", "a\u200b", "a\u202e", "a\u2028", "a\u2029", "a\ud800", "é".repeat(33))) {
            refuses { theme.copy(name = text) }
            refuses { theme.copy(author = text) }
        }
        for (id in listOf("", "UPPER", "bad_id", "x".repeat(65), "emoji🧭")) refuses { theme.copy(id = id) }
        val quoted = theme.copy(name = "Quote \" and \\", author = "é🧭")
        assertEquals(quoted, ShareableThemeCodec.decode(ShareableThemeCodec.encode(quoted)))
    }
    @Test fun profileBoundsCanonicalIdentityAndExplicitRanks() {
        assertEquals(listOf(0, 10, 50, 80, 100), KoderaRoleRank.entries.map { it.powerLevel })
        val profile = KoderaUserProfile(actor, "Local member", "local.member", "Member", KoderaPresenceStatus.OFFLINE, KoderaRoleRank.GUEST)
        assertEquals("é".repeat(32), profile.copy(displayName = "é".repeat(32)).displayName)
        for (bad in listOf("", "a\n", "a\u200b", "a\udc00", "é".repeat(33))) {
            refuses(WorkspacePreferencesError.INVALID_PROFILE) { profile.copy(displayName = bad) }
            refuses(WorkspacePreferencesError.INVALID_PROFILE) { profile.copy(roleTitle = bad) }
        }
        for (bad in listOf("UPPER", "bad handle", "a".repeat(33), "é")) refuses(WorkspacePreferencesError.INVALID_PROFILE) { profile.copy(handle = bad) }
        for (bad in listOf("", actor.uppercase().replace('1', 'A'), "00000000-0000-0000-0000-000000000000")) refuses(WorkspacePreferencesError.INVALID_PROFILE) { profile.copy(userId = bad) }
    }
    @Test fun iamReadPrerequisiteAndFeatureFlagsHoldAcrossEveryRankThreshold() {
        for (readRank in KoderaRoleRank.entries) for (writeRank in KoderaRoleRank.entries) for (manageRank in KoderaRoleRank.entries) {
            val policy = ChannelIamPolicy("channel", "category", true, readRank, writeRank, manageRank, true, true)
            for (rank in KoderaRoleRank.entries) {
                val result = policy.evaluate(rank)
                val read = rank.powerLevel >= readRank.powerLevel
                assertEquals(read, result.canRead)
                assertEquals(read && rank.powerLevel >= writeRank.powerLevel, result.canWrite)
                assertEquals(read && rank.powerLevel >= manageRank.powerLevel, result.canManage)
                assertEquals(result.canWrite, result.canCreatePoll)
                assertEquals(result.canManage, result.canManageConnectors)
                assertEquals(read, result.canJoinVoice)
                val disabled = policy.copy(isVoice = false, allowPolls = false, allowConnectors = false).evaluate(rank)
                assertFalse(disabled.canJoinVoice || disabled.canCreatePoll || disabled.canManageConnectors)
            }
        }
        refuses(WorkspacePreferencesError.INVALID_POLICY) { ChannelIamPolicy("", "category", false, KoderaRoleRank.GUEST, KoderaRoleRank.GUEST, KoderaRoleRank.GUEST, false, false) }
    }
    @Test fun documentByteBoundAndLiteralMarkdownRoundTrip() {
        val body = "é".repeat(32768)
        val doc = DocsPadDraft("pad", "channel", "é".repeat(60), body, 1, actor)
        assertEquals(65536, doc.markdownBody.toByteArray(Charsets.UTF_8).size)
        assertEquals(2, doc.updateContent("Title", "# Heading\n\t<script>literal</script>\r\n", actor).revision)
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { doc.copy(markdownBody = body + "a") }
        for (bad in listOf("\u0000", "\u200b", "\ud800")) refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { doc.copy(markdownBody = bad) }
        assertEquals(1, doc.revision)
        assertEquals(body, doc.markdownBody)
    }
    @Test fun frontmatterQuotesMetadataAndRevisionOverflowRefusesAtomically() {
        val doc = DocsPadDraft("pad\"quoted", "channel\\path", "Title: \"quoted\"", "---\nbody", 7, actor)
        assertEquals("---\npad_id: \"pad\\\"quoted\"\nchannel_id: \"channel\\\\path\"\ntitle: \"Title: \\\"quoted\\\"\"\nrevision: 7\nupdated_by: \"$actor\"\n---\n\n---\nbody", doc.exportMarkdown())
        val exhausted = doc.copy(revision = Int.MAX_VALUE)
        refuses(WorkspacePreferencesError.REVISION_EXHAUSTED) { exhausted.updateContent("Next", "body", actor) }
        assertEquals(Int.MAX_VALUE, exhausted.revision)
        for (title in listOf("", "bad\nmetadata", "bad\u2028metadata", "bad\u2029metadata", "é".repeat(61))) refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { doc.updateContent(title, "body", actor) }
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { doc.copy(revision = -1) }
        refuses(WorkspacePreferencesError.INVALID_DOCUMENT) { doc.updateContent("Title", "body", "wrong actor") }
        assertEquals(7, doc.revision)
    }
}
