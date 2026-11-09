package io.kodera.android.client

import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.IssuerAdmission
import okhttp3.FormBody
import okhttp3.Request
import java.io.IOException

/** RFC 7009 refresh-token revocation for a public client. */
object Revocation {
    const val REFRESH_TOKEN = "refresh_token"

    /**
     * Best effort, blocking: revoke the refresh [token] at [endpoint]. Returns false, sending nothing,
     * unless the endpoint sits on the admitted issuer's origin.
     */
    fun revoke(endpoint: String, token: String, clientId: String, issuer: AdmittedIssuer): Boolean {
        val request = request(endpoint, token, clientId, issuer) ?: return false
        send(request, null, 10000)
        return true
    }

    /** `null` unless the endpoint sits on the admitted issuer's origin: a refresh token is never sent elsewhere. */
    internal fun request(endpoint: String, token: String, clientId: String, issuer: AdmittedIssuer): Request? {
        if (!IssuerAdmission.sharesOrigin(endpoint, issuer)) return null
        val body = FormBody.Builder().add("token", token).add("token_type_hint", REFRESH_TOKEN)
            .add("client_id", clientId).build()
        return try {
            Request.Builder().url(endpoint).post(body).header("Cache-Control", "no-store").build()
        } catch (_: IllegalArgumentException) { null }
    }

    // The outcome is not used: the local state is already wiped, and the provider's answer changes nothing.
    internal fun send(request: Request, route: ClientTestRoute?, timeoutMillis: Long) {
        val http = CoreDiscoveryClient.buildPolicy(route, timeoutMillis, false)
        try { http.newCall(request).execute().close() }
        catch (_: IOException) { }
        catch (_: RuntimeException) { }
        finally {
            http.connectionPool.evictAll()
            http.dispatcher.executorService.shutdown()
        }
    }
}
