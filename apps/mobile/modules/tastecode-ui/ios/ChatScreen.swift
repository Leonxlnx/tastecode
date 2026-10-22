import SwiftUI
import UIKit

/// One chat, continued from wherever it was started.
struct ChatScreen: View {
  @Environment(AppModel.self) private var model
  let threadId: String

  var body: some View {
    ChatContent(store: model.thread(threadId))
      .onAppear { model.openThread(threadId) }
      .onDisappear { model.closeThread(threadId) }
  }
}

private struct ChatContent: View {
  @Environment(AppModel.self) private var model
  let store: ThreadStore
  @State private var jumpToken = 0
  @State private var showChanges = false
  @State private var renaming = false
  @State private var draftTitle = ""
  @State private var problem: String?

  var body: some View {
    let meta = store.meta
    Transcript(store: store, jumpToken: jumpToken)
      .safeAreaBar(edge: .bottom) {
        ChatBar(store: store, problem: $problem) { jumpToken += 1 }
      }
      .navigationTitle(meta?.title ?? "")
      .navigationBarTitleDisplayMode(.inline)
      .navigationSubtitle(subtitle(meta))
      .toolbarTitleMenu {
        if let meta {
          Button("Rename…", systemImage: "pencil") {
            draftTitle = meta.title
            renaming = true
          }
          Button(meta.pinned ? "Unpin" : "Pin", systemImage: meta.pinned ? "pin.slash" : "pin") {
            model.perform(["type": "thread.pin", "threadId": store.id, "pinned": !meta.pinned]) { problem = $0 }
          }
          if meta.archived {
            Button("Restore", systemImage: "tray.and.arrow.up") {
              model.perform(["type": "thread.restore", "threadId": store.id]) { problem = $0 }
            }
          } else {
            Button("Archive", systemImage: "archivebox") {
              model.perform(["type": "thread.archive", "threadId": store.id]) { problem = $0 }
            }
          }
        }
      }
      .toolbar {
        if let changes = meta?.changes {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              showChanges = true
            } label: {
              LineCounts(added: changes.added, removed: changes.removed)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 4)
            }
            .accessibilityLabel("Changes: \(changes.files) files")
          }
        }
      }
      .sheet(isPresented: $showChanges) {
        ChangesSheet(threadId: store.id)
      }
      .alert("Rename Chat", isPresented: $renaming) {
        TextField("Title", text: $draftTitle)
        Button("Cancel", role: .cancel) {}
        Button("Rename") {
          let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !title.isEmpty else { return }
          model.perform(["type": "thread.rename", "threadId": store.id, "title": title]) { problem = $0 }
        }
      }
      .problemAlert($problem)
  }

  private func subtitle(_ meta: ThreadMetaView?) -> String {
    if model.link?.phase != .open { return "Reconnecting…" }
    return meta?.projectName ?? ""
  }
}

/// The bottom of a chat: the composer, or the decision the agent waits for.
/// They share one piece of glass that reshapes from one to the other.
private struct ChatBar: View {
  @Environment(AppModel.self) private var model
  let store: ThreadStore
  @Binding var problem: String?
  let onSent: () -> Void
  @Namespace private var glass

  var body: some View {
    let meta = store.meta
    GlassEffectContainer(spacing: 12) {
      Group {
        if let meta, let approval = meta.approval {
          ApprovalPanel(threadId: store.id, request: approval)
            .id(approval.id)
        } else if let meta, let questions = meta.questions {
          QuestionPanel(threadId: store.id, request: questions)
            .id(questions.id)
        } else {
          composer(meta)
        }
      }
      .glassEffectID("bar", in: glass)
    }
    .padding(.horizontal, 10)
    .padding(.bottom, 6)
    .animation(.smooth(duration: 0.35), value: meta?.approval?.id)
    .animation(.smooth(duration: 0.35), value: meta?.questions?.id)
  }

  private func composer(_ meta: ThreadMetaView?) -> some View {
    let threadId = store.id
    let running = meta?.running ?? false
    return Composer(
      draftKey: threadId,
      placeholder: running ? "Add to the queue" : "Message",
      setup: meta?.setup ?? .empty,
      running: running,
      enabled: model.link?.phase == .open && meta != nil,
      queue: meta?.queue ?? [],
      canSteer: meta?.canSteer ?? false,
      actions: SetupActions(
        model: { source, picked in
          model.perform(["type": "thread.setModel", "threadId": threadId, "sourceKey": source, "model": picked]) {
            problem = $0
          }
        },
        effort: { effort in
          model.perform(["type": "thread.setEffort", "threadId": threadId, "effort": effort]) { problem = $0 }
        },
        tier: { tier in
          model.perform(["type": "thread.setTier", "threadId": threadId, "tier": tier.map { $0 as Any } ?? NSNull()]) {
            problem = $0
          }
        },
        access: { mode in
          model.perform(["type": "thread.setAccess", "threadId": threadId, "access": mode]) { problem = $0 }
        }
      ),
      onSend: { text, attachments in
        onSent()
        _ = try await model.request([
          "type": "thread.send", "threadId": threadId, "text": text, "attachments": attachments,
        ])
      },
      onStop: {
        model.perform(["type": "thread.stop", "threadId": threadId]) { problem = $0 }
      },
      onSteer: { id in
        model.perform(["type": "thread.steer", "threadId": threadId, "queuedId": id]) { problem = $0 }
      },
      onUnqueue: { id in
        model.perform(["type": "thread.unqueue", "threadId": threadId, "queuedId": id]) { problem = $0 }
      },
      onMove: { id, up in
        model.perform([
          "type": "thread.moveQueued", "threadId": threadId, "queuedId": id, "direction": up ? "up" : "down",
        ]) { problem = $0 }
      }
    )
  }
}

