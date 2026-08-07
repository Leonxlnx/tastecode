import SwiftUI

struct NewThreadFlow: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let onCreated: (ProjectRecord, ThreadSummary) -> Void

  @State private var selectedProject: ProjectRecord?
  @State private var browsingProjects = false

  var body: some View {
    Group {
      if let selectedProject {
        TaskComposerView(
          project: selectedProject, onBack: { self.selectedProject = nil }, onCreated: onCreated)
      } else if browsingProjects {
        ProjectDirectoryBrowser(
          onBack: { browsingProjects = false },
          onSelected: { project in
            browsingProjects = false
            selectedProject = project
          }
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
                selectedProject = project
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
}

private struct TaskComposerView: View {
  @EnvironmentObject private var model: AppModel
  let project: ProjectRecord
  let onBack: () -> Void
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
      SheetHeader(
        title: project.name.isEmpty ? HarnessFormat.projectName(project.path) : project.name,
        leading: AnyView(
          GlassIconButton(
            icon: .arrowLeft, accessibilityLabel: "Choose another project",
            action: onBack))
      )

      ZStack(alignment: .topLeading) {
        TextEditor(text: $prompt)
          .font(.system(size: 16))
          .scrollContentBackground(.hidden)
          .focused($promptFocused)
          .padding(.horizontal, 14)
          .padding(.top, 7)
        if prompt.isEmpty {
          Text(
            "Describe a coding task in \(project.name.isEmpty ? HarnessFormat.projectName(project.path) : project.name)"
          )
          .font(.system(size: 16))
          .foregroundStyle(HarnessColor.secondary)
          .padding(.horizontal, 19)
          .padding(.top, 15)
          .allowsHitTesting(false)
        }
      }

      AttachmentStrip(attachments: $attachments)
        .padding(.bottom, attachments.isEmpty ? 0 : 8)

      composerControls
    }
    .background(HarnessColor.background)
    .task {
      promptFocused = true
      await loadWorkspace()
    }
    .alert(
      "Couldn’t start task",
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

  private var composerControls: some View {
    VStack(spacing: 4) {
      Divider().overlay(HarnessColor.separator)
      GlassEffectContainer(spacing: 7) {
        HStack(spacing: 7) {
          AttachmentPickerButton(attachments: $attachments)
          ScrollView(.horizontal) {
            HStack(spacing: 7) {
              ModelMenu(onSelection: keepPromptFocused)
                .containerRelativeFrame(.horizontal, count: 2, span: 1, spacing: 7)
              ACPAgentMenu(onSelection: keepPromptFocused)
                .containerRelativeFrame(.horizontal, count: 2, span: 1, spacing: 7)
              AgentSettingsMenu(onSelection: keepPromptFocused)
                .containerRelativeFrame(.horizontal, count: 2, span: 1, spacing: 7)
              CheckoutMenu(
                currentBranch: currentBranch,
                selectedBranch: $selectedBranch,
                branches: branches,
                onSelection: keepPromptFocused
              )
              .containerRelativeFrame(.horizontal, count: 2, span: 1, spacing: 7)
            }
          }
          .scrollIndicators(.hidden)
          .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
          .scrollEdgeEffectStyle(.hard, for: .trailing)
          .frame(maxWidth: .infinity)
          .padding(.trailing, 5)
          GlassIconButton(
            icon: sending ? .loader : .arrowUp,
            accessibilityLabel: "Start task",
            prominent: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            disabled: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending
          ) {
            Task { await send() }
          }
        }
        .padding(.horizontal, 10)
      }
      .padding(.bottom, 4)
    }
    .background(HarnessColor.background.opacity(0.95))
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
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !sending else { return }
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

      let title = HarnessFormat.taskTitle(trimmed)
      _ = try? await model.request(
        "thread.rename",
        params: .object([
          "threadId": .string(threadID),
          "title": .string(title),
        ]))
      let deliveredPrompt =
        settings.interaction == .plan
        ? "Plan this task first. Do not make changes until I approve the plan.\n\n\(trimmed)"
        : trimmed
      var turnParams: [String: JSONValue] = [
        "threadId": .string(threadID),
        "text": .string(deliveredPrompt),
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
