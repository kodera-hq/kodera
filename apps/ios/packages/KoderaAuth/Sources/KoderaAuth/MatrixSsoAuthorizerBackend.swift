import AuthenticationServices
import Foundation
import KoderaClient
import KoderaDomain
#if canImport(UIKit)
import UIKit
#endif

/// Production Synapse OIDC SSO authorizer inside `KoderaAuth`, driving a non-ephemeral
/// `ASWebAuthenticationSession` (sharing the member's Keycloak browser cookies), immediately stripping
/// `loginToken` and `state` from the callback URL, and verifying `state` in constant time.
@MainActor
public final class MatrixSsoAuthorizerBackend: NSObject {
    #if os(iOS)
    public typealias Presenter = @MainActor () -> UIViewController?
    private let presenter: Presenter
    private var activeSession: ASWebAuthenticationSession?

    public init(presenter: @escaping Presenter) {
        self.presenter = presenter
        super.init()
    }
    #else
    public override init() {
        super.init()
    }
    #endif

    public func makeAuthorizer(fence: SessionFence) -> MatrixSsoAuthorizer {
        { [weak self] request throws(MatrixClientFailure) -> MatrixSsoTokenGrant in
            try fence.checkActive()
            guard let self else { throw .signedOut }
            return try await self.authorize(request: request, fence: fence)
        }
    }

    public func authorize(
        request: MatrixSsoRedirectRequest,
        fence: SessionFence
    ) async throws(MatrixClientFailure) -> MatrixSsoTokenGrant {
        try fence.checkActive()
        #if os(iOS)
        guard activeSession == nil else {
            throw .identityUnavailable
        }
        guard presenter()?.view.window != nil else {
            throw .identityUnavailable
        }

        let watchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(for: AppAuthBackend.browserLimit)
            guard !Task.isCancelled else { return }
            self?.activeSession?.cancel()
        }
        defer { watchdog.cancel() }

        let fenceToken = fence.registerCancellation { [weak self] in
            Task { @MainActor in
                self?.activeSession?.cancel()
            }
        }
        defer { fence.unregisterCancellation(fenceToken) }

        let outcome: Result<MatrixSsoTokenGrant, MatrixClientFailure> = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let session = ASWebAuthenticationSession(
                    url: request.ssoRedirectURL,
                    callbackURLScheme: MatrixRoomClient.ssoCallbackScheme
                ) { callbackURL, error in
                    if let callbackURL {
                        let rawString = callbackURL.absoluteString
                        do throws(MatrixClientFailure) {
                            let grant = try MatrixRoomClient.consumeSsoCallbackURI(
                                rawString,
                                expectedState: request.state
                            )
                            continuation.resume(returning: .success(grant))
                        } catch {
                            continuation.resume(returning: .failure(error))
                        }
                    } else if let nsError = error as NSError?,
                              nsError.domain == ASWebAuthenticationSessionErrorDomain,
                              nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(returning: .failure(.signedOut))
                    } else {
                        continuation.resume(returning: .failure(.identityUnavailable))
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                self.activeSession = session
                if fence.isInvalidated || !session.start() {
                    self.activeSession = nil
                    continuation.resume(returning: .failure(fence.isInvalidated ? .signedOut : .identityUnavailable))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.activeSession?.cancel()
            }
        }
        activeSession = nil
        if fence.isInvalidated {
            throw .signedOut
        }
        return try outcome.get()
        #else
        throw .identityUnavailable
        #endif
    }
}

#if os(iOS)
extension MatrixSsoAuthorizerBackend: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = presenter()?.view.window {
            return window
        }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}
#endif
