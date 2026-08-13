import Foundation

enum ProviderID: String, Codable, CaseIterable, Identifiable, Sendable {
  case codex
  case claudeCode = "claude-code"
  case grok
  case cursor
  case opencode
  case antigravity
  case acp
  case api

  var id: String { rawValue }

  var fallbackName: String {
    switch self {
    case .codex: "Codex"
    case .claudeCode: "Claude Code"
    case .grok: "Grok"
    case .cursor: "Cursor"
    case .opencode: "OpenCode"
    case .antigravity: "Antigravity"
    case .acp: "ACP"
    case .api: "API"
    }
  }
}

struct ProviderCapabilities: Codable, Equatable, Sendable {
  let steer: Bool
  let fork: Bool
  let interrupt: Bool
  let reasoningItems: Bool
  let approvals: Bool
  let userInput: Bool?
  let autoReview: Bool?
  let images: Bool
}

struct ProviderStatus: Codable, Identifiable, Equatable, Sendable {
  let id: ProviderID
  let displayName: String
  let installed: Bool
  let version: String?
  let auth: String
  let capabilities: ProviderCapabilities?
  let problem: String?
}

struct ACPAgent: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let name: String
  let installed: Bool
  let verified: Bool
  let install: String?
}

struct ServiceTier: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let name: String
  let description: String
}

struct ModelOption: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let displayName: String
  let description: String?
  let isDefault: Bool
  let reasoningEfforts: [String]
  let defaultReasoningEffort: String?
  let serviceTiers: [ServiceTier]
  let defaultServiceTier: String?

  init(
    id: String,
    displayName: String,
    description: String? = nil,
    isDefault: Bool,
    reasoningEfforts: [String],
    defaultReasoningEffort: String? = nil,
    serviceTiers: [ServiceTier] = [],
    defaultServiceTier: String? = nil
  ) {
    self.id = id
    self.displayName = displayName
    self.description = description
    self.isDefault = isDefault
    self.reasoningEfforts = reasoningEfforts
    self.defaultReasoningEffort = defaultReasoningEffort
    self.serviceTiers = serviceTiers
    self.defaultServiceTier = defaultServiceTier
  }

  private enum CodingKeys: String, CodingKey {
    case id, displayName, description, isDefault, reasoningEfforts
    case defaultReasoningEffort, serviceTiers, defaultServiceTier
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    displayName = try container.decode(String.self, forKey: .displayName)
    description = try container.decodeIfPresent(String.self, forKey: .description)
    isDefault = try container.decode(Bool.self, forKey: .isDefault)
    reasoningEfforts = try container.decodeIfPresent([String].self, forKey: .reasoningEfforts) ?? []
    defaultReasoningEffort = try container.decodeIfPresent(
      String.self, forKey: .defaultReasoningEffort)
    serviceTiers = try container.decodeIfPresent([ServiceTier].self, forKey: .serviceTiers) ?? []
    defaultServiceTier = try container.decodeIfPresent(String.self, forKey: .defaultServiceTier)
  }
}

enum ThreadLifecycleState: String, Codable, Hashable, Sendable {
  case active
  case settled
  case snoozed
}

struct ThreadLifecycle: Codable, Equatable, Sendable {
  let state: ThreadLifecycleState
  let keepActive: Bool?
  let wokeAt: Double?
  let settledAt: Double?
  let reason: String?
  let snoozedAt: Double?
  let wakeAt: Double?
}

struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
  let id: String
  var title: String
  let provider: ProviderID
  let agent: String?
  let createdAt: Double
  var running: Bool
  var status: String?
  var unread: Bool?
  var lifecycle: ThreadLifecycle?
  let closedAt: Double?
  let worktreeBranch: String?

  static func == (lhs: ThreadSummary, rhs: ThreadSummary) -> Bool { lhs.id == rhs.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct ProjectRecord: Codable, Identifiable, Hashable, Sendable {
  var id: String { path }
  let path: String
  let name: String
  let pinned: Bool
  let createdAt: Double
  var sessions: [ThreadSummary]

  static func == (lhs: ProjectRecord, rhs: ProjectRecord) -> Bool { lhs.path == rhs.path }
  func hash(into hasher: inout Hasher) { hasher.combine(path) }
}

enum ProjectDirectoryEntryKind: String, Codable, Sendable {
  case directory
  case file
}

struct ProjectDirectoryEntry: Codable, Identifiable, Equatable, Sendable {
  var id: String { path }
  let path: String
  let name: String
  let kind: ProjectDirectoryEntryKind
  let modifiedAt: Double
}

struct ProjectDirectoryListing: Codable, Equatable, Sendable {
  let path: String
  let name: String
  let parent: String?
  let entries: [ProjectDirectoryEntry]
}

struct AddedProjectResponse: Codable, Sendable {
  let path: String
  let name: String
  let pinned: Bool
  let createdAt: Double
}

enum EnvironmentIcon: String, Codable, CaseIterable, Identifiable, Sendable {
  case desktop = "desktopcomputer"
  case laptop = "laptopcomputer"
  case macBook = "macbook"
  case server = "server.rack"
  case storage = "externaldrive.connected.to.line.below"
  case terminal
  case network
  case home = "house"

  var id: String { rawValue }
}

enum EnvironmentAccent: String, Codable, CaseIterable, Identifiable, Sendable {
  case blue
  case indigo
  case purple
  case pink
  case red
  case orange
  case green
  case teal

  var id: String { rawValue }
}

struct PairedEnvironment: Codable, Identifiable, Equatable, Sendable {
  var id: String { deviceId }
  let deviceId: String
  let deviceToken: String
  var serverName: String
  var endpoints: [String]
  var preferredEndpoint: String?
  var customName: String?
  var icon: EnvironmentIcon?
  var accent: EnvironmentAccent?

  var displayName: String {
    if let customName {
      let trimmed = customName.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { return trimmed }
    }
    return serverName
  }

  var displayIcon: EnvironmentIcon { icon ?? .desktop }
  var displayAccent: EnvironmentAccent { accent ?? .blue }

  init(
    deviceId: String,
    deviceToken: String,
    serverName: String,
    endpoints: [String],
    preferredEndpoint: String?,
    customName: String? = nil,
    icon: EnvironmentIcon? = nil,
    accent: EnvironmentAccent? = nil
  ) {
    self.deviceId = deviceId
    self.deviceToken = deviceToken
    self.serverName = serverName
    self.endpoints = endpoints
    self.preferredEndpoint = preferredEndpoint
    self.customName = customName
    self.icon = icon
    self.accent = accent
  }
}

enum ApprovalMode: String, Codable, CaseIterable, Identifiable, Sendable {
  case ask
  case auto
  case autoReview = "auto-review"
  case full

  var id: String { rawValue }

  var label: String {
    switch self {
    case .ask: "Approve actions"
    case .auto: "Auto-accept edits"
    case .autoReview: "Auto review"
    case .full: "Full access"
    }
  }
}

enum InteractionMode: String, Codable, CaseIterable, Identifiable, Sendable {
  case standard
  case plan

  var id: String { rawValue }
  var label: String { self == .standard ? "Default" : "Plan" }
}

struct ComposerPreferences: Codable, Equatable, Sendable {
  var provider: ProviderID = .codex
  var agentID: String?
  var modelID: String?
  var effort: String?
  var serviceTier: String?
  var approval: ApprovalMode = .full
  var interaction: InteractionMode = .standard
  var isolate = false
  var designMode = false

  init(
    provider: ProviderID = .codex,
    agentID: String? = nil,
    modelID: String? = nil,
    effort: String? = nil,
    serviceTier: String? = nil,
    approval: ApprovalMode = .full,
    interaction: InteractionMode = .standard,
    isolate: Bool = false,
    designMode: Bool = false
  ) {
    self.provider = provider
    self.agentID = agentID
    self.modelID = modelID
    self.effort = effort
    self.serviceTier = serviceTier
    self.approval = approval
    self.interaction = interaction
    self.isolate = isolate
    self.designMode = designMode
  }

  private enum CodingKeys: String, CodingKey {
    case provider, agentID, modelID, effort, serviceTier, approval, interaction, isolate, designMode
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    provider = try container.decodeIfPresent(ProviderID.self, forKey: .provider) ?? .codex
    agentID = try container.decodeIfPresent(String.self, forKey: .agentID)
    modelID = try container.decodeIfPresent(String.self, forKey: .modelID)
    effort = try container.decodeIfPresent(String.self, forKey: .effort)
    serviceTier = try container.decodeIfPresent(String.self, forKey: .serviceTier)
    approval = try container.decodeIfPresent(ApprovalMode.self, forKey: .approval) ?? .full
    interaction =
      try container.decodeIfPresent(InteractionMode.self, forKey: .interaction) ?? .standard
    isolate = try container.decodeIfPresent(Bool.self, forKey: .isolate) ?? false
    designMode = try container.decodeIfPresent(Bool.self, forKey: .designMode) ?? false
  }
}

struct AppPreferences: Codable, Equatable, Sendable {
  var activeEnvironmentID: String?
  var lastProjectPath: String?
  var showSettledThreads = true
  var hapticsEnabled = true
  var composer = ComposerPreferences()

  init(
    activeEnvironmentID: String? = nil,
    lastProjectPath: String? = nil,
    showSettledThreads: Bool = true,
    hapticsEnabled: Bool = true,
    composer: ComposerPreferences = ComposerPreferences()
  ) {
    self.activeEnvironmentID = activeEnvironmentID
    self.lastProjectPath = lastProjectPath
    self.showSettledThreads = showSettledThreads
    self.hapticsEnabled = hapticsEnabled
    self.composer = composer
  }

  private enum CodingKeys: String, CodingKey {
    case activeEnvironmentID, lastProjectPath, showSettledThreads, hapticsEnabled
    case composer
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    activeEnvironmentID = try container.decodeIfPresent(String.self, forKey: .activeEnvironmentID)
    lastProjectPath = try container.decodeIfPresent(String.self, forKey: .lastProjectPath)
    showSettledThreads =
      try container.decodeIfPresent(Bool.self, forKey: .showSettledThreads) ?? true
    hapticsEnabled = try container.decodeIfPresent(Bool.self, forKey: .hapticsEnabled) ?? true
    composer =
      try container.decodeIfPresent(ComposerPreferences.self, forKey: .composer)
      ?? ComposerPreferences()
  }
}

struct ProjectsResponse: Codable, Sendable { let projects: [ProjectRecord] }
struct ThreadLifecycleResponse: Codable, Sendable { let lifecycle: ThreadLifecycle }
struct ProvidersResponse: Codable, Sendable { let providers: [ProviderStatus] }
struct ModelsResponse: Codable, Sendable { let models: [ModelOption] }
struct ACPAgentsResponse: Codable, Sendable { let agents: [ACPAgent] }
struct BranchesResponse: Codable, Sendable { let branches: [String] }

struct WorkspaceInfo: Codable, Sendable {
  let branch: String?
  let added: Int
  let removed: Int
  let dirtyFiles: Int
}

struct QueuedTurn: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let text: String
  let attachments: [String]
  let createdAt: Double
}

struct ThreadQueue: Codable, Equatable, Sendable {
  let items: [QueuedTurn]
  let canSteer: Bool
}

struct AttachmentDraft: Identifiable, Equatable, Sendable {
  let id = UUID()
  let name: String
  let mimeType: String
  let data: Data
}

enum ConnectionState: String, Sendable {
  case connecting
  case open
  case reconnecting
  case failed
  case closed
}

struct PushMessage: Equatable, Sendable {
  let channel: String
  let sequence: Int
  let data: JSONValue
}

struct ThreadRoute: Hashable, Sendable {
  let project: ProjectRecord
  let thread: ThreadSummary
}
