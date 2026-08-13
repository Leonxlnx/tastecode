import Foundation

actor HarnessTransport {
  enum Signal: Sendable {
    case state(ConnectionState)
    case push(PushMessage)
    case endpoint(String)
    case sequenceGap
  }

  private let environment: PairedEnvironment
  private let signalHandler: @MainActor @Sendable (Signal) -> Void
  private var endpointIndex: Int
  private var socket: URLSessionWebSocketTask?
  private var session: URLSession?
  private var runner: Task<Void, Never>?
  private var stopped = true
  private var requestCounter = 0
  private var lastSequence = 0
  private var pending: [String: CheckedContinuation<JSONValue, any Error>] = [:]

  init(
    environment: PairedEnvironment,
    signalHandler: @escaping @MainActor @Sendable (Signal) -> Void
  ) {
    self.environment = environment
    self.signalHandler = signalHandler
    if let preferred = environment.preferredEndpoint,
      let index = environment.endpoints.firstIndex(of: preferred)
    {
      endpointIndex = index
    } else {
      endpointIndex = 0
    }
  }

  func start() {
    guard runner == nil else { return }
    stopped = false
    runner = Task { await runConnectionLoop() }
  }

  func stop() async {
    stopped = true
    runner?.cancel()
    runner = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    session?.invalidateAndCancel()
    session = nil
    failAll(with: CancellationError())
    await emit(.state(.closed))
  }

  func request(method: String, params: JSONValue = .object([:])) async throws -> JSONValue {
    guard let socket else {
      throw RPCFailure(message: "Harness is reconnecting.", detail: "Try again in a moment.")
    }
    requestCounter += 1
    let id = String(requestCounter)
    let envelope = JSONValue.object(
      ("id", .string(id)),
      ("method", .string(method)),
      ("params", params)
    )
    let data = try JSONEncoder().encode(envelope)
    guard let payload = String(data: data, encoding: .utf8) else {
      throw RPCFailure(message: "Couldn’t encode the request.", detail: nil)
    }

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        Task { await self.send(payload, requestID: id, over: socket) }
      }
    } onCancel: {
      Task { await self.cancelRequest(id) }
    }
  }

  private func runConnectionLoop() async {
    var reconnecting = false
    while !stopped && !Task.isCancelled {
      guard !environment.endpoints.isEmpty else {
        await emit(.state(.failed))
        return
      }

      let endpoint = environment.endpoints[endpointIndex]
      guard
        let url = PairingParser.deviceSocketURL(endpoint: endpoint, token: environment.deviceToken)
      else {
        await emit(.state(.failed))
        rotateEndpoint()
        reconnecting = true
        try? await Task.sleep(for: .milliseconds(800))
        continue
      }

      if !reconnecting { await emit(.state(.connecting)) }
      lastSequence = 0
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 15
      configuration.timeoutIntervalForResource = 60
      let nextSession = URLSession(configuration: configuration)
      let nextSocket = nextSession.webSocketTask(with: url)
      session = nextSession
      socket = nextSocket
      nextSocket.maximumMessageSize = 40 * 1_024 * 1_024
      nextSocket.resume()

      var announcedOpen = false
      do {
        while !stopped && !Task.isCancelled {
          let message = try await nextSocket.receive()
          if !announcedOpen {
            announcedOpen = true
            reconnecting = false
            await emit(.state(.open))
            await emit(.endpoint(endpoint))
          }
          switch message {
          case .string(let text): try await receive(text)
          case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else { continue }
            try await receive(text)
          @unknown default: continue
          }
        }
      } catch {
        if stopped || Task.isCancelled { break }
      }

      nextSocket.cancel(with: .goingAway, reason: nil)
      nextSession.invalidateAndCancel()
      if socket === nextSocket { socket = nil }
      if session === nextSession { session = nil }
      failAll(with: RPCFailure(message: "The Harness environment disconnected.", detail: nil))
      if stopped || Task.isCancelled { break }

      rotateEndpoint()
      reconnecting = true
      await emit(.state(announcedOpen ? .reconnecting : .failed))
      try? await Task.sleep(for: .milliseconds(800))
    }
    await emit(.state(.closed))
  }

  private func send(_ payload: String, requestID: String, over socket: URLSessionWebSocketTask)
    async
  {
    do {
      try await socket.send(.string(payload))
    } catch {
      failRequest(requestID, with: error)
    }
  }

  private func receive(_ text: String) async throws {
    guard let data = text.data(using: .utf8) else { return }
    let message = try JSONDecoder().decode(JSONValue.self, from: data)
    guard let object = message.objectValue else { return }

    if let id = object["id"]?.stringValue {
      guard let continuation = pending.removeValue(forKey: id) else { return }
      if let error = object["error"]?.objectValue {
        continuation.resume(
          throwing: RPCFailure(
            message: error["message"]?.stringValue ?? "Request failed.",
            detail: error["detail"]?.stringValue
          ))
      } else {
        continuation.resume(returning: object["result"] ?? .null)
      }
      return
    }

    guard let channel = object["channel"]?.stringValue,
      let sequence = object["sequence"]?.intValue,
      let payload = object["data"]
    else { return }
    if lastSequence != 0, sequence != lastSequence + 1 {
      await emit(.sequenceGap)
    }
    lastSequence = sequence
    await emit(.push(PushMessage(channel: channel, sequence: sequence, data: payload)))
  }

  private func rotateEndpoint() {
    endpointIndex = (endpointIndex + 1) % max(environment.endpoints.count, 1)
  }

  private func cancelRequest(_ id: String) {
    pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
  }

  private func failRequest(_ id: String, with error: any Error) {
    pending.removeValue(forKey: id)?.resume(throwing: error)
  }

  private func failAll(with error: any Error) {
    let continuations = pending.values
    pending.removeAll()
    for continuation in continuations {
      continuation.resume(throwing: error)
    }
  }

  private func emit(_ signal: Signal) async {
    await signalHandler(signal)
  }
}
