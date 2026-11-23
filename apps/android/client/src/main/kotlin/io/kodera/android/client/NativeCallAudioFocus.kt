package io.kodera.android.client

/** Serializes acquisition and release, including cleanup of an acquisition retired while opening. */
class NativeCallAudioFocus(
    private val request: () -> Boolean,
    private val abandon: () -> Unit,
    private val communicationMode: (Boolean) -> Unit,
) {
    private val lock = Any()
    private var callId: String? = null

    fun acquire(id: String, stillOwned: () -> Boolean): Boolean = synchronized(lock) {
        if (!stillOwned()) return@synchronized false
        try {
            if (!request() || !stillOwned()) { reset(); return@synchronized false }
            communicationMode(true)
            if (!stillOwned()) { reset(); return@synchronized false }
            callId = id
            true
        } catch (failure: Exception) { reset(); throw failure }
    }

    fun release(id: String? = null) = synchronized(lock) {
        if (id == null || callId == id) reset()
    }

    private fun reset() {
        callId = null
        try { abandon() } finally { communicationMode(false) }
    }
}
