package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

// Labelled local reducer inputs only; no production fake-success adapter exists.
class ConnectionStateTests {
    private fun initial(readiness: ServiceReadiness = ServiceReadiness.Ready, adapter: Boolean = true) =
        MediaState(1, Fixtures.organisation, readiness, adapter)
    private fun attempt(id: String = "attempt-a", generation: Long = 1,
                        organisation: String = Fixtures.organisation, room: String = "!room:atelier.test") =
        MediaAttempt(id, generation, organisation, room)

    @Test fun missingAdapterAndUnreadyMetadataCannotJoin() {
        for (state in listOf(initial(adapter = false), initial(readiness = ServiceReadiness.Pending),
            initial(readiness = ServiceReadiness.Unavailable(UnavailabilityReason.FORBIDDEN)),
            initial(readiness = ServiceReadiness.Unknown))) {
            assertEquals(state.phase, state.applying(MediaEvent.RequestJoin(attempt())).phase)
            assertNotEquals(MediaPhase.Joined, state.phase)
        }
        assertEquals(MediaPhase.Unavailable(UnavailabilityReason.NOT_CONFIGURED), initial(adapter = false).phase)
    }

    @Test fun requestAndGrantAreNotConnectedOrPublishedMedia() {
        val joining = initial().applying(MediaEvent.RequestJoin(attempt()))
        assertEquals(MediaPhase.Joining, joining.phase)
        val granted = joining.applying(MediaEvent.GrantReceived(attempt()))
        assertEquals(MediaPhase.Joining, granted.phase)
        assertFalse(granted.cameraIntent)
        assertFalse(granted.cameraPublished)
        assertEquals(MediaPhase.Joined, granted.applying(MediaEvent.TransportConnected(attempt())).phase)
    }

    @Test fun staleWrongRoomAndWrongAccountCallbacksAreIgnored() {
        val joining = initial().applying(MediaEvent.RequestJoin(attempt()))
        for (callback in listOf(attempt(id = "old"), attempt(generation = 2),
            attempt(organisation = Fixtures.otherOrganisation), attempt(room = "!other:atelier.test"))) {
            assertEquals(joining, joining.applying(MediaEvent.TransportConnected(callback)))
        }
        assertEquals(initial(), initial().applying(MediaEvent.TransportConnected(attempt())))
        assertEquals(initial(), initial().applying(MediaEvent.RequestJoin(attempt(generation = 2))))
    }

    @Test fun leaveRevocationAndSignOutBeatLateCallbacks() {
        val joining = initial().applying(MediaEvent.RequestJoin(attempt()))
        for (event in listOf(MediaEvent.Leave, MediaEvent.Revoke, MediaEvent.SignOut)) {
            val ended = joining.applying(event)
            assertEquals(MediaPhase.Ended, ended.phase)
            assertNull(ended.attempt)
            assertFalse(ended.cameraPublished)
            assertEquals(ended, ended.applying(MediaEvent.TransportConnected(attempt())))
            assertEquals(ended, ended.applying(MediaEvent.CameraPublication(attempt(), true)))
            assertEquals(ended, ended.applying(MediaEvent.RequestJoin(attempt())))
        }
    }

    @Test fun lostTransportShowsReconnectingAndFailureEndsWithoutFalseSuccess() {
        val joined = initial().applying(MediaEvent.RequestJoin(attempt())).applying(MediaEvent.TransportConnected(attempt()))
        val lost = joined.applying(MediaEvent.TransportLost(attempt()))
        assertEquals(MediaPhase.Reconnecting, lost.phase)
        assertFalse(lost.cameraPublished)
        assertEquals(MediaPhase.Joined, lost.applying(MediaEvent.TransportConnected(attempt())).phase)
        assertEquals(MediaPhase.Ended, lost.applying(MediaEvent.TransportFailed(attempt())).phase)
    }

    @Test fun cameraRequiresIntentPermissionAndMatchingPublicationEvent() {
        val joined = initial().applying(MediaEvent.RequestJoin(attempt())).applying(MediaEvent.TransportConnected(attempt()))
        assertFalse(joined.applying(MediaEvent.CameraPublication(attempt(), true)).cameraPublished)
        val intent = joined.applying(MediaEvent.CameraIntent(true))
        assertFalse(intent.cameraPublished)
        assertFalse(intent.applying(MediaEvent.CameraPublication(attempt(), true)).cameraPublished)
        val permission = intent.applying(MediaEvent.CameraPermission(true))
        assertFalse(permission.cameraPublished)
        assertFalse(permission.applying(MediaEvent.CameraPublication(attempt(id = "old"), true)).cameraPublished)
        val published = permission.applying(MediaEvent.CameraPublication(attempt(), true))
        assertTrue(published.cameraPublished)
        assertFalse(published.applying(MediaEvent.CameraIntent(false)).cameraPublished)
        assertFalse(published.applying(MediaEvent.CameraPermission(false)).cameraPublished)
        assertFalse(published.applying(MediaEvent.TransportLost(attempt())).cameraPublished)
    }
}
