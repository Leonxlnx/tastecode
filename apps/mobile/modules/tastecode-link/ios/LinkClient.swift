import CryptoKit
import Foundation
import Network

/// The encrypted link to one computer.
///
/// `connect` races every address the computer gave (its local name, LAN and
/// tailnet addresses), a quarter second apart, and keeps the first that
/// completes the Noise handshake. After that each WebSocket message is one
/// encrypted protocol frame. Reconnecting is the caller's decision: this type
/// reports `open`, `failed` and `closed` and does nothing on its own.
final class LinkClient {
  struct Answer {
    let deviceId: String
    let serverName: String
  }

  var onState: ([String: Any]) -> Void = { _ in }
  var onFrames: (Int, [String]) -> Void = { _, _ in }

  private let queue = DispatchQueue(label: "dev.tastecode.link")
  /// Callbacks leave the link's queue, so a handler may call `send` or `connect` right away.
  private let callbacks = DispatchQueue(label: "dev.tastecode.link.callbacks")
  private var attempt = 0
  private var candidates: [Candidate] = []
  private var failures: [(host: String, error: String, code: String)] = []
  private var active: Candidate?
  private var pending: [String] = []
  private var flushScheduled = false
  private var deadline: DispatchWorkItem?

  private static let staggerMs = 250
  private static let handshakeTimeout: DispatchTimeInterval = .seconds(10)
  private static let maxMessageBytes = 64 * 1024 * 1024

  /// Starts a new attempt and returns its number; events for older attempts are never sent.
  func connect(
    serverKey: Data,
    hosts: [String],
    port: UInt16,
    hello: Data,
    deviceKey: Curve25519.KeyAgreement.PrivateKey? = nil
  ) throws -> Int {
    let staticKey = try deviceKey ?? LinkStore.deviceKey()
    return queue.sync { () -> Int in
      cancelAll()
      attempt += 1
      let current = attempt
      failures = []
      let unique = hosts.reduce(into: [String]()) { list, host in
        if !host.isEmpty && !list.contains(host) { list.append(host) }
      }
      guard !unique.isEmpty, let nwPort = NWEndpoint.Port(rawValue: port) else {
        report(["attempt": current, "state": "failed", "code": "no_address", "error": "No address to reach the computer"])
        return current
      }
      for (index, host) in unique.enumerated() {
        let candidate = Candidate(
          host: host,
          connection: Self.connection(host: host, port: nwPort),
          initiator: NoiseInitiator(staticKey: staticKey, remoteStatic: serverKey),
          hello: hello
        )
        candidates.append(candidate)
        queue.asyncAfter(deadline: .now() + .milliseconds(index * Self.staggerMs)) { [weak self] in
          guard let self, self.attempt == current, !candidate.finished, self.active == nil else { return }
          self.start(candidate, attempt: current)
        }
      }
      let timeout = DispatchWorkItem { [weak self] in
        guard let self, self.attempt == current, self.active == nil else { return }
        for candidate in self.candidates where !candidate.finished {
          self.fail(candidate, attempt: current, error: "The computer did not answer in time", code: "timeout")
        }
      }
      deadline = timeout
      queue.asyncAfter(deadline: .now() + Self.handshakeTimeout, execute: timeout)
      return current
    }
  }

  func send(_ frame: String) -> Bool {
    queue.sync { () -> Bool in
      guard let active, let session = active.session else { return false }
      do {
        let message = try session.send.encrypt(Data(frame.utf8))
        Self.sendBinary(message, on: active.connection)
        return true
      } catch {
        close(active, reason: "The link could not encrypt a message", code: "encrypt")
        return false
      }
    }
  }

  func close() {
    queue.sync {
      attempt += 1
      cancelAll()
    }
  }

  // MARK: - Candidates

  private final class Candidate {
    let host: String
    let connection: NWConnection
    let initiator: NoiseInitiator
    let hello: Data
    var session: NoiseSession?
    var finished = false

