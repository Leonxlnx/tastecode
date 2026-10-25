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
  @AppStorage("foldedProjects") private var foldedStore = ""
  /// Folded projects as the list draws them; changed inside an animation, then stored.
  @State private var folded: Set<String>?

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
    let archived = chats.filter(\.archived)
    List {
      ForEach(ChatGroup.groups(active, seen: model.seen), id: \.title) { group in
        Section {
          let folded = group.foldable && foldedProjects.contains(group.title) && query.isEmpty
          GroupHeader(title: group.title, count: group.chats.count, foldable: group.foldable, folded: folded) {
            toggleFold(group.title)
          }
          if !folded {
            ForEach(group.chats) { chat in
              ChatRow(chat: chat, problem: $problem, onRename: startRenaming)
            }
          }
        }
        .listSectionSeparator(.hidden)
      }
      if showArchived && !archived.isEmpty {
        Section {
          GroupHeader(title: "Archived", count: archived.count, foldable: false, folded: false) {}
          ForEach(archived) { chat in
            ChatRow(chat: chat, problem: $problem, onRename: startRenaming)
          }
        }
        .listSectionSeparator(.hidden)
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

  /// Projects folded away, by name; kept on this phone across launches.
  private var foldedProjects: Set<String> {
    folded ?? Set(foldedStore.split(separator: "\n").map(String.init))
  }

  private func toggleFold(_ name: String) {
    var folded = foldedProjects
    if folded.contains(name) { folded.remove(name) } else { folded.insert(name) }
    // The state changes inside the animation, so the rows slide and the chevron turns with it.
    withAnimation(.smooth(duration: 0.38)) { self.folded = folded }
    foldedStore = folded.sorted().joined(separator: "\n")
  }

  @ViewBuilder private var emptyState: some View {
    let status = model.chats.status
    if !query.isEmpty {
      ContentUnavailableView("No Results for “\(query)”", tabler: "search", description: Text("Check the spelling or try a new search."))
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
        Image(tabler: "settings", size: 22)
      }
      .accessibilityLabel("Settings")
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Section {
          Picker("Project", tabler: "folder", selection: $project) {
            Text("All Projects").tag(String?.none)
            ForEach(model.chats.projects) { entry in
              Text(entry.name).tag(Optional(entry.path))
            }
          }
          // One computer today; the list is ready for more.
          Picker("Device", tabler: "device-laptop", selection: $device) {
            Text("All Devices").tag(String?.none)
            if let name = model.link?.computerName {
              Text(name).tag(Optional(name))
            }
          }
          Picker("Agent", tabler: "terminal-2", selection: $source) {
            Text("All Agents").tag(String?.none)
            ForEach(distinct { $0.sourceName }, id: \.self) { name in
              Text(name).tag(Optional(name))
            }
          }
          Picker("Model", tabler: "cpu", selection: $modelName) {
            Text("All Models").tag(String?.none)
            ForEach(distinct { $0.modelName }, id: \.self) { name in
              Text(name).tag(Optional(name))
            }
          }
          Picker("Status", tabler: "circle-dashed", selection: $status) {
            ForEach(StatusFilter.allCases, id: \.self) { filter in
              Text(filter.title).tag(filter)
            }
          }
        }
        .pickerStyle(.menu)
        Section {
          Toggle("Show Archived", tabler: "archive", isOn: $showArchived)
          if filtering {
            Button("Clear Filters", tabler: "x") { clearFilters() }
          }
        }
        Section {
          Button("Add Project…", tabler: "folder-plus") { addingProject = true }
        }
      } label: {
        Image(tabler: filtering ? "filter-filled" : "filter", size: 22)
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
        Image(tabler: "edit", size: 22)
      }
      .accessibilityLabel("New Chat")
    }
  }
}

/// A run of chats under one heading: pinned ones, the ones that need you, then
/// one group per project in the order its newest chat comes, so a row never
/// has to repeat its project.
struct ChatGroup {
  let title: String
  let chats: [ChatView]
  /// Only projects fold away; what is pinned or needs you always shows.
  let foldable: Bool