/// A chat that does not exist yet. The middle of the screen is the project it
/// will start in; the composer below is the same one every chat has.
struct NewChatScreen: View {
  @Environment(AppModel.self) private var model
  let project: String?
  @State private var started: String?
  @State private var pending: String?
  @State private var addingProject = false
  @State private var problem: String?

  var body: some View {
    if let started {
      ChatScreen(threadId: started)
    } else {
      content
        .onAppear {
          model.send(["type": "newChat.open", "projectPath": project.map { $0 as Any } ?? NSNull()])
        }
    }
  }

  private var content: some View {
    let view = model.newChat
    return VStack {
      if let pending {
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            UserMessage(text: pending, attachments: [])
            WorkingLine(text: "Starting")
          }
          .padding(.horizontal, 20)
          .padding(.top, 14)
        }
        .defaultScrollAnchor(.bottom)
      } else {
        Spacer()
        ProjectPicker(view: view, addingProject: $addingProject)
        Spacer()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .safeAreaBar(edge: .bottom) {
      Composer(
        draftKey: "new:\(view.projectPath ?? "")",
        placeholder: view.projectName.map { "Ask anything in \($0)" } ?? "Message",
        setup: view.setup,
        running: false,
        enabled: model.link?.phase == .open && pending == nil && view.projectPath != nil,
        actions: SetupActions(
          model: { source, picked in model.send(["type": "newChat.set", "sourceKey": source, "model": picked]) },
          effort: { effort in model.send(["type": "newChat.set", "effort": effort]) },
          tier: { tier in model.send(["type": "newChat.set", "tier": tier.map { $0 as Any } ?? NSNull()]) },
          access: { mode in model.send(["type": "newChat.set", "access": mode]) }
        ),
        onSend: { text, attachments in
          pending = text
          do {
            let chat = try await model.request(
              StartedChat.self, ["type": "newChat.start", "text": text, "attachments": attachments])
            started = chat.threadId
          } catch {
            pending = nil
            throw error
          }
        }
      )
      .padding(.horizontal, 10)
      .padding(.bottom, 6)
    }
    .navigationTitle("New Chat")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $addingProject) {
      FolderBrowser { path in
        addingProject = false
        model.send(["type": "newChat.set", "projectPath": path])
      }
    }
    .problemAlert($problem)
  }
}

/// The project name, large, as the menu that changes it.
private struct ProjectPicker: View {
  @Environment(AppModel.self) private var model
  let view: NewChatView
  @Binding var addingProject: Bool

  var body: some View {
    VStack(spacing: 6) {
      if model.chats.projects.isEmpty {
        Text("Add a project to start")
          .font(.title2.weight(.semibold))
        Button("Add Project") { addingProject = true }
          .buttonStyle(.glass)
          .padding(.top, 8)
      } else {
        Menu {
          Picker(
            "Project",
            selection: Binding(
              get: { view.projectPath ?? "" },
              set: { model.send(["type": "newChat.set", "projectPath": $0]) }
            )
          ) {
            ForEach(model.chats.projects) { project in
              Text(project.name).tag(project.path)
            }
          }
          .pickerStyle(.inline)
          Section {
            Toggle(
              "Private Checkout",
              systemImage: "arrow.triangle.branch",
              isOn: Binding(get: { view.isolate }, set: { model.send(["type": "newChat.set", "isolate": $0]) })
            )
            Button("Add Project…", systemImage: "folder.badge.plus") { addingProject = true }
          }
        } label: {
          HStack(spacing: 6) {
            Text(view.projectName ?? "Choose a project")
              .font(.title2.weight(.semibold))
              .foregroundStyle(.primary)
            Image(systemName: "chevron.down")
              .font(.footnote.weight(.bold))
              .foregroundStyle(.tertiary)
          }
          .contentShape(.rect)
        }
        .menuOrder(.fixed)
        Text(placeLine)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 32)
    .multilineTextAlignment(.center)
  }

  private var placeLine: String {
    let computer = model.link?.computerName ?? "your computer"
    return view.isolate ? "In a private checkout on \(computer)" : "On \(computer)"
  }
}
