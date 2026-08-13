import SwiftUI
import UIKit

struct ThreadView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let project: ProjectRecord
  let thread: ThreadSummary

  @FocusState private var composerFocused: Bool
  @State private var timeline = ThreadTimeline()
  @State private var deltaBuffer = TimelineDeltaBuffer()
  @State private var deltaFlushTask: Task<Void, Never>?
  @State private var scrollRevision = 0
  @State private var queue = ThreadQueue(items: [], canSteer: false)
  @State private var composer = ""
  @State private var attachments: [AttachmentDraft] = []
  @State private var expandedTurns: Set<String> = []
  @State private var sending = false
  @State private var loaded = false
  @State private var localError: String?
  @State private var terminalPresented = false
  @State private var workspacePresented = false
  @State private var branchPresented = false

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(HarnessColor.separator)
      transcript
      queueStrip
      AttachmentStrip(attachments: $attachments)
      composerBar
    }
    .background(HarnessColor.background.ignoresSafeArea())
    .background {
      InteractiveBackGestureEnabler()
        .frame(width: 0, height: 0)
    }
    .toolbar(.hidden, for: .navigationBar)
    .task { await observeThread() }
    .onDisappear {
      deltaFlushTask?.cancel()
      deltaFlushTask = nil
    }
    .sheet(isPresented: $terminalPresented) {
      TerminalView(threadID: thread.id)
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .sheet(isPresented: $workspacePresented) {
      WorkspaceChangesView(project: project, thread: thread)
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .sheet(isPresented: $branchPresented) {
      CheckoutDetailsView(project: project, thread: thread)
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .alert(
      "Harness",
      isPresented: Binding(
        get: { localError != nil },
        set: { if !$0 { localError = nil } }
      )
    ) {
      Button("OK", role: .cancel) { localError = nil }
    } message: {
      Text(localError ?? "")
    }
  }

  private var header: some View {
    HStack(spacing: 9) {
      GlassIconButton(icon: .arrowLeft, accessibilityLabel: "Back", size: 36) {
        dismiss()
      }
      Text(thread.title)
        .font(.system(size: 14, weight: .semibold))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 2) {
        HeaderAction(icon: .squareTerminal, label: "Terminal") { terminalPresented = true }
        HeaderAction(icon: .fileDiff, label: "Changes") { workspacePresented = true }
      }
      .padding(.horizontal, 4)
      .frame(height: 36)
      .glassEffect(.regular.interactive(), in: .capsule)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 5)
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 18) {
          if !loaded {
            HStack(spacing: 9) {
              LucideLoader(size: 16)
              Text("Loading thread…")
            }
            .foregroundStyle(HarnessColor.secondary)
            .frame(maxWidth: .infinity, minHeight: 280)
          }
          ForEach(timeline.turns) { turn in
            TurnTranscriptView(
              turn: turn,
              running: timeline.running && turn.id == timeline.turns.last?.id,
              workExpanded: expandedTurns.contains(turn.id),
              toggleWork: {
                if expandedTurns.contains(turn.id) {
                  expandedTurns.remove(turn.id)
                } else {
                  expandedTurns.insert(turn.id)
                }
              }
            )
          }
          ForEach(timeline.approvals) { approval in
            ApprovalCard(approval: approval) { decision in
              Task { await respond(to: approval, decision: decision) }
            }
          }
          ForEach(timeline.userInputs) { request in
            UserInputCard(request: request) { answers in
              Task { await respond(to: request, answers: answers) }
            }
          }
          if let error = timeline.error {
            LucideLabel(error, icon: .circleAlert)
              .foregroundStyle(HarnessColor.red)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(.horizontal, HarnessMetrics.pageInset)
        .padding(.top, 16)
        .padding(.bottom, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .defaultScrollAnchor(.bottom)
      .onChange(of: scrollRevision) { _, _ in
        if timeline.running {
          proxy.scrollTo("bottom", anchor: .bottom)
        } else {
          withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
      }
    }
  }

  @ViewBuilder
  private var queueStrip: some View {
    if !queue.items.isEmpty {
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(queue.items) { item in
            Menu {
              if queue.canSteer {
                Button {
                  Task { await steer(item) }
                } label: {
                  LucideActionLabel(title: "Send next", icon: .cornerDownRight)
                }
              }
              Button(role: .destructive) {
                Task { await remove(item) }
              } label: {
                LucideActionLabel(title: "Remove", icon: .trash)
              }
            } label: {
              HStack(spacing: 7) {
                LucideIconView(.clock, size: 14)
                Text(item.text).lineLimit(1)
                LucideIconView(.ellipsis, size: 14)
              }
              .font(.system(size: 14, weight: .semibold))
              .padding(.horizontal, 12)
              .frame(maxWidth: 250, minHeight: 36)
              .harnessGlassCapsule()
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 18)
      }
      .scrollIndicators(.hidden)
      .padding(.vertical, 4)
    }
  }

  private var composerBar: some View {
    VStack(spacing: 0) {
      TextField("Do anything", text: $composer, axis: .vertical)
        .font(.system(size: 15))
        .textFieldStyle(.plain)
        .lineLimit(1...8)
        .focused($composerFocused)
        .padding(.horizontal, 14)
        .padding(.top, 13)
        .padding(.bottom, 7)
        .frame(minHeight: 54, alignment: .top)

      HStack(alignment: .center, spacing: 4) {
        ScrollView(.horizontal) {
          HStack(spacing: 6) {
            AttachmentPickerButton(attachments: $attachments, style: .composer)
            ApprovalMenu(onSelection: keepComposerFocused)
              .disabled(timeline.running)
            Button {
              branchPresented = true
            } label: {
              ComposerIconLabel(icon: .gitBranch)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show branch and worktree")
            .accessibilityValue(thread.worktreeBranch ?? "Current checkout")
            DesignModeButton(onSelection: keepComposerFocused)
            ModelMenu(onSelection: keepComposerFocused)
              .disabled(timeline.running)
            ACPAgentMenu(onSelection: keepComposerFocused)
              .disabled(timeline.running)
            AgentSettingsMenu(onSelection: keepComposerFocused)
              .disabled(timeline.running)
          }
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity)

        GlassIconButton(
          icon: actionIcon,
          accessibilityLabel: actionLabel,
          size: 38,
          prominent: !composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          disabled: sending
            || (!timeline.running
              && composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        ) {
          Task {
            if timeline.running
              && composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
              await interrupt()
            } else {
              await send()
            }
          }
        }
      }
      .padding(.leading, 5)
      .padding(.trailing, 3)
      .padding(.bottom, 4)
    }
    .harnessComposerSurface()
    .padding(.horizontal, 10)
    .padding(.bottom, 6)
    .background(HarnessColor.background.opacity(0.94))
  }

  private var actionIcon: LucideIcon {
    if sending { return .loader }
    if timeline.running && composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return .squareFilled
    }
    return .arrowUp
  }

  private var actionLabel: String {
    timeline.running && composer.isEmpty ? "Stop turn" : "Send"
  }

  private func keepComposerFocused() {
    Task { @MainActor in
      await Task.yield()
      composerFocused = true
    }
  }

  private func load() async {
    do {
      async let history = model.request(
        "thread.history", params: .object(["threadId": .string(thread.id)]))
      async let queued: ThreadQueue = model.request(
        "thread.queue",
        params: .object(["threadId": .string(thread.id)]),
        as: ThreadQueue.self
      )
      let (historyValue, queueValue) = try await (history, queued)
      timeline.load(history: historyValue)
      queue = queueValue
      loaded = true
      scrollRevision &+= 1
    } catch {
      localError = error.localizedDescription
      loaded = true
    }
  }

  private func observeThread() async {
    let pushes = model.pushStream()
    await load()
    for await push in pushes {
      guard !Task.isCancelled else { return }
      apply(push)
    }
  }

  private func apply(_ push: PushMessage) {
    switch push.channel {
    case "thread.event":
      guard push.data["threadId"]?.stringValue == thread.id,
        let event = push.data["event"]
      else { return }
      if deltaBuffer.append(event: event) {
        scheduleDeltaFlush()
      } else {
        applyTimelineEvent(event)
      }
    case "thread.queue":
      guard push.data["threadId"]?.stringValue == thread.id else { return }
      if let decoded = try? push.data.decoded(as: ThreadQueue.self) { queue = decoded }
    default: break
    }
  }

  private func scheduleDeltaFlush() {
    guard deltaFlushTask == nil else { return }
    deltaFlushTask = Task { @MainActor in
      do {
        try await Task.sleep(for: .milliseconds(16))
      } catch {
        return
      }
      flushBufferedDeltas()
    }
  }

  private func flushBufferedDeltas() {
    deltaFlushTask = nil
    let deltas = deltaBuffer.drain()
    guard !deltas.isEmpty else { return }
    var updated = timeline
    for delta in deltas { updated.apply(delta: delta) }
    timeline = updated
    scrollRevision &+= 1
  }

  private func applyTimelineEvent(_ event: JSONValue) {
    deltaFlushTask?.cancel()
    deltaFlushTask = nil
    var updated = timeline
    for delta in deltaBuffer.drain() { updated.apply(delta: delta) }
    updated.apply(event: event)
    timeline = updated
    scrollRevision &+= 1
  }

  private func send() async {
    let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    sending = true
    defer { sending = false }
    do {
      var uploaded: [String] = []
      for attachment in attachments { uploaded.append(try await model.upload(attachment)) }
      let settings = model.preferences.composer
      uploaded = ComposerSubmission.attachments(uploaded, designMode: settings.designMode)
      var params: [String: JSONValue] = [
        "threadId": .string(thread.id),
        "text": .string(ComposerSubmission.text(text, interaction: settings.interaction)),
        "approval": .string(settings.approval.rawValue),
      ]
      if !uploaded.isEmpty { params["attachments"] = .array(uploaded.map(JSONValue.string)) }
      if let modelID = settings.modelID { params["model"] = .string(modelID) }
      if let effort = settings.effort { params["effort"] = .string(effort) }
      if let tier = settings.serviceTier { params["serviceTier"] = .string(tier) }
      _ = try await model.request("thread.sendTurn", params: .object(params))
      composer = ""
      attachments = []
      timeline.running = true
      let refreshed: ThreadQueue = try await model.request(
        "thread.queue",
        params: .object(["threadId": .string(thread.id)]),
        as: ThreadQueue.self
      )
      queue = refreshed
      if model.preferences.hapticsEnabled {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
      }
    } catch {
      localError = error.localizedDescription
    }
  }

  private func interrupt() async {
    do {
      _ = try await model.request(
        "thread.interrupt", params: .object(["threadId": .string(thread.id)]))
      timeline.running = false
    } catch { localError = error.localizedDescription }
  }

  private func respond(to approval: PendingApproval, decision: String) async {
    do {
      _ = try await model.request(
        "thread.respondToApproval",
        params: .object([
          "threadId": .string(thread.id),
          "approvalId": .string(approval.id),
          "decision": .string(decision),
        ]))
      timeline.approvals.removeAll { $0.id == approval.id }
    } catch { localError = error.localizedDescription }
  }

  private func respond(to request: PendingUserInput, answers: [String: [String]]) async {
    do {
      let encoded = answers.mapValues { JSONValue.array($0.map(JSONValue.string)) }
      _ = try await model.request(
        "thread.respondToUserInput",
        params: .object([
          "threadId": .string(thread.id),
          "requestId": .string(request.id),
          "answers": .object(encoded),
        ]))
      timeline.userInputs.removeAll { $0.id == request.id }
    } catch { localError = error.localizedDescription }
  }

  private func remove(_ queuedTurn: QueuedTurn) async {
    do {
      _ = try await model.request(
        "thread.deleteQueuedTurn",
        params: .object([
          "threadId": .string(thread.id),
          "queuedTurnId": .string(queuedTurn.id),
        ]))
      queue = ThreadQueue(
        items: queue.items.filter { $0.id != queuedTurn.id }, canSteer: queue.canSteer)
    } catch { localError = error.localizedDescription }
  }

  private func steer(_ queuedTurn: QueuedTurn) async {
    do {
      _ = try await model.request(
        "thread.steerQueuedTurn",
        params: .object([
          "threadId": .string(thread.id),
          "queuedTurnId": .string(queuedTurn.id),
        ]))
      queue = ThreadQueue(
        items: queue.items.filter { $0.id != queuedTurn.id }, canSteer: queue.canSteer)
    } catch { localError = error.localizedDescription }
  }
}

private struct InteractiveBackGestureEnabler: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> InteractiveBackGestureViewController {
    InteractiveBackGestureViewController()
  }

  func updateUIViewController(
    _ uiViewController: InteractiveBackGestureViewController,
    context: Context
  ) {}
}

@MainActor
private final class InteractiveBackGestureViewController: UIViewController {
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    enableInteractiveBackGestures()
  }

  func enableInteractiveBackGestures() {
    guard let navigationController, navigationController.viewControllers.count > 1 else { return }
    navigationController.interactivePopGestureRecognizer?.isEnabled = true
    navigationController.interactiveContentPopGestureRecognizer?.isEnabled = true
  }
}

private struct HeaderAction: View {
  let icon: LucideIcon
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      LucideIconView(icon, size: 14)
        .frame(width: 30, height: 32)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}
