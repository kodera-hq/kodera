import CryptoKit
import Foundation
import KoderaDomain

public enum MatrixClientFailure: Error, Equatable, Sendable {
    case invalidInput
    case protocolViolation
    case unauthorized
    case forbidden
    case notFound
    case rateLimited
    case payloadTooLarge
    case serviceUnavailable
    case signedOut
    case signedOutNotWiped
    case identityUnavailable
    case transport(TransportFailure)
}

/// Thread-safe session/owner generation fence checked before and after every Matrix HTTP exchange,
/// cancelling active network tasks immediately on sign-out, organisation switch, or teardown.
public final class SessionFence: @unchecked Sendable {
    private static let counterLock = NSLock()
    nonisolated(unsafe) private static var nextGeneration: UInt64 = 0

    public let generation: UInt64
    private let lock = NSLock()
    private var invalidated = false
    private var cancelHandlers: [UUID: @Sendable () -> Void] = [:]

    public init() {
        self.generation = Self.counterLock.withLock {
            Self.nextGeneration &+= 1
            return Self.nextGeneration
        }
    }

    public var isInvalidated: Bool {
        lock.withLock { invalidated }
    }

    public func checkActive() throws(MatrixClientFailure) {
        if isInvalidated {
            throw .signedOut
        }
    }

    public func registerCancellation(_ handler: @escaping @Sendable () -> Void) -> UUID? {
        let state: (UUID?, Bool) = lock.withLock {
            if invalidated { return (nil, true) }
            let token = UUID()
            cancelHandlers[token] = handler
            return (token, false)
        }
        if state.1 {
            handler()
            return nil
        }
        return state.0
    }

    public func unregisterCancellation(_ token: UUID?) {
        guard let token else { return }
        _ = lock.withLock { cancelHandlers.removeValue(forKey: token) }
    }

    public func invalidate() {
        let handlers: [@Sendable () -> Void] = lock.withLock {
            guard !invalidated else { return [] }
            invalidated = true
            let list = Array(cancelHandlers.values)
            cancelHandlers.removeAll()
            return list
        }
        for handler in handlers {
            handler()
        }
    }
}

/// Synapse OIDC SSO redirect request targeting `{homeserverOrigin}/_matrix/client/v3/login/sso/redirect?redirectUrl=...`.
public struct MatrixSsoRedirectRequest: Equatable, Sendable {
    public let homeserverOrigin: String
    public let ssoRedirectURL: URL
    public let callbackURI: String
    public let state: String

    public init(homeserverOrigin: String, ssoRedirectURL: URL, callbackURI: String, state: String) {
        self.homeserverOrigin = homeserverOrigin
        self.ssoRedirectURL = ssoRedirectURL
        self.callbackURI = callbackURI
        self.state = state
    }
}

/// Verified single-use `loginToken` extracted from the Synapse SSO callback with `loginToken` and `state` stripped.
public struct MatrixSsoTokenGrant: Equatable, Sendable {
    public let loginToken: String
    public let redactedCallbackURI: String

    public init(loginToken: String, redactedCallbackURI: String) {
        self.loginToken = loginToken
        self.redactedCallbackURI = redactedCallbackURI
    }
}

/// Injectable Synapse SSO authorizer seam (backed in production by `KoderaAuth` browser authentication).
public typealias MatrixSsoAuthorizer = @Sendable (MatrixSsoRedirectRequest) async throws(MatrixClientFailure) -> MatrixSsoTokenGrant

/// Matrix device session credentials sealed inside `KeychainSessionVault` (`KDV1`).
public struct PersistedMatrixSession: Equatable, Sendable {
    public let homeserverOrigin: String
    public let serverName: String
    public let userId: String
    public let deviceId: String
    public let accessToken: String
    public let refreshToken: String?

    public init(
        homeserverOrigin: String,
        serverName: String,
        userId: String,
        deviceId: String,
        accessToken: String,
        refreshToken: String?
    ) throws(MatrixClientFailure) {
        guard !homeserverOrigin.isEmpty,
              (try? MatrixServerName(serverName)) != nil,
              (try? MatrixUserId(userId)) != nil,
              Kdv1SessionVaultCodec.isValidVaultDeviceId(deviceId),
              !accessToken.isEmpty,
              accessToken.utf8.count <= 4096,
              accessToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
            throw .invalidInput
        }
        if let refreshToken {
            guard !refreshToken.isEmpty,
                  refreshToken.utf8.count <= 4096,
                  refreshToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
                throw .invalidInput
            }
        }
        self.homeserverOrigin = homeserverOrigin
        self.serverName = serverName
        self.userId = userId
        self.deviceId = deviceId
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }

    public func encodeVaultData() throws(MatrixClientFailure) -> Data {
        var obj: [String: Any] = [
            "version": 1,
            "homeserver_origin": homeserverOrigin,
            "server_name": serverName,
            "user_id": userId,
            "device_id": deviceId,
            "access_token": accessToken,
        ]
        if let refreshToken {
            obj["refresh_token"] = refreshToken
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else {
            throw .invalidInput
        }
        return data
    }

    public static func decodeVaultData(_ data: Data) throws(MatrixClientFailure) -> PersistedMatrixSession {
        guard let parsed = try? StrictJSON.parse(data, byteLimit: StrictJSON.byteLimit),
              let root = parsed.object,
              root["version"]?.integer == 1,
              let homeserverOrigin = root["homeserver_origin"]?.string,
              let serverName = root["server_name"]?.string,
              let userId = root["user_id"]?.string,
              let deviceId = root["device_id"]?.string,
              let accessToken = root["access_token"]?.string else {
            throw .protocolViolation
        }
        let refreshToken: String?
        if let rawRefresh = root["refresh_token"], !rawRefresh.isNull {
            guard let str = rawRefresh.string else { throw .protocolViolation }
            refreshToken = str
        } else {
            refreshToken = nil
        }
        return try PersistedMatrixSession(
            homeserverOrigin: homeserverOrigin,
            serverName: serverName,
            userId: userId,
            deviceId: deviceId,
            accessToken: accessToken,
            refreshToken: refreshToken
        )
    }
}

public struct MatrixSyncBatch: Equatable, Sendable {
    public let nextBatch: String
    public let roomEvents: [String: [MatrixRawTimelineEvent]]
    public let roomDeltas: [String: MatrixRoomSyncDelta]

    public init(nextBatch: String, roomEvents: [String: [MatrixRawTimelineEvent]]) {
        self.nextBatch = nextBatch
        self.roomEvents = roomEvents
        self.roomDeltas = roomEvents.mapValues { MatrixRoomSyncDelta(events: $0) }
    }

    public init(nextBatch: String, roomDeltas: [String: MatrixRoomSyncDelta]) {
        self.nextBatch = nextBatch
        self.roomDeltas = roomDeltas
        self.roomEvents = roomDeltas.mapValues(\.events)
    }
}

public struct AttachmentUploadPayload: Equatable, Sendable {
    public let filename: String
    public let contentType: AttachmentMimeType
    public let data: Data

    public init(filename: String, contentType: AttachmentMimeType, data: Data) throws {
        guard !data.isEmpty, data.count <= AttachmentMetadataRef.maxSizeBytes else {
            throw MatrixClientFailure.payloadTooLarge
        }
        let cleaned = AttachmentMetadataRef.cleanFilename(filename)
        guard !cleaned.isEmpty, cleaned.count <= AttachmentMetadataRef.maxFilenameLength else {
            throw MatrixClientFailure.invalidInput
        }
        self.filename = cleaned
        self.contentType = contentType
        self.data = data
    }
}

