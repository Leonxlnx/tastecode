import Foundation
import Observation
import SwiftUI
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
  /// Pictures in chats, by the path the computer keeps them under: the ones
  /// this phone attached, and the ones read from the computer to show.
  var images: [String: UIImage] = [:]
  @ObservationIgnored private var loadingImages: Set<String> = []
  /// Paths the computer could not give, so a row does not ask again and again.
  private(set) var missingImages: Set<String> = []

  private let decoder = JSONDecoder()

  /// State the logic sent, read from its JSON off the main thread.
  enum Update {
    case link(LinkView)
    case chats(ChatsView)
    case catalog(CatalogView)
    case newChat(NewChatView)
    case thread(String, ThreadPatch)
  }

  private nonisolated(unsafe) static let backgroundDecoder = JSONDecoder()

  /// Reads one piece of state. Called on one serial queue only, so a long
  /// chat's first page never holds up the main thread.
  nonisolated static func decode(_ key: String, _ json: String) -> Update? {
    let data = Data(json.utf8)
    let decoder = backgroundDecoder
    do {
      switch key {
      case "link": return .link(try decoder.decode(LinkView.self, from: data))
      case "chats": return .chats(try decoder.decode(ChatsView.self, from: data))
      case "catalog": return .catalog(try decoder.decode(CatalogView.self, from: data))
      case "newChat": return .newChat(try decoder.decode(NewChatView.self, from: data))
      default:
        guard key.hasPrefix("thread:") else { return nil }
        return .thread(String(key.dropFirst("thread:".count)), try decoder.decode(ThreadPatch.self, from: data))
      }
    } catch {
      NSLog("TasteUI: could not read %@: %@", key, String(describing: error))
      return nil
    }
  }

  func apply(_ update: Update) {
    switch update {
    case .link(let next): if link != next { link = next }
    case .chats(let next): if chats != next { chats = next }
    case .catalog(let next): if catalog != next { catalog = next }
    case .newChat(let next): if newChat != next { newChat = next }
    case .thread(let id, let patch): thread(id).apply(patch)
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

  /// Each chat's last activity when it was last on screen here, so a chat that
  /// failed leaves Needs You once seen and comes back only when something new
  /// happens in it. Kept on this phone across launches.
  private(set) var seenChats: [String: Double] =
    UserDefaults.standard.dictionary(forKey: "seenChats") as? [String: Double] ?? [:]

  /// Whether the chat was on screen here since its last activity.
  func seen(_ chat: ChatView) -> Bool {
    (seenChats[chat.id] ?? -1) >= chat.at
  }

  func markSeen(_ id: String) {
    guard let chat = chats.chats.first(where: { $0.id == id }), seenChats[id] != chat.at else { return }
    seenChats[id] = chat.at
    // Chats gone from the computer are forgotten here too.
    let known = Set(chats.chats.map(\.id))
    seenChats = seenChats.filter { known.contains($0.key) }
    UserDefaults.standard.set(seenChats, forKey: "seenChats")
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

  /// Reads a picture a chat's message attached from the computer, once.
  func loadImage(threadId: String, path: String) async {
    guard images[path] == nil, !missingImages.contains(path), !loadingImages.contains(path) else { return }
    loadingImages.insert(path)
    defer { loadingImages.remove(path) }
    do {
      let read = try await request(
        AttachedImage.self, ["type": "attachment.read", "threadId": threadId, "path": path])
      // Decoded off the main thread and ready to draw, so the frame that first
      // shows it does not stop to unpack it.
      let decoded = await Task.detached(priority: .userInitiated) { () -> UIImage? in
        guard let data = Data(base64Encoded: read.data), let image = UIImage(data: data) else { return nil }
        let scaled = image.scaledForUpload()
        return scaled.preparingForDisplay() ?? scaled
      }.value
      guard let decoded else {
        missingImages.insert(path)
        return
      }
      images[path] = decoded
    } catch {
      missingImages.insert(path)
    }
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

/// One open chat: its setup and state, and its rows. The transcript hears
/// exactly which rows changed, so a streaming reply lays out only itself.
@MainActor @Observable
final class ThreadStore {
  let id: String
  var meta: ThreadMetaView?
  var order: [String] = []
  @ObservationIgnored private(set) var rows: [String: RowModel] = [:]
  @ObservationIgnored var onChange: ((ThreadChange) -> Void)?

  init(id: String) {
    self.id = id
  }

  func apply(_ patch: ThreadPatch) {
    var change = ThreadChange(reset: patch.reset)
    for row in patch.rows {
      if let existing = rows[row.key] {
        guard existing.row != row else { continue }
        existing.row = row
      } else {
        rows[row.key] = RowModel(row: row)
      }
      change.rows.insert(row.key)
    }
    if let next = patch.order {
      let keep = Set(next)
      rows = rows.filter { keep.contains($0.key) }
      // Rows only go away when a turn folds its work under "Worked for"; that change is animated.
      change.folding = !patch.reset && order.contains { !keep.contains($0) }
      if order != next {
        order = next
        change.orderChanged = true
      }
    }
    if meta != patch.meta {
      meta = patch.meta
      change.metaChanged = true
    }
    onChange?(change)
  }
}

@MainActor @Observable
final class RowModel {
  var row: RowView
  /// Which of its folds are open: kept here, since the transcript drops rows
  /// scrolled out of view and would close them on the way back.
  var expanded = false
  var openRuns: Set<String> = []

  init(row: RowView) {
    self.row = row
  }
}
