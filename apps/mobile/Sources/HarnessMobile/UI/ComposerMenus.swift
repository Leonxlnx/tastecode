import SwiftUI

enum ComposerSubmission {
  static let designBriefAttachment = "personal-harness://design-brief-v1"

  static func text(_ text: String, interaction: InteractionMode) -> String {
    interaction == .plan
      ? "Plan this task first. Do not make changes until I approve the plan.\n\n\(text)"
      : text
  }

  static func attachments(_ paths: [String], designMode: Bool) -> [String] {
    guard designMode, !paths.contains(designBriefAttachment) else { return paths }
    return paths + [designBriefAttachment]
  }
}

enum ComposerMenuSelection {
  static func apply(
    provider: ProviderID,
    model option: ModelOption,
    installedACPAgentID: String?,
    supportsAutoReview: Bool,
    to preferences: inout ComposerPreferences
  ) {
    preferences.provider = provider
    preferences.agentID = provider == .acp ? installedACPAgentID : nil
    preferences.modelID = option.id
    preferences.effort = option.defaultReasoningEffort ?? option.reasoningEfforts.first
    preferences.serviceTier = option.defaultServiceTier
    if preferences.approval == .autoReview, !supportsAutoReview {
      preferences.approval = .auto
    }
  }
}

struct ModelMenu: View {
  @EnvironmentObject private var model: AppModel
  var onSelection: () -> Void = {}

  var body: some View {
    Menu {
      if installedProviders.isEmpty {
        Text("No installed providers")
      } else {
        ForEach(installedProviders) { provider in
          providerPicker(provider)
        }
      }
    } label: {
      ComposerToolLabel(title: selected?.displayName ?? providerName, showsChevron: true) {
        ProviderGlyph(provider: model.preferences.composer.provider, size: 18)
      }
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Choose provider and model")
  }

  private var installedProviders: [ProviderStatus] { model.providers.filter(\.installed) }
  private var selected: ModelOption? { model.selectedModel() }
  private var providerName: String {
    installedProviders.first { $0.id == model.preferences.composer.provider }?.displayName
      ?? model.preferences.composer.provider.fallbackName
  }

  @ViewBuilder
  private func providerPicker(_ provider: ProviderStatus) -> some View {
    let options = model.models(for: provider.id)
    if options.isEmpty {
      Menu {
        Text("No models available")
      } label: {
        Text(provider.displayName)
      }
    } else {
      Picker(selection: modelSelection(for: provider, options: options)) {
        ForEach(options) { option in
          Text(option.displayName).tag(option.id as String?)
        }
      } label: {
        Text(provider.displayName)
      }
      .pickerStyle(.menu)
    }
  }

  private func modelSelection(
    for provider: ProviderStatus,
    options: [ModelOption]
  ) -> Binding<String?> {
    Binding(
      get: {
        guard provider.id == model.preferences.composer.provider else { return nil }
        return selected?.id
      },
      set: { modelID in
        guard let modelID, let option = options.first(where: { $0.id == modelID }) else { return }
        select(provider: provider, option: option)
      }
    )
  }

  private func select(provider: ProviderStatus, option: ModelOption) {
    model.updatePreferences { preferences in
      ComposerMenuSelection.apply(
        provider: provider.id,
        model: option,
        installedACPAgentID: model.agents.first(where: \.installed)?.id,
        supportsAutoReview: provider.capabilities?.autoReview == true,
        to: &preferences.composer
      )
    }
    onSelection()
  }
}

struct ACPAgentMenu: View {
  @EnvironmentObject private var model: AppModel
  var onSelection: () -> Void = {}

  @ViewBuilder
  var body: some View {
    if model.preferences.composer.provider == .acp {
      if installedAgents.isEmpty {
        Menu {
          Text("No installed ACP agents")
        } label: {
          menuLabel
        }
        .buttonStyle(.plain)
        .menuOrder(.fixed)
        .accessibilityLabel("Choose ACP agent")
      } else {
        Picker(selection: agentSelection) {
          ForEach(installedAgents) { agent in
            Text(agent.name).tag(agent.id)
          }
        } label: {
          menuLabel
        }
        .pickerStyle(.menu)
        .buttonStyle(.plain)
        .accessibilityLabel("Choose ACP agent")
      }
    }
  }