/// High-level conversation transport consumed by `ChannelConversationView` without exposing raw URLs in `App/`.
public protocol ChannelConversationTransport: Sendable {
    var ownUserId: String { get }
    func bootstrapRoom(organisationId: String, channelId: String) async throws(MatrixClientFailure) -> (roomId: String, initialBatch: MatrixSyncBatch)
    func syncRoom(roomId: String, since: String?) async throws(MatrixClientFailure) -> MatrixSyncBatch
    func sendMessage(
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String?,
        attachments: [AttachmentMetadataRef]
    ) async throws(MatrixClientFailure) -> String
    func editMessage(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        newBody: String
    ) async throws(MatrixClientFailure) -> String
    func redactEvent(
        roomId: String,
        transactionId: String,
        targetEventId: String
    ) async throws(MatrixClientFailure) -> String
    func sendReaction(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        emojiKey: String
    ) async throws(MatrixClientFailure) -> String
    func uploadAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload
    ) async throws(MatrixClientFailure) -> AttachmentMetadataRef
    func backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int
    ) async throws(MatrixClientFailure) -> [MatrixRawTimelineEvent]
}

public extension ChannelConversationTransport {
    func backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int
    ) async throws(MatrixClientFailure) -> [MatrixRawTimelineEvent] {
        []
    }
}

