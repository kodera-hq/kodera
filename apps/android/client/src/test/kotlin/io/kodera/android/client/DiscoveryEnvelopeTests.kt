package io.kodera.android.client

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import org.junit.Assert.*
import org.junit.Test

class DiscoveryEnvelopeTests {
    private fun decode(bytes: ByteArray) = DiscoveryEnvelope.decode(bytes, Fixtures.configuration())
    @Test fun testExactZeroOneAndManyUnion() {
        val zero = runCatching { decode(Fixtures.data("zero")) }
        assertTrue("Valid zero envelope must decode", zero.isSuccess)
        assertEquals(AnonymousDiscoveryResult.NoMatch, zero.getOrThrow())
        assertEquals("atelier", (decode(Fixtures.data()) as AnonymousDiscoveryResult.Single).metadata.organisationSlug)
        assertEquals(listOf("atelier", "bureau"), (decode(Fixtures.data("many")) as AnonymousDiscoveryResult.Multiple).choices.map { it.organisationSlug })
        val many = Fixtures.objectValue("zero"); val candidates = JsonArray()
        repeat(20) { n -> val one = Fixtures.objectValue(); one.remove("candidates")
            val slug = "team%02d".format(n); one.addProperty("realm", slug); one.addProperty("issuer", "https://id.kodera.io/realms/$slug")
            one.addProperty("openid_configuration_url", "https://id.kodera.io/realms/$slug/.well-known/openid-configuration")
            one.getAsJsonObject("organisation").apply { addProperty("id", "%08x-1111-4111-8111-111111111111".format(n + 1)); addProperty("slug", slug); addProperty("realm", slug) }; candidates.add(one) }
        many.add("candidates", candidates)
        assertEquals(20, (decode(Fixtures.bytes(many)) as AnonymousDiscoveryResult.Multiple).choices.size)
    }
    @Test fun testEveryAnonymousIdentityInvariantIsChecked() {
        for ((key, value) in listOf("id" to "bad", "slug" to "UPPER", "name" to "", "name" to "é".repeat(201), "realm" to "other")) {
            val obj = Fixtures.objectValue(); obj.getAsJsonObject("organisation").addProperty(key, value)
            Fixtures.refused { decode(Fixtures.bytes(obj)) }
        }
        for ((key, value) in listOf("realm" to "other", "issuer" to "https://id.kodera.io.evil/realms/atelier", "issuer" to "https://id.kodera.io/realms/%61telier", "openid_configuration_url" to "https://id.kodera.io/other")) {
            val obj = Fixtures.objectValue(); obj.addProperty(key, value); Fixtures.refused { decode(Fixtures.bytes(obj)) }
        }
    }
    @Test fun testMixedAndIncompleteUnionShapesRefuse() {
        val mixed = Fixtures.objectValue(); mixed.getAsJsonArray("candidates").add(Fixtures.objectValue().apply { remove("candidates") })
        Fixtures.refused { decode(Fixtures.bytes(mixed)) }
        val missing = Fixtures.objectValue("zero"); missing.remove("issuer"); Fixtures.refused { decode(Fixtures.bytes(missing)) }
        val singleton = Fixtures.objectValue("zero"); singleton.getAsJsonArray("candidates").add(Fixtures.objectValue().apply { remove("candidates") })
        Fixtures.refused { decode(Fixtures.bytes(singleton)) }
    }
    @Test fun testCandidateUniquenessOrderAndCardinality() {
        val many = Fixtures.objectValue("many"); val choices = many.getAsJsonArray("candidates")
        many.add("candidates", JsonArray().apply { add(choices[0]); add(choices[0]) }); Fixtures.refused { decode(Fixtures.bytes(many)) }
        many.add("candidates", JsonArray().apply { add(choices[1]); add(choices[0]) }); Fixtures.refused { decode(Fixtures.bytes(many)) }
        many.add("candidates", JsonArray().apply { repeat(21) { add(choices[0]) } }); Fixtures.refused { decode(Fixtures.bytes(many)) }
    }
    @Test fun testMalformedDuplicateUnknownAndDeepJsonRefuses() {
        for (bytes in listOf(byteArrayOf(0xff.toByte()), "{".toByteArray(), "[]".toByteArray(),
            """{"realm":null,"issuer":null,"\u0069ssuer":null,"openid_configuration_url":null,"organisation":null,"candidates":[]}""".toByteArray(),
            ("[".repeat(32) + "null" + "]".repeat(32)).toByteArray(), """{"x":"\uD800"}""".toByteArray())) Fixtures.refused { decode(bytes) }
        for (key in listOf("unknown", "next_cursor")) { val obj = Fixtures.objectValue("zero"); obj.addProperty(key, true); Fixtures.refused { decode(Fixtures.bytes(obj)) } }
        val obj = Fixtures.objectValue(); obj.getAsJsonObject("organisation").addProperty("unknown", true); Fixtures.refused { decode(Fixtures.bytes(obj)) }
        // Parser-level mutations distinguish invalid Unicode from an otherwise unknown schema key.
        for (json in listOf("""{"\uD800":null}""", """{"\uDC00":null}""", """{"ok":"\uD800"}""", """{"ok":"\uDC00"}""", """{"ok":"\uD800x"}""")) {
            Fixtures.refused { StrictJson.parse(json.toByteArray(Charsets.UTF_8)) }
        }
        val invalidName = Fixtures.data().toString(Charsets.UTF_8).replace("Atelier Example", "\\uD800")
        Fixtures.refused { decode(invalidName.toByteArray(Charsets.UTF_8)) }
        val nestedDuplicate = Fixtures.data().toString(Charsets.UTF_8).replace("\"name\":", "\"name\":\"first\",\"na\\u006de\":")
        Fixtures.refused { decode(nestedDuplicate.toByteArray()) }
    }
    @Test fun testLeadingDigitAndBoundedUnicodeNameRemainValidMetadata() {
        val obj = Fixtures.objectValue(); obj.addProperty("realm", "1team"); obj.addProperty("issuer", "https://id.kodera.io/realms/1team")
        obj.addProperty("openid_configuration_url", "https://id.kodera.io/realms/1team/.well-known/openid-configuration")
        obj.getAsJsonObject("organisation").apply { addProperty("slug", "1team"); addProperty("realm", "1team"); addProperty("name", "😀".repeat(200)) }
        val result = (decode(Fixtures.bytes(obj)) as AnonymousDiscoveryResult.Single).metadata
        assertEquals("1team", result.organisationSlug); assertEquals(200, result.displayName.codePointCount(0, result.displayName.length))
        obj.getAsJsonObject("organisation").addProperty("name", "😀".repeat(201)); Fixtures.refused { decode(Fixtures.bytes(obj)) }
        val escapedPair = Fixtures.data().toString(Charsets.UTF_8).replace("Atelier Example", "\\uD83D\\uDE00")
        val paired = (decode(escapedPair.toByteArray(Charsets.UTF_8)) as AnonymousDiscoveryResult.Single).metadata
        assertEquals(1, paired.displayName.codePointCount(0, paired.displayName.length))
    }
}
