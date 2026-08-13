import Foundation

enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container, debugDescription: "Unsupported JSON value")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  var objectValue: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  var arrayValue: [JSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var doubleValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }

  var intValue: Int? {
    doubleValue.map(Int.init)
  }

  var boolValue: Bool? {
    guard case .bool(let value) = self else { return nil }
    return value
  }

  subscript(key: String) -> JSONValue? {
    objectValue?[key]
  }

  func decoded<T: Decodable>(as type: T.Type = T.self) throws -> T {
    let data = try JSONEncoder().encode(self)
    return try JSONDecoder().decode(type, from: data)
  }
}

extension JSONValue {
  static func object(_ pairs: (String, JSONValue?)...) -> JSONValue {
    .object(
      Dictionary(
        uniqueKeysWithValues: pairs.compactMap { key, value in
          value.map { (key, $0) }
        }))
  }

  static func string(_ value: String?) -> JSONValue? {
    value.map(JSONValue.string)
  }

  static func bool(_ value: Bool?) -> JSONValue? {
    value.map(JSONValue.bool)
  }
}

struct RPCFailure: LocalizedError, Sendable {
  let message: String
  let detail: String?

  var errorDescription: String? {
    guard let detail, !detail.isEmpty else { return message }
    return "\(message) \(detail)"
  }
}