/// Matrix Client-Server v3 room transport + Core-scoped 3-step attachment uploader.
/// Enforces origin validation, zero redirects, ephemeral credential-free sessions, and <= 65,536-byte JSON bounds.
public actor MatrixRoomClient {
    public static let syncTimelineLimit = 25
    public static let boundedSyncFilterJSON = #"{"room":{"state":{"lazy_load_members":true},"timeline":{"limit":25}}}"#

    private static let forbiddenPresignedHeaders: Set<String> = [
        "authorization", "cookie", "set-cookie", "host", "origin", "referer",
        "content-length", "transfer-encoding", "connection",
    ]

    private let coreRequester: CoreRequester
    private let loopback: LoopbackPolicy
    private let fence: SessionFence
    private let protocolClass: URLProtocol.Type?
    private let timeout: TimeInterval

    public init(
        coreRequester: CoreRequester,
        loopback: LoopbackPolicy,
        fence: SessionFence = SessionFence(),
        protocolClass: URLProtocol.Type? = nil,
        timeout: TimeInterval = 15
    ) {
        self.coreRequester = coreRequester
        self.loopback = loopback
        self.fence = fence
        self.protocolClass = protocolClass
        self.timeout = timeout
    }

    /// Derives the deployment Matrix base domain from a validated `coreApiOrigin` (`api.kodera.io` -> `kodera.io`).
    public static func deriveMatrixDomain(fromCoreApiOrigin coreApiOrigin: String, loopback: LoopbackPolicy) -> String? {
        guard let url = URL(string: coreApiOrigin),
              let rawHost = url.host?.lowercased(),
              !rawHost.isEmpty else {
            return nil
        }
        if rawHost == "localhost" || rawHost == "127.0.0.1" || rawHost == "::1" {
            return loopback == .admitForDevelopment ? "kodera.test" : nil
        }
        for prefix in ["api.", "core."] where rawHost.hasPrefix(prefix) {
            let candidate = String(rawHost.dropFirst(prefix.count))
            if candidate.contains("."), TrustPolicy.validDNSName(candidate) {
                return candidate
            }
        }
        return rawHost.contains(".") && TrustPolicy.validDNSName(rawHost) ? rawHost : nil
    }

    /// Discovers the Matrix homeserver origin via `/.well-known/matrix/client` on `{organisationSlug}.{matrixDomain}`,
    /// falling back to `{scheme}://{organisationSlug}.{matrixDomain}` on HTTP `404`.
    public func discoverHomeserverOrigin(
        organisationSlug: String,
        matrixDomain: String
    ) async throws(MatrixClientFailure) -> String {
        guard Self.isValidDNSLabel(organisationSlug), TrustPolicy.validDNSName(matrixDomain.lowercased()) else {
            throw .invalidInput
        }
        let host = "\(organisationSlug.lowercased()).\(matrixDomain.lowercased())"
        let defaultOrigin = "https://\(host)"
        do {
            try IssuerAdmission.validateOrigin(defaultOrigin, loopback: loopback)
        } catch {
            throw .invalidInput
        }
        guard let wellKnownURL = URL(string: defaultOrigin + "/.well-known/matrix/client") else {
            throw .invalidInput
        }

        try fence.checkActive()
        let response = await MatrixHTTPTransport(
            protocolClass: protocolClass,
            timeout: timeout,
            maxResponseBytes: StrictJSON.byteLimit,
            fence: fence
        ).perform(
            url: wellKnownURL,
            method: "GET",
            bearerToken: nil,
            headers: ["Accept": "application/json", "Cache-Control": "no-store"],
            body: nil
        )
        try fence.checkActive()

        switch response {
        case .redirected, .tooLarge:
            throw .protocolViolation
        case let .failure(reason):
            throw .transport(reason)
        case let .response(status, body):
            switch status {
            case 200:
                guard let parsed = try? StrictJSON.parse(body, byteLimit: StrictJSON.byteLimit),
                      let root = parsed.object,
                      let homeserver = root["m.homeserver"]?.object,
                      let rawBase = homeserver["base_url"]?.string else {
                    throw .protocolViolation
                }
                let normalized = rawBase.hasSuffix("/") ? String(rawBase.dropLast()) : rawBase
                do {
                    try IssuerAdmission.validateOrigin(normalized, loopback: loopback)
                } catch {
                    throw .protocolViolation
                }
                return normalized
            case 404:
                return defaultOrigin
            case 429:
                throw .rateLimited
            case 500...599:
                throw .serviceUnavailable
            default:
                throw .protocolViolation
            }
        }
    }

    /// Resolves canonical Kodera channel alias `#kodera-ch-{channelId}:{serverName}` via Matrix directory API.
    public func resolveChannelRoomId(
        homeserverOrigin: String,
        matrixAccessToken: String,
        channelId: String,
        serverName: String
    ) async throws(MatrixClientFailure) -> MatrixRoomId {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        guard TrustPolicy.canonicalNonNilUUID(channelId),
              let validatedServer = try? MatrixServerName(serverName),
              let alias = try? MatrixRoomAlias("#kodera-ch-\(channelId):\(validatedServer.rawValue)") else {
            throw .invalidInput
        }
        let encodedAlias = Self.percentEncodePathSegment(alias.rawValue)
        guard let url = URL(string: "\(homeserverOrigin)/_matrix/client/v3/directory/room/\(encodedAlias)") else {
            throw .invalidInput
        }
        let root = try await matrixJSONRequest(
            url: url,
            method: "GET",
            matrixAccessToken: matrixAccessToken,
            jsonBody: nil
        )
        guard let rawRoomId = root["room_id"]?.string,
              let roomId = try? MatrixRoomId(rawRoomId) else {
            throw .protocolViolation
        }
        return roomId
    }

    /// Runs a bounded Matrix `/sync` (`lazy_load_members: true`, `timeline.limit: 25`, `<= 65,536` bytes).
    public func sync(
        homeserverOrigin: String,
        matrixAccessToken: String,
        since: String? = nil
    ) async throws(MatrixClientFailure) -> MatrixSyncBatch {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        if let since {
            guard !since.isEmpty, since.utf8.count <= 256, since.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
                throw .invalidInput
            }
        }
        let encodedFilter = Self.percentEncodeQueryComponent(Self.boundedSyncFilterJSON)
        var query = "filter=\(encodedFilter)&timeout=0"
        if let since {
            query += "&since=\(Self.percentEncodeQueryComponent(since))"
        }
        guard let url = URL(string: "\(homeserverOrigin)/_matrix/client/v3/sync?\(query)") else {
            throw .invalidInput
        }
        let root = try await matrixJSONRequest(
            url: url,
            method: "GET",
            matrixAccessToken: matrixAccessToken,
            jsonBody: nil
        )
        guard let nextBatch = root["next_batch"]?.string, !nextBatch.isEmpty else {
            throw .protocolViolation
        }
        var roomDeltas: [String: MatrixRoomSyncDelta] = [:]
        if let joinedRooms = root["rooms"]?.object?["join"]?.object {
            for (roomKey, roomVal) in joinedRooms {
                guard (try? MatrixRoomId(roomKey)) != nil else { continue }
                let timelineObj = roomVal.object?["timeline"]?.object
                let rawEvents = timelineObj?["events"]?.array ?? []
                let limited: Bool
                if let limVal = timelineObj?["limited"], case let .boolean(b) = limVal {
                    limited = b
                } else {
                    limited = false
                }
                let prevBatch = timelineObj?["prev_batch"]?.string
                roomDeltas[roomKey] = MatrixRoomSyncDelta(
                    events: rawEvents.compactMap(Self.decodeTimelineEvent),
                    limited: limited,
                    prevBatch: prevBatch
                )
            }
        }
        return MatrixSyncBatch(nextBatch: nextBatch, roomDeltas: roomDeltas)
    }

    /// Backfills timeline messages prior to `fromToken` (`dir=b`) when an incremental `/sync` reports `limited: true`.
    public func fetchRoomMessages(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        fromToken: String,
        limit: Int = syncTimelineLimit
    ) async throws(MatrixClientFailure) -> [MatrixRawTimelineEvent] {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        guard (try? MatrixRoomId(roomId)) != nil,
              !fromToken.isEmpty,
              fromToken.utf8.count <= 256,
              fromToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }),
              (1...50).contains(limit) else {
            throw .invalidInput
        }
        let encodedRoom = Self.percentEncodePathSegment(roomId)
        let encodedFrom = Self.percentEncodeQueryComponent(fromToken)
        guard let url = URL(
            string: "\(homeserverOrigin)/_matrix/client/v3/rooms/\(encodedRoom)/messages?from=\(encodedFrom)&dir=b&limit=\(limit)"
        ) else {
            throw .invalidInput
        }
        let root = try await matrixJSONRequest(
            url: url,
            method: "GET",
            matrixAccessToken: matrixAccessToken,
            jsonBody: nil
        )
        let chunk = root["chunk"]?.array ?? []
        return chunk.compactMap(Self.decodeTimelineEvent).reversed()
    }

    public static let defaultSsoCallbackURI = "io.kodera.app:/oauth2redirect"
    public static let ssoCallbackScheme = "io.kodera.app"

    /// Builds `{homeserverOrigin}/_matrix/client/v3/login/sso/redirect?redirectUrl=...` with a 32-byte cryptographic `state`.
    public static func buildSsoRedirectRequest(
        homeserverOrigin: String,
        callbackBaseURI: String = MatrixRoomClient.defaultSsoCallbackURI,
        state explicitState: String? = nil,
        loopback: LoopbackPolicy
    ) throws(MatrixClientFailure) -> MatrixSsoRedirectRequest {
        do {
            try IssuerAdmission.validateOrigin(homeserverOrigin, loopback: loopback)
        } catch {
            throw .invalidInput
        }
        guard var callbackComponents = URLComponents(string: callbackBaseURI),
              callbackComponents.scheme == ssoCallbackScheme,
              callbackComponents.path == "/oauth2redirect",
              callbackComponents.host == nil || callbackComponents.host?.isEmpty == true,
              callbackComponents.fragment == nil else {
            throw .invalidInput
        }
        let state: String
        if let explicitState {
            guard isValidSsoState(explicitState) else { throw .invalidInput }
            state = explicitState
        } else {
            let randomBytes = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            state = KoderaMobileFfiBridge.encodeHex(randomBytes)
        }
        var items = (callbackComponents.queryItems ?? []).filter {
            $0.name != "state" && $0.name != "loginToken"
        }
        items.append(URLQueryItem(name: "state", value: state))
        callbackComponents.queryItems = items
        guard let callbackURI = callbackComponents.string else {
            throw .invalidInput
        }
        let encodedRedirect = Self.percentEncodeQueryComponent(callbackURI)
        guard let ssoRedirectURL = URL(
            string: "\(homeserverOrigin)/_matrix/client/v3/login/sso/redirect?redirectUrl=\(encodedRedirect)"
        ) else {
            throw .invalidInput
        }
        return MatrixSsoRedirectRequest(
            homeserverOrigin: homeserverOrigin,
            ssoRedirectURL: ssoRedirectURL,
            callbackURI: callbackURI,
            state: state
        )
    }

    /// Strips `loginToken` and `state` from `rawCallbackURI` immediately, verifies `state == expectedState`
    /// in constant time, and returns the single-use `MatrixSsoTokenGrant`.
    public static func consumeSsoCallbackURI(
        _ rawCallbackURI: String,
        expectedState: String
    ) throws(MatrixClientFailure) -> MatrixSsoTokenGrant {
        guard isValidSsoState(expectedState),
              rawCallbackURI.utf8.count <= 4096,
              var components = URLComponents(string: rawCallbackURI),
              components.scheme == ssoCallbackScheme,
              components.path == "/oauth2redirect",
              components.host == nil || components.host?.isEmpty == true else {
            throw .protocolViolation
        }
        let queryItems = components.queryItems ?? []
        let loginToken = queryItems.first(where: { $0.name == "loginToken" })?.value
        let returnedState = queryItems.first(where: { $0.name == "state" })?.value

        // Immediately strip both `loginToken` and `state` before any further validation.
        let remaining = queryItems.filter { $0.name != "loginToken" && $0.name != "state" }
        components.queryItems = remaining.isEmpty ? nil : remaining
        let redactedURI = components.string ?? defaultSsoCallbackURI

        guard let returnedState,
              constantTimeEquals(returnedState, expectedState),
              let loginToken,
              !loginToken.isEmpty,
              loginToken.utf8.count <= 4096,
              loginToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
            throw .forbidden
        }
        return MatrixSsoTokenGrant(loginToken: loginToken, redactedCallbackURI: redactedURI)
    }

    /// Authenticates with Synapse via OIDC SSO (`/_matrix/client/v3/login/sso/redirect` -> single-use `loginToken`
    /// -> `POST /_matrix/client/v3/login` with `m.login.token` and `refresh_token: true`), validating
    /// `@<expectedSubject>:<serverName>` against the OIDC `sub` identity and revoking any issued Matrix token
    /// via `/_matrix/client/v3/logout` immediately if validation or session fencing fails.
    public func authenticateWithSso(
        homeserverOrigin: String,
        serverName: String,
        deviceId: String,
        expectedSubject: String,
        ssoAuthorizer: MatrixSsoAuthorizer,
        callbackBaseURI: String = MatrixRoomClient.defaultSsoCallbackURI
    ) async throws(MatrixClientFailure) -> PersistedMatrixSession {
        try fence.checkActive()
        guard (try? MatrixServerName(serverName)) != nil,
              Kdv1SessionVaultCodec.isValidVaultDeviceId(deviceId),
              Self.isValidExpectedOidcSubject(expectedSubject) else {
            throw .invalidInput
        }
        let redirectRequest = try Self.buildSsoRedirectRequest(
            homeserverOrigin: homeserverOrigin,
            callbackBaseURI: callbackBaseURI,
            loopback: loopback
        )
        let grant = try await ssoAuthorizer(redirectRequest)
        try fence.checkActive()
        guard !grant.loginToken.isEmpty,
              grant.loginToken.utf8.count <= 4096,
              grant.loginToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
            throw .invalidInput
        }

        let loginPayload: [String: Any] = [
            "type": "m.login.token",
            "token": grant.loginToken,
            "refresh_token": true,
            "initial_device_display_name": "Kodera",
            "device_id": deviceId,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: loginPayload),
              let url = URL(string: "\(homeserverOrigin)/_matrix/client/v3/login") else {
            throw .invalidInput
        }

        let httpResult = await MatrixHTTPTransport(
            protocolClass: protocolClass,
            timeout: timeout,
            maxResponseBytes: StrictJSON.byteLimit,
            fence: fence
        ).perform(
            url: url,
            method: "POST",
            bearerToken: nil,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            ],
            body: body
        )

        switch httpResult {
        case .redirected, .tooLarge:
            if fence.isInvalidated { throw .signedOut }
            throw .protocolViolation
        case let .failure(reason):
            if fence.isInvalidated { throw .signedOut }
            throw .transport(reason)
        case let .response(status, responseBody):
            switch status {
            case 200:
                guard let parsed = try? StrictJSON.parse(responseBody, byteLimit: StrictJSON.byteLimit),
                      let root = parsed.object else {
                    if fence.isInvalidated { throw .signedOut }
                    throw .protocolViolation
                }
                let rawAccessToken = root["access_token"]?.string
                func refuseAndLogout(_ failure: MatrixClientFailure) async throws(MatrixClientFailure) -> Never {
                    if let token = rawAccessToken, !token.isEmpty {
                        await logout(homeserverOrigin: homeserverOrigin, matrixAccessToken: token)
                    }
                    throw failure
                }

                if fence.isInvalidated {
                    try await refuseAndLogout(.signedOut)
                }
                guard let userId = root["user_id"]?.string,
                      let accessToken = rawAccessToken,
                      !accessToken.isEmpty,
                      let returnedDeviceId = root["device_id"]?.string else {
                    try await refuseAndLogout(.protocolViolation)
                }
                guard userId.hasPrefix("@"),
                      let colon = userId.firstIndex(of: ":"),
                      colon > userId.index(after: userId.startIndex) else {
                    try await refuseAndLogout(.forbidden)
                }
                let localpart = String(userId[userId.index(after: userId.startIndex)..<colon])
                let hsPart = String(userId[userId.index(after: colon)...])
                guard localpart == expectedSubject, hsPart == serverName else {
                    try await refuseAndLogout(.forbidden)
                }
                guard let refreshToken = root["refresh_token"]?.string, !refreshToken.isEmpty else {
                    try await refuseAndLogout(.protocolViolation)
                }
                do {
                    return try PersistedMatrixSession(
                        homeserverOrigin: homeserverOrigin,
                        serverName: serverName,
                        userId: userId,
                        deviceId: returnedDeviceId,
                        accessToken: accessToken,
                        refreshToken: refreshToken
                    )
                } catch {
                    try await refuseAndLogout(.protocolViolation)
                }
            case 401:
                if fence.isInvalidated { throw .signedOut }
                throw .unauthorized
            case 403:
                if fence.isInvalidated { throw .signedOut }
                throw .forbidden
            case 404:
                if fence.isInvalidated { throw .signedOut }
                throw .notFound
            case 413:
                if fence.isInvalidated { throw .signedOut }
                throw .payloadTooLarge
            case 429:
                if fence.isInvalidated { throw .signedOut }
                throw .rateLimited
            case 500...599:
                if fence.isInvalidated { throw .signedOut }
                throw .serviceUnavailable
            default:
                if fence.isInvalidated { throw .signedOut }
                throw .protocolViolation
            }
        }
    }

    /// Rotates an expired Matrix access token via `/_matrix/client/v3/refresh`.
    public func refreshSession(
        homeserverOrigin: String,
        refreshToken: String
    ) async throws(MatrixClientFailure) -> (accessToken: String, refreshToken: String?) {
        try fence.checkActive()
        do {
            try IssuerAdmission.validateOrigin(homeserverOrigin, loopback: loopback)
        } catch {
            throw .invalidInput
        }
        guard !refreshToken.isEmpty,
              refreshToken.utf8.count <= 4096,
              refreshToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }),
              let body = try? JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken]),
              let url = URL(string: "\(homeserverOrigin)/_matrix/client/v3/refresh") else {
            throw .invalidInput
        }
        let root = try await matrixUnauthenticatedJSONRequest(url: url, method: "POST", jsonBody: body)
        guard let newAccess = root["access_token"]?.string, !newAccess.isEmpty else {
            throw .protocolViolation
        }
        return (newAccess, root["refresh_token"]?.string)
    }

    /// Best-effort Matrix device logout (`/logout`) on explicit sign-out.
    public func logout(homeserverOrigin: String, matrixAccessToken: String) async {
        await Self.logoutStandalone(
            homeserverOrigin: homeserverOrigin,
            matrixAccessToken: matrixAccessToken,
            loopback: loopback,
            protocolClass: protocolClass,
            timeout: min(timeout, 3.0)
        )
    }

    /// Standalone best-effort Matrix `/logout` usable during sign-out even after a channel view closed.
    public static func logoutStandalone(
        homeserverOrigin: String,
        matrixAccessToken: String,
        loopback: LoopbackPolicy,
        protocolClass: URLProtocol.Type? = nil,
        timeout: TimeInterval = 3.0
    ) async {
        guard (try? IssuerAdmission.validateOrigin(homeserverOrigin, loopback: loopback)) != nil,
              !matrixAccessToken.isEmpty,
              matrixAccessToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }),
              let url = URL(string: "\(homeserverOrigin)/_matrix/client/v3/logout") else {
            return
        }
        _ = await MatrixHTTPTransport(
            protocolClass: protocolClass,
            timeout: timeout,
            maxResponseBytes: StrictJSON.byteLimit,
            fence: nil
        ).perform(
            url: url,
            method: "POST",
            bearerToken: matrixAccessToken,
            headers: ["Accept": "application/json", "Content-Type": "application/json", "Cache-Control": "no-store"],
            body: Data("{}".utf8)
        )
    }

    /// Sends `m.room.message` (`m.text`) with an idempotent `UUIDv7` transaction ID, optional `m.in_reply_to`,
    /// and optional validated `io.kodera.attachments` references.
    public func sendTextMessage(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String? = nil,
        attachments: [AttachmentMetadataRef] = []
    ) async throws(MatrixClientFailure) -> String {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        guard (try? MatrixRoomId(roomId)) != nil,
              (try? UuidV7Identifier(parsing: transactionId)) != nil,
              attachments.count <= AttachmentMetadataRef.maxRefsPerMessage else {
            throw .invalidInput
        }
        let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBody.isEmpty || !attachments.isEmpty else {
            throw .invalidInput
        }
        if let replyToEventId {
            guard Self.isValidMatrixEventId(replyToEventId) else { throw .invalidInput }
        }

        let effectiveBody: String
        if attachments.isEmpty {
            effectiveBody = body
        } else if trimmedBody.isEmpty {
            effectiveBody = AttachmentMetadataRef.fallbackBody(for: attachments)
        } else {
            effectiveBody = body + "\n\n" + AttachmentMetadataRef.fallbackBody(for: attachments)
        }

        var payload: [String: Any] = [
            "msgtype": "m.text",
            "body": effectiveBody,
        ]
        if let replyToEventId {
            payload["m.relates_to"] = [
                "m.in_reply_to": ["event_id": replyToEventId]
            ]
        }
        if !attachments.isEmpty {
            payload[AttachmentMetadataRef.matrixFieldName] = attachments.map { ref in
                [
                    "id": ref.id,
                    "filename": ref.filename,
                    "contentType": ref.contentType.rawValue,
                    "sizeBytes": ref.sizeBytes,
                ] as [String: Any]
            }
        }
        return try await putRoomEvent(
            homeserverOrigin: homeserverOrigin,
            matrixAccessToken: matrixAccessToken,
            roomId: roomId,
            eventType: "m.room.message",
            transactionId: transactionId,
            payloadObject: payload
        )
    }

    /// Sends an `m.replace` message edit event.
    public func editMessage(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        newBody: String
    ) async throws(MatrixClientFailure) -> String {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        let trimmed = newBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (try? MatrixRoomId(roomId)) != nil,
              (try? UuidV7Identifier(parsing: transactionId)) != nil,
              Self.isValidMatrixEventId(targetEventId),
              !trimmed.isEmpty else {
            throw .invalidInput
        }
        let payload: [String: Any] = [
            "msgtype": "m.text",
            "body": "* \(newBody)",
            "m.new_content": [
                "msgtype": "m.text",
                "body": newBody,
            ],
            "m.relates_to": [
                "rel_type": "m.replace",
                "event_id": targetEventId,
            ],
        ]
        return try await putRoomEvent(
            homeserverOrigin: homeserverOrigin,
            matrixAccessToken: matrixAccessToken,
            roomId: roomId,
            eventType: "m.room.message",
            transactionId: transactionId,
            payloadObject: payload
        )
    }

    /// Redacts a room message or reaction event.
    public func redactEvent(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        reason: String? = nil
    ) async throws(MatrixClientFailure) -> String {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        guard (try? MatrixRoomId(roomId)) != nil,
              (try? UuidV7Identifier(parsing: transactionId)) != nil,
              Self.isValidMatrixEventId(targetEventId) else {
            throw .invalidInput
        }
        var payloadObject: [String: Any] = [:]
        if let reason, !reason.isEmpty {
            guard reason.count <= 255 else { throw .invalidInput }
            payloadObject["reason"] = reason
        }
        guard let body = try? JSONSerialization.data(withJSONObject: payloadObject),
              body.count <= StrictJSON.byteLimit else {
            throw .payloadTooLarge
        }
        let encodedRoom = Self.percentEncodePathSegment(roomId)
        let encodedTarget = Self.percentEncodePathSegment(targetEventId)
        guard let url = URL(
            string: "\(homeserverOrigin)/_matrix/client/v3/rooms/\(encodedRoom)/redact/\(encodedTarget)/\(transactionId)"
        ) else {
            throw .invalidInput
        }
        let root = try await matrixJSONRequest(
            url: url,
            method: "PUT",
            matrixAccessToken: matrixAccessToken,
            jsonBody: body
        )
        guard let eventId = root["event_id"]?.string, Self.isValidMatrixEventId(eventId) else {
            throw .protocolViolation
        }
        return eventId
    }

    /// Sends a single-grapheme `m.reaction` (`m.annotation`) event.
    public func sendReaction(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        transactionId: String,
        targetEventId: String,
        emojiKey: String
    ) async throws(MatrixClientFailure) -> String {
        try validateHomeserverOriginAndToken(homeserverOrigin: homeserverOrigin, matrixAccessToken: matrixAccessToken)
        guard (try? MatrixRoomId(roomId)) != nil,
              (try? UuidV7Identifier(parsing: transactionId)) != nil,
              Self.isValidMatrixEventId(targetEventId),
              ReactionKeyValidator.isValid(emojiKey) else {
            throw .invalidInput
        }
        let payload: [String: Any] = [
            "m.relates_to": [
                "rel_type": "m.annotation",
                "event_id": targetEventId,
                "key": emojiKey,
            ]
        ]
        return try await putRoomEvent(
            homeserverOrigin: homeserverOrigin,
            matrixAccessToken: matrixAccessToken,
            roomId: roomId,
            eventType: "m.reaction",
            transactionId: transactionId,
            payloadObject: payload
        )
    }

    /// Executes the 3-step Core-scoped attachment upload (`POST .../uploads` -> credential-free `PUT` -> `POST .../complete`).
    public func uploadChannelAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload
    ) async throws(MatrixClientFailure) -> AttachmentMetadataRef {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              TrustPolicy.canonicalNonNilUUID(channelId) else {
            throw .invalidInput
        }
        let sha256Hex = Self.sha256LowercaseHex(payload.data)
        guard let createIdempotency = (try? UuidV7Identifier.mint())?.description,
              let completeIdempotency = (try? UuidV7Identifier.mint())?.description else {
            throw .invalidInput
        }
        let createBodyObject: [String: Any] = [
            "filename": payload.filename,
            "contentType": payload.contentType.rawValue,
            "sizeBytes": payload.data.count,
            "sha256": sha256Hex,
            "channelId": channelId,
        ]
        guard let createBody = try? JSONSerialization.data(withJSONObject: createBodyObject) else {
            throw .invalidInput
        }

        try fence.checkActive()
        let createReply = await coreRequester.post(
            path: "/api/v1/organisations/\(organisationId)/workspace/attachments/uploads",
            jsonBody: createBody,
            idempotencyKey: createIdempotency
        )
        let ticketBody = try unwrapCoreReply(createReply, expectedStatuses: [201])
        let ticket = try Self.decodeUploadTicket(ticketBody, loopback: loopback)

        try fence.checkActive()
        let putResponse = await MatrixHTTPTransport(
            protocolClass: protocolClass,
            timeout: timeout,
            maxResponseBytes: StrictJSON.byteLimit,
            fence: fence
        ).perform(
            url: ticket.uploadURL,
            method: "PUT",
            bearerToken: nil,
            headers: ticket.headers,
            body: payload.data
        )
        try fence.checkActive()
        switch putResponse {
        case .redirected, .tooLarge:
            throw .protocolViolation
        case let .failure(reason):
            throw .transport(reason)
        case let .response(status, _):
            guard [200, 201, 204].contains(status) else {
                if status == 413 { throw .payloadTooLarge }
                if status == 429 { throw .rateLimited }
                if (500...599).contains(status) { throw .serviceUnavailable }
                throw .protocolViolation
            }
        }

        let completeReply = await coreRequester.post(
            path: "/api/v1/organisations/\(organisationId)/workspace/attachments/\(ticket.attachmentId)/complete",
            jsonBody: Data("{}".utf8),
            idempotencyKey: completeIdempotency
        )
        let completeBody = try unwrapCoreReply(completeReply, expectedStatuses: [200])
        return try Self.decodeCompletedAttachment(
            completeBody,
            expectedAttachmentId: ticket.attachmentId,
            expectedSha256: sha256Hex,
            expectedSizeBytes: payload.data.count
        )
    }

    // MARK: - Internal Helpers

    private func putRoomEvent(
        homeserverOrigin: String,
        matrixAccessToken: String,
        roomId: String,
        eventType: String,
        transactionId: String,
        payloadObject: [String: Any]
    ) async throws(MatrixClientFailure) -> String {
        guard let body = try? JSONSerialization.data(withJSONObject: payloadObject),
              body.count <= StrictJSON.byteLimit else {
            throw .payloadTooLarge
        }
        let encodedRoom = Self.percentEncodePathSegment(roomId)
        let encodedType = Self.percentEncodePathSegment(eventType)
        guard let url = URL(
            string: "\(homeserverOrigin)/_matrix/client/v3/rooms/\(encodedRoom)/send/\(encodedType)/\(transactionId)"
        ) else {
            throw .invalidInput
        }
        let root = try await matrixJSONRequest(
            url: url,
            method: "PUT",
            matrixAccessToken: matrixAccessToken,
            jsonBody: body
        )
        guard let eventId = root["event_id"]?.string, Self.isValidMatrixEventId(eventId) else {
            throw .protocolViolation
        }
        return eventId
    }

    private func matrixJSONRequest(
        url: URL,
        method: String,
        matrixAccessToken: String,
        jsonBody: Data?
    ) async throws(MatrixClientFailure) -> [String: StrictJSONValue] {
        try await performJSONRequest(url: url, method: method, bearerToken: matrixAccessToken, jsonBody: jsonBody)
    }

    private func matrixUnauthenticatedJSONRequest(
        url: URL,
        method: String,
        jsonBody: Data?
    ) async throws(MatrixClientFailure) -> [String: StrictJSONValue] {
        try await performJSONRequest(url: url, method: method, bearerToken: nil, jsonBody: jsonBody)
    }

    private func performJSONRequest(
        url: URL,
        method: String,
        bearerToken: String?,
        jsonBody: Data?
    ) async throws(MatrixClientFailure) -> [String: StrictJSONValue] {
        try fence.checkActive()
        var headers = [
            "Accept": "application/json",
            "Cache-Control": "no-store",
        ]
        if jsonBody != nil {
            headers["Content-Type"] = "application/json"
        }
        let result = await MatrixHTTPTransport(
            protocolClass: protocolClass,
            timeout: timeout,
            maxResponseBytes: StrictJSON.byteLimit,
            fence: fence
        ).perform(
            url: url,
            method: method,
            bearerToken: bearerToken,
            headers: headers,
            body: jsonBody
        )
        try fence.checkActive()
        switch result {
        case .redirected, .tooLarge:
            throw .protocolViolation
        case let .failure(reason):
            throw .transport(reason)
        case let .response(status, body):
            switch status {
            case 200:
                guard let parsed = try? StrictJSON.parse(body, byteLimit: StrictJSON.byteLimit),
                      let object = parsed.object else {
                    throw .protocolViolation
                }
                return object
            case 401:
                throw .unauthorized
            case 403:
                throw .forbidden
            case 404:
                throw .notFound
            case 413:
                throw .payloadTooLarge
            case 429:
                throw .rateLimited
            case 500...599:
                throw .serviceUnavailable
            default:
                throw .protocolViolation
            }
        }
    }

    private func validateHomeserverOriginAndToken(
        homeserverOrigin: String,
        matrixAccessToken: String
    ) throws(MatrixClientFailure) {
        do {
            try IssuerAdmission.validateOrigin(homeserverOrigin, loopback: loopback)
        } catch {
            throw .invalidInput
        }
        guard !matrixAccessToken.isEmpty,
              matrixAccessToken.utf8.count <= 4096,
              matrixAccessToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else {
            throw .invalidInput
        }
    }

    private func unwrapCoreReply(
        _ reply: CoreReply,
        expectedStatuses: Set<Int>
    ) throws(MatrixClientFailure) -> Data {
        switch reply {
        case let .answered(status, body):
            if expectedStatuses.contains(status) { return body }
            switch status {
            case 404: throw .notFound
            case 413: throw .payloadTooLarge
            case 429: throw .rateLimited
            case 500...599: throw .serviceUnavailable
            default: throw .protocolViolation
            }
        case .forbidden: throw .forbidden
        case .signedOut: throw .signedOut
        case .signedOutNotWiped: throw .signedOutNotWiped
        case .identityUnavailable: throw .identityUnavailable
        case .tooLarge: throw .payloadTooLarge
        case .pathRefused, .redirected: throw .protocolViolation
        case let .transport(reason): throw .transport(reason)
        }
    }

    private struct UploadTicket {
        let attachmentId: String
        let uploadURL: URL
        let headers: [String: String]
    }

    private static func decodeUploadTicket(
        _ data: Data,
        loopback: LoopbackPolicy
    ) throws(MatrixClientFailure) -> UploadTicket {
        guard let parsed = try? StrictJSON.parse(data, byteLimit: StrictJSON.byteLimit),
              let root = parsed.object,
              let attachmentId = root["attachmentId"]?.string,
              TrustPolicy.canonicalNonNilUUID(attachmentId),
              let rawURL = root["uploadUrl"]?.string,
              rawURL.utf8.count <= 2048,
              root["method"]?.string == "PUT",
              let rawHeaders = root["headers"]?.object,
              root["expiresAt"]?.string != nil,
              let url = URL(string: rawURL),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.fragment == nil,
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            throw .protocolViolation
        }
        let scheme = components.scheme?.lowercased()
        let isLoopbackHost = (host == "localhost" || host == "127.0.0.1" || host == "::1")
        if scheme == "https" {
            // Permitted
        } else if scheme == "http" && loopback == .admitForDevelopment && isLoopbackHost {
            // Permitted only under explicit loopback policy
        } else {
            throw .protocolViolation
        }

        var validatedHeaders: [String: String] = [:]
        guard rawHeaders.count <= 16 else { throw .protocolViolation }
        for (name, val) in rawHeaders {
            let lower = name.lowercased()
            guard !name.isEmpty,
                  name.utf8.count <= 128,
                  !forbiddenPresignedHeaders.contains(lower),
                  !lower.hasPrefix("proxy-"),
                  !lower.hasPrefix("sec-"),
                  name.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E && $0 != UInt8(ascii: ":") }),
                  let text = val.string,
                  text.utf8.count <= 1024,
                  !text.utf8.contains(0x0D),
                  !text.utf8.contains(0x0A) else {
                throw .protocolViolation
            }
            validatedHeaders[name] = text
        }
        return UploadTicket(attachmentId: attachmentId, uploadURL: url, headers: validatedHeaders)
    }

    private static func decodeCompletedAttachment(
        _ data: Data,
        expectedAttachmentId: String,
        expectedSha256: String,
        expectedSizeBytes: Int
    ) throws(MatrixClientFailure) -> AttachmentMetadataRef {
        guard let parsed = try? StrictJSON.parse(data, byteLimit: StrictJSON.byteLimit),
              let root = parsed.object,
              let id = root["id"]?.string,
              id == expectedAttachmentId,
              let filename = root["filename"]?.string,
              let rawMime = root["contentType"]?.string,
              let mime = AttachmentMimeType(rawValue: rawMime),
              let sizeInt64 = root["sizeBytes"]?.integer,
              Int(sizeInt64) == expectedSizeBytes,
              let sha256 = root["sha256"]?.string,
              sha256 == expectedSha256,
              let ref = try? AttachmentMetadataRef(
                  id: id,
                  filename: filename,
                  contentType: mime,
                  sizeBytes: expectedSizeBytes
              ) else {
            throw .protocolViolation
        }
        return ref
    }

    static func decodeTimelineEvent(_ value: StrictJSONValue) -> MatrixRawTimelineEvent? {
        guard let obj = value.object,
              let type = obj["type"]?.string,
              let eventId = obj["event_id"]?.string,
              isValidMatrixEventId(eventId),
              let sender = obj["sender"]?.string,
              (try? MatrixUserId(sender)) != nil,
              let originServerTs = obj["origin_server_ts"]?.integer else {
            return nil
        }
        let content = obj["content"]?.object
        let unsignedObj = obj["unsigned"]?.object
        let isRedactedUnsigned = (unsignedObj?["redacted_because"]?.object != nil)
        let transactionId = unsignedObj?["transaction_id"]?.string

        let msgtype = content?["msgtype"]?.string
        let body = content?["body"]?.string
        let newContentBody = content?["m.new_content"]?.object?["body"]?.string

        let relates = content?["m.relates_to"]?.object
        let relationType = relates?["rel_type"]?.string
        let relatesToEventId = relates?["event_id"]?.string
        let reactionKey = relates?["key"]?.string
        let replyToEventId = relates?["m.in_reply_to"]?.object?["event_id"]?.string
        let redactsEventId = obj["redacts"]?.string ?? content?["redacts"]?.string

        var attachments: [AttachmentMetadataRef] = []
        if let rawRefs = content?[AttachmentMetadataRef.matrixFieldName]?.array {
            for item in rawRefs.prefix(AttachmentMetadataRef.maxRefsPerMessage) {
                guard let refObj = item.object,
                      let id = refObj["id"]?.string,
                      let filename = refObj["filename"]?.string,
                      let rawMime = refObj["contentType"]?.string,
                      let mime = AttachmentMimeType(rawValue: rawMime),
                      let size64 = refObj["sizeBytes"]?.integer,
                      let size = Int(exactly: size64),
                      let validated = try? AttachmentMetadataRef(
                          id: id,
                          filename: filename,
                          contentType: mime,
                          sizeBytes: size
                      ) else {
                    continue
                }
                attachments.append(validated)
            }
        }

        return MatrixRawTimelineEvent(
            type: type,
            eventId: eventId,
            sender: sender,
            originServerTs: originServerTs,
            msgtype: msgtype,
            body: body,
            newContentBody: newContentBody,
            relationType: relationType,
            relatesToEventId: relatesToEventId,
            reactionKey: reactionKey,
            replyToEventId: replyToEventId,
            redactsEventId: redactsEventId,
            transactionId: transactionId,
            isRedactedUnsigned: isRedactedUnsigned,
            attachments: attachments
        )
    }

    static func isValidMatrixEventId(_ value: String) -> Bool {
        value.hasPrefix("$")
            && (2...255).contains(value.utf8.count)
            && value.utf8.allSatisfy { $0 >= 0x21 && $0 <= 0x7E }
    }

    static func isValidDNSLabel(_ slug: String) -> Bool {
        let bytes = Array(slug.lowercased().utf8)
        guard (1...63).contains(bytes.count),
              bytes.first != UInt8(ascii: "-"),
              bytes.last != UInt8(ascii: "-") else {
            return false
        }
        return bytes.allSatisfy {
            ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "z"))
                || ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9"))
                || $0 == UInt8(ascii: "-")
        }
    }

    static func sha256LowercaseHex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return KoderaMobileFfiBridge.encodeHex(Data(digest))
    }

    private static func isValidSsoState(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (16...128).contains(bytes.count) else { return false }
        return bytes.allSatisfy { b in
            (b >= 0x30 && b <= 0x39)
                || (b >= 0x41 && b <= 0x5A)
                || (b >= 0x61 && b <= 0x7A)
                || b == 0x2D || b == 0x5F
        }
    }

    private static func isValidExpectedOidcSubject(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...255).contains(bytes.count) else { return false }
        return bytes.allSatisfy { $0 >= 0x21 && $0 <= 0x7E && $0 != UInt8(ascii: ":") }
    }

    private static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        let maxLen = max(a.count, b.count)
        var diff = a.count ^ b.count
        for i in 0..<maxLen {
            let x = i < a.count ? Int(a[i]) : 0
            let y = i < b.count ? Int(b[i]) : 0
            diff |= (x ^ y)
        }
        return diff == 0
    }

    private static func percentEncodePathSegment(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func percentEncodeQueryComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

/// Live `ChannelConversationTransport` backed by `MatrixRoomClient`, supporting both pre-authenticated
/// tokens and production Synapse OIDC SSO (`m.login.token`) sessions sealed in `KeychainSessionVault`.
public actor MatrixChannelConversationTransport: ChannelConversationTransport {
    private final class UserIdBox: @unchecked Sendable {
        private let lock = NSLock()
        private var current: String
        init(_ initial: String) { self.current = initial }
        var value: String {
            get { lock.withLock { current } }
            set { lock.withLock { current = newValue } }
        }
    }

    private enum AuthStrategy: Sendable {
        case staticToken(accessToken: String)
        case ssoVault(
            organisationId: String,
            vaultDeviceId: String,
            expectedSubjectProvider: @Sendable () async throws(MatrixClientFailure) -> String,
            ssoAuthorizer: MatrixSsoAuthorizer,
            loadVault: @Sendable (String, String) -> Data?,
            saveVault: @Sendable (String, String, Data) throws(MatrixClientFailure) -> Bool,
            onSessionEstablished: (@Sendable (PersistedMatrixSession) -> Void)?
        )
    }

    private let userIdBox: UserIdBox
    public nonisolated var ownUserId: String { userIdBox.value }
    private let roomClient: MatrixRoomClient
    private let organisationSlug: String
    private let matrixDomain: String
    private let matrixServerName: String
    private let authStrategy: AuthStrategy
    private var cachedHomeserverOrigin: String?
    private var cachedSession: PersistedMatrixSession?

    public init(
        ownUserId: String,
        roomClient: MatrixRoomClient,
        organisationSlug: String,
        matrixDomain: String,
        matrixServerName: String,
        matrixAccessToken: String
    ) {
        self.userIdBox = UserIdBox(ownUserId)
        self.roomClient = roomClient
        self.organisationSlug = organisationSlug
        self.matrixDomain = matrixDomain
        self.matrixServerName = matrixServerName
        self.authStrategy = .staticToken(accessToken: matrixAccessToken)
    }

    public init(
        roomClient: MatrixRoomClient,
        organisationId: String,
        organisationSlug: String,
        matrixDomain: String,
        vaultDeviceId: String,
        initialExpectedSubject: String? = nil,
        expectedSubjectProvider: @escaping @Sendable () async throws(MatrixClientFailure) -> String,
        ssoAuthorizer: @escaping MatrixSsoAuthorizer,
        loadVault: @escaping @Sendable (String, String) -> Data?,
        saveVault: @escaping @Sendable (String, String, Data) throws(MatrixClientFailure) -> Bool,
        onSessionEstablished: (@Sendable (PersistedMatrixSession) -> Void)? = nil
    ) {
        let serverName = "\(organisationSlug.lowercased()).\(matrixDomain.lowercased())"
        let initialUser = "@\(initialExpectedSubject ?? "member"):\(serverName)"
        self.userIdBox = UserIdBox(initialUser)
        self.roomClient = roomClient
        self.organisationSlug = organisationSlug.lowercased()
        self.matrixDomain = matrixDomain.lowercased()
        self.matrixServerName = serverName
        self.authStrategy = .ssoVault(
            organisationId: organisationId,
            vaultDeviceId: vaultDeviceId,
            expectedSubjectProvider: expectedSubjectProvider,
            ssoAuthorizer: ssoAuthorizer,
            loadVault: loadVault,
            saveVault: saveVault,
            onSessionEstablished: onSessionEstablished
        )
    }

    public func logoutIfAuthenticated() async {
        guard let session = cachedSession else { return }
        cachedSession = nil
        await roomClient.logout(homeserverOrigin: session.homeserverOrigin, matrixAccessToken: session.accessToken)
    }

    private func resolveAuthenticatedContext() async throws(MatrixClientFailure) -> (origin: String, token: String) {
        switch authStrategy {
        case let .staticToken(accessToken):
            if let cachedHomeserverOrigin { return (cachedHomeserverOrigin, accessToken) }
            let discovered = try await roomClient.discoverHomeserverOrigin(
                organisationSlug: organisationSlug,
                matrixDomain: matrixDomain
            )
            cachedHomeserverOrigin = discovered
            return (discovered, accessToken)

        case let .ssoVault(
            organisationId,
            vaultDeviceId,
            expectedSubjectProvider,
            ssoAuthorizer,
            loadVault,
            saveVault,
            onSessionEstablished
        ):
            if let cachedSession {
                return (cachedSession.homeserverOrigin, cachedSession.accessToken)
            }
            let expectedSubject = try await expectedSubjectProvider()
            if let rawVault = loadVault(organisationId, vaultDeviceId),
               let restored = try? PersistedMatrixSession.decodeVaultData(rawVault),
               restored.serverName == matrixServerName,
               restored.userId == "@\(expectedSubject):\(matrixServerName)" {
                cachedSession = restored
                cachedHomeserverOrigin = restored.homeserverOrigin
                userIdBox.value = restored.userId
                onSessionEstablished?(restored)
                return (restored.homeserverOrigin, restored.accessToken)
            }
            let discovered = try await roomClient.discoverHomeserverOrigin(
                organisationSlug: organisationSlug,
                matrixDomain: matrixDomain
            )
            let authenticated = try await roomClient.authenticateWithSso(
                homeserverOrigin: discovered,
                serverName: matrixServerName,
                deviceId: vaultDeviceId,
                expectedSubject: expectedSubject,
                ssoAuthorizer: ssoAuthorizer
            )
            let encoded = try authenticated.encodeVaultData()
            let saved = try saveVault(organisationId, vaultDeviceId, encoded)
            guard saved else {
                await roomClient.logout(
                    homeserverOrigin: authenticated.homeserverOrigin,
                    matrixAccessToken: authenticated.accessToken
                )
                throw .signedOut
            }
            cachedSession = authenticated
            cachedHomeserverOrigin = authenticated.homeserverOrigin
            userIdBox.value = authenticated.userId
            onSessionEstablished?(authenticated)
            return (authenticated.homeserverOrigin, authenticated.accessToken)
        }
    }

    private func withAuthenticatedRetry<T: Sendable>(
        _ operation: (String, String) async throws -> T
    ) async throws(MatrixClientFailure) -> T {
        let (origin, token) = try await resolveAuthenticatedContext()
        do {
            return try await operation(origin, token)
        } catch let failure as MatrixClientFailure {
            guard failure == .unauthorized,
                  case let .ssoVault(
                      organisationId,
                      vaultDeviceId,
                      expectedSubjectProvider,
                      ssoAuthorizer,
                      _,
                      saveVault,
                      onSessionEstablished
                  ) = authStrategy,
                  let current = cachedSession else {
                throw failure
            }
            let expectedSubject = try await expectedSubjectProvider()
            let recovered: PersistedMatrixSession
            if let refreshToken = current.refreshToken {
                do {
                    let refreshed = try await roomClient.refreshSession(
                        homeserverOrigin: current.homeserverOrigin,
                        refreshToken: refreshToken
                    )
                    recovered = try PersistedMatrixSession(
                        homeserverOrigin: current.homeserverOrigin,
                        serverName: current.serverName,
                        userId: current.userId,
                        deviceId: current.deviceId,
                        accessToken: refreshed.accessToken,
                        refreshToken: refreshed.refreshToken ?? refreshToken
                    )
                } catch let refreshFailure where refreshFailure == .unauthorized || refreshFailure == .forbidden {
                    recovered = try await roomClient.authenticateWithSso(
                        homeserverOrigin: current.homeserverOrigin,
                        serverName: matrixServerName,
                        deviceId: vaultDeviceId,
                        expectedSubject: expectedSubject,
                        ssoAuthorizer: ssoAuthorizer
                    )
                }
            } else {
                recovered = try await roomClient.authenticateWithSso(
                    homeserverOrigin: current.homeserverOrigin,
                    serverName: matrixServerName,
                    deviceId: vaultDeviceId,
                    expectedSubject: expectedSubject,
                    ssoAuthorizer: ssoAuthorizer
                )
            }
            let encoded = try recovered.encodeVaultData()
            let saved = try saveVault(organisationId, vaultDeviceId, encoded)
            guard saved else {
                await roomClient.logout(
                    homeserverOrigin: recovered.homeserverOrigin,
                    matrixAccessToken: recovered.accessToken
                )
                throw .signedOut
            }
            cachedSession = recovered
            userIdBox.value = recovered.userId
            onSessionEstablished?(recovered)
            do {
                return try await operation(recovered.homeserverOrigin, recovered.accessToken)
            } catch let retryFailure as MatrixClientFailure {
                throw retryFailure
            } catch {
                throw .protocolViolation
            }
        } catch {
            throw .protocolViolation
        }
    }

    public func bootstrapRoom(
        organisationId: String,
        channelId: String
    ) async throws(MatrixClientFailure) -> (roomId: String, initialBatch: MatrixSyncBatch) {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw .invalidInput }
        return try await withAuthenticatedRetry { origin, token in
            let roomId = try await roomClient.resolveChannelRoomId(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                channelId: channelId,
                serverName: matrixServerName
            )
            let batch = try await roomClient.sync(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                since: nil
            )
            return (roomId.rawValue, batch)
        }
    }

    public func syncRoom(roomId: String, since: String?) async throws(MatrixClientFailure) -> MatrixSyncBatch {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.sync(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                since: since
            )
        }
    }

    public func backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int
    ) async throws(MatrixClientFailure) -> [MatrixRawTimelineEvent] {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.fetchRoomMessages(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                roomId: roomId,
                fromToken: fromToken,
                limit: limit
            )
        }
    }

    public func sendMessage(
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String?,
        attachments: [AttachmentMetadataRef]
    ) async throws(MatrixClientFailure) -> String {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.sendTextMessage(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                roomId: roomId,
                transactionId: transactionId,
                body: body,
                replyToEventId: replyToEventId,
                attachments: attachments
            )
        }
    }

    public func editMessage(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        newBody: String
    ) async throws(MatrixClientFailure) -> String {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.editMessage(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                roomId: roomId,
                transactionId: transactionId,
                targetEventId: targetEventId,
                newBody: newBody
            )
        }
    }

    public func redactEvent(
        roomId: String,
        transactionId: String,
        targetEventId: String
    ) async throws(MatrixClientFailure) -> String {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.redactEvent(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                roomId: roomId,
                transactionId: transactionId,
                targetEventId: targetEventId
            )
        }
    }

    public func sendReaction(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        emojiKey: String
    ) async throws(MatrixClientFailure) -> String {
        try await withAuthenticatedRetry { origin, token in
            try await roomClient.sendReaction(
                homeserverOrigin: origin,
                matrixAccessToken: token,
                roomId: roomId,
                transactionId: transactionId,
                targetEventId: targetEventId,
                emojiKey: emojiKey
            )
        }
    }

    public func uploadAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload
    ) async throws(MatrixClientFailure) -> AttachmentMetadataRef {
        try await roomClient.uploadChannelAttachment(
            organisationId: organisationId,
            channelId: channelId,
            payload: payload
        )
    }
}

