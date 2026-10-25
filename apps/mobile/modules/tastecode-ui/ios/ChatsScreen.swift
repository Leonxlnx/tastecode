import SwiftUI

enum Route: Hashable {
  case chat(String)
  case newChat(project: String?)
}

/// The app's home: every chat on the computer in one list, the ones waiting
/// for you first. Projects filter it; search and a new chat sit at the bottom
/// where the thumb is.
struct ChatsScreen: View {
  @Environment(AppModel.self) private var model
  @State private var path: [Route] = []
  @State private var query = ""
  @State private var project: String?
  @State private var device: String?
  @State private var source: String?
  @State private var modelName: String?
  @State private var status: StatusFilter = .all
  @State private var showArchived = false
  @State private var showSettings = false
  @State private var addingProject = false
  @State private var problem: String?
  @State private var renaming: ChatView?
  @State private var newTitle = ""

  var body: some View {
    NavigationStack(path: $path) {
      list
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .searchable(text: $query, prompt: "Search chats")
        .searchPresentationToolbarBehavior(.avoidHidingContent)
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .chat(let id):
            ChatScreen(threadId: id)
          case .newChat(let project):
            NewChatScreen(project: project)
          }
        }
    }
    .sheet(isPresented: $showSettings) {
      SettingsSheet()
    }
    .sheet(isPresented: $addingProject) {
      FolderBrowser { path in
        addingProject = false
        project = path
      }
    }
    .problemAlert($problem)
    .alert("Rename Chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Title", text: $newTitle)
        .submitLabel(.done)
      Button("Cancel", role: .cancel) {}
      Button("Rename") { rename() }
        .disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }

  private func startRenaming(_ chat: ChatView) {
    newTitle = chat.title
    renaming = chat
  }

  private func rename() {
    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let chat = renaming, !title.isEmpty, title != chat.title else { return }
    model.perform(["type": "thread.rename", "threadId": chat.id, "title": title]) { problem = $0 }
  }

  private var title: String {
    if let project, let found = model.chats.projects.first(where: { $0.path == project }) {
      return found.name
    }
    return ""
  }

  private var filtering: Bool {
    project != nil || device != nil || source != nil || modelName != nil || status != .all
  }

  private func clearFilters() {
    project = nil
    device = nil
    source = nil
    modelName = nil
    status = .all
  }

  /// The values the chats carry for one field, each once, in name order.
  private func distinct(_ field: (ChatView) -> String?) -> [String] {
    Set(model.chats.chats.compactMap(field)).sorted {
      $0.localizedStandardCompare($1) == .orderedAscending
    }
  }

  private var matching: [ChatView] {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    return model.chats.chats.filter { chat in
      (project == nil || chat.projectPath == project)
        && (source == nil || chat.sourceName == source)
        && (modelName == nil || chat.modelName == modelName)
        && status.includes(chat)
        && (needle.isEmpty || chat.title.lowercased().contains(needle)
          || chat.projectName.lowercased().contains(needle))
    }
  }

  @ViewBuilder private var list: some View {
    let chats = matching
    let active = chats.filter { !$0.archived }
    let pinned = active.filter(\.pinned)
    let others = active.filter { !$0.pinned }
    let archived = chats.filter(\.archived)
    List {
      if !pinned.isEmpty {
        Section("Pinned") {
          ForEach(pinned) { chat in
            ChatRow(chat: chat, problem: $problem, onRename: startRenaming)
          }
        }
      }
      Section {
        ForEach(others) { chat in
          ChatRow(chat: chat, problem: $problem, onRename: startRenaming)
        }
      } header: {
        if !pinned.isEmpty { Text("Chats") }
      }
      .listSectionSeparator(.hidden, edges: .top)
      if showArchived && !archived.isEmpty {
        Section("Archived") {
          ForEach(archived) { chat in
            ChatRow(chat: chat, problem: $problem, onRename: startRenaming)
          }
        }
      }
    }
    .listStyle(.plain)
    .refreshable {
      _ = try? await model.request(["type": "refresh"])
    }
    .overlay {
      if active.isEmpty && (!showArchived || archived.isEmpty) {
        emptyState
      }
    }
    .animation(.default, value: chats.map(\.id))
  }

  @ViewBuilder private var emptyState: some View {
    let status = model.chats.status
    if !query.isEmpty {
      ContentUnavailableView.search(text: query)
    } else if let link = model.link, link.phase == .waiting || link.phase == .refused, status != .ready {
      ContentUnavailableView {
        Text("Can't reach \(link.computerName ?? "your computer")")
      } description: {
        Text(link.error ?? "")
      } actions: {
        if link.phase == .waiting {
          Button("Try Again") { model.send(["type": "reconnect"]) }
            .buttonStyle(.glass)
        } else {
          Button("Pair Again") { model.send(["type": "forget"]) }
            .buttonStyle(.glass)
        }
      }
    } else if status == .idle || status == .loading {
      ProgressView()
    } else if filtering {
      ContentUnavailableView {
        Text("No matching chats")
      } description: {
        Text("No chat matches these filters.")
      } actions: {
        Button("Clear Filters") { clearFilters() }
          .buttonStyle(.glass)
      }
    } else if model.chats.projects.isEmpty {
      ContentUnavailableView {
        Text("No projects yet")
      } description: {
        Text("Add a folder on your computer to start chatting in it.")
      } actions: {
        Button("Add Project") { addingProject = true }
          .buttonStyle(.glass)
      }
    } else {
      ContentUnavailableView {
        Text("No chats yet")
      } description: {
        Text("Start one here or on your computer. It shows up in both places.")
      } actions: {
        Button("New Chat") { path.append(.newChat(project: project)) }
          .buttonStyle(.glass)
      }
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button {
        showSettings = true
      } label: {
        Image(systemName: "gearshape")
      }
      .accessibilityLabel("Settings")
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Section {
          Picker("Project", systemImage: "folder", selection: $project) {
            Text("All Projects").tag(String?.none)
            ForEach(model.chats.projects) { entry in
              Text(entry.name).tag(Optional(entry.path))
            }
          }
          // One computer today; the list is ready for more.
          Picker("Device", systemImage: "laptopcomputer", selection: $device) {
            Text("All Devices").tag(String?.none)
            if let name = model.link?.computerName {
              Text(name).tag(Optional(name))
            }
          }
          Picker("Agent", systemImage: "terminal", selection: $source) {
            Text("All Agents").tag(String?.none)
            ForEach(distinct { $0.sourceName }, id: \.self) { name in
              Text(name).tag(Optional(name))
            }
          }
          Picker("Model", systemImage: "cpu", selection: $modelName) {
            Text("All Models").tag(String?.none)
            ForEach(distinct { $0.modelName }, id: \.self) { name in
              Text(name).tag(Optional(name))
            }
          }
          Picker("Status", systemImage: "circle.dashed", selection: $status) {
            ForEach(StatusFilter.allCases, id: \.self) { filter in
              Text(filter.title).tag(filter)
            }
          }
        }
        .pickerStyle(.menu)
        Section {
          Toggle("Show Archived", systemImage: "archivebox", isOn: $showArchived)
          if filtering {
            Button("Clear Filters", systemImage: "xmark") { clearFilters() }
          }
        }
        Section {
          Button("Add Project…", systemImage: "folder.badge.plus") { addingProject = true }
        }
      } label: {
        Image(systemName: filtering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
      }
      .menuOrder(.fixed)
      .accessibilityLabel("Filter")
    }
    DefaultToolbarItem(kind: .search, placement: .bottomBar)
    ToolbarSpacer(.fixed, placement: .bottomBar)
    ToolbarItem(placement: .bottomBar) {
      Button {
        path.append(.newChat(project: project))
      } label: {
        Image(systemName: "square.and.pencil")
      }
      .accessibilityLabel("New Chat")
    }
  }
}

