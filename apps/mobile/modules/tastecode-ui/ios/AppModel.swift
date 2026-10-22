import Foundation
import Observation
import UIKit

struct ActionError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// Everything the screens show, as the phone's logic last sent it, and the way
/// back: actions it performs and requests it answers. The logic lives in
/// TypeScript (shared with Android); this side only draws and asks.
@MainActor @Observable
final class AppModel {
  static let shared = AppModel()

  /// Nil until the logic first reports; the screens stay blank instead of flashing pairing.
  var link: LinkView?
  var chats = ChatsView.empty
  var catalog = CatalogView.empty
  var newChat = NewChatView.empty

  @ObservationIgnored var emit: ((String, String) -> Void)?
  @ObservationIgnored private var threads: [String: ThreadStore] = [:]
  @ObservationIgnored private var openCounts: [String: Int] = [:]
  @ObservationIgnored private var pending: [String: CheckedContinuation<Data, Error>] = [:]
  @ObservationIgnored private var nextRequest = 0
  /// What was typed but not sent, per chat, while the app runs.
  @ObservationIgnored var drafts: [String: String] = [:]
  /// Pictures this phone attached, by the path the computer saved them under.
  @ObservationIgnored var images: [String: UIImage] = [:]

  private let decoder = JSONDecoder()

  func update(_ key: String, _ json: String) {
    let data = Data(json.utf8)
    do {
      switch key {
      case "link":
        let next = try decoder.decode(LinkView.self, from: data)
        if link != next { link = next }
      case "chats":
        let next = try decoder.decode(ChatsView.self, from: data)
        if chats != next { chats = next }
      case "catalog":
        let next = try decoder.decode(CatalogView.self, from: data)
        if catalog != next { catalog = next }
      case "newChat":
        let next = try decoder.decode(NewChatView.self, from: data)
        if newChat != next { newChat = next }
      default:
        guard key.hasPrefix("thread:") else { return }
        let id = String(key.dropFirst("thread:".count))
        thread(id).apply(try decoder.decode(ThreadPatch.self, from: data))
      }
    } catch {
      NSLog("TasteUI: could not read %@: %@", key, String(describing: error))
    }
  }

  // MARK: Chats on screen

  /// The chat's state as last sent; it fills in once the chat is opened.
  func thread(_ id: String) -> ThreadStore {
    if let store = threads[id] { return store }
    let store = ThreadStore(id: id)
    threads[id] = store
    return store
  }

  func openThread(_ id: String) {
    let count = openCounts[id, default: 0]
    openCounts[id] = count + 1
    if count == 0 { send(["type": "thread.open", "threadId": id]) }
  }

  func closeThread(_ id: String) {
    let count = openCounts[id, default: 0] - 1
    if count > 0 {
      openCounts[id] = count
      return
    }
    openCounts[id] = nil
    threads[id] = nil
    send(["type": "thread.close", "threadId": id])
  }

  // MARK: Actions and requests

  /// Tells the logic to do something without waiting for it.
  func send(_ action: [String: Any]) {
    emitAction("", action)
  }

  /// Asks the logic for something; throws its error sentence when it fails.
  func request(_ action: [String: Any]) async throws -> Data {
    nextRequest += 1
    let id = "r\(nextRequest)"
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      if !emitAction(id, action) {
        pending[id] = nil
        continuation.resume(throwing: ActionError(message: "The app could not send that request."))
      }
    }
  }

  func request<T: Decodable>(_ type: T.Type, _ action: [String: Any]) async throws -> T {
    try decoder.decode(T.self, from: try await request(action))
  }

  /// Fire-and-report: runs a request and hands any failure to `onError`.
  func perform(_ action: [String: Any], onError: @escaping (String) -> Void) {
    Task {
      do {
        _ = try await request(action)
      } catch {
        onError(error.localizedDescription)
      }
    }
  }

  func resolve(_ id: String, _ json: String?, _ error: String?) {
    guard let continuation = pending.removeValue(forKey: id) else { return }
    if let error {
      continuation.resume(throwing: ActionError(message: error))
    } else {
      continuation.resume(returning: Data((json ?? "null").utf8))
    }
  }

  @discardableResult
  private func emitAction(_ id: String, _ action: [String: Any]) -> Bool {
    guard let emit, JSONSerialization.isValidJSONObject(action),
      let data = try? JSONSerialization.data(withJSONObject: action),
      let json = String(data: data, encoding: .utf8)
    else { return false }
    emit(id, json)
    return true
  }
}

/// One open chat: its setup and state, and its rows, each observed on its own
/// so a streaming reply redraws only itself.
@MainActor @Observable
final class ThreadStore {
  let id: String
  var meta: ThreadMetaView?
  var order: [String] = []
  @ObservationIgnored private(set) var rows: [String: RowModel] = [:]

  init(id: String) {
    self.id = id
  }

  func apply(_ patch: ThreadPatch) {
    for row in patch.rows {
      if let existing = rows[row.key] {
        if existing.row != row { existing.row = row }
      } else {
        rows[row.key] = RowModel(row: row)
      }
    }
    if let next = patch.order {
      let keep = Set(next)
      rows = rows.filter { keep.contains($0.key) }
      if order != next { order = next }
    }
    if meta != patch.meta { meta = patch.meta }
  }
}

@MainActor @Observable
final class RowModel {
  var row: RowView

  init(row: RowView) {
    self.row = row
  }
}
