package io.kodera.android.calls

import android.content.Intent
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle

/** The platform binder permission protects this sole exported call service. */
class KoderaConnectionService : ConnectionService() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = NativeTelecomRuntime.current.get()
        val id = intent?.getStringExtra(NativeTelecomRuntime.CALL_ID)
        if (runtime != null && id != null) runtime.answerWithForeground(id, this) else stopSelf()
        return START_NOT_STICKY
    }
    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection {
        val runtime = NativeTelecomRuntime.current.get()
        val id = request.extras?.getString(NativeTelecomRuntime.CALL_ID)
        if (runtime == null || id == null) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
        val connection = KoderaConnection(runtime, id)
        if (!runtime.attach(id, connection)) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
        connection.connectionProperties = Connection.PROPERTY_SELF_MANAGED
        connection.audioModeIsVoip = true
        connection.setRinging()
        return connection
    }
    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest) {
        request.extras?.getString(NativeTelecomRuntime.CALL_ID)?.let { NativeTelecomRuntime.current.get()?.end(it, false) }
    }
}
internal class KoderaConnection(private val runtime: NativeTelecomRuntime, private val id: String) : Connection() {
    override fun onShowIncomingCallUi() { runtime.showIncoming(id) }
    override fun onAnswer() { runtime.answer(id) }
    override fun onAnswer(videoState: Int) { onAnswer() }
    override fun onReject() { runtime.end(id, true) }
    override fun onDisconnect() { runtime.end(id, false) }
    override fun onAbort() { runtime.end(id, false) }
    override fun onCallAudioStateChanged(state: CallAudioState) { runtime.muted(id, state.isMuted) }
}
