package io.kodera.android.client

import com.google.gson.JsonObject
import io.kodera.android.domain.NativeCallWake

/** FCM string values are canonical bounded integers before entering the shared wake parser. */
object NativeCallWakeData {
    fun admit(data: Map<String, String>, now: Long): NativeCallWake? {
        if (data.keys != setOf("call_id", "organisation_id", "channel_id", "epoch", "state", "expires_at")) return null
        val raw = JsonObject()
        for ((key, value) in data) {
            if (key == "epoch" || key == "expires_at") {
                val number = value.toLongOrNull() ?: return null
                if (number.toString() != value) return null
                raw.addProperty(key, number)
            } else raw.addProperty(key, value)
        }
        return runCatching { NativeCallWake.admit(raw.toString().toByteArray(), now) }.getOrNull()
    }
}
