import Foundation

struct PairingOffer: Equatable, Sendable {
  let serverName: String
  let ticket: String
  let expiresAt: Double
  let endpoints: [String]
}

enum PairingError: LocalizedError, Sendable {
  case malformed(String)
  case expired
  case unreachable(String)
  case invalidResponse
  case timedOut

  var errorDescription: String? {
    switch self {
    case .malformed(let message): message
    case .expired: "This pairing link has expired. Create a new one in Harness."
    case .unreachable(let name): "Couldn’t reach \(name) on a private network."
    case .invalidResponse: "The Harness server returned an invalid pairing response."
    case .timedOut: "Pairing timed out. Check that both devices can reach the same private network."
    }
  }
}

enum PairingParser {
  static func parse(_ rawValue: String, now: Date = .now) throws -> PairingOffer {
    let normalized = rawValue.unicodeScalars.filter { scalar in
      !CharacterSet.whitespacesAndNewlines.contains(scalar)
        && !CharacterSet.controlCharacters.contains(scalar)
        && scalar.value != 0x200B
        && scalar.value != 0x200C
        && scalar.value != 0x200D
        && scalar.value != 0xFEFF
    }.map(String.init).joined()

    guard let components = URLComponents(string: normalized),
      components.scheme == "harness",
      components.host == "pair",
      let encoded = components.queryItems?.first(where: { $0.name == "payload" })?.value,
      let data = decodeBase64URL(encoded),
      let json = try? JSONDecoder().decode(JSONValue.self, from: data),
      let object = json.objectValue
    else {
      throw PairingError.malformed("Paste a complete Harness pairing link.")
    }

    guard object["version"]?.intValue == 1 else {
      throw PairingError.malformed("This pairing link uses an unsupported version.")
    }
    guard let serverName = object["serverName"]?.stringValue?.trimmingCharacters(in: .whitespaces),
      !serverName.isEmpty,
      let ticket = object["ticket"]?.stringValue,
      ticket.range(of: "^[A-Za-z0-9_-]{32,}$", options: .regularExpression) != nil,
      let expiresAt = object["expiresAt"]?.doubleValue,
      let candidates = object["endpoints"]?.arrayValue
    else {
      throw PairingError.malformed("The pairing link is incomplete.")
    }
    guard expiresAt > now.timeIntervalSince1970 * 1_000 else { throw PairingError.expired }

    let endpoints = candidates.compactMap(\.stringValue).filter(endpointIsAllowed)
    let unique = endpoints.reduce(into: [String]()) { result, endpoint in
      if !result.contains(endpoint) { result.append(endpoint) }
    }
    guard !unique.isEmpty else {
      throw PairingError.malformed("The pairing link has no private-network endpoint.")
    }
    return PairingOffer(
      serverName: serverName, ticket: ticket, expiresAt: expiresAt, endpoints: unique)
  }

  static func pairingSocketURL(endpoint: String, ticket: String) -> URL? {
    socketURL(endpoint: endpoint, queryName: "pairing_ticket", value: ticket)
  }

  static func deviceSocketURL(endpoint: String, token: String) -> URL? {
    socketURL(endpoint: endpoint, queryName: "token", value: token)
  }

  static func endpointIsAllowed(_ endpoint: String) -> Bool {
    guard let components = URLComponents(string: endpoint),
      components.scheme == "ws",
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path.isEmpty || components.path == "/",
      let host = components.host
    else { return false }
    let octets = host.split(separator: ".").compactMap { Int($0) }
    guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
    let first = octets[0]
    let second = octets[1]
    if first == 100, (64...127).contains(second) { return true }
    if first == 10 { return true }
    if first == 172, (16...31).contains(second) { return true }
    return first == 192 && second == 168
  }

  private static func socketURL(endpoint: String, queryName: String, value: String) -> URL? {
    guard endpointIsAllowed(endpoint), var components = URLComponents(string: endpoint) else {
      return nil
    }
    components.queryItems = [URLQueryItem(name: queryName, value: value)]
    return components.url
  }

