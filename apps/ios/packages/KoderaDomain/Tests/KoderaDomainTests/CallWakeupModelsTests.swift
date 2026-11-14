import XCTest
@testable import KoderaDomain

final class CallWakeupModelsTests: XCTestCase {
    private let orgId = "00000000-0000-4000-8000-000000000001"
    private let wakeupId = "0192f3a4-5b6c-7d8e-9f01-23456789abcd"

    func testPayloadFreePushEnvelopeAdmitsOpaqueIdentifiersOnly() throws {
        let raw: [String: Any] = [
            "wakeup_id": wakeupId,
            "organisation_id": orgId,
            "sync_hint": "sync_epoch:42",
            "aps": ["content-available": 1],
        ]
        let admitted = try PayloadFreePushEnvelope.admit(jsonObject: raw, policy: .rejectCleartext)
        XCTAssertEqual(admitted.envelope.wakeupId, wakeupId)
        XCTAssertEqual(admitted.envelope.organisationId, orgId)
        XCTAssertEqual(admitted.envelope.syncHint, "sync_epoch:42")
        XCTAssertTrue(admitted.strippedFieldNames.isEmpty)
    }

    func testPayloadFreePushEnvelopeRejectsOrStripsCleartextRoomSenderAndMessageFields() throws {
        let forbiddenPayloads: [(String, [String: Any])] = [
            ("room_title", [
                "wakeup_id": wakeupId,
                "organisation_id": orgId,
                "sync_hint": "sync_1",
                "room_title": "Confidential Strategy",
            ]),
            ("sender_display_name", [
                "wakeup_id": wakeupId,
                "organisation_id": orgId,
                "sync_hint": "sync_1",
                "sender_display_name": "Claire",
            ]),
            ("plaintext", [
                "wakeup_id": wakeupId,
                "organisation_id": orgId,
                "sync_hint": "sync_1",
                "plaintext": "Hello secret message",
            ]),
            ("aps.alert", [
                "wakeup_id": wakeupId,
                "organisation_id": orgId,
                "sync_hint": "sync_1",
                "aps": ["alert": "Incoming call from Claire"],
            ]),
            ("livekit_token", [
                "wakeup_id": wakeupId,
                "organisation_id": orgId,
                "sync_hint": "sync_1",
                "livekit_token": "redacted",
            ]),
        ]

        for (expectedField, payload) in forbiddenPayloads {
            XCTAssertThrowsError(
                try PayloadFreePushEnvelope.admit(jsonObject: payload, policy: .rejectCleartext)
            ) { error in
                XCTAssertEqual(
                    error as? CallWakeupError,
                    .cleartextPayloadForbidden(field: expectedField)
                )
            }

            let sanitized = try PayloadFreePushEnvelope.admit(
                jsonObject: payload,
                policy: .stripUntrustedRelayFields
            )
            XCTAssertTrue(sanitized.strippedFieldNames.contains(expectedField))
            XCTAssertEqual(sanitized.envelope.wakeupId, wakeupId)
            XCTAssertEqual(sanitized.envelope.organisationId, orgId)
        }
    }

    func testDeterministicStateMachineTransitionsFromIdleThroughRingingConnectingActiveMutedHeldToEndedAndFailed() throws {
        var state = try CallSessionState(organisationId: orgId)
        XCTAssertEqual(state.phase, .idle)

        let envelope = try PayloadFreePushEnvelope(
            wakeupId: wakeupId,
            organisationId: orgId,
            syncHint: "rtc_1"
        )
        let wakeup = IncomingCallWakeup(envelope: envelope)
        let descriptor = try VerifiedCallDescriptor(
            wakeupId: wakeupId,
            organisationId: orgId,
            roomId: "!office:community.kodera.io",
            liveKitRoomName: "lk_room_01",
            callerLabel: "Office Hours",
            hasVideo: true
        )

        try state.beginRinging(wakeup: wakeup, descriptor: descriptor)
        XCTAssertEqual(state.phase, .ringing(wakeup, descriptor))
        XCTAssertEqual(state.activeCallUUID, wakeup.callUUID)

        // Cannot mute before connecting
        XCTAssertThrowsError(try state.setMuted(true)) { error in
            XCTAssertEqual(error as? CallWakeupError, .invalidTransition)
        }

        try state.acceptAnswer()
        XCTAssertEqual(state.phase, .connecting(wakeup, descriptor))

        try state.markConnected()
        XCTAssertEqual(
            state.phase,
            .active(wakeup, descriptor, isMuted: false, isHeld: false, isVideoEnabled: true)
        )

        try state.setMuted(true)
        XCTAssertTrue(state.isMuted)
        XCTAssertFalse(state.isHeld)

        try state.setHeld(true)
        XCTAssertTrue(state.isMuted)
        XCTAssertTrue(state.isHeld)

        try state.setHeld(false)
        try state.setMuted(false)
        XCTAssertFalse(state.isMuted)
        XCTAssertFalse(state.isHeld)

        try state.endCall(reason: .localHangup)
        XCTAssertEqual(state.phase, .ended(.localHangup))
        XCTAssertNil(state.activeCallUUID)

        // Replay of the same wakeup_id is refused and moves state to .failed(.replayWakeup)
        XCTAssertThrowsError(try state.beginRinging(wakeup: wakeup, descriptor: descriptor)) { error in
            XCTAssertEqual(error as? CallWakeupError, .replayWakeup)
        }
        XCTAssertEqual(state.phase, .failed(.replayWakeup))

        try state.resetToIdle()
        XCTAssertEqual(state.phase, .idle)
    }
}