/// One chat: its title, where it runs and what it is doing, and when.
struct ChatRow: View {
  @Environment(AppModel.self) private var model
  let chat: ChatView
  @Binding var problem: String?
  let onRename: (ChatView) -> Void

  var body: some View {
    NavigationLink(value: Route.chat(chat.id)) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(chat.title)
            .font(.subheadline.weight(chat.unread ? .semibold : .regular))
            .lineLimit(1)
          detail
            .font(.footnote)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        trailing
      }
      .padding(.vertical, 1)
    }
    .navigationLinkIndicatorVisibility(.hidden)
    .swipeActions(edge: .leading) {
      Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash.fill" : "pin.fill") {
        togglePin()
      }
      .tint(.orange)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if chat.archived {
        Button("Restore", systemImage: "tray.and.arrow.up.fill") { restore() }
          .tint(.indigo)
      } else {
        Button("Archive", systemImage: "archivebox.fill") { archive() }
          .tint(.indigo)
      }
    }
    .contextMenu {
      Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin") {
        togglePin()
      }
      Button("Rename", systemImage: "pencil") { onRename(chat) }
      if chat.archived {
        Button("Restore", systemImage: "tray.and.arrow.up") { restore() }
      } else {
        Button("Archive", systemImage: "archivebox") { archive() }
      }
    }
    .sensoryFeedback(.selection, trigger: chat.pinned)
  }

  private func togglePin() {
    model.perform(["type": "thread.pin", "threadId": chat.id, "pinned": !chat.pinned]) { problem = $0 }
  }

  private func archive() {
    model.perform(["type": "thread.archive", "threadId": chat.id]) { problem = $0 }
  }

  private func restore() {
    model.perform(["type": "thread.restore", "threadId": chat.id]) { problem = $0 }
  }

  private var detail: Text {
    let project = Text(chat.projectName).foregroundStyle(.secondary)
    guard let state = stateText else { return project }
    return Text("\(project)\(Text(" · ").foregroundStyle(.secondary))\(state)")
  }

  private var stateText: Text? {
    switch chat.state {
    case .approval: return Text("Needs approval").foregroundStyle(.blue)
    case .input: return Text("Has a question").foregroundStyle(.blue)
    case .failed: return Text("Stopped with an error").foregroundStyle(.red)
    case .starting, .working, .queued: return Text("Working").foregroundStyle(.secondary)
    case .idle: return chat.branch.map { Text($0).foregroundStyle(.tertiary) }
    }
  }

  @ViewBuilder private var trailing: some View {
    if chat.state.isWorking {
      ProgressView()
        .controlSize(.small)
    } else {
      HStack(spacing: 5) {
        if chat.pinned {
          Image(systemName: "pin.fill")
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        TimelineView(.periodic(from: .now, by: 60)) { context in
          Text(shortTime(chat.date, now: context.date))
            .font(.footnote)
            .monospacedDigit()
            .foregroundStyle(chat.unread ? .primary : .tertiary)
        }
      }
    }
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
