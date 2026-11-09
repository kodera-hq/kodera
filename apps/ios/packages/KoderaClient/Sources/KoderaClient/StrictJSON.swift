import Foundation

/// Bounded JSON values keep numeric lexemes intact, including bool/integer distinctions.
indirect enum StrictJSONValue {
    case object([String: StrictJSONValue]), array([StrictJSONValue]), string(String)
    case number(String), boolean(Bool), null

    var object: [String: StrictJSONValue]? { if case let .object(value) = self { value } else { nil } }
    var array: [StrictJSONValue]? { if case let .array(value) = self { value } else { nil } }
    var string: String? { if case let .string(value) = self { value } else { nil } }
    var isNull: Bool { if case .null = self { true } else { false } }
    var integer: Int64? {
        guard case let .number(value) = self, !value.isEmpty,
              value.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return Int64(value)
    }
}

/// Private to this adapter module; no unbounded input or general parser extension surface.
struct StrictJSON {
    static let byteLimit = 65_536
    private let bytes: [UInt8]
    private var offset = 0

    static func parse(_ data: Data) throws -> StrictJSONValue {
        guard data.count <= byteLimit, String(data: data, encoding: .utf8) != nil else {
            throw DiscoveryFailure.protocolViolation
        }
        var parser = StrictJSON(bytes: Array(data))
        let value = try parser.value(depth: 0)
        parser.whitespace()
        guard parser.offset == parser.bytes.count else { throw DiscoveryFailure.protocolViolation }
        return value
    }

    private mutating func whitespace() {
        while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 }
    }
    private mutating func take(_ byte: UInt8) -> Bool {
        guard offset < bytes.count, bytes[offset] == byte else { return false }
        offset += 1
        return true
    }
    private mutating func value(depth: Int) throws -> StrictJSONValue {
        guard depth < 12 else { throw DiscoveryFailure.protocolViolation }
        whitespace()
        guard offset < bytes.count else { throw DiscoveryFailure.protocolViolation }
        switch bytes[offset] {
        case 123:
            offset += 1
            whitespace()
            var result: [String: StrictJSONValue] = [:]
            if take(125) { return .object(result) }
            while true {
                whitespace()
                let key = try string()
                guard result[key] == nil else { throw DiscoveryFailure.protocolViolation }
                whitespace()
                guard take(58) else { throw DiscoveryFailure.protocolViolation }
                result[key] = try value(depth: depth + 1)
                whitespace()
                if take(125) { return .object(result) }
                guard take(44) else { throw DiscoveryFailure.protocolViolation }
            }
        case 91:
            offset += 1
            whitespace()
            var result: [StrictJSONValue] = []
            if take(93) { return .array(result) }
            while true {
                result.append(try value(depth: depth + 1))
                whitespace()
                if take(93) { return .array(result) }
                guard take(44) else { throw DiscoveryFailure.protocolViolation }
            }
        case 34: return .string(try string())
        case 116: try literal("true"); return .boolean(true)
        case 102: try literal("false"); return .boolean(false)
        case 110: try literal("null"); return .null
        case 45, 48...57: return .number(try number())
        default: throw DiscoveryFailure.protocolViolation
        }
    }
    private mutating func literal(_ value: String) throws {
        let expected = Array(value.utf8)
        guard bytes.count - offset >= expected.count,
              Array(bytes[offset..<(offset + expected.count)]) == expected else {
            throw DiscoveryFailure.protocolViolation
        }
        offset += expected.count
    }
    private mutating func string() throws -> String {
        let start = offset
        guard take(34) else { throw DiscoveryFailure.protocolViolation }
        while offset < bytes.count {
            let byte = bytes[offset]
            offset += 1
            if byte == 34 {
                do { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset])) }
                catch { throw DiscoveryFailure.protocolViolation }
            }
            guard byte >= 32 else { throw DiscoveryFailure.protocolViolation }
            if byte == 92 {
                guard offset < bytes.count else { throw DiscoveryFailure.protocolViolation }
                let escaped = bytes[offset]
                offset += 1
                if escaped == 117 {
                    guard bytes.count - offset >= 4,
                          bytes[offset..<(offset + 4)].allSatisfy({
                              (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
                          }) else { throw DiscoveryFailure.protocolViolation }
                    offset += 4
                } else if ![34, 47, 92, 98, 102, 110, 114, 116].contains(escaped) {
                    throw DiscoveryFailure.protocolViolation
                }
            }
        }
        throw DiscoveryFailure.protocolViolation
    }
    private mutating func digits() -> Int {
        let start = offset
        while offset < bytes.count && (48...57).contains(bytes[offset]) { offset += 1 }
        return offset - start
    }
    private mutating func number() throws -> String {
        let start = offset
        _ = take(45)
        if take(48) {
            if offset < bytes.count && (48...57).contains(bytes[offset]) { throw DiscoveryFailure.protocolViolation }
        } else {
            guard offset < bytes.count, (49...57).contains(bytes[offset]), digits() > 0 else {
                throw DiscoveryFailure.protocolViolation
            }
        }
        if take(46), digits() == 0 { throw DiscoveryFailure.protocolViolation }
        if take(101) || take(69) {
            if !take(43) { _ = take(45) }
            guard digits() > 0 else { throw DiscoveryFailure.protocolViolation }
        }
        return String(decoding: bytes[start..<offset], as: UTF8.self)
    }
}
