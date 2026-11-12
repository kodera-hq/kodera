import Foundation
import XCTest
@testable import KoderaDomain

/// `kodera-rs` and the Android client read the same file: the three agree line for line.
final class ProximityHandleTests: XCTestCase {
    private struct RosterEntry {
        let name: String, salt: Data, sender: Data, dedicated: String?, handle: String, fingerprint: String?
        let present: Bool
    }
    private struct Vectors {
        var bounds: [String: Int] = [:], origins: [String] = [], adjectives: [String] = [], nouns: [String] = []
        var valid: [String] = [], refused: [(name: String, text: String)] = []
        var generated: [(salt: Data, sender: Data, handle: String)] = [], rosters: [RosterEntry] = []
    }

    private func bytes(_ hex: String) throws -> Data {
        XCTAssertEqual(hex.count % 2, 0, hex)
        return Data(try stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            return try XCTUnwrap(UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16), hex)
        })
    }

    /// Strict: a line outside the grammar fails the test rather than being skipped.
    private func vectors() throws -> Vectors {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        let text = try String(contentsOf: url.appendingPathComponent("packages/kodera-rs/vectors/proximity-handle-v1.txt"), encoding: .utf8)
        var parsed = Vectors()
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) where !line.isEmpty && !line.hasPrefix("#") {
            let fields = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
            switch (fields.first, fields.count) {
            case ("bound", 3): parsed.bounds[fields[1]] = try XCTUnwrap(Int(fields[2]), String(line))
            case ("origin", 2): parsed.origins.append(fields[1])
            case ("adjective", 3):
                XCTAssertEqual(Int(fields[1]), parsed.adjectives.count, String(line)); parsed.adjectives.append(fields[2])
            case ("noun", 3):
                XCTAssertEqual(Int(fields[1]), parsed.nouns.count, String(line)); parsed.nouns.append(fields[2])
            case ("valid", 2): parsed.valid.append(fields[1])
            case ("refuse", 3):
                let raw = fields[2] == "-" ? Data() : try bytes(fields[2])
                parsed.refused.append((fields[1], try XCTUnwrap(String(data: raw, encoding: .utf8), String(line))))
            case ("generated", 4): parsed.generated.append((try bytes(fields[1]), try bytes(fields[2]), fields[3]))
            case ("roster", 8):
                XCTAssertTrue(["present", "absent"].contains(fields[7]), String(line))
                parsed.rosters.append(RosterEntry(
                    name: fields[1], salt: try bytes(fields[2]), sender: try bytes(fields[3]),
                    dedicated: fields[4] == "-" ? nil : fields[4], handle: fields[5],
                    fingerprint: fields[6] == "-" ? nil : fields[6], present: fields[7] == "present"))
            default: XCTFail("unknown line in the shared handle vectors: \(line)")
            }
        }
        return parsed
    }

    func testSharedVectorsStateTheBoundsOriginsAndWordsThisPackageUses() throws {
        let shared = try vectors()
        XCTAssertEqual(shared.bounds, ["min_chars": ProximityHandle.minimumCharacters,
                                       "max_chars": ProximityHandle.maximumCharacters,
                                       "generated_suffix_chars": ProximityHandle.generatedSuffixCharacters,
                                       "generated_digest_bits": ProximityHandle.generatedDigestBits,
                                       "min_fingerprint_hex_chars": ProximityHandle.minimumFingerprintHexCharacters])
        XCTAssertEqual(ProximityHandle.generatedDigestBits, 5 + 5 + 5 * ProximityHandle.generatedSuffixCharacters)
        XCTAssertEqual(shared.origins, ProximityHandleOrigin.allCases.map(\.rawValue))
        XCTAssertEqual(shared.origins, ["dedicated", "generated"])
        for slug in ["", "Dedicated", "generated ", "random"] { XCTAssertNil(ProximityHandleOrigin(rawValue: slug), slug) }
        XCTAssertEqual(shared.adjectives, ProximityHandle.adjectives)
        XCTAssertEqual(shared.nouns, ProximityHandle.nouns)
        XCTAssertEqual(ProximityHandle.generatedLabel, "kodera-proximity-handle-v1:")
        XCTAssertEqual(ProximityHandle.fingerprintLabel, "kodera-proximity-fingerprint-v1:")
        XCTAssertEqual(String(ProximityHandle.suffixAlphabet), "0123456789abcdefghjkmnpqrstvwxyz")
    }

    func testEverySharedValidHandleIsAcceptedAndEveryRefusedOneIsRefused() throws {
        let shared = try vectors()
        XCTAssertGreaterThanOrEqual(shared.valid.count, 10)
        XCTAssertGreaterThanOrEqual(shared.refused.count, 25)
        for handle in shared.valid {
            XCTAssertTrue(ProximityHandle.isValid(handle), handle)
            let dedicated = try ProximityHandle(dedicated: handle)
            XCTAssertEqual(dedicated.value, handle)
            XCTAssertEqual(dedicated.origin, .dedicated)
        }
        let salt = Data(repeating: 1, count: 32), sender = Data(repeating: 7, count: 32)
        for (name, text) in shared.refused {
            XCTAssertFalse(ProximityHandle.isValid(text), name)
            XCTAssertThrowsError(try ProximityHandle(dedicated: text), name) {
                XCTAssertEqual($0 as? ProximityError, .invalidHandle, name)
            }
            // An invalid dedicated handle is never replaced silently by a generated one.
            XCTAssertThrowsError(try ProximityHandle.resolve(dedicated: text, organisationSalt: salt, senderPublicKey: sender), name)
        }
    }

    /// Refusal mutation: one character of an accepted handle replaced by one outside the grammar,
    /// at every position, must be refused.
    func testASingleForeignCharacterAtAnyPositionIsRefused() throws {
        for handle in try vectors().valid {
            for position in 0..<handle.count {
                for foreign in ["A", "_", " ", ".", "\u{e9}"] {
                    var characters = handle.map(String.init)
                    characters[position] = foreign
                    XCTAssertFalse(ProximityHandle.isValid(characters.joined()), "\(handle) with \(foreign) at \(position)")
                }
            }
        }
    }

    func testGeneratedHandlesMatchTheSharedVectorsAndAlwaysValidate() throws {
        let shared = try vectors()
        XCTAssertGreaterThanOrEqual(shared.generated.count, 10)
        for (salt, sender, expected) in shared.generated {
            let handle = try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: sender)
            XCTAssertEqual(handle.value, expected)
            XCTAssertEqual(handle.origin, .generated)
            XCTAssertTrue(ProximityHandle.isValid(handle.value))
            XCTAssertEqual(try ProximityHandle.resolve(dedicated: nil, organisationSalt: salt, senderPublicKey: sender), handle)
            XCTAssertEqual(try ProximityHandle(expected, origin: .generated, organisationSalt: salt, senderPublicKey: sender), handle)
        }
        // The longest word pair with the full suffix is exactly the bound, and every pair fits.
        let longest = { (words: [String]) in words.map(\.count).max() ?? 0 }
        XCTAssertEqual(longest(ProximityHandle.adjectives) + 1 + longest(ProximityHandle.nouns) + 1
                       + ProximityHandle.generatedSuffixCharacters, ProximityHandle.maximumCharacters)
        for adjective in ProximityHandle.adjectives {
            for noun in ProximityHandle.nouns { XCTAssertTrue(ProximityHandle.isValid("\(adjective)-\(noun)-zzzzzzzzz")) }
        }
        for seed in UInt8.min...UInt8.max {
            let handle = try ProximityHandle.generated(organisationSalt: Data(repeating: seed, count: 32),
                                                       senderPublicKey: Data(repeating: seed &+ 1, count: 32))
            XCTAssertTrue(ProximityHandle.isValid(handle.value))
            XCTAssertEqual(handle.value.split(separator: "-").last?.count, ProximityHandle.generatedSuffixCharacters)
        }
        let good = Data(repeating: 1, count: 32)
        for count in [0, 31, 33] {
            let bad = Data(repeating: 1, count: count)
            XCTAssertThrowsError(try ProximityHandle.generated(organisationSalt: good, senderPublicKey: bad))
            XCTAssertThrowsError(try ProximityHandle.generated(organisationSalt: bad, senderPublicKey: good))
        }
    }

    /// The organisation binding: one sender key, two organisations, two handles.
    func testTheSameSenderKeyYieldsDifferentHandlesInTwoOrganisations() throws {
        let shared = try vectors()
        var compared = 0
        for (salt, sender, handle) in shared.generated {
            for (otherSalt, otherSender, otherHandle) in shared.generated where sender == otherSender && salt != otherSalt {
                XCTAssertNotEqual(handle, otherHandle)
                XCTAssertNotEqual(try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: sender),
                                  try ProximityHandle.generated(organisationSalt: otherSalt, senderPublicKey: sender))
                // A handle derived in one organisation is not accepted as this sender's in another.
                XCTAssertThrowsError(try ProximityHandle(handle, origin: .generated, organisationSalt: otherSalt, senderPublicKey: sender))
                compared += 1
            }
        }
        XCTAssertGreaterThanOrEqual(compared, 10, "the vectors must hold each sender in two organisations")
    }

    /// Refusal mutation on the binding itself: derive with the organisation removed (one fixed
    /// binding for everyone). No shared vector survives.
    func testADerivationWithoutTheOrganisationBindingMatchesNoSharedVector() throws {
        for (salt, sender, expected) in try vectors().generated {
            XCTAssertNotEqual(ProximityHandle.derive(binding: Data(), senderPublicKey: sender), expected)
            XCTAssertEqual(ProximityHandle.derive(binding: salt, senderPublicKey: sender), expected)
        }
    }

    func testAGeneratedHandleBelongsToItsKeyAndADedicatedOneWins() throws {
        let salt = Data(repeating: 0x42, count: 32)
        let sender = Data(repeating: 9, count: 32), other = Data(repeating: 10, count: 32)
        let generated = try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: sender)
        XCTAssertNotEqual(generated, try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: other))
        XCTAssertThrowsError(try ProximityHandle(generated.value, origin: .generated, organisationSalt: salt, senderPublicKey: other))
        let picked = try ProximityHandle.resolve(dedicated: "north-wing-3", organisationSalt: salt, senderPublicKey: sender)
        XCTAssertEqual(picked.value, "north-wing-3")
        XCTAssertEqual(picked.origin, .dedicated)
        XCTAssertEqual(try ProximityHandle("north-wing-3", origin: .dedicated, organisationSalt: salt, senderPublicKey: other), picked)
    }

    private func rosterCases() throws -> [(name: String, entries: [RosterEntry])] {
        var cases: [(name: String, entries: [RosterEntry])] = []
        for entry in try vectors().rosters {
            if cases.last?.name == entry.name { cases[cases.count - 1].entries.append(entry) }
            else { cases.append((entry.name, [entry])) }
        }
        return cases
    }
    private func resolved(_ entries: [RosterEntry], _ name: String) throws -> [(senderPublicKey: Data, handle: ProximityHandle)] {
        try entries.map { entry in
            let handle = try ProximityHandle.resolve(dedicated: entry.dedicated, organisationSalt: entry.salt,
                                                     senderPublicKey: entry.sender)
            XCTAssertEqual(handle.value, entry.handle, name)
            return (entry.sender, handle)
        }
    }

    func testEqualHandlesInARosterAreShownWithAKeyFingerprint() throws {
        let cases = try rosterCases()
        XCTAssertGreaterThanOrEqual(cases.count, 6)
        var disambiguated = 0, extended = 0
        for (name, entries) in cases {
            let labels = ProximityHandle.disambiguate(try resolved(entries, name))
            XCTAssertEqual(labels.count, entries.count, name)
            for (label, entry) in zip(labels, entries) {
                XCTAssertEqual(label.senderPublicKey, entry.sender, name)
                XCTAssertEqual(label.fingerprint, entry.fingerprint, name)
                XCTAssertEqual(label.display, entry.fingerprint.map { "\(entry.handle) [\($0)]" } ?? entry.handle, name)
                if let fingerprint = entry.fingerprint {
                    XCTAssertTrue(ProximityHandle.fingerprint(senderPublicKey: entry.sender).hasPrefix(fingerprint), name)
                    // The disambiguated display is not a handle and cannot be stored as one.
                    XCTAssertFalse(ProximityHandle.isValid(label.display), name)
                    disambiguated += 1
                    if fingerprint.count > 8 { extended += 1 }
                }
            }
            // Every provisioned sender of a roster ends with a display of its own.
            XCTAssertEqual(Set(labels.map(\.display)).count, entries.count, name)
        }
        XCTAssertGreaterThanOrEqual(disambiguated, 11)
        XCTAssertGreaterThanOrEqual(extended, 2)
    }

    /// The groups cover every provisioned sender. A sender whose handle equals an absent member's
    /// is labelled with its fingerprint before that member ever checks in.
    func testCollisionGroupsCoverProvisionedSendersThatHaveNotCheckedIn() throws {
        var guarded = 0
        for (name, entries) in try rosterCases() {
            let provisioned = try resolved(entries, name)
            let present = entries.filter(\.present), observed = present.map(\.sender)
            let labels = try ProximityHandle.labels(provisioned: provisioned, observed: observed)
            XCTAssertEqual(labels.count, present.count, name)
            for (label, entry) in zip(labels, present) {
                XCTAssertEqual(label.senderPublicKey, entry.sender, name)
                XCTAssertEqual(label.handle.value, entry.handle, name)
                XCTAssertEqual(label.fingerprint, entry.fingerprint, name)
            }
            // Refusal mutation: groups restricted to the senders seen so far. Where a present sender
            // shares its handle only with absent members, that computation shows the bare handle.
            let observedOnly = provisioned.filter { observed.contains($0.senderPublicKey) }
            for (label, weak) in zip(labels, ProximityHandle.disambiguate(observedOnly)) {
                let holders = provisioned.filter { $0.handle.value == label.handle.value }.count
                let presentHolders = observedOnly.filter { $0.handle.value == label.handle.value }.count
                if holders > 1, presentHolders == 1 {
                    XCTAssertNotNil(label.fingerprint, name)
                    XCTAssertNil(weak.fingerprint, "\(name): the narrowed groups miss it")
                    guarded += 1
                }
            }
            // A label does not change when the absent members appear.
            let later = try ProximityHandle.labels(provisioned: provisioned, observed: entries.map(\.sender))
            for label in labels { XCTAssertTrue(later.contains(label), name) }
        }
        XCTAssertGreaterThanOrEqual(guarded, 2, "the vectors must hold a handle shared with an absent member")
        // A sender the roster does not hold is not labelled at all.
        XCTAssertThrowsError(try ProximityHandle.labels(provisioned: [], observed: [Data(repeating: 9, count: 32)])) {
            XCTAssertEqual($0 as? ProximityError, .unauthorizedSender)
        }
        XCTAssertTrue(try ProximityHandle.labels(provisioned: [], observed: []).isEmpty)
    }

    func testAKeyListedTwiceDoesNotCollideWithItself() throws {
        let salt = Data(repeating: 0x42, count: 32), sender = Data(repeating: 9, count: 32)
        let handle = try ProximityHandle.generated(organisationSalt: salt, senderPublicKey: sender)
        let labels = ProximityHandle.disambiguate([(sender, handle), (sender, handle)])
        XCTAssertTrue(labels.allSatisfy { $0.fingerprint == nil })
        XCTAssertTrue(ProximityHandle.disambiguate([]).isEmpty)
        XCTAssertEqual(ProximityHandle.fingerprint(senderPublicKey: sender).count, 64)
    }
}
