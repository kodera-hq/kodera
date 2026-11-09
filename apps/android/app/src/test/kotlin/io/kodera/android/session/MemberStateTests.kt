package io.kodera.android.session

import io.kodera.android.client.MeFailure
import io.kodera.android.client.TransportFailure
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the signed-in screen shows when `/me` kept the session but named no member. That Core's 403 reaches
 * the app as [MeFailure.Forbidden], with no retry and no sign-out, is `:client`'s CoreMeClientTests.
 */
class MemberStateTests {
    @Test fun testA403IsTheNoOrganisationYetState() {
        assertEquals(MemberState.NoOrganisationYet, MemberState.of(MeFailure.Forbidden))
    }

    /** Only a 403 is "no organisation yet": every other failure keeps the retry of "Core unavailable". */
    @Test fun testEveryOtherFailureIsCoreUnavailable() {
        for (failure in listOf(MeFailure.ProtocolViolation, MeFailure.ServiceUnavailable, MeFailure.IdentityUnavailable,
                MeFailure.Transport(TransportFailure.TIMEOUT))) {
            assertEquals("$failure", MemberState.CoreUnavailable, MemberState.of(failure))
        }
    }
}
