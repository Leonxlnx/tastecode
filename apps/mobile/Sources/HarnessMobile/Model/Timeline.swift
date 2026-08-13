import Foundation

struct TimelineItem: Identifiable, Equatable, Sendable {
  let id: String
  let turnID: String
  let type: String
  var status: String
  let role: String?
  var text: String
  let command: String?
  let exitCode: Int?
  let durationMs: Double?
  let path: String?
  let linesAdded: Int?
  let linesRemoved: Int?
  let createdAt: Double

  init?(json: JSONValue) {
    guard let id = json["id"]?.stringValue,
      let turnID = json["turnId"]?.stringValue,
      let type = json["type"]?.stringValue,
      let status = json["status"]?.stringValue,
      let createdAt = json["createdAt"]?.doubleValue
    else { return nil }
    self.id = id
    self.turnID = turnID
    self.type = type
    self.status = status
    role = json["role"]?.stringValue
    text = json["text"]?.stringValue ?? ""
    command = json["command"]?.stringValue
    exitCode = json["exitCode"]?.intValue
    durationMs = json["durationMs"]?.doubleValue
    path = json["path"]?.stringValue
    linesAdded = json["linesAdded"]?.intValue
    linesRemoved = json["linesRemoved"]?.intValue
    self.createdAt = createdAt
  }
}

struct TimelineTurn: Identifiable, Equatable, Sendable {
  let id: String
  let createdAt: Double
  var status: String
  var items: [TimelineItem] = []
  var plan: [PlanStep] = []
}

struct TimelineTurnPresentation: Equatable, Sendable {
  let userMessages: [TimelineItem]
  let workItems: [TimelineItem]
  let finalAnswer: TimelineItem?
  let elapsedMs: Double
  let complete: Bool
}

enum TimelineWorkBlock: Equatable, Identifiable, Sendable {
  case narrative(TimelineItem)
  case toolCalls([TimelineItem])

  var id: String {
    switch self {
    case .narrative(let item): item.id
    case .toolCalls(let items): "tools:\(items.map(\.id).joined(separator: ":"))"
    }
  }
}

/// Projects provider events into the same completed-turn hierarchy as the desktop renderer.
enum TimelineTranscriptPresentation {
  static func present(_ turn: TimelineTurn) -> TimelineTurnPresentation {
    let answerIndex = turn.items.lastIndex(where: isCompletedAnswer)
    let workItems: [TimelineItem] = turn.items.enumerated().compactMap { index, item in
      guard !item.isUserMessage, index != answerIndex else { return nil }
      return item
    }
    let earliest = turn.items.map(\.createdAt).min() ?? turn.createdAt
    let latest = turn.items.map(\.createdAt).max() ?? earliest
    let finalAnswer = answerIndex.map { turn.items[$0] }

    return TimelineTurnPresentation(
      userMessages: turn.items.filter(\.isUserMessage),
      workItems: workItems,
      finalAnswer: finalAnswer,
      elapsedMs: max(0, latest - earliest),
      complete: finalAnswer != nil && !workItems.contains { $0.status == "started" }
    )
  }

  static func workBlocks(from items: [TimelineItem]) -> [TimelineWorkBlock] {
    var blocks: [TimelineWorkBlock] = []
    var toolCalls: [TimelineItem] = []

    func flushToolCalls() {
      guard !toolCalls.isEmpty else { return }
      blocks.append(.toolCalls(toolCalls))
      toolCalls = []
    }

    for item in items {
      if item.isNarrative {
        guard item.hasVisibleText else { continue }
        flushToolCalls()
        blocks.append(.narrative(item))
      } else {
        toolCalls.append(item)
      }
    }
    flushToolCalls()
    return blocks
  }

  private static func isCompletedAnswer(_ item: TimelineItem) -> Bool {
    item.type == "message" && item.role == "assistant" && item.status == "completed"
      && item.hasVisibleText
  }
}

