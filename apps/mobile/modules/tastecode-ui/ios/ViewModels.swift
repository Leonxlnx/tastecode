import Foundation

// What the phone's logic sends the screens, already worded. Mirrors
// `src/view/types.ts`; absent values arrive as null.

struct LinkView: Decodable, Equatable {
  enum Phase: String, Decodable { case idle, connecting, open, waiting, refused }

  var paired: Bool
  var pairing: Bool
  var computerName: String?
  var phase: Phase
  var host: String?
  var error: String?
  var computerKey: String?
  var phoneKey: String
}

enum ChatState: String, Decodable {
  case idle, starting, working, queued, approval, input, failed

  var waitsForYou: Bool { self == .approval || self == .input }
  var isWorking: Bool { self == .starting || self == .working || self == .queued }
}

struct ChatView: Decodable, Equatable, Identifiable {
  var id: String
  var title: String
  var projectPath: String
  var projectName: String
  var state: ChatState
  var unread: Bool
  var pinned: Bool
  var archived: Bool
  var at: Double
  var branch: String?

  var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

struct ProjectView: Decodable, Equatable, Identifiable {
  var path: String
  var name: String
  var pinned: Bool
  var chats: Int

  var id: String { path }
}

struct ChatsView: Decodable, Equatable {
  enum Status: String, Decodable { case idle, loading, ready, error }

  var status: Status
  var error: String?
  var projects: [ProjectView]
  var chats: [ChatView]

  static let empty = ChatsView(status: .idle, error: nil, projects: [], chats: [])
}

struct EffortView: Decodable, Equatable, Identifiable {
  var id: String
  var label: String
}

struct ModelView: Decodable, Equatable, Identifiable {
  var id: String
  var name: String
  var more: Bool
  var efforts: [EffortView]
}

struct AccessView: Decodable, Equatable, Identifiable {
  var mode: String
  var title: String
  var detail: String

  var id: String { mode }
}

struct SourceView: Decodable, Equatable, Identifiable {
  enum Status: String, Decodable { case loading, ready, error }

  var key: String
  var name: String
  var status: Status
  var images: Bool
  var models: [ModelView]
  var access: [AccessView]

  var id: String { key }
}

struct CatalogView: Decodable, Equatable {
  var status: ChatsView.Status
  var sources: [SourceView]

  static let empty = CatalogView(status: .idle, sources: [])

  func source(_ key: String?) -> SourceView? {
    sources.first { $0.key == key }
  }
}

struct SetupView: Decodable, Equatable {
  var sourceKey: String?
  var sourceName: String?
  var model: String?
  var modelName: String?
  var effort: String?
  var effortLabel: String?
  var access: String
  var accessTitle: String
  var images: Bool
  var switchable: Bool

  static let empty = SetupView(
    sourceKey: nil, sourceName: nil, model: nil, modelName: nil, effort: nil, effortLabel: nil,
    access: "ask", accessTitle: "Ask first", images: true, switchable: true)
}

struct StepView: Decodable, Equatable, Identifiable {
  enum Kind: String, Decodable { case command, file, tool, agent, thinking, plan, other }

  var id: String
  var kind: Kind
  var title: String
  var detail: String?
  var added: Int?
  var removed: Int?
  var running: Bool
  var failed: Bool
}

struct RowView: Decodable, Equatable, Identifiable {
  enum Kind: String, Decodable { case user, assistant, steps, notice, error }

  var key: String
  var kind: Kind
  var text: String?
  var attachments: [String]?
  var streaming: Bool?
  var live: Bool?
  var summary: String?
  var duration: String?
  var failed: Bool?
  var steps: [StepView]?

  var id: String { key }
}

struct ApprovalView: Decodable, Equatable, Identifiable {
  var id: String
  var title: String
  var subject: String?
  var reason: String?
  var `where`: String?
}

struct OptionView: Decodable, Equatable, Hashable {
  var label: String
  var detail: String
}

struct QuestionView: Decodable, Equatable, Identifiable {
  var id: String
  var header: String
  var question: String
  var options: [OptionView]
  var multiple: Bool
  var other: Bool
  var secret: Bool
}

struct QuestionsView: Decodable, Equatable, Identifiable {
  var id: String
  var questions: [QuestionView]
}

struct QueuedView: Decodable, Equatable, Identifiable {
  var id: String
  var text: String
}

struct PlanView: Decodable, Equatable, Hashable {
  var text: String
  var status: String
}

struct ChangesView: Decodable, Equatable {
  var files: Int
  var added: Int
  var removed: Int
}

struct ThreadMetaView: Decodable, Equatable {
  enum Status: String, Decodable { case loading, ready, error }

  var id: String
  var title: String
  var projectName: String?
  var projectPath: String?
  var pinned: Bool
  var archived: Bool
  var status: Status
  var error: String?
  var running: Bool
  var waiting: Bool
  var hasOlder: Bool
  var loadingOlder: Bool
  var setup: SetupView
  var approval: ApprovalView?
  var questions: QuestionsView?
  var queue: [QueuedView]
  var canSteer: Bool
  var plan: [PlanView]
  var changes: ChangesView?
}

struct ThreadPatch: Decodable {
  var meta: ThreadMetaView
  var rows: [RowView]
  var order: [String]?
  var reset: Bool
}

struct NewChatView: Decodable, Equatable {
  var projectPath: String?
  var projectName: String?
  var isolate: Bool
  var setup: SetupView

  static let empty = NewChatView(projectPath: nil, projectName: nil, isolate: false, setup: .empty)
}

// Answers to requests.

struct BrowsedFolder: Decodable, Equatable, Identifiable {
  var name: String
  var path: String
  var repository: Bool
  var added: Bool

  var id: String { path }
}

struct BrowseRoot: Decodable, Equatable, Identifiable {
  var name: String
  var path: String

  var id: String { path }
}

struct BrowseResult: Decodable, Equatable {
  var path: String
  var parent: String?
  var home: String
  var roots: [BrowseRoot]
  var folders: [BrowsedFolder]
  var truncated: Bool
}

struct DiffLine: Decodable, Equatable {
  var kind: String
  var text: String
}

struct DiffHunk: Decodable, Equatable, Identifiable {
  var id: String
  var header: String?
  var oldStart: Int
  var newStart: Int
  var lines: [DiffLine]
}

struct DiffFile: Decodable, Equatable, Identifiable {
  var path: String
  var previousPath: String?
  var status: String
  var binary: Bool
  var hunks: [DiffHunk]

  var id: String { path }
  var added: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == "addition" }.count } }
  var removed: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == "deletion" }.count } }
}

struct SessionDiff: Decodable, Equatable {
  var files: [DiffFile]
}

struct SavedImage: Decodable {
  var path: String
}

struct StartedChat: Decodable {
  var threadId: String
}
