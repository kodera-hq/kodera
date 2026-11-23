package io.kodera.android.calls

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.pm.ServiceInfo
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import io.kodera.android.R
import io.kodera.android.client.AuthenticatedNativeCall
import io.kodera.android.client.NativeCallCoordinator
import io.kodera.android.client.NativeCallPresenter
import io.kodera.android.domain.NativeCallWake
import io.kodera.android.domain.NativeRingPhase
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** Install only for a provisioned authenticated call session; never from untrusted intent extras. */
class NativeTelecomRuntime(private val context: Context, val coordinator: NativeCallCoordinator) : NativeCallPresenter {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val audio = context.getSystemService(AudioManager::class.java)
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val account = PhoneAccountHandle(ComponentName(context, KoderaConnectionService::class.java), "native-calls")
    private var foreground: Service? = null
    private val connections = mutableMapOf<String, KoderaConnection>()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener { change ->
            if (change == AudioManager.AUDIOFOCUS_LOSS) coordinator.revoke()
            else coordinator.audioSession(change == AudioManager.AUDIOFOCUS_GAIN)
        }.build()
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { work { coordinator.networkPathChanged() } }
    }
    private val expiry = object : Runnable {
        override fun run() { coordinator.tick(); if (current.get() === this@NativeTelecomRuntime) main.postDelayed(this, 1000) }
    }
    fun start() {
        check(context.checkSelfPermission(Manifest.permission.MANAGE_OWN_CALLS) == PackageManager.PERMISSION_GRANTED)
        check(current.compareAndSet(null, this))
        try {
            telecom.registerPhoneAccount(PhoneAccount.builder(account, context.getString(R.string.brand_name)).setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED).build())
            notifications.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.native_call_channel), NotificationManager.IMPORTANCE_HIGH))
            coordinator.bind(this); connectivity.registerDefaultNetworkCallback(network); main.post(expiry)
        } catch (failure: Exception) { stop(); throw failure }
    }
    fun stop() {
        if (!current.compareAndSet(this, null)) return
        coordinator.revoke(); main.removeCallbacks(expiry)
        runCatching { connectivity.unregisterNetworkCallback(network) }; audio.abandonAudioFocusRequest(focus)
        telecom.unregisterPhoneAccount(account); worker.shutdownNow()
    }
    /** Entry point for a provisioned messaging provider's high-priority data callback. No notification payload is accepted. */
    fun onFcmCallWake(data: Map<String, String>, highPriority: Boolean, hasNotification: Boolean = false) {
        check(highPriority && !hasNotification)
        val keys = setOf("call_id", "organisation_id", "channel_id", "epoch", "state", "expires_at")
        require(data.keys == keys)
        val raw = JSONObject()
        for ((key, value) in data) {
            if (key == "epoch" || key == "expires_at") {
                val number = value.toLong(); require(number.toString() == value); raw.put(key, number)
            } else raw.put(key, value)
        }
        val wake = NativeCallWake.admit(raw.toString().toByteArray(), System.currentTimeMillis() / 1000)
        // Cancellation bypasses the worker so it cannot queue behind a blocked authenticated lookup.
        if (wake.state == NativeRingPhase.RINGING) work { coordinator.receive(wake) } else coordinator.receive(wake)
    }
    override fun ringing(call: AuthenticatedNativeCall) = onMain {
        if (coordinator.phase(call.wake.callId) != NativeRingPhase.RINGING) return@onMain
        try {
            val extras = Bundle().apply { putString(CALL_ID, call.wake.callId) }
            telecom.addNewIncomingCall(account, extras)
        } catch (_: Exception) { coordinator.end(call.wake.callId) }
    }
    internal fun attach(id: String, connection: KoderaConnection): Boolean {
        if (coordinator.currentCall()?.wake?.callId != id || coordinator.phase(id) != NativeRingPhase.RINGING) return false
        connections[id] = connection; return true
    }
    internal fun showIncoming(id: String) {
        if (coordinator.phase(id) != NativeRingPhase.RINGING) return
        notifications.notify(id.hashCode(), notification(id, incoming = true))
    }
    internal fun answer(id: String) = onMain {
        if (coordinator.currentCall()?.wake?.callId != id || coordinator.phase(id) != NativeRingPhase.RINGING) return@onMain
        try {
            context.startForegroundService(Intent(context, KoderaConnectionService::class.java).putExtra(CALL_ID, id))
        } catch (_: Exception) { coordinator.end(id) }
    }
    internal fun answerWithForeground(id: String, service: Service) {
        if (coordinator.currentCall()?.wake?.callId != id || coordinator.phase(id) != NativeRingPhase.RINGING) { service.stopSelf(); return }
        try {
            check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            val notification = notification(id, incoming = false)
            if (Build.VERSION.SDK_INT >= 30) service.startForeground(id.hashCode(), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else service.startForeground(id.hashCode(), notification)
            foreground = service
            answerWithFocus(id)
        } catch (_: Exception) { coordinator.end(id); service.stopSelf() }
    }
    private fun answerWithFocus(id: String) = work {
        if (coordinator.currentCall()?.wake?.callId != id || coordinator.phase(id) != NativeRingPhase.RINGING) return@work
        check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { coordinator.end(id); return@work }
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        coordinator.audioSession(true); coordinator.answer(id)
    }
    internal fun end(id: String, declined: Boolean) { coordinator.end(id, declined) }
    internal fun muted(id: String, muted: Boolean) = work { if (coordinator.currentCall()?.wake?.callId == id) coordinator.setMuted(muted) }
    fun route(id: String, route: Int) = onMain {
        if (route in setOf(CallAudioState.ROUTE_BLUETOOTH, CallAudioState.ROUTE_SPEAKER, CallAudioState.ROUTE_EARPIECE)) connections[id]?.setAudioRoute(route)
    }
    override fun connected(callId: String) = onMain {
        connections[callId]?.setActive()
        notifications.notify(callId.hashCode(), notification(callId, incoming = false))
    }
    override fun ended(callId: String, reason: NativeRingPhase) = onMain {
        val cause = when (reason) {
            NativeRingPhase.ANSWERED_ELSEWHERE -> DisconnectCause.ANSWERED_ELSEWHERE
            NativeRingPhase.DECLINED -> DisconnectCause.REJECTED
            NativeRingPhase.EXPIRED -> DisconnectCause.MISSED
            NativeRingPhase.REVOKED -> DisconnectCause.ERROR
            else -> DisconnectCause.REMOTE
        }
        connections.remove(callId)?.apply { setDisconnected(DisconnectCause(cause)); destroy() }
        notifications.cancel(callId.hashCode()); audio.abandonAudioFocusRequest(focus); audio.mode = AudioManager.MODE_NORMAL
        foreground?.stopForeground(Service.STOP_FOREGROUND_REMOVE); foreground?.stopSelf(); foreground = null
    }
    private fun notification(id: String, incoming: Boolean): Notification {
        val end = action(id, "end")
        val builder = Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.kodera_monogram)
            .setContentTitle(context.getString(R.string.brand_name)).setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setOngoing(true)
        if (Build.VERSION.SDK_INT >= 31) {
            val person = Person.Builder().setName(context.getString(R.string.brand_name)).setImportant(true).build()
            builder.setStyle(if (incoming) Notification.CallStyle.forIncomingCall(person, end, action(id, "answer")) else Notification.CallStyle.forOngoingCall(person, end))
        } else {
            if (incoming) builder.addAction(Notification.Action.Builder(null, context.getString(R.string.native_call_answer), action(id, "answer")).build())
            builder.addAction(Notification.Action.Builder(null, context.getString(R.string.native_call_end), end).build())
        }
        return builder.build()
    }
    private fun action(id: String, action: String): PendingIntent {
        val intent = Intent(context, NativeCallActionReceiver::class.java).setAction(action).putExtra(CALL_ID, id)
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    private fun onMain(body: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) body() else main.post(body) }
    private fun work(body: () -> Unit) {
        if (worker.isShutdown) return
        worker.execute { runCatching(body).onFailure { coordinator.revoke() } }
    }
    companion object {
        internal val current = AtomicReference<NativeTelecomRuntime?>()
        internal const val CALL_ID = "call_id"
        private const val CHANNEL = "native-calls"
    }
}

/** Explicit immutable PendingIntents are the only external route to this non-exported receiver. */
class NativeCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val runtime = NativeTelecomRuntime.current.get() ?: return
        val id = intent.getStringExtra(NativeTelecomRuntime.CALL_ID) ?: return
        when (intent.action) { "answer" -> runtime.answer(id); "end" -> runtime.end(id, runtime.coordinator.phase(id) == NativeRingPhase.RINGING) }
    }
}
