import Foundation
import XCTest
@testable import KoderaClient

final class DiscoveryEnvelopeTests: XCTestCase {
    private func decode(_ data: Data) throws -> AnonymousDiscoveryResult {
        try DiscoveryEnvelope.decode(data: data, configuration: DiscoveryFixtures.configuration)
    }
    func testExactZeroOneAndManyUnion() throws {
        XCTAssertEqual(try decode(DiscoveryFixtures.data("discovery-zero")), .noMatch)
        guard case let .single(one) = try decode(DiscoveryFixtures.data("discovery-one")) else {
            return XCTFail("one result must remain anonymous single metadata")
        }
        XCTAssertEqual(one.organisationSlug, "atelier")
        guard case let .multiple(many) = try decode(DiscoveryFixtures.data("discovery-many")) else {
            return XCTFail("multiple results need explicit choice")
        }
        XCTAssertEqual(many.map(\.organisationSlug), ["atelier", "bureau"])
        var twenty = try DiscoveryFixtures.object("discovery-zero")
        twenty["candidates"] = (0..<20).map {
            DiscoveryFixtures.candidate(id: String(format: "%08x-1111-4111-8111-111111111111", $0 + 1),
                slug: String(format: "team%02d", $0))
        }
        guard case let .multiple(values) = try decode(DiscoveryFixtures.json(twenty)) else {
            return XCTFail("twenty valid choices must decode")
        }
        XCTAssertEqual(values.count, 20)
    }

    func testEveryAnonymousIdentityInvariantIsChecked() throws {
        let mutations: [(String, Any)] = [("id", "bad"), ("slug", "UPPER"), ("name", ""),
            ("name", String(repeating: "é", count: 201)), ("realm", "other")]
        for (key, value) in mutations {
            var object = try DiscoveryFixtures.object()
            var organisation = try XCTUnwrap(object["organisation"] as? [String: Any])
            organisation[key] = value
            object["organisation"] = organisation
            XCTAssertThrowsError(try decode(DiscoveryFixtures.json(object)), key)
        }
        for (key, value) in [("realm", "other"), ("issuer", "https://id.kodera.io.evil/realms/atelier"),
            ("issuer", "https://id.kodera.io/realms/%61telier"),
            ("openid_configuration_url", "https://id.kodera.io/other")] {
            var object = try DiscoveryFixtures.object()
            object[key] = value
            XCTAssertThrowsError(try decode(DiscoveryFixtures.json(object)), key)
        }
    }

    func testMixedAndIncompleteUnionShapesRefuse() throws {
        var one = try DiscoveryFixtures.object()
        one["candidates"] = [DiscoveryFixtures.candidate()]
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(one)))
        var zero = try DiscoveryFixtures.object("discovery-zero")
        zero.removeValue(forKey: "issuer")
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(zero)))
        var singleton = try DiscoveryFixtures.object("discovery-zero")
        singleton["candidates"] = [DiscoveryFixtures.candidate()]
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(singleton)))
    }

    func testCandidateUniquenessOrderAndCardinality() throws {
        var many = try DiscoveryFixtures.object("discovery-many")
        many["candidates"] = [DiscoveryFixtures.candidate(), DiscoveryFixtures.candidate()]
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(many)))
        var ordered = try DiscoveryFixtures.object("discovery-many")
        ordered["candidates"] = (try XCTUnwrap(ordered["candidates"] as? [[String: Any]])).reversed().map { $0 }
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(ordered)))
        many["candidates"] = (0..<21).map {
            DiscoveryFixtures.candidate(id: String(format: "%08x-1111-4111-8111-111111111111", $0 + 1),
                slug: String(format: "team%02d", $0))
        }
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(many)))
    }

    func testMalformedDuplicateAndUnknownJSONRefuses() throws {
        for data in [Data([0xff, 0xfe]), Data("{".utf8), Data("[]".utf8),
            Data(#"{"realm":null,"issuer":null,"\u0069ssuer":null,"openid_configuration_url":null,"organisation":null,"candidates":[]}"#.utf8)] {
            XCTAssertThrowsError(try decode(data))
        }
        for key in ["next_cursor", "unknown"] {
            var object = try DiscoveryFixtures.object("discovery-zero")
            object[key] = "unexpected"
            XCTAssertThrowsError(try decode(DiscoveryFixtures.json(object)))
        }
        var object = try DiscoveryFixtures.object()
        var organisation = try XCTUnwrap(object["organisation"] as? [String: Any])
        organisation["unknown"] = true
        object["organisation"] = organisation
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(object)))
        let nested = Data((String(repeating: "[", count: 32) + "null" + String(repeating: "]", count: 32)).utf8)
        XCTAssertThrowsError(try decode(nested))
    }

    func testLeadingDigitAndBoundedUnicodeNameRemainValidMetadata() throws {
        var object = DiscoveryFixtures.candidate(slug: "1team")
        object["candidates"] = [Any]()
        var organisation = try XCTUnwrap(object["organisation"] as? [String: Any])
        organisation["name"] = String(repeating: "é", count: 200)
        object["organisation"] = organisation
        guard case let .single(metadata) = try decode(DiscoveryFixtures.json(object)) else {
            return XCTFail("valid anonymous metadata rejected")
        }
        XCTAssertEqual(metadata.organisationSlug, "1team")
        XCTAssertEqual(metadata.displayName.unicodeScalars.count, 200)
    }
}