  private var installedAgents: [ACPAgent] { model.agents.filter(\.installed) }
  private var selected: ACPAgent? { model.selectedAgent() }
  private var agentSelection: Binding<String> {
    Binding(
      get: { selected?.id ?? installedAgents[0].id },
      set: { agentID in
        guard installedAgents.contains(where: { $0.id == agentID }) else { return }
        model.updatePreferences { $0.composer.agentID = agentID }
        onSelection()
      }
    )
  }
  private var menuLabel: some View {
    ComposerToolLabel(title: selected?.name ?? "ACP agent", showsChevron: true) {
      AgentGlyph(agentID: selected?.id, size: 15)
    }
  }
}

struct ApprovalMenu: View {
  @EnvironmentObject private var model: AppModel
  var onSelection: () -> Void = {}

  var body: some View {
    Menu {
      ForEach(runtimeModes) { mode in
        Button {
          model.updatePreferences { $0.composer.approval = mode }
          onSelection()
        } label: {
          LucideActionLabel(title: mode.label, icon: icon(for: mode))
        }
      }
    } label: {
      ComposerToolLabel(title: selection.label, tint: tint) {
        LucideIconView(icon(for: selection), size: 14)
      }
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Permissions")
  }

  private var selection: ApprovalMode { model.preferences.composer.approval }
  private var runtimeModes: [ApprovalMode] {
    let provider = model.providers.first { $0.id == model.preferences.composer.provider }
    return ApprovalMode.allCases.filter {
      $0 != .autoReview || provider?.capabilities?.autoReview == true
    }
  }
  private var tint: Color {
    switch selection {
    case .ask: HarnessColor.primary
    case .auto: HarnessColor.green
    case .autoReview: HarnessColor.blue
    case .full: HarnessColor.composerDanger
    }
  }
  private func icon(for mode: ApprovalMode) -> LucideIcon {
    switch mode {
    case .ask: .shieldAlert
    case .auto, .autoReview: .shieldCheck
    case .full: .lockOpen
    }
  }
}

struct DesignModeButton: View {
  @EnvironmentObject private var model: AppModel
  var onSelection: () -> Void = {}