    init(host: String, connection: NWConnection, initiator: NoiseInitiator, hello: Data) {
      self.host = host
      self.connection = connection
      self.initiator = initiator
      self.hello = hello
    }
  }

  private static func connection(host: String, port: NWEndpoint.Port) -> NWConnection {
    let websocket = NWProtocolWebSocket.Options()
    websocket.autoReplyPing = true
    websocket.maximumMessageSize = maxMessageBytes
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = 6
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
    let url = URL(string: "ws://\(host):\(port.rawValue)/link")!
    return NWConnection(to: .url(url), using: parameters)
  }

  private static func sendBinary(_ data: Data, on connection: NWConnection) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
    let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
  }

  private func start(_ candidate: Candidate, attempt current: Int) {
    candidate.connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.handshake(candidate, attempt: current)
      case .waiting(let error), .failed(let error):
        if candidate === self.active {
          self.close(candidate, reason: Self.describe(error), code: Self.code(error))
        } else {
          self.fail(candidate, attempt: current, error: Self.describe(error), code: Self.code(error))
        }
      case .cancelled:
        if candidate === self.active { self.close(candidate, reason: "The link closed", code: "closed") }
      default:
        break
      }
    }
    candidate.connection.start(queue: queue)
  }

  private func handshake(_ candidate: Candidate, attempt current: Int) {
    let first: Data
    do {
      first = try candidate.initiator.writeMessage1(payload: candidate.hello)
    } catch {
      fail(candidate, attempt: current, error: "The pairing key is not valid", code: "bad_key")
      return
    }
    Self.sendBinary(first, on: candidate.connection)
    candidate.connection.receiveMessage { [weak self] content, _, _, error in
      guard let self, self.attempt == current, !candidate.finished else { return }
      guard let content, error == nil else {
        self.fail(candidate, attempt: current, error: error.map(Self.describe) ?? "The computer closed the link", code: error.map(Self.code) ?? "closed")
        return
      }
      do {
        let (payload, session) = try candidate.initiator.readMessage2(content)
        let answer = try JSONSerialization.jsonObject(with: payload) as? [String: Any] ?? [:]
        if answer["ok"] as? Bool == true {
          candidate.session = session
          self.win(candidate, attempt: current, answer: answer)
        } else {
          let code = answer["error"] as? String ?? "refused"
          self.fail(candidate, attempt: current, error: Self.refusal(code), code: code)
        }
      } catch {
        // Only the computer holding the pinned key can answer; anything else is not it.
        self.fail(candidate, attempt: current, error: "Something else answered at this address", code: "wrong_computer")
      }
    }
  }

  private func win(_ candidate: Candidate, attempt current: Int, answer: [String: Any]) {
    candidate.finished = true
    active = candidate
    deadline?.cancel()
    for other in candidates where other !== candidate {
      other.finished = true
      other.connection.stateUpdateHandler = nil
      other.connection.cancel()
    }
    candidates = [candidate]
    report([
      "attempt": current,
      "state": "open",
      "host": candidate.host,
      "deviceId": answer["deviceId"] as? String ?? "",
      "serverName": answer["serverName"] as? String ?? "",
    ])
    receive(candidate, attempt: current)
  }

  private func fail(_ candidate: Candidate, attempt current: Int, error: String, code: String) {
    guard !candidate.finished else { return }
    candidate.finished = true
    candidate.connection.stateUpdateHandler = nil
    candidate.connection.cancel()
    failures.append((candidate.host, error, code))
    guard attempt == current, active == nil, candidates.allSatisfy({ $0.finished }) else { return }
    deadline?.cancel()
    // A refusal from the computer itself says more than a dead address.
    let ranked = failures.sorted { Self.rank($0.code) > Self.rank($1.code) }
    let best = ranked.first ?? (candidate.host, error, code)
    report(["attempt": current, "state": "failed", "host": best.host, "error": best.error, "code": best.code])
  }

  private func receive(_ candidate: Candidate, attempt current: Int) {
    candidate.connection.receiveMessage { [weak self] content, context, _, error in
      guard let self, self.active === candidate else { return }
      if let error {
        self.close(candidate, reason: Self.describe(error), code: Self.code(error))
        return
      }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
        as? NWProtocolWebSocket.Metadata
      if metadata?.opcode == .close {
        self.close(candidate, reason: "The computer closed the link", code: "closed")
        return
      }
      if let content, metadata?.opcode == .binary, let session = candidate.session {
        do {
          let plaintext = try session.receive.decrypt(content)
          self.enqueue(String(decoding: plaintext, as: UTF8.self), attempt: current)
        } catch {
          // A frame that fails authentication means the stream can no longer be trusted.
          self.close(candidate, reason: "The link failed an integrity check", code: "integrity")
          return
        }
      }
      self.receive(candidate, attempt: current)
    }
  }

  private func enqueue(_ frame: String, attempt current: Int) {
    pending.append(frame)
    guard !flushScheduled else { return }
    flushScheduled = true
    // Streamed replies arrive as hundreds of small frames; hand them over in batches.
    queue.asyncAfter(deadline: .now() + .milliseconds(8)) { [weak self] in
      guard let self else { return }
      self.flushScheduled = false
      let frames = self.pending
      self.pending = []
      if self.attempt == current, !frames.isEmpty {
        let onFrames = self.onFrames
        self.callbacks.async { onFrames(current, frames) }
      }
    }
  }

  private func close(_ candidate: Candidate, reason: String, code: String) {
    guard active === candidate else { return }
    active = nil
    candidates = []
    candidate.connection.stateUpdateHandler = nil
    candidate.connection.cancel()
    pending = []
    report(["attempt": attempt, "state": "closed", "host": candidate.host, "error": reason, "code": code])
  }

  private func cancelAll() {
    deadline?.cancel()
    deadline = nil
    for candidate in candidates {
      candidate.finished = true
      candidate.connection.stateUpdateHandler = nil
      candidate.connection.cancel()
    }
    candidates = []
    active = nil
    pending = []
  }

  private func report(_ event: [String: Any]) {
    let onState = self.onState
    callbacks.async { onState(event) }
  }

  // MARK: - Errors in words

  private static func rank(_ code: String) -> Int {
    switch code {
    case "not_paired", "pairing_expired", "disabled", "bad_hello", "wrong_computer": return 3
    case "local_network_denied": return 2
    case "refused", "timeout": return 1
    default: return 0
    }
  }

  private static func refusal(_ code: String) -> String {
    switch code {
    case "not_paired": return "This computer no longer knows this phone. Pair again."
    case "pairing_expired": return "The pairing code has expired or was already used. Show a new one."
    case "disabled": return "Phone access is turned off on the computer."
    default: return "The computer refused the link."
    }
  }

  private static func code(_ error: NWError) -> String {
    switch error {
    case .dns(let status) where status == -65570: return "local_network_denied"
    case .posix(.ECONNREFUSED): return "refused"
    case .posix(.ETIMEDOUT): return "timeout"
    case .posix(.ENETUNREACH), .posix(.EHOSTUNREACH), .posix(.ENETDOWN): return "unreachable"
    case .dns: return "not_found"
    default: return "network"
    }
  }

  private static func describe(_ error: NWError) -> String {
    switch code(error) {
    case "local_network_denied": return "TasteCode may not use the local network. Allow it in Settings › Privacy › Local Network."
    case "refused": return "The computer is not accepting phone links. Is TasteCode running with phone access on?"
    case "timeout": return "The computer did not answer."
    case "unreachable": return "The computer is not reachable from this network."
    case "not_found": return "The computer's address could not be found on this network."
    default: return error.localizedDescription
    }
  }
}