extension TimelineItem {
  var isUserMessage: Bool { type == "message" && role == "user" }

  fileprivate var isNarrative: Bool {
    (type == "message" && role == "assistant") || type == "reasoning"
  }

  fileprivate var hasVisibleText: Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

struct TimelineTextDelta: Equatable, Sendable {
  let turnID: String
  let itemID: String
  var text: String

  init(turnID: String, itemID: String, text: String) {
    self.turnID = turnID
    self.itemID = itemID
    self.text = text
  }

  init?(event: JSONValue) {
    guard event["type"]?.stringValue == "item.delta",
      let turnID = event["turnId"]?.stringValue,
      let itemID = event["itemId"]?.stringValue,
      let text = event["textDelta"]?.stringValue
    else { return nil }
    self.turnID = turnID
    self.itemID = itemID
    self.text = text
  }
}

struct TimelineDeltaBuffer: Equatable, Sendable {
  private var deltas: [TimelineTextDelta] = []

  var isEmpty: Bool { deltas.isEmpty }

  mutating func append(event: JSONValue) -> Bool {
    guard let delta = TimelineTextDelta(event: event) else { return false }
    if let index = deltas.lastIndex(where: {
      $0.turnID == delta.turnID && $0.itemID == delta.itemID
    }) {
      deltas[index].text.append(contentsOf: delta.text)
    } else {
      deltas.append(delta)
    }
    return true
  }

  mutating func drain() -> [TimelineTextDelta] {
    let drained = deltas
    deltas.removeAll(keepingCapacity: true)
    return drained
  }
}

struct PlanStep: Identifiable, Equatable, Sendable {
  let id: String
  let text: String
  let status: String
}

struct PendingApproval: Identifiable, Equatable, Sendable {
  let id: String
  let turnID: String?
  let kind: String
  let reason: String?
  let command: String?
  let cwd: String?
  let path: String?
  let createdAt: Double
}

struct UserInputOption: Identifiable, Equatable, Sendable {
  var id: String { label }
  let label: String
  let description: String
}

struct UserInputQuestion: Identifiable, Equatable, Sendable {
  let id: String
  let header: String
  let question: String
  let allowOther: Bool
  let secret: Bool
  let options: [UserInputOption]?
}

struct PendingUserInput: Identifiable, Equatable, Sendable {
  let id: String
  let turnID: String
  let questions: [UserInputQuestion]
  let createdAt: Double
}

struct ThreadTimeline: Equatable, Sendable {
  var turns: [TimelineTurn] = []
  var approvals: [PendingApproval] = []
  var userInputs: [PendingUserInput] = []
  var running = false
  var error: String?

  mutating func load(history: JSONValue) {
    self = ThreadTimeline()
    for entry in history["events"]?.arrayValue ?? [] {
      if let event = entry["event"] { apply(event: event) }
    }
    running = history["running"]?.boolValue ?? running
  }