  var body: some View {
    Button {
      model.updatePreferences { $0.composer.designMode.toggle() }
      onSelection()
    } label: {
      ComposerToolLabel(
        title: "Design",
        tint: model.preferences.composer.designMode ? designTint : HarnessColor.primary,
        active: model.preferences.composer.designMode
      ) {
        LucideIconView(.palette, size: 14)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(
      model.preferences.composer.designMode ? "Turn off Design mode" : "Turn on Design mode"
    )
    .accessibilityValue(model.preferences.composer.designMode ? "On" : "Off")
  }

  private var designTint: Color {
    Color(red: 0.72, green: 0.64, blue: 1)
  }
}

struct AgentSettingsMenu: View {
  @EnvironmentObject private var model: AppModel
  var onSelection: () -> Void = {}

  var body: some View {
    Menu {
      Section {
        reasoningControl
        serviceTierControl
      }
      Section {
        interactionControl
      }
    } label: {
      ComposerToolLabel(title: settingsSummary, showsChevron: true) {
        LucideIconView(.settings, size: 14)
      }
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Reasoning, service tier, and interaction")
  }

  @ViewBuilder
  private var reasoningControl: some View {
    if efforts.isEmpty {
      LucideActionLabel(title: "Reasoning unavailable", icon: .brain)
    } else {
      Picker(selection: effortSelection) {
        ForEach(efforts, id: \.self) { effort in
          Text(effortTitle(effort)).tag(effort)
        }
      } label: {
        LucideActionLabel(title: "Reasoning", icon: .brain)
      }
      .pickerStyle(.menu)
    }
  }

  private var serviceTierControl: some View {
    Picker(selection: serviceTierSelection) {
      Text("\(defaultTierName) (default)").tag(defaultTierID)
      ForEach(nonDefaultTiers) { tier in
        Text(tier.name).tag(tier.id as String?)
      }
    } label: {
      LucideActionLabel(title: "Service Tier", icon: .zap)
    }
    .pickerStyle(.menu)
  }

  private var interactionControl: some View {
    Picker(selection: interactionSelection) {
      ForEach(InteractionMode.allCases) { interaction in
        Text(interaction.label).tag(interaction)
      }
    } label: {
      LucideActionLabel(title: "Interaction", icon: .gitFork)
    }
    .pickerStyle(.menu)
  }

  private var selectedModel: ModelOption? { model.selectedModel() }
  private var efforts: [String] { selectedModel?.reasoningEfforts ?? [] }
  private var defaultTierID: String? { selectedModel?.defaultServiceTier }
  private var defaultTierName: String {
    guard let selectedModel else { return "Standard" }
    return selectedModel.serviceTiers.first { $0.id == selectedModel.defaultServiceTier }?.name
      ?? "Standard"
  }
  private var nonDefaultTiers: [ServiceTier] {
    selectedModel?.serviceTiers.filter { $0.id != defaultTierID } ?? []
  }
  private var effortSelection: Binding<String> {
    Binding(
      get: { model.preferences.composer.effort ?? efforts[0] },
      set: { effort in
        guard efforts.contains(effort) else { return }
        model.updatePreferences { $0.composer.effort = effort }
        onSelection()
      }
    )
  }
  private var serviceTierSelection: Binding<String?> {
    Binding(
      get: { model.preferences.composer.serviceTier ?? defaultTierID },
      set: { tier in
        model.updatePreferences { $0.composer.serviceTier = tier }
        onSelection()
      }
    )
  }
  private var interactionSelection: Binding<InteractionMode> {
    Binding(
      get: { model.preferences.composer.interaction },
      set: { interaction in
        model.updatePreferences { $0.composer.interaction = interaction }
        onSelection()
      }
    )
  }
  private var settingsSummary: String {
    let effort = model.preferences.composer.effort.map(HarnessFormat.label(for:)) ?? "Default"
    let selectedTierID = model.preferences.composer.serviceTier ?? defaultTierID
    let tier =
      selectedModel?.serviceTiers.first { $0.id == selectedTierID }?.name
      ?? defaultTierName
    return "\(effort) · \(tier)"
  }
  private func effortTitle(_ effort: String) -> String {
    let label = HarnessFormat.label(for: effort)
    return effort == selectedModel?.defaultReasoningEffort ? "\(label) (default)" : label
  }
}

struct CheckoutMenu: View {
  @EnvironmentObject private var model: AppModel
  let currentBranch: String?
  @Binding var selectedBranch: String?
  let branches: [String]
  var onSelection: () -> Void = {}

  var body: some View {
    Menu {
      Picker(selection: isolationSelection) {
        Text("Current checkout").tag(false)
        Text("New worktree").tag(true)
      } label: {
        LucideActionLabel(title: "Mode", icon: .gitBranch)
      }
      .pickerStyle(.menu)

      if !model.preferences.composer.isolate, !branches.isEmpty {
        Picker(selection: branchSelection) {
          ForEach(branches, id: \.self) { branch in
            Text(branch == currentBranch ? "\(branch) (current)" : branch).tag(branch)
          }
        } label: {
          LucideActionLabel(title: "Branch", icon: .gitBranch)
        }
        .pickerStyle(.menu)
      }
    } label: {
      ComposerIconLabel(icon: .gitBranch)
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Checkout mode and branch")
    .accessibilityValue(checkoutSummary)
  }

  private var isolationSelection: Binding<Bool> {
    Binding(
      get: { model.preferences.composer.isolate },
      set: { isolate in
        model.updatePreferences { $0.composer.isolate = isolate }
        onSelection()
      }
    )
  }
  private var branchSelection: Binding<String> {
    Binding(
      get: { selectedBranch ?? currentBranch ?? branches[0] },
      set: { branch in
        guard branches.contains(branch) else { return }
        selectedBranch = branch
        onSelection()
      }
    )
  }
  private var checkoutSummary: String {
    if model.preferences.composer.isolate { return "New worktree" }
    return selectedBranch ?? currentBranch ?? "Current checkout"
  }
}
