import Foundation

/// Where a sender handle comes from.
public enum ProximityHandleOrigin: String, CaseIterable, Sendable {
    /// Picked by the member as their proximity pseudonym.
    case dedicated
    /// Derived for the sender inside one organisation when the member picked none.
    case generated
}

/// The pseudonym shown for the sender of a `#proximity` check-in.
///
/// A proximity frame carries its sender's device public key and nothing else about the person. A
/// handle is display metadata held beside the frame, never inside it: the frozen v1 wire format is
/// untouched, a real name is never required and none travels in a frame.
///
/// A handle is a display label. It is never an identity and never an authorisation input: identity
/// stays the Ed25519 signing key, and the roster and the signature decide what is admitted. Nothing
/// may be granted, refused, deduplicated or looked up by handle. A generated handle keeps 55 bits
/// of a digest keyed with the organisation's beacon salt, so the same key shows another handle in
/// another organisation; two senders can still show the same handle, and a roster view must go
/// through `labels(provisioned:observed:organisationSalt:)`, which adds a fingerprint of each signing
/// key and judges equality over the whole provisioned roster, absent members included. The fingerprint
/// is keyed with the organisation's beacon salt too, so it links nothing across organisations.
///
/// The grammar, the word lists and the vectors are shared with `kodera-rs` and the Android client
/// through `packages/kodera-rs/vectors/proximity-handle-v1.txt`, which the tests read.
public struct ProximityHandle: Hashable, Sendable {
    public static let minimumCharacters = 3
    public static let maximumCharacters = 24
    /// Characters after the two words of a generated handle: 45 bits, five per character.
    public static let generatedSuffixCharacters = 9
    /// Digest bits a generated handle keeps: five per word and 45 in the suffix.
    public static let generatedDigestBits = 55
    /// Shortest fingerprint prefix shown beside a handle that is not unique in its roster.
    public static let minimumFingerprintHexCharacters = 8

    public let value: String
    public let origin: ProximityHandleOrigin

    private init(unchecked value: String, origin: ProximityHandleOrigin) {
        self.value = value
        self.origin = origin
    }

    /// Exactly `^[a-z0-9]+(?:-[a-z0-9]+)*$` with 3 to 24 characters. Nothing is trimmed, folded or
    /// normalised: a display name, an email address or any non-ASCII text is refused, not repaired.
    public static func isValid(_ raw: String) -> Bool {
        let bytes = Array(raw.utf8)
        guard (minimumCharacters...maximumCharacters).contains(bytes.count) else { return false }
        var previousWasHyphen = true // a leading hyphen is refused like a doubled one
        for byte in bytes {
            let isHyphen = byte == 0x2d
            let isWord = (0x61...0x7a).contains(byte) || (0x30...0x39).contains(byte)
            guard isWord || isHyphen, !(isHyphen && previousWasHyphen) else { return false }
            previousWasHyphen = isHyphen
        }
        return !previousWasHyphen
    }

    /// A pseudonym the member picked. Refused, never repaired, when it is outside the grammar.
    public init(dedicated raw: String) throws {
        guard Self.isValid(raw) else { throw ProximityError.invalidHandle }
        self.init(unchecked: raw, origin: .dedicated)
    }

    /// The handle every device of one organisation derives for a 32-byte sender key.
    /// `organisationSalt` is the 32-byte salt `ProximityBeacon.compute` takes: the same key gives
    /// the same handle on every platform inside that organisation, and another one outside it.
    public static func generated(organisationSalt: Data, senderPublicKey: Data) throws -> Self {
        guard organisationSalt.count == 32, senderPublicKey.count == 32 else { throw ProximityError.invalidHandle }
        return Self(unchecked: derive(binding: organisationSalt, senderPublicKey: senderPublicKey), origin: .generated)
    }

