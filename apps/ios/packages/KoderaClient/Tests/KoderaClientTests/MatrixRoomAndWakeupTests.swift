import Foundation
import KoderaDomain
import XCTest
@testable import KoderaClient

@MainActor
final class MatrixRoomAndWakeupTests: XCTestCase {
    private static let orgId = "00000000-0000-4000-8000-000000000001"
    private static let channelId = "00000000-0000-4000-8000-000000000010"
    private static let deviceId = "01935800-0000-7000-8000-000000000042"
    private static let attachmentId = "01935800-0000-7000-8000-000000000077"
    private static let txn1 = "01935651-787b-7102-8304-05060708090a"
    private static let txn2 = "01935651-787b-7102-8304-05060708090b"
    private static let roomId = "!roomAlpha:atelier.matrix.kodera.io"
    private static let jsonHeaders = ["Content-Type": "application/json", "Cache-Control": "no-store"]

    private func makeRequester(_ tokens: FakeTokens = FakeTokens()) throws -> CoreRequester {
        try CoreRequester(
            coreApiOrigin: "https://core.test",
            loopback: .refuse,
            tokens: tokens,
            protocolClass: URLProtocolFixture.self,
            timeout: 2
        )
    }

    func testCoreRequesterAdmitsValidatedPaginationQueryPutAndDeleteAndRefusesInjection() async throws {
        let pageBody = Data(#"{"data":[],"has_more":false,"next_cursor":null}"#.utf8)
        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [pageBody]))

        let tokens = FakeTokens()
        let requester = try makeRequester(tokens)
        let okReply = await requester.get(
            path: "/api/v1/notifications",
            query: [("limit", "50"), ("cursor", "sig_v1:1tGabc:token-01")]
        )
        XCTAssertEqual(okReply, .answered(status: 200, body: pageBody))
        XCTAssertEqual(
            URLProtocolFixture.requests.first?.url?.absoluteString,
            "https://core.test/api/v1/notifications?limit=50&cursor=sig_v1%3A1tGabc%3Atoken-01"
        )

