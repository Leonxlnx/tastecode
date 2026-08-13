import SwiftUI
import UIKit

struct ProjectPickerFlow: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let onSelected: (ProjectRecord) -> Void

  @State private var browsingProjects = false

  var body: some View {
    Group {
      if browsingProjects {
        ProjectDirectoryBrowser(
          onBack: { browsingProjects = false },
          onSelected: select
        )
      } else {
        projectChooser
      }
    }
    .background(HarnessColor.background)
    .presentationDetents([.large])
  }

  private var projectChooser: some View {
    VStack(spacing: 0) {
      SheetHeader(
        title: "Choose project",
        leading: AnyView(
          GlassIconButton(icon: .arrowLeft, accessibilityLabel: "Close") {
            dismiss()
          }),
        trailing: AnyView(
          GlassIconButton(icon: .folderPen, accessibilityLabel: "Add project") {
            browsingProjects = true
          }
        )
      )
      ScrollView {
        GlassEffectContainer(spacing: 8) {
          LazyVStack(spacing: 8) {
            ForEach(model.projects) { project in
              Button {
                select(project)
              } label: {
                HStack(spacing: 10) {
                  LucideIconView(.folder, size: 12)
                    .foregroundStyle(HarnessColor.secondary)
                  Text(
                    project.name.isEmpty ? HarnessFormat.projectName(project.path) : project.name
                  )
                  .font(.system(size: 14, weight: .semibold))
                  .foregroundStyle(.white)
                  .lineLimit(1)
                  Spacer()
                  LucideIconView(.chevronRight, size: 10)
                    .foregroundStyle(HarnessColor.tertiary)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: HarnessMetrics.rowHeight)
                .harnessSurface(interactive: true)
                .contentShape(.rect(cornerRadius: HarnessMetrics.surfaceRadius))
              }
              .buttonStyle(.plain)
            }
          }
        }
        .padding(.horizontal, HarnessMetrics.pageInset)
        .padding(.top, 10)

        if model.projects.isEmpty {
          ContentUnavailableView {
            Label {
              Text("No projects available")
            } icon: {
              LucideIconView(.folderSearch, size: 40)
            }
          } description: {
            Text("Add a project on your Harness machine, then refresh.")
          }
          .frame(minHeight: 420)
        }
      }
      .refreshable { await model.refreshEverything() }
    }
  }

  private func select(_ project: ProjectRecord) {
    model.rememberProject(project)
    onSelected(project)
  }
}