    /// `<adjective>-<noun>-<9 characters>` from `HMAC-SHA256(binding, label || sender key)`.
    /// `binding` is the organisation's beacon salt; the tests pass another one to show what the
    /// binding buys.
    static func derive(binding: Data, senderPublicKey: Data) -> String {
        let digest = Array(ProximitySHA256.hmac(key: binding, data: Data(generatedLabel.utf8) + senderPublicKey))
        // The top 45 bits of digest[2..<8], most significant character first.
        var bits = digest[2..<8].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } >> 3
        var suffix = [Character](repeating: "0", count: generatedSuffixCharacters)
        for index in suffix.indices.reversed() {
            suffix[index] = suffixAlphabet[Int(bits & 31)]
            bits >>= 5
        }
        return "\(adjectives[Int(digest[0] & 31)])-\(nouns[Int(digest[1] & 31)])-\(String(suffix))"
    }

    /// The dedicated handle when the member picked one, the generated one otherwise. An invalid
    /// dedicated handle throws: it is not silently replaced, and it is never shown.
    public static func resolve(dedicated: String?, organisationSalt: Data, senderPublicKey: Data) throws -> Self {
        if let dedicated { return try Self(dedicated: dedicated) }
        return try generated(organisationSalt: organisationSalt, senderPublicKey: senderPublicKey)
    }

    /// Rebuilds a handle received with its origin. A `generated` one must be the one this
    /// organisation derives for this key.
    public init(_ raw: String, origin: ProximityHandleOrigin, organisationSalt: Data, senderPublicKey: Data) throws {
        switch origin {
        case .dedicated: try self.init(dedicated: raw)
        case .generated:
            let expected = try Self.generated(organisationSalt: organisationSalt, senderPublicKey: senderPublicKey)
            guard expected.value == raw else { throw ProximityError.invalidHandle }
            self = expected
        }
    }

    /// The 64 lowercase hex characters a sender is told apart by, inside one organisation, when
    /// handles are equal: `HMAC-SHA256(organisation beacon salt, "kodera-proximity-fingerprint-v1:"
    /// || sender key)`. A prefix of it is shown.
    ///
    /// It is keyed with the organisation's beacon salt, like the generated handle and for the same
    /// reason: the same key shows another fingerprint in another organisation, so the fingerprint
    /// beside a handle does not link a member across organisations. There is deliberately no
    /// unkeyed fingerprint of a sender key in this package.
    public static func fingerprint(organisationSalt: Data, senderPublicKey: Data) throws -> String {
        guard organisationSalt.count == 32, senderPublicKey.count == 32 else { throw ProximityError.invalidHandle }
        return deriveFingerprint(binding: organisationSalt, senderPublicKey: senderPublicKey)
    }

    /// `binding` is the organisation's beacon salt; the tests pass another one to show what the
    /// binding buys.
    static func deriveFingerprint(binding: Data, senderPublicKey: Data) -> String {
        ProximitySHA256.hmac(key: binding, data: Data(fingerprintLabel.utf8) + senderPublicKey).map { byte in
            String(hexDigits[Int(byte >> 4)]) + String(hexDigits[Int(byte & 0x0f)])
        }.joined()
    }

    /// Labels for every provisioned sender of one roster, in the order given. When two or more
    /// distinct keys resolve to the same handle, whatever its origin, each carries a fingerprint
    /// prefix: 8 hex characters, lengthened two at a time until the prefixes of that group differ.
    /// A key listed twice is one sender. The result is for display; identity remains the key.
    ///
    /// `provisioned` must be the whole provisioned roster, never only the senders seen so far: a
    /// group computed over observed senders alone would show a bare handle to a sender whose
    /// handle equals an absent member's. To label the senders that have checked in, use
    /// `labels(provisioned:observed:organisationSalt:)`.
    ///
    /// `organisationSalt` keys the fingerprints: they belong to this organisation and say nothing
    /// about the same key elsewhere.
    public static func disambiguate(_ provisioned: [(senderPublicKey: Data, handle: ProximityHandle)],
                                    organisationSalt: Data) throws -> [ProximityRosterLabel] {
        var groups: [String: Set<Data>] = [:]
        for entry in provisioned { groups[entry.handle.value, default: []].insert(entry.senderPublicKey) }
        var lengths: [String: Int] = [:]
        for (handle, keys) in groups where keys.count > 1 {
            let fingerprints = try keys.map { try fingerprint(organisationSalt: organisationSalt, senderPublicKey: $0) }
            var length = minimumFingerprintHexCharacters
            while length < 64, Set(fingerprints.map { $0.prefix(length) }).count < fingerprints.count { length += 2 }
            lengths[handle] = length
        }
        return try provisioned.map { entry in
            ProximityRosterLabel(senderPublicKey: entry.senderPublicKey, handle: entry.handle,
                                 fingerprint: try lengths[entry.handle.value].map {
                                     String(try fingerprint(organisationSalt: organisationSalt,
                                                            senderPublicKey: entry.senderPublicKey).prefix($0))
                                 })
        }
    }

    /// Labels for the senders that have checked in, in the order of `observed`, with the collision
    /// groups computed over the whole `provisioned` roster. A sender whose handle equals that of
    /// any provisioned member carries its fingerprint whether or not that member has checked in,
    /// so a label never changes when another member appears. An observed key outside the
    /// provisioned roster throws: nothing is labelled for a sender the roster does not hold.
    public static func labels(provisioned: [(senderPublicKey: Data, handle: ProximityHandle)],
                              observed: [Data], organisationSalt: Data) throws -> [ProximityRosterLabel] {
        var byKey: [Data: ProximityRosterLabel] = [:]
        for label in try disambiguate(provisioned, organisationSalt: organisationSalt) { byKey[label.senderPublicKey] = label }
        return try observed.map { key in
            guard let label = byKey[key] else { throw ProximityError.unauthorizedSender }
            return label
        }
    }

    /// MACed with the sender key under the organisation's beacon salt. It labels a display value
    /// only: it is not part of the frozen frame v1 and signs nothing.
    static let generatedLabel = "kodera-proximity-handle-v1:"
    static let fingerprintLabel = "kodera-proximity-fingerprint-v1:"
    /// Lowercase, digits first, without `i`, `l`, `o` and `u`: five bits per character.
    static let suffixAlphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")
    private static let hexDigits = Array("0123456789abcdef")
    static let adjectives = [
        "amber", "brisk", "calm", "clear", "coral", "crisp", "dusky", "early", "fair", "gentle",
        "golden", "green", "hazel", "ivory", "jade", "keen", "light", "lunar", "mellow", "misty",
        "noble", "olive", "pale", "quiet", "rapid", "royal", "sandy", "silver", "solar", "steady",
        "swift", "vivid",
    ]
    static let nouns = [
        "alder", "aspen", "badger", "birch", "brook", "cedar", "comet", "crane", "delta", "dune",
        "ember", "falcon", "fern", "finch", "glade", "harbor", "heron", "island", "juniper", "lark",
        "lynx", "maple", "meadow", "otter", "pebble", "pine", "quartz", "raven", "reef", "river",
        "sparrow", "willow",
    ]
}

/// What a roster view shows for one sender: the handle, and a fingerprint prefix of the signing
/// key when another sender of the same roster shows the same handle. Display only.
public struct ProximityRosterLabel: Equatable, Sendable {
    public let senderPublicKey: Data
    public let handle: ProximityHandle
    /// Nil when the handle is unique in the roster it was computed for.
    public let fingerprint: String?

    /// `handle`, or `handle [fingerprint]` when the handle alone would be ambiguous. The second
    /// form is a display string, not a handle: it is outside the handle grammar on purpose.
    public var display: String {
        if let fingerprint { return "\(handle.value) [\(fingerprint)]" }
        return handle.value
    }
}