  mutating func apply(event: JSONValue) {
    guard let type = event["type"]?.stringValue else { return }
    switch type {
    case "turn.started":
      guard let turn = event["turn"],
        let id = turn["id"]?.stringValue,
        let createdAt = turn["createdAt"]?.doubleValue
      else { return }
      upsertTurn(id: id, createdAt: createdAt, status: turn["status"]?.stringValue ?? "running")
      running = true
      error = nil
    case "item.started", "item.completed":
      guard let itemJSON = event["item"], let item = TimelineItem(json: itemJSON) else { return }
      upsert(item: item)
    case "item.delta":
      guard let delta = TimelineTextDelta(event: event) else { return }
      apply(delta: delta)
    case "turn.completed":
      guard let id = event["turnId"]?.stringValue else { return }
      if let index = turns.firstIndex(where: { $0.id == id }) {
        turns[index].status = event["status"]?.stringValue ?? "completed"
      }
      running = false
    case "thread.error":
      error = event["message"]?.stringValue ?? "The agent stopped with an error."
      running = false
    case "plan.updated":
      guard let turnID = event["turnId"]?.stringValue,
        let turnIndex = turns.firstIndex(where: { $0.id == turnID })
      else { return }
      turns[turnIndex].plan = (event["steps"]?.arrayValue ?? []).enumerated().compactMap {
        index, step in
        guard let text = step["text"]?.stringValue,
          let status = step["status"]?.stringValue
        else { return nil }
        return PlanStep(id: "\(turnID)-\(index)", text: text, status: status)
      }
    case "approval.requested":
      guard let request = event["request"],
        let id = request["id"]?.stringValue,
        let kind = request["kind"]?.stringValue,
        let createdAt = request["createdAt"]?.doubleValue
      else { return }
      approvals.removeAll { $0.id == id }
      approvals.append(
        PendingApproval(
          id: id,
          turnID: request["turnId"]?.stringValue,
          kind: kind,
          reason: request["reason"]?.stringValue,
          command: request["command"]?.stringValue,
          cwd: request["cwd"]?.stringValue,
          path: request["path"]?.stringValue,
          createdAt: createdAt
        ))
    case "approval.resolved":
      if let id = event["id"]?.stringValue { approvals.removeAll { $0.id == id } }
    case "user_input.requested":
      guard let request = event["request"],
        let input = PendingUserInput(json: request)
      else { return }
      userInputs.removeAll { $0.id == input.id }
      userInputs.append(input)
    case "user_input.resolved":
      if let id = event["id"]?.stringValue { userInputs.removeAll { $0.id == id } }
    default:
      break
    }
  }

  mutating func apply(delta: TimelineTextDelta) {
    guard let turnIndex = turns.firstIndex(where: { $0.id == delta.turnID }),
      let itemIndex = turns[turnIndex].items.firstIndex(where: { $0.id == delta.itemID })
    else { return }
    turns[turnIndex].items[itemIndex].text.append(contentsOf: delta.text)
  }

  private mutating func upsertTurn(id: String, createdAt: Double, status: String) {
    if let index = turns.firstIndex(where: { $0.id == id }) {
      turns[index].status = status
    } else {
      turns.append(TimelineTurn(id: id, createdAt: createdAt, status: status))
    }
  }

  private mutating func upsert(item: TimelineItem) {
    if !turns.contains(where: { $0.id == item.turnID }) {
      turns.append(TimelineTurn(id: item.turnID, createdAt: item.createdAt, status: "running"))
    }
    guard let turnIndex = turns.firstIndex(where: { $0.id == item.turnID }) else { return }
    if let itemIndex = turns[turnIndex].items.firstIndex(where: { $0.id == item.id }) {
      turns[turnIndex].items[itemIndex] = item
    } else {
      turns[turnIndex].items.append(item)
    }
  }
}

extension PendingUserInput {
  fileprivate init?(json: JSONValue) {
    guard let id = json["id"]?.stringValue,
      let turnID = json["turnId"]?.stringValue,
      let createdAt = json["createdAt"]?.doubleValue
    else { return nil }
    let questions = (json["questions"]?.arrayValue ?? []).compactMap(UserInputQuestion.init(json:))
    guard !questions.isEmpty else { return nil }
    self.init(id: id, turnID: turnID, questions: questions, createdAt: createdAt)
  }
}

extension UserInputQuestion {
  fileprivate init?(json: JSONValue) {
    guard let id = json["id"]?.stringValue,
      let header = json["header"]?.stringValue,
      let question = json["question"]?.stringValue
    else { return nil }
    let options = json["options"]?.arrayValue?.compactMap { option -> UserInputOption? in
      guard let label = option["label"]?.stringValue,
        let description = option["description"]?.stringValue
      else { return nil }
      return UserInputOption(label: label, description: description)
    }
    self.init(
      id: id,
      header: header,
      question: question,
      allowOther: json["allowOther"]?.boolValue ?? true,
      secret: json["secret"]?.boolValue ?? false,
      options: options
    )
  }
}
