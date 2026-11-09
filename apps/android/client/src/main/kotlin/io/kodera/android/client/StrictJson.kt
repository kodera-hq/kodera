package io.kodera.android.client

import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

internal sealed interface JsonValue {
    data class ObjectValue(val fields: Map<String, JsonValue>) : JsonValue
    data class ArrayValue(val values: List<JsonValue>) : JsonValue
    data class StringValue(val value: String) : JsonValue
    data class NumberValue(val raw: String) : JsonValue
    data class BooleanValue(val value: Boolean) : JsonValue
    data object NullValue : JsonValue
}
internal fun JsonValue.objectValue(): Map<String, JsonValue> = (this as? JsonValue.ObjectValue)?.fields ?: refused()
internal fun JsonValue.arrayValue(): List<JsonValue> = (this as? JsonValue.ArrayValue)?.values ?: refused()
internal fun JsonValue.stringValue(): String = (this as? JsonValue.StringValue)?.value ?: refused()
internal fun JsonValue.integerValue(): Long {
    val raw = (this as? JsonValue.NumberValue)?.raw ?: refused()
    if (!Regex("-?(0|[1-9][0-9]*)").matches(raw)) refused()
    return raw.toLongOrNull() ?: refused()
}
internal fun refused(): Nothing = throw DiscoveryDecodingException()
internal fun String.scalarCount(): Int = codePointCount(0, length)

/** Bounded token parsing; numbers retain their lexical type and every decoded object key is unique. */
internal object StrictJson {
    fun parse(data: ByteArray): JsonValue {
        if (data.size > 65536) refused()
        try {
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            val text = decoder.decode(ByteBuffer.wrap(data)).toString()
            return JsonReader(StringReader(text)).use { reader ->
                reader.strictness = Strictness.STRICT
                val value = read(reader, 0)
                if (reader.peek() != JsonToken.END_DOCUMENT) refused()
                value
            }
        } catch (error: DiscoveryDecodingException) { throw error }
        catch (_: Exception) { refused() }
    }
    private fun checkedString(value: String): String {
        var index = 0
        while (index < value.length) {
            val c = value[index++]
            if (Character.isHighSurrogate(c)) {
                if (index >= value.length || !Character.isLowSurrogate(value[index])) refused()
                index++
            } else if (Character.isLowSurrogate(c)) refused()
        }
        return value
    }
    private fun read(reader: JsonReader, depth: Int): JsonValue {
        if (depth > 12) refused()
        return when (reader.peek()) {
            JsonToken.BEGIN_OBJECT -> {
                reader.beginObject(); val values = linkedMapOf<String, JsonValue>()
                while (reader.hasNext()) {
                    val name = checkedString(reader.nextName())
                    if (values.containsKey(name)) refused()
                    values[name] = read(reader, depth + 1)
                }
                reader.endObject(); JsonValue.ObjectValue(values)
            }
            JsonToken.BEGIN_ARRAY -> {
                reader.beginArray(); val values = mutableListOf<JsonValue>()
                while (reader.hasNext()) values += read(reader, depth + 1)
                reader.endArray(); JsonValue.ArrayValue(values)
            }
            JsonToken.STRING -> JsonValue.StringValue(checkedString(reader.nextString()))
            JsonToken.NUMBER -> JsonValue.NumberValue(reader.nextString())
            JsonToken.BOOLEAN -> JsonValue.BooleanValue(reader.nextBoolean())
            JsonToken.NULL -> { reader.nextNull(); JsonValue.NullValue }
            else -> refused()
        }
    }
}