struct NewThreadView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let project: ProjectRecord
  let onCreated: (ProjectRecord, ThreadSummary) -> Void

  @FocusState private var promptFocused: Bool
  @State private var prompt = ""
  @State private var attachments: [AttachmentDraft] = []
  @State private var branches: [String] = []
  @State private var currentBranch: String?
  @State private var selectedBranch: String?
  @State private var sending = false
  @State private var errorMessage: String?

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(HarnessColor.separator)
      Color.clear
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(.rect)
        .onTapGesture { promptFocused = false }
      AttachmentStrip(attachments: $attachments)
        .padding(.bottom, attachments.isEmpty ? 0 : 4)
      composer
    }
    .background(HarnessColor.background.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .task {
      model.rememberProject(project)
      promptFocused = true
      await loadWorkspace()
    }
    .alert(
      "Couldn’t start chat",
      isPresented: Binding(
        get: { errorMessage != nil },
        set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("OK", role: .cancel) { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private var header: some View {
    HStack(spacing: 9) {
      GlassIconButton(icon: .arrowLeft, accessibilityLabel: "Back", size: 36) {
        dismiss()
      }
      Text("New chat")
        .font(.system(size: 14, weight: .semibold))
        .lineLimit(1)
      Spacer()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 5)
  }

  private var composer: some View {
    VStack(spacing: 0) {
      TextField("Do anything", text: $prompt, axis: .vertical)
        .font(.system(size: 15))
        .textFieldStyle(.plain)
        .lineLimit(1...8)
        .focused($promptFocused)
        .padding(.horizontal, 14)
        .padding(.top, 13)
        .padding(.bottom, 7)
        .frame(minHeight: 54, alignment: .top)

      HStack(alignment: .center, spacing: 4) {
        ScrollView(.horizontal) {
          HStack(spacing: 6) {
            AttachmentPickerButton(attachments: $attachments, style: .composer)
            ApprovalMenu(onSelection: keepPromptFocused)
            CheckoutMenu(
              currentBranch: currentBranch,
              selectedBranch: $selectedBranch,
              branches: branches,
              onSelection: keepPromptFocused
            )
            DesignModeButton(onSelection: keepPromptFocused)
            ModelMenu(onSelection: keepPromptFocused)
            ACPAgentMenu(onSelection: keepPromptFocused)
            AgentSettingsMenu(onSelection: keepPromptFocused)
          }
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity)

        GlassIconButton(
          icon: sending ? .loader : .arrowUp,
          accessibilityLabel: "Start chat",
          size: 38,
          prominent: !trimmedPrompt.isEmpty,
          disabled: trimmedPrompt.isEmpty || sending
        ) {
          Task { await send() }
        }
      }
      .padding(.leading, 5)
      .padding(.trailing, 3)
      .padding(.bottom, 4)
    }
    .harnessComposerSurface()
    .padding(.horizontal, 10)
    .padding(.bottom, 6)
  }

  private var trimmedPrompt: String {
    prompt.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func loadWorkspace() async {
    do {
      async let info: WorkspaceInfo = model.request(
        "workspace.info",
        params: .object(["path": .string(project.path)]),
        as: WorkspaceInfo.self
      )
      async let available: BranchesResponse = model.request(
        "workspace.branches",
        params: .object(["path": .string(project.path)]),
        as: BranchesResponse.self
      )
      let (workspace, branchResponse) = try await (info, available)
      currentBranch = workspace.branch
      branches = branchResponse.branches
      selectedBranch = workspace.branch ?? branchResponse.branches.first
    } catch {
      branches = []
      currentBranch = nil
      selectedBranch = nil
    }
  }

  private func keepPromptFocused() {
    Task { @MainActor in
      await Task.yield()
      promptFocused = true
    }
  }

  private func send() async {
    guard !trimmedPrompt.isEmpty, !sending else { return }
    sending = true
    defer { sending = false }
    do {
      let settings = model.preferences.composer
      if !settings.isolate,
        let selectedBranch,
        selectedBranch != currentBranch
      {
        _ = try await model.request(
          "workspace.switchBranch",
          params: .object([
            "path": .string(project.path),
            "branch": .string(selectedBranch),
          ]))
      }

      var uploaded: [String] = []
      for attachment in attachments {
        uploaded.append(try await model.upload(attachment))
      }
      uploaded = ComposerSubmission.attachments(uploaded, designMode: settings.designMode)

      var startParams: [String: JSONValue] = [
        "provider": .string(settings.provider.rawValue),
        "workspacePath": .string(project.path),
        "approval": .string(settings.approval.rawValue),
      ]
      if let modelID = settings.modelID { startParams["model"] = .string(modelID) }
      if settings.provider == .acp, let agentID = settings.agentID {
        startParams["agent"] = .string(agentID)
      }
      if let effort = settings.effort { startParams["effort"] = .string(effort) }
      if let tier = settings.serviceTier { startParams["serviceTier"] = .string(tier) }
      if settings.isolate { startParams["isolate"] = .bool(true) }
      let started = try await model.request("thread.start", params: .object(startParams))
      guard let threadID = started["threadId"]?.stringValue else {
        throw RPCFailure(message: "Harness didn’t return a thread identifier.", detail: nil)
      }

      let title = HarnessFormat.taskTitle(trimmedPrompt)
      _ = try? await model.request(
        "thread.rename",
        params: .object([
          "threadId": .string(threadID),
          "title": .string(title),
        ]))
      var turnParams: [String: JSONValue] = [
        "threadId": .string(threadID),
        "text": .string(ComposerSubmission.text(trimmedPrompt, interaction: settings.interaction)),
        "approval": .string(settings.approval.rawValue),
      ]
      if !uploaded.isEmpty { turnParams["attachments"] = .array(uploaded.map(JSONValue.string)) }
      if let modelID = settings.modelID { turnParams["model"] = .string(modelID) }
      if let effort = settings.effort { turnParams["effort"] = .string(effort) }
      if let tier = settings.serviceTier { turnParams["serviceTier"] = .string(tier) }
      _ = try await model.request("thread.sendTurn", params: .object(turnParams))

      let thread = ThreadSummary(
        id: threadID,
        title: title,
        provider: settings.provider,
        agent: settings.provider == .acp ? settings.agentID : nil,
        createdAt: Date.now.timeIntervalSince1970 * 1_000,
        running: true,
        status: "working",
        unread: false,
        lifecycle: ThreadLifecycle(
          state: .active,
          keepActive: false,
          wokeAt: nil,
          settledAt: nil,
          reason: nil,
          snoozedAt: nil,
          wakeAt: nil
        ),
        closedAt: nil,
        worktreeBranch: settings.isolate ? selectedBranch : nil
      )
      if model.preferences.hapticsEnabled {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      }
      onCreated(project, thread)
      await model.refreshProjects()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
