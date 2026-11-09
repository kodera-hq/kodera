import Foundation
import KoderaDomain

/// Public discovery metadata only; no authenticated identity or membership is represented.
public struct AnonymousOrganisationMetadata: Equatable, Sendable {
    public let organisationId: String
    public let organisationSlug: String
    public let displayName: String
    public let realm: String
    public let issuer: String
    public let openidConfigurationURL: String
}

public enum AnonymousDiscoveryResult: Equatable, Sendable {
    case noMatch
    case single(AnonymousOrganisationMetadata)
    case multiple([AnonymousOrganisationMetadata])
}

public enum DiscoveryEnvelope {
    public static func decode(data: Data, configuration: CoreDiscoveryConfiguration)
        throws -> AnonymousDiscoveryResult {
        guard let object = try StrictJSON.parse(data).object,
              Set(object.keys) == ["realm", "issuer", "openid_configuration_url", "organisation", "candidates"],
              let candidates = object["candidates"]?.array else { throw DiscoveryFailure.protocolViolation }
        let nullMetadata = ["realm", "issuer", "openid_configuration_url", "organisation"].allSatisfy {
            object[$0]?.isNull == true
        }
        if nullMetadata {
            if candidates.isEmpty { return .noMatch }
            guard (2...20).contains(candidates.count) else { throw DiscoveryFailure.protocolViolation }
            let values = try candidates.map { value -> AnonymousOrganisationMetadata in
                guard let candidate = value.object,
                      Set(candidate.keys) == ["realm", "issuer", "openid_configuration_url", "organisation"] else {
                    throw DiscoveryFailure.protocolViolation
                }
                return try metadata(candidate, configuration: configuration)
            }
            guard Set(values.map(\.organisationId)).count == values.count else { throw DiscoveryFailure.protocolViolation }
            for (previous, next) in zip(values, values.dropFirst()) {
                guard previous.organisationSlug < next.organisationSlug ||
                    (previous.organisationSlug == next.organisationSlug && previous.organisationId < next.organisationId) else {
                    throw DiscoveryFailure.protocolViolation
                }
            }
            return .multiple(values)
        }
        guard candidates.isEmpty else { throw DiscoveryFailure.protocolViolation }
        return .single(try metadata(object, configuration: configuration))
    }

    private static func metadata(_ value: [String: StrictJSONValue], configuration: CoreDiscoveryConfiguration)
        throws -> AnonymousOrganisationMetadata {
        guard let realm = value["realm"]?.string, let issuer = value["issuer"]?.string,
              let wellKnown = value["openid_configuration_url"]?.string,
              let organisation = value["organisation"]?.object,
              Set(organisation.keys) == ["id", "slug", "name", "realm"],
              let id = organisation["id"]?.string, let slug = organisation["slug"]?.string,
              let name = organisation["name"]?.string, (1...200).contains(name.unicodeScalars.count),
              organisation["realm"]?.string == realm else { throw DiscoveryFailure.protocolViolation }
        let selection = DiscoverySelection(organisationId: id, organisationSlug: slug, realm: realm,
            issuer: issuer, openidConfigurationUrl: wellKnown)
        do { _ = try TrustPolicy.validateDiscovery(selection, trust: configuration.trust) }
        catch { throw DiscoveryFailure.protocolViolation }
        return AnonymousOrganisationMetadata(organisationId: id, organisationSlug: slug, displayName: name,
            realm: realm, issuer: issuer, openidConfigurationURL: wellKnown)
    }

    /// `RealmDiscoveryRequest.email` at `contracts/v0.26.0`, verbatim: a bounded ASCII local part, then a
    /// dotted DNS domain. Core refuses anything else with 422, so the client sends nothing else.
    private static let emailPattern =
        #"^(?=[^@]{1,64}@)[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![\s\S])"#

    static func approvedEmail(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...254).contains(bytes.count), bytes.allSatisfy({ $0 > 32 && $0 < 127 }),
              // Built per lookup: a lookup is one tap, and no shared regex instance crosses concurrency domains.
              let pattern = try? NSRegularExpression(pattern: emailPattern) else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return pattern.firstMatch(in: value, options: [.anchored], range: range)?.range == range
    }

    static func canonicalSlug(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        let alphanumeric: (UInt8) -> Bool = { (48...57).contains($0) || (97...122).contains($0) }
        guard (5...20).contains(bytes.count), let first = bytes.first, let last = bytes.last,
              alphanumeric(first), alphanumeric(last) else { return false }
        return bytes.allSatisfy { alphanumeric($0) || $0 == 45 }
    }
}