/// Ephemeral, redirect-refusing, byte-bounded HTTP transport for Matrix and presigned object PUT requests.
private final class MatrixHTTPTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Result: Sendable {
        case response(status: Int, body: Data)
        case redirected
        case tooLarge
        case failure(TransportFailure)
    }

    private struct Finish {
        let continuation: CheckedContinuation<Result, Never>
        let result: Result
        let task: URLSessionDataTask?
        let session: URLSession?
    }

    private let protocolClass: URLProtocol.Type?
    private let timeout: TimeInterval
    private let maxResponseBytes: Int
    private let fence: SessionFence?
    private let lock = NSLock()
    private var body = Data()
    private var status: Int?
    private var expectedURL: URL?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var continuation: CheckedContinuation<Result, Never>?
    private var selected = false
    private var cancelled = false

    init(protocolClass: URLProtocol.Type?, timeout: TimeInterval, maxResponseBytes: Int, fence: SessionFence?) {
        self.protocolClass = protocolClass
        self.timeout = timeout
        self.maxResponseBytes = maxResponseBytes
        self.fence = fence
    }

    func cancelImmediately() {
        let done = lock.withLock {
            cancelled = true
            return selectLocked(.failure(.other))
        }
        finish(done)
    }

    func perform(
        url: URL,
        method: String,
        bearerToken: String?,
        headers: [String: String],
        body requestBody: Data?
    ) async -> Result {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let bearerToken {
            request.setValue("Bearer " + bearerToken, forHTTPHeaderField: "Authorization")
        }
        if let requestBody {
            request.httpBody = requestBody
        }

        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        if let protocolClass { config.protocolClasses = [protocolClass] }
        let urlSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)

        let fenceToken = fence?.registerCancellation { [weak self] in
            self?.cancelImmediately()
        }
        defer { fence?.unregisterCancellation(fenceToken) }

        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let dataTask = urlSession.dataTask(with: request)
                let immediate = lock.withLock { () -> Finish? in
                    self.session = urlSession
                    self.task = dataTask
                    self.continuation = continuation
                    self.expectedURL = request.url
                    return cancelled ? selectLocked(.failure(.other)) : nil
                }
                if let immediate { finish(immediate) } else { dataTask.resume() }
            }
        } onCancel: {
            self.cancelImmediately()
        }
    }

    private func selectLocked(_ result: Result) -> Finish? {
        guard !selected, let continuation else { return nil }
        selected = true
        let out = Finish(continuation: continuation, result: result, task: task, session: session)
        self.continuation = nil
        self.task = nil
        self.session = nil
        self.expectedURL = nil
        self.status = nil
        self.body = Data()
        return out
    }

    private func finish(_ item: Finish?) {
        guard let item else { return }
        item.task?.cancel()
        item.session?.invalidateAndCancel()
        item.continuation.resume(returning: item.result)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        let decision: (Finish?, Bool) = lock.withLock {
            guard !selected else { return (nil, false) }
            guard let http = response as? HTTPURLResponse,
                  http.url?.absoluteString == expectedURL?.absoluteString else {
                return (selectLocked(.redirected), false)
            }
            guard http.expectedContentLength <= Int64(maxResponseBytes) else {
                return (selectLocked(.tooLarge), false)
            }
            status = http.statusCode
            return (nil, true)
        }
        completionHandler(decision.1 ? .allow : .cancel)
        finish(decision.0)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let overflow = lock.withLock { () -> Finish? in
            guard !selected else { return nil }
            guard data.count <= maxResponseBytes - body.count else {
                return selectLocked(.tooLarge)
            }
            body.append(data)
            return nil
        }
        finish(overflow)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let done = lock.withLock { () -> Finish? in
            if let error { return selectLocked(.failure(Self.mapError(error))) }
            guard let status else { return selectLocked(.redirected) }
            return selectLocked(.response(status: status, body: body))
        }
        finish(done)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        let done = lock.withLock { selectLocked(.redirected) }
        completionHandler(nil)
        finish(done)
    }

    private static func mapError(_ error: Error) -> TransportFailure {
        switch (error as? URLError)?.code {
        case .timedOut: .timeout
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            .offline
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed:
            .tls
        default: .other
        }
    }
}
