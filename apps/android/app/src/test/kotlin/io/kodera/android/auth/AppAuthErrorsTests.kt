package io.kodera.android.auth

import io.kodera.android.client.BackendFailure
import net.openid.appauth.AuthorizationException
import org.junit.Assert.assertEquals
import org.junit.Test

class AppAuthErrorsTests {
    @Test fun testTheConstantsMatchAppAuthsGeneralErrors() {
        assertEquals(AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW.code, AppAuthErrors.PROGRAM_CANCELED)
        assertEquals(AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW.code, AppAuthErrors.USER_CANCELED)
        assertEquals(AuthorizationException.GeneralErrors.NETWORK_ERROR.code, AppAuthErrors.NETWORK_ERROR)
        assertEquals(AuthorizationException.GeneralErrors.SERVER_ERROR.code, AppAuthErrors.SERVER_ERROR)
    }

    @Test fun testEachErrorMapsToTheOutcomeTheSessionOwnerActsOn() {
        val cases = listOf(
            AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW to BackendFailure.CANCELLED,
            AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW to BackendFailure.CANCELLED,
            AuthorizationException.GeneralErrors.NETWORK_ERROR to BackendFailure.UNAVAILABLE,
            AuthorizationException.GeneralErrors.SERVER_ERROR to BackendFailure.UNAVAILABLE,
            AuthorizationException.GeneralErrors.ID_TOKEN_VALIDATION_ERROR to BackendFailure.PROTOCOL_VIOLATION,
            AuthorizationException.GeneralErrors.INVALID_DISCOVERY_DOCUMENT to BackendFailure.PROTOCOL_VIOLATION,
            AuthorizationException.GeneralErrors.JSON_DESERIALIZATION_ERROR to BackendFailure.PROTOCOL_VIOLATION,
            AuthorizationException.AuthorizationRequestErrors.ACCESS_DENIED to BackendFailure.REFUSED,
            AuthorizationException.TokenRequestErrors.INVALID_GRANT to BackendFailure.REFUSED,
            AuthorizationException.RegistrationRequestErrors.INVALID_REDIRECT_URI to BackendFailure.PROTOCOL_VIOLATION,
        )
        for ((error, expected) in cases) assertEquals("type ${error.type} code ${error.code}", expected, AppAuthErrors.classify(error.type, error.code))
    }

    @Test fun testOnlyARealRefusalOfARefreshSignsOut() {
        // AppAuth leaves the state authorized after anything but an OAuth token error.
        assertEquals(BackendFailure.UNAVAILABLE, AppAuthErrors.refreshOutcome(true, null))
        assertEquals(BackendFailure.UNAVAILABLE, AppAuthErrors.refreshOutcome(true, "invalid_grant"))
        assertEquals(BackendFailure.REFUSED, AppAuthErrors.refreshOutcome(false, "invalid_grant"))
        assertEquals(BackendFailure.REFUSED, AppAuthErrors.refreshOutcome(false, null))
        assertEquals(BackendFailure.UNAVAILABLE, AppAuthErrors.refreshOutcome(false, "temporarily_unavailable"))
        assertEquals(BackendFailure.UNAVAILABLE, AppAuthErrors.refreshOutcome(false, "server_error"))
    }
}
