import Foundation
import UIKit

@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var isReady = false
  @Published private(set) var environments: [PairedEnvironment] = []
  @Published private(set) var activeEnvironment: PairedEnvironment?
  @Published private(set) var connectionState: ConnectionState = .closed
  @Published private(set) var projects: [ProjectRecord] = []
  @Published private(set) var providers: [ProviderStatus] = []
  @Published private(set) var agents: [ACPAgent] = []
  @Published private(set) var modelsByProvider: [ProviderID: [ModelOption]] = [:]
  @Published private(set) var preferences = AppPreferences()
  @Published private(set) var pendingThreadLifecycleIDs: Set<String> = []
  @Published var pairingLink: String?
  @Published var errorMessage: String?

  private let vault = CredentialVault()
  private let preferencesStore = PreferencesStore()
  private var transport: HarnessTransport?
  private var refreshTask: Task<Void, Never>?
  private var pushObservers: [UUID: AsyncStream<PushMessage>.Continuation] = [:]
  private var bootstrapped = false

  func bootstrap() async {
    guard !bootstrapped else { return }
    bootstrapped = true
    preferences = preferencesStore.load()
    do {
      environments = try vault.load()
    } catch {
      errorMessage = error.localizedDescription
    }
    let selected =
      environments.first { $0.id == preferences.activeEnvironmentID } ?? environments.first
    isReady = true
    if let selected { await activate(selected) }
  }

  func receive(url: URL) {
    guard url.scheme == "harness", url.host == "pair" else { return }
    pairingLink = url.absoluteString
  }

  func pair(using link: String) async throws {
    var environment = try await PairingClient.claim(link: link, deviceName: UIDevice.current.name)
    if let index = environments.firstIndex(where: { $0.deviceId == environment.deviceId }) {
      environment.customName = environments[index].customName
      environment.icon = environments[index].icon
      environment.accent = environments[index].accent
      environments[index] = environment
    } else {
      environments.append(environment)
    }
    try vault.save(environments)
    pairingLink = nil
    await activate(environment)
  }

  func activate(_ environment: PairedEnvironment) async {
    refreshTask?.cancel()
    refreshTask = nil
    if let transport { await transport.stop() }
    transport = nil
    projects = []
    providers = []
    agents = []
    modelsByProvider = [:]
    activeEnvironment = environment
    connectionState = .connecting
    preferences.activeEnvironmentID = environment.id
    preferencesStore.save(preferences)

    let next = HarnessTransport(environment: environment) { [weak self] signal in
      self?.receive(signal: signal)
    }
    transport = next
    await next.start()
  }

  func reconnect() async {
    guard let environment = activeEnvironment else { return }
    await activate(environment)
  }

  private func disconnect() async {
    if let transport { await transport.stop() }
    transport = nil
    connectionState = .closed
  }

  func removeEnvironment(_ environment: PairedEnvironment) async throws {
    let remaining = environments.filter { $0.id != environment.id }
    try vault.save(remaining)
    environments = remaining
    guard activeEnvironment?.id == environment.id else { return }
    if let replacement = environments.first {
      await activate(replacement)
    } else {
      await disconnect()
      activeEnvironment = nil
      projects = []
      providers = []
      agents = []
      modelsByProvider = [:]
      preferences.activeEnvironmentID = nil
      preferencesStore.save(preferences)
    }
  }

  func updateEnvironmentAppearance(
    id: String,
    name: String,
    icon: EnvironmentIcon,
    accent: EnvironmentAccent
  ) {
    guard let index = environments.firstIndex(where: { $0.id == id }) else { return }
    var updatedEnvironments = environments
    var environment = updatedEnvironments[index]
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    environment.customName =
      trimmedName.isEmpty || trimmedName == environment.serverName ? nil : trimmedName
    environment.icon = icon == .desktop ? nil : icon
    environment.accent = accent == .blue ? nil : accent
    updatedEnvironments[index] = environment
    do {
      try vault.save(updatedEnvironments)
      environments = updatedEnvironments
      if activeEnvironment?.id == environment.id {
        activeEnvironment = environment
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func request(_ method: String, params: JSONValue = .object([:])) async throws -> JSONValue {
    guard let transport else {
      throw RPCFailure(message: "Connect a Harness environment first.", detail: nil)
    }
    return try await transport.request(method: method, params: params)
  }

  func request<T: Decodable>(
    _ method: String,
    params: JSONValue = .object([:]),
    as type: T.Type = T.self
  ) async throws -> T {
    try await request(method, params: params).decoded(as: type)
  }

  func refreshEverything() async {
    guard connectionState == .open else { return }
    do {
      async let projectRequest: ProjectsResponse = request(
        "projects.list", as: ProjectsResponse.self)
      async let providerRequest: ProvidersResponse = request(
        "providers.list", as: ProvidersResponse.self)
      let (projectResponse, providerResponse) = try await (projectRequest, providerRequest)
      projects = projectResponse.projects
      providers = providerResponse.providers
      if providerResponse.providers.contains(where: { $0.id == .acp && $0.installed }) {
        let response = try? await request("acp.agents", as: ACPAgentsResponse.self)
        agents = response?.agents ?? []
      } else {
        agents = []
      }

      var catalogs: [ProviderID: [ModelOption]] = [:]
      for provider in providerResponse.providers where provider.installed {
        let response = try? await request(
          "models.list",
          params: .object(["provider": .string(provider.id.rawValue)]),
          as: ModelsResponse.self
        )
        catalogs[provider.id] = response?.models ?? []
      }
      modelsByProvider = catalogs
      normalizeComposerPreferences()
      await refreshEnvironmentRoutes()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func refreshProjects() async {
    guard connectionState == .open else { return }
    do {
      let response: ProjectsResponse = try await request("projects.list", as: ProjectsResponse.self)
      projects = response.projects
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func browseProjectDirectory(at path: String? = nil) async throws -> ProjectDirectoryListing {
    let params: JSONValue = path.map { .object(["path": .string($0)]) } ?? .object([:])
    return try await request("projects.browse", params: params, as: ProjectDirectoryListing.self)
  }

  func addProject(at path: String) async throws -> ProjectRecord {
    let response: AddedProjectResponse = try await request(
      "projects.add",
      params: .object(["path": .string(path)]),
      as: AddedProjectResponse.self
    )
    let existingSessions = projects.first { $0.path == response.path }?.sessions ?? []
    let project = ProjectRecord(
      path: response.path,
      name: response.name,
      pinned: response.pinned,
      createdAt: response.createdAt,
      sessions: existingSessions
    )

    if let index = projects.firstIndex(where: { $0.path == response.path }) {
      projects[index] = project
    } else {
      projects.append(project)
    }
    return project
  }

  func applyThreadLifecycle(_ lifecycle: ThreadLifecycle, to threadID: String) {
    projects = ProjectThreadState.applying(lifecycle, to: threadID, in: projects)
  }

  func transitionThreadLifecycle(_ action: ThreadLifecycleAction, threadID: String) async {
    guard pendingThreadLifecycleIDs.insert(threadID).inserted else { return }
    defer { pendingThreadLifecycleIDs.remove(threadID) }

    let previous = ProjectThreadState.lifecycle(for: threadID, in: projects)
    applyThreadLifecycle(action.projectedLifecycle(), to: threadID)

    do {
      let response: ThreadLifecycleResponse = try await request(
        action.method,
        params: .object(["threadId": .string(threadID)]),
        as: ThreadLifecycleResponse.self
      )
      applyThreadLifecycle(response.lifecycle, to: threadID)
    } catch {
      projects = ProjectThreadState.applying(previous, to: threadID, in: projects)
      let message = error.localizedDescription
      await refreshProjects()
      guard lifecycleState(for: threadID) != action.expectedState else { return }
      errorMessage = message
    }
  }

  func threadLifecycleUpdateIsPending(_ threadID: String) -> Bool {
    pendingThreadLifecycleIDs.contains(threadID)
  }

  func lifecycleState(for threadID: String) -> ThreadLifecycleState? {
    ProjectThreadState.lifecycleState(for: threadID, in: projects)
  }

  func updatePreferences(_ update: (inout AppPreferences) -> Void) {
    update(&preferences)
    preferencesStore.save(preferences)
  }

  func pushStream() -> AsyncStream<PushMessage> {
    let id = UUID()
    return AsyncStream { continuation in
      pushObservers[id] = continuation
      continuation.onTermination = { @Sendable [weak self] _ in
        Task { @MainActor in self?.pushObservers.removeValue(forKey: id) }
      }
    }
  }

  func resetInterfacePreferences() {
    let environmentID = activeEnvironment?.id
    preferences = AppPreferences(activeEnvironmentID: environmentID)
    preferencesStore.save(preferences)
    normalizeComposerPreferences()
  }

  func models(for provider: ProviderID) -> [ModelOption] {
    modelsByProvider[provider] ?? []
  }

  func selectedModel(for provider: ProviderID? = nil) -> ModelOption? {
    let resolvedProvider = provider ?? preferences.composer.provider
    let models = models(for: resolvedProvider)
    return models.first { $0.id == preferences.composer.modelID }
      ?? models.first { $0.isDefault }
      ?? models.first
  }

  func selectedAgent() -> ACPAgent? {
    agents.first { $0.id == preferences.composer.agentID && $0.installed }
      ?? agents.first { $0.installed }
  }

  func upload(_ attachment: AttachmentDraft) async throws -> String {
    let limit = 25 * 1_024 * 1_024
    guard attachment.data.count <= limit else {
      throw RPCFailure(message: "\(attachment.name) is larger than 25 MB.", detail: nil)
    }
    let encoded = await Task.detached(priority: .userInitiated) {
      attachment.data.base64EncodedString()
    }.value
    let result = try await request(
      "attachments.saveFile",
      params: .object([
        "name": .string(attachment.name),
        "mimeType": .string(attachment.mimeType),
        "data": .string(encoded),
      ]))
    guard let path = result["path"]?.stringValue else {
      throw RPCFailure(message: "The server didn’t return an attachment path.", detail: nil)
    }
    return path
  }

  func clearError() {
    errorMessage = nil
  }

  private func receive(signal: HarnessTransport.Signal) {
    switch signal {
    case .state(let state):
      connectionState = state
      if state == .open {
        refreshTask?.cancel()
        refreshTask = Task { await refreshEverything() }
      }
    case .push(let push):
      for observer in pushObservers.values { observer.yield(push) }
      if push.channel == "thread.lifecycle" {
        if let threadID = push.data["threadId"]?.stringValue,
          let lifecycleValue = push.data["lifecycle"],
          let lifecycle = try? lifecycleValue.decoded(as: ThreadLifecycle.self)
        {
          applyThreadLifecycle(lifecycle, to: threadID)
        }
        scheduleProjectRefresh()
      } else if push.channel == "sidebar.settings" {
        scheduleProjectRefresh()
      } else if push.channel == "thread.event",
        let type = push.data["event"]?["type"]?.stringValue,
        ["turn.started", "turn.completed", "thread.error"].contains(type)
      {
        scheduleProjectRefresh()
      }
    case .endpoint(let endpoint):
      guard var environment = activeEnvironment,
        environment.preferredEndpoint != endpoint
      else { return }
      environment.preferredEndpoint = endpoint
      replaceEnvironment(environment)
    case .sequenceGap:
      refreshTask?.cancel()
      refreshTask = Task { await refreshEverything() }
    }
  }

  private func scheduleProjectRefresh() {
    refreshTask?.cancel()
    refreshTask = Task {
      try? await Task.sleep(for: .milliseconds(120))
      guard !Task.isCancelled else { return }
      await refreshProjects()
    }
  }

  private func refreshEnvironmentRoutes() async {
    guard var environment = activeEnvironment else { return }
    guard let result = try? await request("connections.deviceStatus"),
      let addresses = result["addresses"]?.arrayValue
    else { return }
    let discovered = addresses.compactMap { $0["url"]?.stringValue }
      .filter(PairingParser.endpointIsAllowed)
    let merged = (discovered + environment.endpoints).reduce(into: [String]()) { values, endpoint in
      if !values.contains(endpoint) { values.append(endpoint) }
    }
    environment.serverName = result["serverName"]?.stringValue ?? environment.serverName
    environment.endpoints = merged
    replaceEnvironment(environment)
  }

  private func replaceEnvironment(_ environment: PairedEnvironment) {
    activeEnvironment = environment
    if let index = environments.firstIndex(where: { $0.id == environment.id }) {
      environments[index] = environment
    }
    do {
      try vault.save(environments)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func normalizeComposerPreferences() {
    let installed = providers.filter(\.installed)
    let provider =
      installed.contains { $0.id == preferences.composer.provider }
      ? preferences.composer.provider
      : (installed.first?.id ?? preferences.composer.provider)
    let options = models(for: provider)
    let selected =
      options.first { $0.id == preferences.composer.modelID }
      ?? options.first { $0.isDefault }
      ?? options.first
    updatePreferences { value in
      value.composer.provider = provider
      if provider == .acp {
        value.composer.agentID =
          agents.first {
            $0.id == value.composer.agentID && $0.installed
          }?.id ?? agents.first { $0.installed }?.id
      } else {
        value.composer.agentID = nil
      }
      value.composer.modelID = selected?.id
      if let selected {
        if !selected.reasoningEfforts.contains(value.composer.effort ?? "") {
          value.composer.effort = selected.defaultReasoningEffort ?? selected.reasoningEfforts.first
        }
        if let tier = value.composer.serviceTier,
          !selected.serviceTiers.contains(where: { $0.id == tier })
        {
          value.composer.serviceTier = selected.defaultServiceTier
        }
      }
      let supportsAutoReview =
        installed.first { $0.id == provider }?.capabilities?.autoReview == true
      if value.composer.approval == .autoReview, !supportsAutoReview {
        value.composer.approval = .auto
      }
    }
  }
}

enum ProjectThreadState {
  static func applying(
    _ lifecycle: ThreadLifecycle?,
    to threadID: String,
    in projects: [ProjectRecord]
  ) -> [ProjectRecord] {
    var updated = projects
    for projectIndex in updated.indices {
      guard
        let threadIndex = updated[projectIndex].sessions.firstIndex(where: { $0.id == threadID })
      else { continue }
      updated[projectIndex].sessions[threadIndex].lifecycle = lifecycle
      return updated
    }
    return projects
  }

  static func lifecycle(
    for threadID: String,
    in projects: [ProjectRecord]
  ) -> ThreadLifecycle? {
    for project in projects {
      if let thread = project.sessions.first(where: { $0.id == threadID }) {
        return thread.lifecycle
      }
    }
    return nil
  }

  static func lifecycleState(
    for threadID: String,
    in projects: [ProjectRecord]
  ) -> ThreadLifecycleState? {
    lifecycle(for: threadID, in: projects)?.state
  }
}

enum ThreadLifecycleAction: Sendable {
  case settle
  case unsettle

  var method: String {
    switch self {
    case .settle: "thread.settle"
    case .unsettle: "thread.unsettle"
    }
  }

  var expectedState: ThreadLifecycleState {
    switch self {
    case .settle: .settled
    case .unsettle: .active
    }
  }

  func projectedLifecycle(at timestamp: Double = Date().timeIntervalSince1970 * 1_000)
    -> ThreadLifecycle
  {
    switch self {
    case .settle:
      ThreadLifecycle(
        state: .settled,
        keepActive: nil,
        wokeAt: nil,
        settledAt: timestamp,
        reason: "manual",
        snoozedAt: nil,
        wakeAt: nil
      )
    case .unsettle:
      ThreadLifecycle(
        state: .active,
        keepActive: false,
        wokeAt: timestamp,
        settledAt: nil,
        reason: nil,
        snoozedAt: nil,
        wakeAt: nil
      )
    }
  }
}
