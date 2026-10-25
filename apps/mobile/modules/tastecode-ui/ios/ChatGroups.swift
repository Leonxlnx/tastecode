import SwiftUI

enum Route: Hashable {
  case chat(String)
  case newChat(project: String?)
}

/// A run of chats under one heading: pinned ones, the ones that need you, then
/// one group per project in the order its newest chat comes, so a row never
/// has to repeat its project.
struct ChatGroup {
  let title: String
  let chats: [ChatView]
  /// Only projects fold away; what is pinned or needs you always shows.
  let foldable: Bool

  /// `seen`: whether a chat was on screen here since its last activity.
  static func groups(_ chats: [ChatView], seen: (ChatView) -> Bool) -> [ChatGroup] {
    let pinned = chats.filter(\.pinned)
    let rest = chats.filter { !$0.pinned }
    // A question or approval waits until answered; a failure only until it is seen.
    let waiting = rest.filter { $0.state.waitsForYou || ($0.state == .failed && !seen($0)) }
    var groups: [ChatGroup] = []
    if !pinned.isEmpty { groups.append(ChatGroup(title: "Pinned", chats: pinned, foldable: false)) }
    if !waiting.isEmpty { groups.append(ChatGroup(title: "Needs You", chats: waiting, foldable: false)) }
    var order: [String] = []
    var byProject: [String: [ChatView]] = [:]
    for chat in rest where !waiting.contains(chat) {
      if byProject[chat.projectName] == nil { order.append(chat.projectName) }
      byProject[chat.projectName, default: []].append(chat)
    }
    for name in order { groups.append(ChatGroup(title: name, chats: byProject[name] ?? [], foldable: true)) }
    return groups
  }
}

/// Which chats the list shows by what they are doing.
enum StatusFilter: CaseIterable {
  case all, needsYou, working, unread

  var title: String {
    switch self {
    case .all: return "Any Status"
    case .needsYou: return "Needs You"
    case .working: return "Working"
    case .unread: return "Unread"
    }
  }

  func includes(_ chat: ChatView) -> Bool {
    switch self {
    case .all: return true
    case .needsYou: return chat.state.waitsForYou
    case .working: return chat.state.isWorking
    case .unread: return chat.unread
    }
  }
}

/// "now", "4m", "2h", "Tue", "12 Oct": short enough for a row's edge.
func shortTime(_ date: Date, now: Date = .now) -> String {
  let minutes = Int(now.timeIntervalSince(date) / 60)
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h" }
  if hours < 24 * 6 { return date.formatted(.dateTime.weekday(.abbreviated)) }
  return date.formatted(.dateTime.day().month(.abbreviated))
}

extension View {
  /// A failure the person should read, as an alert with one OK.
  func problemAlert(_ problem: Binding<String?>) -> some View {
    alert(
      "Something went wrong",
      isPresented: Binding(get: { problem.wrappedValue != nil }, set: { if !$0 { problem.wrappedValue = nil } }),
      presenting: problem.wrappedValue
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { text in
      Text(text)
    }
  }
}
