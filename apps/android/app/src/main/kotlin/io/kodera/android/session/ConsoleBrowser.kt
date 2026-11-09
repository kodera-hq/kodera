package io.kodera.android.session

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import io.kodera.android.auth.SIGN_IN_BROWSERS
import net.openid.appauth.browser.BrowserDescriptor
import net.openid.appauth.browser.BrowserSelector

/** What opening the Console asks Android for. Pure and host-tested; [intent] is its one Android form. */
internal data class ConsoleRequest(val origin: String, val browserPackage: String?) {
    fun intent(): Intent = Intent(Intent.ACTION_VIEW, Uri.parse(origin)).addCategory(Intent.CATEGORY_BROWSABLE).apply {
        if (browserPackage != null) setPackage(browserPackage)
    }

    companion object {
        /**
         * The Console at exactly [origin], in [browser], the one AppAuth's selector picks for sign-in: on
         * Android 11 and earlier an unverified app that claims the Console's links cannot take it then. Only
         * when no browser is found, the plain browsable intent, which Android resolves itself.
         */
        fun of(origin: String, browser: BrowserDescriptor?) = ConsoleRequest(origin, browser?.packageName)
    }
}

/** Opens the Console in the sign-in browser. False when nothing could open it, and the screen says so. */
internal fun openConsole(context: Context, origin: String): Boolean {
    val request = ConsoleRequest.of(origin, BrowserSelector.select(context, SIGN_IN_BROWSERS))
    return try {
        context.startActivity(request.intent())
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