        // Invalid query keys, duplicate keys, out-of-range limits, and injection characters refuse before fetching tokens.
        let badQueries: [[(String, String)]] = [
            [("unknown", "1")],
            [("limit", "0")],
            [("limit", "201")],
            [("limit", "05")],
            [("limit", "10"), ("limit", "20")],
            [("cursor", "abc&admin=1")],
            [("cursor", "abc#frag")],
            [("cursor", "")],
        ]
        for badQuery in badQueries {
            URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [pageBody]))
            let guardedTokens = FakeTokens()
            let guardedRequester = try makeRequester(guardedTokens)
            let refused = await guardedRequester.get(path: "/api/v1/notifications", query: badQuery)
            XCTAssertEqual(refused, .pathRefused)
            let asked = await guardedTokens.requested
            XCTAssertEqual(asked, 0)
            XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        }

        // PUT and DELETE honour bearer auth and status codes.
        URLProtocolFixture.install(.body(status: 204, headers: Self.jsonHeaders, chunks: []))
        let putReply = await requester.put(path: "/api/v1/resource", jsonBody: Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(putReply, .answered(status: 204, body: Data()))
        XCTAssertEqual(URLProtocolFixture.requests.first?.httpMethod, "PUT")

        URLProtocolFixture.install(.body(status: 204, headers: Self.jsonHeaders, chunks: []))
        let deleteReply = await requester.delete(path: "/api/v1/resource")
        XCTAssertEqual(deleteReply, .answered(status: 204, body: Data()))
        XCTAssertEqual(URLProtocolFixture.requests.first?.httpMethod, "DELETE")
    }

    func testTimelineReducerOptimisticReconciliationRepliesSenderVerifiedEditsReactionsAndRedactions() throws {
        var reducer = MatrixTimelineReducer(ownUserId: "@alice:atelier.matrix.kodera.io")

        // 1. Enqueue optimistic send, mark failed, retry, then reconcile via /sync echo preserving UI key.
        let optimistic = reducer.enqueueOptimisticSend(
            transactionId: Self.txn1,
            body: "Bonjour l'équipe",
            nowMs: 1_700_000_000_000
        )
        XCTAssertEqual(optimistic.key, "txn:\(Self.txn1)")
        XCTAssertEqual(reducer.messages.first?.deliveryStatus, .sending)

        reducer.markOptimisticFailed(transactionId: Self.txn1)
        XCTAssertEqual(reducer.messages.first?.deliveryStatus, .failed)

        reducer.markOptimisticRetrying(transactionId: Self.txn1)
        XCTAssertEqual(reducer.messages.first?.deliveryStatus, .sending)

        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$msg1",
                sender: "@alice:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_100,
                msgtype: "m.text",
                body: "Bonjour l'équipe",
                transactionId: Self.txn1
            ),
            // 2. Reply with Matrix fallback quote stripped.
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$msg2",
                sender: "@bob:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_200,
                msgtype: "m.text",
                body: "> <@alice:atelier.matrix.kodera.io> Bonjour l'équipe\n\nPrêt pour la revue",
                replyToEventId: "$msg1"
            ),
        ])

        XCTAssertEqual(reducer.messages.count, 2)
        XCTAssertEqual(reducer.messages[0].key, "txn:\(Self.txn1)", "Optimistic row key must remain stable on ack")
        XCTAssertEqual(reducer.messages[0].eventId, "$msg1")
        XCTAssertEqual(reducer.messages[0].deliveryStatus, .sent)
        XCTAssertEqual(reducer.messages[1].body, "Prêt pour la revue")
        XCTAssertEqual(reducer.messages[1].replyPreview?.sender, "alice")
        XCTAssertEqual(reducer.messages[1].replyPreview?.bodyExcerpt, "Bonjour l'équipe")

        // 3. Foreign-sender m.replace is ignored; same-sender m.replace updates body and marks edited.
        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$spoofEdit",
                sender: "@mallory:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_300,
                msgtype: "m.text",
                body: "* Spoofed",
                newContentBody: "Spoofed",
                relationType: "m.replace",
                relatesToEventId: "$msg1"
            )
        ])
        XCTAssertEqual(reducer.messages[0].body, "Bonjour l'équipe")
        XCTAssertFalse(reducer.messages[0].isEdited)

        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$realEdit",
                sender: "@alice:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_400,
                msgtype: "m.text",
                body: "* Bonjour l'équipe (mis à jour)",
                newContentBody: "Bonjour l'équipe (mis à jour)",
                relationType: "m.replace",
                relatesToEventId: "$msg1"
            )
        ])
        XCTAssertEqual(reducer.messages[0].body, "Bonjour l'équipe (mis à jour)")
        XCTAssertTrue(reducer.messages[0].isEdited)

        // 4. Reactions: valid single-grapheme counted & own reaction tracked; invalid multi-grapheme ignored; redaction removes reaction.
        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.reaction",
                eventId: "$react1",
                sender: "@alice:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_500,
                relationType: "m.annotation",
                relatesToEventId: "$msg1",
                reactionKey: "🚀"
            ),
            MatrixRawTimelineEvent(
                type: "m.reaction",
                eventId: "$react2",
                sender: "@bob:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_501,
                relationType: "m.annotation",
                relatesToEventId: "$msg1",
                reactionKey: "🚀"
            ),
            MatrixRawTimelineEvent(
                type: "m.reaction",
                eventId: "$reactInvalid",
                sender: "@bob:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_502,
                relationType: "m.annotation",
                relatesToEventId: "$msg1",
                reactionKey: "🚀🔥"
            ),
        ])
        XCTAssertEqual(reducer.messages[0].reactions.count, 1)
        XCTAssertEqual(reducer.messages[0].reactions[0].key, "🚀")
        XCTAssertEqual(reducer.messages[0].reactions[0].count, 2)
        XCTAssertTrue(reducer.messages[0].reactions[0].isSelectedByMe)
        XCTAssertEqual(reducer.messages[0].reactions[0].myReactionEventId, "$react1")

        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.redaction",
                eventId: "$redactReact1",
                sender: "@alice:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_600,
                redactsEventId: "$react1"
            )
        ])
        XCTAssertEqual(reducer.messages[0].reactions[0].count, 1)
        XCTAssertFalse(reducer.messages[0].reactions[0].isSelectedByMe)

        // 5. Redacting message clears body, edited flag, and reactions.
        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.redaction",
                eventId: "$redactMsg1",
                sender: "@alice:atelier.matrix.kodera.io",
                originServerTs: 1_700_000_000_700,
                redactsEventId: "$msg1"
            )
        ])
        XCTAssertTrue(reducer.messages[0].isRedacted)
        XCTAssertEqual(reducer.messages[0].body, "")
        XCTAssertTrue(reducer.messages[0].reactions.isEmpty)
    }

    func testMatrixRoomClientDiscoveryAliasSyncSendAndThreeStepAttachmentUpload() async throws {
        let requester = try makeRequester()
        let client = MatrixRoomClient(
            coreRequester: requester,
            loopback: .refuse,
            protocolClass: URLProtocolFixture.self,
            timeout: 2
        )

        // 1. Well-known 200 discovery with trailing slash normalization.
        URLProtocolFixture.install(.body(
            status: 200,
            headers: Self.jsonHeaders,
            chunks: [Data(#"{"m.homeserver":{"base_url":"https://hs.atelier.matrix.kodera.io/"}}"#.utf8)]
        ))
        let discovered = try await client.discoverHomeserverOrigin(
            organisationSlug: "atelier",
            matrixDomain: "matrix.kodera.io"
        )
        XCTAssertEqual(discovered, "https://hs.atelier.matrix.kodera.io")

        // 2. Well-known 404 fallback to https://{slug}.{matrixDomain}.
        URLProtocolFixture.install(.body(status: 404, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]))
        let fallback = try await client.discoverHomeserverOrigin(
            organisationSlug: "atelier",
            matrixDomain: "matrix.kodera.io"
        )
        XCTAssertEqual(fallback, "https://atelier.matrix.kodera.io")

        // 3. Canonical alias #kodera-ch-{channelId}:{serverName} resolution.
        URLProtocolFixture.install(.body(
            status: 200,
            headers: Self.jsonHeaders,
            chunks: [Data(#"{"room_id":"!roomAlpha:atelier.matrix.kodera.io"}"#.utf8)]
        ))
        let resolved = try await client.resolveChannelRoomId(
            homeserverOrigin: fallback,
            matrixAccessToken: "mtx_tok_01",
            channelId: Self.channelId,
            serverName: "atelier.matrix.kodera.io"
        )
        XCTAssertEqual(resolved.rawValue, Self.roomId)
        XCTAssertEqual(
            URLProtocolFixture.requests.first?.url?.absoluteString,
            "https://atelier.matrix.kodera.io/_matrix/client/v3/directory/room/%23kodera-ch-\(Self.channelId)%3Aatelier.matrix.kodera.io"
        )

        // 4. Bounded /sync with lazy_load_members & limit 25.
        let syncPayload = Data(#"""
        {
          "next_batch": "s72_99",
          "rooms": {
            "join": {
              "!roomAlpha:atelier.matrix.kodera.io": {
                "timeline": {
                  "events": [
                    {
                      "type": "m.room.message",
                      "event_id": "$ev1",
                      "sender": "@alice:atelier.matrix.kodera.io",
                      "origin_server_ts": 1700000000000,
                      "content": { "msgtype": "m.text", "body": "Salut" }
                    }
                  ]
                }
              }
            }
          }
        }
        """#.utf8)
        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [syncPayload]))
        let syncBatch = try await client.sync(
            homeserverOrigin: fallback,
            matrixAccessToken: "mtx_tok_01",
            since: "s72_00"
        )
        XCTAssertEqual(syncBatch.nextBatch, "s72_99")
        XCTAssertEqual(syncBatch.roomEvents[Self.roomId]?.count, 1)
        let syncURL = try XCTUnwrap(URLProtocolFixture.requests.first?.url?.absoluteString)
        XCTAssertTrue(syncURL.contains("lazy_load_members"))
        XCTAssertTrue(syncURL.contains("25"))

        // 5. 3-step Core scoped attachment upload + Matrix message send with io.kodera.attachments.
        let fileBytes = Data("rapport-kodera".utf8)
        let expectedSha = MatrixRoomClient.sha256LowercaseHex(fileBytes)
        let ticketJSON = Data(#"""
        {
          "attachmentId": "\#(Self.attachmentId)",
          "uploadUrl": "https://storage.kodera.io/put-object-01",
          "method": "PUT",
          "headers": { "Content-Type": "text/plain" },
          "expiresAt": "2026-12-01T00:00:00Z"
        }
        """#.utf8)
        let completedJSON = Data(#"""
        {
          "id": "\#(Self.attachmentId)",
          "filename": "notes.txt",
          "contentType": "text/plain",
          "sizeBytes": \#(fileBytes.count),
          "sha256": "\#(expectedSha)",
          "downloadUrl": "https://storage.kodera.io/get-object-01",
          "expiresAt": "2026-12-01T00:05:00Z",
          "disposition": "attachment"
        }
        """#.utf8)
        URLProtocolFixture.install(sequence: [
            .body(status: 201, headers: Self.jsonHeaders, chunks: [ticketJSON]),
            .body(status: 200, headers: [:], chunks: []),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [completedJSON]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [Data(#"{"event_id":"$sentWithAttachment"}"#.utf8)]),
        ])
        let uploadPayload = try AttachmentUploadPayload(
            filename: "notes.txt",
            contentType: .plainText,
            data: fileBytes
        )
        let ref = try await client.uploadChannelAttachment(
            organisationId: Self.orgId,
            channelId: Self.channelId,
            payload: uploadPayload
        )
        XCTAssertEqual(ref.id, Self.attachmentId)
        XCTAssertEqual(ref.filename, "notes.txt")

        let sentEventId = try await client.sendTextMessage(
            homeserverOrigin: fallback,
            matrixAccessToken: "mtx_tok_01",
            roomId: Self.roomId,
            transactionId: Self.txn2,
            body: "",
            attachments: [ref]
        )
        XCTAssertEqual(sentEventId, "$sentWithAttachment")

        let recordedRequests = URLProtocolFixture.requests
        XCTAssertEqual(recordedRequests.count, 4)
        XCTAssertNotNil(recordedRequests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertNotNil(recordedRequests[0].value(forHTTPHeaderField: "Idempotency-Key"))
        // Step 2 presigned PUT must NEVER carry Core or Matrix Authorization credentials!
        XCTAssertEqual(recordedRequests[1].httpMethod, "PUT")
        XCTAssertNil(recordedRequests[1].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(recordedRequests[2].url?.path, "/api/v1/organisations/\(Self.orgId)/workspace/attachments/\(Self.attachmentId)/complete")
    }

    func testPushWakeupCoordinatorRegistersRejectsCleartextCatchesUpAndRevokesOnSignOut() async throws {
        let requester = try makeRequester()
        let coordinator = PushWakeupCoordinator(requester: requester)

        let p256dh = String(repeating: "A", count: 87)
        let auth = String(repeating: "B", count: 22)

        // 1. Register wakeup endpoint sending strictly {"endpoint", "p256dh", "auth"} (Core 422 parity).
        URLProtocolFixture.install(.body(status: 204, headers: Self.jsonHeaders, chunks: []))
        try await coordinator.registerDeviceWakeup(
            deviceId: Self.deviceId,
            endpoint: "https://push.kodera.io/w/device-42",
            p256dh: p256dh,
            auth: auth
        )
        let registerReq = try XCTUnwrap(URLProtocolFixture.requests.first)
        XCTAssertEqual(registerReq.httpMethod, "PUT")
        XCTAssertEqual(registerReq.url?.path, "/api/v1/push/subscriptions/\(Self.deviceId)")
        let registerBody = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try URLProtocolFixture.bodyData(registerReq)) as? [String: String]
        )
        XCTAssertEqual(Set(registerBody.keys), ["endpoint", "p256dh", "auth"])
        XCTAssertNil(registerBody["surface"])

        // 2. Cleartext leak (top-level or nested inside transport) is rejected before any network call.
        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]))
        let leakyPayload = Data(#"""
        {
          "wakeup_id": "01935800-0000-7000-8000-000000000301",
          "organisation_id": "\#(Self.orgId)",
          "body": "plaintext leak"
        }
        """#.utf8)
        do {
            _ = try await coordinator.handleIncomingWakeup(rawPayload: leakyPayload, expectedOrganisationId: Self.orgId)
            XCTFail("Expected cleartext rejection")
        } catch {
            XCTAssertEqual(error, .payloadRejected(.cleartextPayloadForbidden(field: "body")))
        }
        let nestedTransportLeak = Data(#"""
        {
          "wakeup_id": "01935800-0000-7000-8000-000000000301",
          "organisation_id": "\#(Self.orgId)",
          "sync_hint": "sync_v1_42",
          "transport": { "body": "secret" }
        }
        """#.utf8)
        do {
            _ = try await coordinator.handleIncomingWakeup(rawPayload: nestedTransportLeak, expectedOrganisationId: Self.orgId)
            XCTFail("Expected nested transport cleartext rejection")
        } catch {
            XCTAssertEqual(error, .payloadRejected(.cleartextPayloadForbidden(field: "transport.body")))
        }
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)

        // 3. Admitted payload-free wakeup fetches /api/v1/notifications and runs Matrix catch-up.
        let inboxJSON = Data(#"""
        {
          "data": [
            {
              "id": "01935800-0000-7000-8000-000000000401",
              "kind": "mention",
              "resourceId": "\#(Self.channelId)",
              "createdAt": "2026-11-23T00:00:00Z",
              "readAt": null
            }
          ],
          "has_more": false,
          "next_cursor": null
        }
        """#.utf8)
        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [inboxJSON]))
        let syncCounter = CounterBox()
        let validWakeup = Data(#"""
        {
          "wakeup_id": "01935800-0000-7000-8000-000000000301",
          "organisation_id": "\#(Self.orgId)",
          "sync_hint": "sync_v1_42"
        }
        """#.utf8)
        let page = try await coordinator.handleIncomingWakeup(
            rawPayload: validWakeup,
            expectedOrganisationId: Self.orgId,
            inboxLimit: 25
        ) {
            syncCounter.increment()
        }
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items.first?.kind, .mention)
        XCTAssertEqual(syncCounter.value, 1)
        XCTAssertEqual(URLProtocolFixture.requests.first?.url?.absoluteString, "https://core.test/api/v1/notifications?limit=25")

        // 4. Sign-out revokes via DELETE.
        URLProtocolFixture.install(.body(status: 204, headers: Self.jsonHeaders, chunks: []))
        try await coordinator.revokeOnSignOut(deviceId: Self.deviceId)
        XCTAssertEqual(URLProtocolFixture.requests.first?.httpMethod, "DELETE")
        XCTAssertEqual(URLProtocolFixture.requests.first?.url?.path, "/api/v1/push/subscriptions/\(Self.deviceId)")
    }

    func testEditRedactionRecomputesPriorBodyPrunesEvictedReactionsHandlesLimitedGapAndFencesOidcLogin() async throws {
        var reducer = MatrixTimelineReducer(ownUserId: "@alice:atelier.kodera.io")

        // 1. Edit chain: original -> edit1 -> edit2; redacting edit2 restores edit1; redacting edit1 restores original!
        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$orig",
                sender: "@alice:atelier.kodera.io",
                originServerTs: 1_000,
                msgtype: "m.text",
                body: "Version originale"
            ),
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$edit1",
                sender: "@alice:atelier.kodera.io",
                originServerTs: 1_100,
                msgtype: "m.text",
                body: "* Version 1",
                newContentBody: "Version 1",
                relationType: "m.replace",
                relatesToEventId: "$orig"
            ),
            MatrixRawTimelineEvent(
                type: "m.room.message",
                eventId: "$edit2",
                sender: "@alice:atelier.kodera.io",
                originServerTs: 1_200,
                msgtype: "m.text",
                body: "* Version 2",
                newContentBody: "Version 2",
                relationType: "m.replace",
                relatesToEventId: "$orig"
            ),
        ])
        XCTAssertEqual(reducer.messages.first?.body, "Version 2")
        XCTAssertTrue(reducer.messages.first?.isEdited == true)

        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.redaction",
                eventId: "$redEdit2",
                sender: "@alice:atelier.kodera.io",
                originServerTs: 1_300,
                redactsEventId: "$edit2"
            ),
        ])
        XCTAssertEqual(reducer.messages.first?.body, "Version 1")
        XCTAssertTrue(reducer.messages.first?.isEdited == true)

        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.room.redaction",
                eventId: "$redEdit1",
                sender: "@alice:atelier.kodera.io",
                originServerTs: 1_400,
                redactsEventId: "$edit1"
            ),
        ])
        XCTAssertEqual(reducer.messages.first?.body, "Version originale")
        XCTAssertEqual(reducer.messages.first?.isEdited, false)

        // 2. Reaction pruning on 250-message eviction + 512 orphan cap.
        reducer.applyEvents([
            MatrixRawTimelineEvent(
                type: "m.reaction",
                eventId: "$reactOrig",
                sender: "@bob:atelier.kodera.io",
                originServerTs: 1_500,
                relationType: "m.annotation",
                relatesToEventId: "$orig",
                reactionKey: "👍"
            ),
        ])
        XCTAssertEqual(reducer.trackedReactionCount, 1)

        var floodMessages: [MatrixRawTimelineEvent] = []
        for idx in 1...255 {
            floodMessages.append(
                MatrixRawTimelineEvent(
                    type: "m.room.message",
                    eventId: "$m\(idx)",
                    sender: "@bob:atelier.kodera.io",
                    originServerTs: Int64(2_000 + idx),
                    msgtype: "m.text",
                    body: "Msg \(idx)"
                )
            )
        }
        reducer.applyEvents(floodMessages)
        XCTAssertEqual(reducer.messages.count, MatrixTimelineReducer.maxTimelineMessages)
        XCTAssertEqual(reducer.trackedReactionCount, 0, "Reactions targeting evicted messages must be pruned")

        var orphanReactions: [MatrixRawTimelineEvent] = []
        for idx in 1...600 {
            orphanReactions.append(
                MatrixRawTimelineEvent(
                    type: "m.reaction",
                    eventId: "$orphan\(idx)",
                    sender: "@bob:atelier.kodera.io",
                    originServerTs: Int64(5_000 + idx),
                    relationType: "m.annotation",
                    relatesToEventId: "$futureEvent",
                    reactionKey: "🎉"
                )
            )
        }
        reducer.applyEvents(orphanReactions)
        XCTAssertEqual(reducer.trackedReactionCount, MatrixTimelineReducer.maxTrackedReactions)

        // 3. Incremental limited == true gap resets stale synced items while preserving local failed optimistic send.
        _ = reducer.enqueueOptimisticSend(transactionId: Self.txn1, body: "Brouillon local", nowMs: 9_000)
        reducer.markOptimisticFailed(transactionId: Self.txn1)
        reducer.applySyncDelta(
            MatrixRoomSyncDelta(
                events: [
                    MatrixRawTimelineEvent(
                        type: "m.room.message",
                        eventId: "$postGap",
                        sender: "@bob:atelier.kodera.io",
                        originServerTs: 9_500,
                        msgtype: "m.text",
                        body: "Après coupure"
                    ),
                ],
                limited: true,
                prevBatch: "p_gap_1"
            ),
            backfilledEvents: [
                MatrixRawTimelineEvent(
                    type: "m.room.message",
                    eventId: "$backfilled1",
                    sender: "@alice:atelier.kodera.io",
                    originServerTs: 9_400,
                    msgtype: "m.text",
                    body: "Historique récupéré"
                ),
            ]
        )
        XCTAssertEqual(reducer.messages.map(\.body), ["Historique récupéré", "Après coupure", "Brouillon local"])
        XCTAssertEqual(reducer.messages.last?.deliveryStatus, .failed)

        // 4. SessionFence + Synapse OIDC SSO (`m.login.token`) + OIDC `sub` != MemberProfile.id + vault seal/restore + logout.
        let fence = SessionFence()
        let requester = try makeRequester()
        let client = MatrixRoomClient(
            coreRequester: requester,
            loopback: .refuse,
            fence: fence,
            protocolClass: URLProtocolFixture.self,
            timeout: 2
        )
        XCTAssertEqual(MatrixRoomClient.deriveMatrixDomain(fromCoreApiOrigin: "https://api.kodera.io", loopback: .refuse), "kodera.io")

        // Verify SSO redirect request + immediate `loginToken`/`state` stripping + state mismatch refusal.
        let ssoReq = try MatrixRoomClient.buildSsoRedirectRequest(
            homeserverOrigin: "https://atelier.kodera.io",
            state: "fixed_state_0123456789abcdef",
            loopback: .refuse
        )
        XCTAssertTrue(ssoReq.ssoRedirectURL.absoluteString.hasPrefix("https://atelier.kodera.io/_matrix/client/v3/login/sso/redirect?redirectUrl="))
        let granted = try MatrixRoomClient.consumeSsoCallbackURI(
            "io.kodera.app:/oauth2redirect?state=fixed_state_0123456789abcdef&loginToken=syt_single_use_tok&keep=1",
            expectedState: ssoReq.state
        )
        XCTAssertEqual(granted.loginToken, "syt_single_use_tok")
        XCTAssertEqual(granted.redactedCallbackURI, "io.kodera.app:/oauth2redirect?keep=1")
        XCTAssertFalse(granted.redactedCallbackURI.contains("syt_single_use_tok"))
        XCTAssertFalse(granted.redactedCallbackURI.contains("fixed_state"))

        do {
            _ = try MatrixRoomClient.consumeSsoCallbackURI(
                "io.kodera.app:/oauth2redirect?state=wrong_state_0123456789abcdef&loginToken=syt_single_use_tok",
                expectedState: ssoReq.state
            )
            XCTFail("Expected state mismatch refusal")
        } catch {
            XCTAssertEqual(error, .forbidden)
        }

        // Regression (Items 1 & 2): MemberProfile.id != oidcSubject.
        // If Synapse returns `@<memberProfileId>:atelier.kodera.io` instead of `@<oidcSubject>:atelier.kodera.io`,
        // `authenticateWithSso` MUST immediately call `POST /_matrix/client/v3/logout` before throwing `.forbidden`.
        let memberProfilePersonId = "11111111-2222-4333-8444-555555555555"
        let oidcSubject = "oidc-sub-77777777-8888-4999-8000-aaaaaaaaaaaa"
        XCTAssertNotEqual(memberProfilePersonId, oidcSubject)

        let wrongSubjectLoginJSON = Data("""
        {"user_id":"@\(memberProfilePersonId):atelier.kodera.io","access_token":"mtx_leaked_1","refresh_token":"mtx_ref_bad","device_id":"\(Self.deviceId)"}
        """.utf8)
        URLProtocolFixture.install(sequence: [
            .body(status: 200, headers: Self.jsonHeaders, chunks: [wrongSubjectLoginJSON]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]),
        ])
        do {
            _ = try await client.authenticateWithSso(
                homeserverOrigin: "https://atelier.kodera.io",
                serverName: "atelier.kodera.io",
                deviceId: Self.deviceId,
                expectedSubject: oidcSubject,
                ssoAuthorizer: { req throws(MatrixClientFailure) -> MatrixSsoTokenGrant in
                    try MatrixRoomClient.consumeSsoCallbackURI(
                        "\(req.callbackURI)&loginToken=sso_tok_mismatch",
                        expectedState: req.state
                    )
                }
            )
            XCTFail("Expected mismatched user_id refusal")
        } catch {
            XCTAssertEqual(error, .forbidden)
        }
        XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.path ?? "" }, [
            "/_matrix/client/v3/login",
            "/_matrix/client/v3/logout",
        ])
        XCTAssertEqual(URLProtocolFixture.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer mtx_leaked_1")

        let vaultBox = VaultBytesBox()
        let transport = MatrixChannelConversationTransport(
            roomClient: client,
            organisationId: Self.orgId,
            organisationSlug: "atelier",
            matrixDomain: "kodera.io",
            vaultDeviceId: Self.deviceId,
            initialExpectedSubject: oidcSubject,
            expectedSubjectProvider: { oidcSubject },
            ssoAuthorizer: { req throws(MatrixClientFailure) -> MatrixSsoTokenGrant in
                try MatrixRoomClient.consumeSsoCallbackURI(
                    "\(req.callbackURI)&loginToken=sso_tok_valid_01",
                    expectedState: req.state
                )
            },
            loadVault: { _, _ in vaultBox.load() },
            saveVault: { _, _, data in vaultBox.save(data); return true }
        )

        let loginJSON = Data("""
        {"user_id":"@\(oidcSubject):atelier.kodera.io","access_token":"mtx_live_1","refresh_token":"mtx_ref_1","device_id":"\(Self.deviceId)"}
        """.utf8)
        let dirJSON = Data(#"{"room_id":"!roomAlpha:atelier.kodera.io"}"#.utf8)
        let syncLimitedJSON = Data(#"""
        {
          "next_batch": "s_next_2",
          "rooms": {
            "join": {
              "!roomAlpha:atelier.kodera.io": {
                "timeline": {
                  "limited": true,
                  "prev_batch": "s_prev_1",
                  "events": []
                }
              }
            }
          }
        }
        """#.utf8)
        URLProtocolFixture.install(sequence: [
            .body(status: 404, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [loginJSON]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [dirJSON]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [syncLimitedJSON]),
        ])
        let boot = try await transport.bootstrapRoom(organisationId: Self.orgId, channelId: Self.channelId)
        let loginRequest = try XCTUnwrap(URLProtocolFixture.requests.dropFirst().first)
        let sentLoginBody = String(decoding: try URLProtocolFixture.bodyData(loginRequest), as: UTF8.self)
        XCTAssertTrue(sentLoginBody.contains("\"type\":\"m.login.token\""))
        XCTAssertTrue(sentLoginBody.contains("\"token\":\"sso_tok_valid_01\""))
        XCTAssertTrue(sentLoginBody.contains("\"refresh_token\":true"))
        XCTAssertEqual(boot.roomId, "!roomAlpha:atelier.kodera.io")
        XCTAssertEqual(boot.initialBatch.roomDeltas["!roomAlpha:atelier.kodera.io"]?.limited, true)
        XCTAssertEqual(boot.initialBatch.roomDeltas["!roomAlpha:atelier.kodera.io"]?.prevBatch, "s_prev_1")
        XCTAssertEqual(transport.ownUserId, "@\(oidcSubject):atelier.kodera.io")
        XCTAssertNotNil(vaultBox.load())

        // 401 triggers Matrix /refresh and retries seamlessly.
        URLProtocolFixture.install(sequence: [
            .body(status: 401, headers: Self.jsonHeaders, chunks: [Data(#"{"errcode":"M_UNKNOWN_TOKEN"}"#.utf8)]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [Data(#"{"access_token":"mtx_live_2","refresh_token":"mtx_ref_2"}"#.utf8)]),
            .body(status: 200, headers: Self.jsonHeaders, chunks: [Data(#"{"chunk":[]}"#.utf8)]),
        ])
        let backfilled = try await transport.backfillRoomMessages(
            roomId: "!roomAlpha:atelier.kodera.io",
            fromToken: "s_prev_1",
            limit: 10
        )
        XCTAssertTrue(backfilled.isEmpty)

        // Logout revokes the rotated token, and fence invalidation blocks any subsequent call before network I/O.
        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]))
        await transport.logoutIfAuthenticated()
        XCTAssertEqual(URLProtocolFixture.requests.first?.url?.path, "/_matrix/client/v3/logout")

        URLProtocolFixture.install(.body(status: 200, headers: Self.jsonHeaders, chunks: [Data("{}".utf8)]))
        fence.invalidate()
        do {
            _ = try await client.sync(homeserverOrigin: "https://atelier.kodera.io", matrixAccessToken: "mtx_live_2")
            XCTFail("Expected fence refusal")
        } catch {
            XCTAssertEqual(error, .signedOut)
        }
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }
}

private final class VaultBytesBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Data?
    func load() -> Data? { lock.withLock { stored } }
    func save(_ data: Data) { lock.withLock { stored = data } }
}

private final class CounterBox: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}