  /// `seen`: whether a chat was on screen here since its last activity.
  static func groups(_ chats: [ChatView], seen: (ChatView) -> Bool) -> [ChatGroup] {
    let pinned = chats.filter(\.pinned)
    let rest = chats.filter { !$0.pinned }
    // A question or approval waits until answered; a failure only until it is seen.
    let waiting = rest.filter { $0.state.waitsForYou || ($0.state == .failed && !seen($0)) }
    var groups: [ChatGroup] = []
    if !pinned.isEmpty { groups.append(ChatGroup(title: "Pinned", chats: pinned, foldable: false)) }
    if !waiting.isEmpty { groups.append(ChatGroup(title: "Needs You", chats: waiting, foldable: false)) }
    var order: [String] = []
    var byProject: [String: [ChatView]] = [:]
    for chat in rest where !waiting.contains(chat) {
      if byProject[chat.projectName] == nil { order.append(chat.projectName) }
      byProject[chat.projectName, default: []].append(chat)
    }
    for name in order { groups.append(ChatGroup(title: name, chats: byProject[name] ?? [], foldable: true)) }
    return groups
  }
}

/// A group's name over its chats. A project's name folds it away with a tap,
/// leaving the name and how many chats wait under it.
struct GroupHeader: View {
  let title: String
  let count: Int
  let foldable: Bool
  let folded: Bool
  let toggle: () -> Void

  var body: some View {
    Group {
      if foldable {
        Button(action: toggle) { label }
          .buttonStyle(.plain)
          .accessibilityValue(folded ? "Folded, \(count) chats" : "Open")
      } else {
        label
      }
    }
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(top: 18, leading: 20, bottom: 4, trailing: 20))
    .accessibilityAddTraits(.isHeader)
  }

  /// The name with its chat count beside it; the chevron at the edge turns as
  /// the group folds.
  private var label: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.primary)
      Text("\(count)")
        .font(.subheadline)
        .monospacedDigit()
        .foregroundStyle(.tertiary)
      Spacer()
      if foldable { chevron }
    }
    .contentShape(Rectangle())
  }

  private var chevron: some View {
    Image(tabler: "chevron-down", size: 15)
      .foregroundStyle(.tertiary)
      .rotationEffect(.degrees(folded ? -90 : 0))
  }
}

/// One chat: its title, then the provider's logo, model and what it is doing.
struct ChatRow: View {
  @Environment(AppModel.self) private var model
  let chat: ChatView
  @Binding var problem: String?
  let onRename: (ChatView) -> Void

  var body: some View {
    NavigationLink(value: Route.chat(chat.id)) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(chat.title)
            .font(.callout.weight(chat.unread ? .semibold : .regular))
            .lineLimit(1)
          detail
        }
        Spacer(minLength: 8)
        trailing
      }
      .padding(.vertical, 2)
    }
    .navigationLinkIndicatorVisibility(.hidden)
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
    .swipeActions(edge: .leading) {
      Button(chat.pinned ? "Unpin" : "Pin", tabler: chat.pinned ? "pinned-off" : "pin-filled") {
        togglePin()
      }
      .tint(.orange)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if chat.archived {
        Button("Restore", tabler: "restore") { restore() }
          .tint(.indigo)
      } else {
        Button("Archive", tabler: "archive-filled") { archive() }
          .tint(.indigo)
      }
    }
    .contextMenu {
      Button(chat.pinned ? "Unpin" : "Pin", tabler: chat.pinned ? "pinned-off" : "pin") {
        togglePin()
      }
      Button("Rename", tabler: "pencil") { onRename(chat) }
      if chat.archived {
        Button("Restore", tabler: "restore") { restore() }
      } else {
        Button("Archive", tabler: "archive") { archive() }
      }
    }
    .sensoryFeedback(.selection, trigger: chat.pinned)
  }

  /// Logo and model, then the project where the group does not name it (pinned,
  /// needs you, archived), then the state. A long line gives up the project first.
  private var detail: some View {
    HStack(spacing: 0) {
      ProviderLogo(mark: chat.mark, size: 12)
        .foregroundStyle(.secondary)
        .padding(.trailing, 5)
      Text(showsProject ? "\(chat.modelName ?? chat.sourceName) · \(chat.projectName)" : chat.modelName ?? chat.sourceName)
        .foregroundStyle(.secondary)
      if let state = stateText {
        Text("\(Text(" · ").foregroundStyle(.secondary))\(state)")
          .layoutPriority(1)
      }
    }
    .font(.footnote)
    .lineLimit(1)
  }

  /// In a group that is not its project's: pinned, archived or needing you.
  private var showsProject: Bool {
    chat.pinned || chat.archived || chat.state.waitsForYou || (chat.state == .failed && !model.seen(chat))
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
          Image(tabler: "pin-filled", size: 13)
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
