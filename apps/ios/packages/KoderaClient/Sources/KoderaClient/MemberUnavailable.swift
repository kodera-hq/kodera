/// What the signed-in screen shows when Core's `/me` kept the session but named no member.
public enum MemberUnavailable: Equatable, Sendable {
    /// 403. Core gives the same generic `forbidden` to an owner whose claim is not finished yet and to anyone
    /// without an active membership, so the app cannot tell them apart and does not guess: one state, which
    /// offers the Console, Check again and sign-out. Finishing a claim in the Console changes Core's answer, so
    /// `/me` is fetched again when the app returns to the foreground and on Check again
    /// (`MemberLoader.checkAgain`), never on its own.
    case noOrganisationYet
    /// Core gave no usable answer now. The session is kept, and a retry is offered.
    case coreUnavailable

    public init(_ failure: MeFailure) {
        switch failure {
        case .forbidden: self = .noOrganisationYet
        case .protocolViolation, .serviceUnavailable, .identityUnavailable, .transport: self = .coreUnavailable
        }
    }
}