  private static func decodeBase64URL(_ value: String) -> Data? {
    var normalized = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = normalized.count % 4
    if remainder != 0 { normalized += String(repeating: "=", count: 4 - remainder) }
    return Data(base64Encoded: normalized)
  }
}

enum PairingClient {
  static func claim(link: String, deviceName: String) async throws -> PairedEnvironment {
    let offer = try PairingParser.parse(link)
    var latestError: (any Error)?
    for endpoint in offer.endpoints {
      do {
        return try await claim(endpoint: endpoint, offer: offer, deviceName: deviceName)
      } catch {
        latestError = error
      }
    }
    throw latestError ?? PairingError.unreachable(offer.serverName)
  }

  private static func claim(
    endpoint: String,
    offer: PairingOffer,
    deviceName: String
  ) async throws -> PairedEnvironment {
    guard let url = PairingParser.pairingSocketURL(endpoint: endpoint, ticket: offer.ticket) else {
      throw PairingError.malformed("The pairing endpoint is invalid.")
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    configuration.timeoutIntervalForResource = 12
    let session = URLSession(configuration: configuration)
    let socket = session.webSocketTask(with: url)
    socket.resume()
    defer {
      socket.cancel(with: .normalClosure, reason: nil)
      session.invalidateAndCancel()
    }

    return try await withThrowingTaskGroup(of: PairedEnvironment.self) { group in
      group.addTask {
        let request = JSONValue.object(
          ("id", .string("claim")),
          ("method", .string("connections.claim")),
          ("params", .object(["name": .string(deviceName)]))
        )
        let data = try JSONEncoder().encode(request)
        guard let payload = String(data: data, encoding: .utf8) else {
          throw PairingError.invalidResponse
        }
        try await socket.send(.string(payload))
        while true {
          let message = try await socket.receive()
          let responseData: Data
          switch message {
          case .string(let text): responseData = Data(text.utf8)
          case .data(let data): responseData = data
          @unknown default: continue
          }
          if let environment = try claimedEnvironment(
            from: responseData,
            offer: offer,
            endpoint: endpoint
          ) {
            return environment
          }
        }
      }
      group.addTask {
        try await Task.sleep(for: .seconds(12))
        throw PairingError.timedOut
      }
      guard let result = try await group.next() else { throw PairingError.invalidResponse }
      group.cancelAll()
      return result
    }
  }

  static func claimedEnvironment(
    from responseData: Data,
    offer: PairingOffer,
    endpoint: String
  ) throws -> PairedEnvironment? {
    let response = try JSONDecoder().decode(JSONValue.self, from: responseData)
    guard let object = response.objectValue else { throw PairingError.invalidResponse }
    guard object["id"]?.stringValue == "claim" else { return nil }
    if let error = object["error"]?.objectValue {
      throw RPCFailure(
        message: error["message"]?.stringValue ?? "Pairing was refused.",
        detail: error["detail"]?.stringValue
      )
    }
    guard let result = object["result"]?.objectValue,
      let deviceID = result["deviceId"]?.stringValue,
      let token = result["deviceToken"]?.stringValue,
      let serverName = result["serverName"]?.stringValue
    else {
      throw PairingError.invalidResponse
    }
    let returned =
      result["addresses"]?.arrayValue?.compactMap { address in
        address["url"]?.stringValue
      }.filter(PairingParser.endpointIsAllowed) ?? []
    let endpoints = (returned + offer.endpoints).reduce(into: [String]()) { values, candidate in
      if !values.contains(candidate) { values.append(candidate) }
    }
    return PairedEnvironment(
      deviceId: deviceID,
      deviceToken: token,
      serverName: serverName,
      endpoints: endpoints,
      preferredEndpoint: endpoint
    )
  }
}
