import Foundation

public struct RetryHint: Equatable, Sendable {
    public let seconds: Int64
}
public struct ProblemCorrelation: Equatable, Sendable {
    public let requestID: String
}
public enum TransportFailure: Equatable, Sendable {
    case timeout, offline, tls, authenticationChallenge, other
}
/// Why Core refused a discovery request, one case per problem type `discoverRealm` documents for it.
/// Each is final for that request: none is retried, and the entry screen shows "request refused".
public enum RequestRejection: Equatable, Sendable {
    /// 400 `malformed-request`: unparseable JSON, duplicate keys, or an invalid compatibility key.
    case malformedRequest
    /// 400 `idempotency-key-missing`: the compatibility key was not sent.
    case idempotencyKeyMissing
    /// 403 `forbidden`: refused from a browser's `Origin` or `Sec-Fetch-Site`, which a native request never sends.
    case forbidden
    /// 413 `payload-too-large`: the body is over 4096 bytes.
    case payloadTooLarge
    /// 415 `unsupported-media-type`: the body is not `application/json`.
    case unsupportedMediaType
    /// 422 `validation-error`: not exactly one canonical slug or approved email.
    case validationError
}
public enum DiscoveryFailure: Error, Equatable, Sendable {
    case notConfigured, invalidInput, protocolViolation, unsupportedService
    case rejectedRequest(RequestRejection)
    case transport(TransportFailure)
    case rateLimited(RetryHint, ProblemCorrelation)
    case temporarilyUnavailable(RetryHint, ProblemCorrelation)
    case internalServiceError(ProblemCorrelation)
}
public enum AnonymousDiscoveryOutcome: Equatable, Sendable {
    case result(AnonymousDiscoveryResult)
    case failure(DiscoveryFailure)
    case cancelled
}
public enum DiscoveryProblem {
    public static func decode(data: Data, status: Int, headers: [String: String]) throws -> DiscoveryFailure {
        let headers = try validateHeaders(headers, problem: true)
        guard let object = try StrictJSON.parse(data).object,
              let type = object["type"]?.string, let title = object["title"]?.string,
              title.unicodeScalars.count <= 200,
              object["status"]?.integer == Int64(status), (100...599).contains(status),
              let requestID = object["request_id"]?.string, validRequestID(requestID),
              requestID == headers["x-request-id"] else { throw DiscoveryFailure.protocolViolation }
        try validateOptionalFields(object)
        let correlation = ProblemCorrelation(requestID: requestID)
        let prefix = "https://kodera.io/problems/"
        guard type.hasPrefix(prefix) else { throw DiscoveryFailure.protocolViolation }
        switch (status, String(type.dropFirst(prefix.count))) {
        case (400, "malformed-request"): return .rejectedRequest(.malformedRequest)
        case (400, "idempotency-key-missing"): return .rejectedRequest(.idempotencyKeyMissing)
        case (403, "forbidden"): return .rejectedRequest(.forbidden)
        case (413, "payload-too-large"): return .rejectedRequest(.payloadTooLarge)
        case (415, "unsupported-media-type"): return .rejectedRequest(.unsupportedMediaType)
        case (422, "validation-error"): return .rejectedRequest(.validationError)
        case (500, "internal-error"):
            return .internalServiceError(correlation)
        case (429, "rate-limited"), (503, "service-unavailable"):
            guard let seconds = object["retry_after_s"]?.integer, seconds > 0,
                  let header = headers["retry-after"], !header.isEmpty,
                  header.utf8.allSatisfy({ (48...57).contains($0) }),
                  let headerSeconds = Int64(header), headerSeconds == seconds,
                  status != 503 || seconds == 5 else { throw DiscoveryFailure.protocolViolation }
            let hint = RetryHint(seconds: seconds)
            return status == 429 ? .rateLimited(hint, correlation) : .temporarilyUnavailable(hint, correlation)
        default: throw DiscoveryFailure.protocolViolation
        }
    }

    static func validateHeaders(_ input: [String: String], problem: Bool) throws -> [String: String] {
        var headers: [String: String] = [:]
        for (name, value) in input {
            let key = name.lowercased()
            guard headers[key] == nil else { throw DiscoveryFailure.protocolViolation }
            headers[key] = value
        }
        let mediaType = headers["content-type"]?.split(separator: ";", omittingEmptySubsequences: false)
            .first?.trimmingCharacters(in: .whitespaces).lowercased()
        let policies = headers["cache-control"]?.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        } ?? []
        guard mediaType == (problem ? "application/problem+json" : "application/json"),
              policies.contains("no-store"), let requestID = headers["x-request-id"],
              validRequestID(requestID) else { throw DiscoveryFailure.protocolViolation }
        return headers
    }

    private static func validRequestID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && value.utf8.allSatisfy { $0 > 32 && $0 < 127 }
    }

    private static func validateOptionalFields(_ value: [String: StrictJSONValue]) throws {
        for (key, limit) in [("detail", 2000), ("reason", 100)] {
            if let field = value[key] {
                guard let text = field.string, text.unicodeScalars.count <= limit else {
                    throw DiscoveryFailure.protocolViolation
                }
            }
        }
        for key in ["instance", "first_seen_at"] {
            if let field = value[key], field.string == nil { throw DiscoveryFailure.protocolViolation }
        }
        for key in ["job_id", "organisation_id"] {
            if let field = value[key], !field.isNull {
                guard let identifier = field.string, UUID(uuidString: identifier) != nil else {
                    throw DiscoveryFailure.protocolViolation
                }
            }
        }
        if let etag = value["current_etag"], !etag.isNull, etag.string == nil {
            throw DiscoveryFailure.protocolViolation
        }
        if let retry = value["retry_after_s"], !retry.isNull, retry.integer == nil {
            throw DiscoveryFailure.protocolViolation
        }
        // `payload-too-large` names the endpoint's limit; it is a count of bytes when present.
        if let limit = value["limit_bytes"] {
            guard let bytes = limit.integer, bytes >= 0 else { throw DiscoveryFailure.protocolViolation }
        }
        for key in ["allowed_states", "required_amr"] {
            if let field = value[key] {
                guard let entries = field.array, entries.allSatisfy({
                    guard let text = $0.string else { return false }
                    return key != "required_amr" || text.unicodeScalars.count <= 128
                }) else { throw DiscoveryFailure.protocolViolation }
            }
        }
        if let errors = value["errors"] {
            guard let fields = errors.array else { throw DiscoveryFailure.protocolViolation }
            for field in fields {
                guard let entry = field.object, entry["pointer"]?.string != nil,
                      let code = entry["code"]?.string, code.unicodeScalars.count <= 100 else {
                    throw DiscoveryFailure.protocolViolation
                }
                if let detail = entry["detail"] {
                    guard let text = detail.string, text.unicodeScalars.count <= 500 else {
                        throw DiscoveryFailure.protocolViolation
                    }
                }
            }
        }
        // Unknown RFC problem extensions remain bounded parsed values and are discarded.
    }
}
