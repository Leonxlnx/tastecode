import SwiftUI
import UIKit

/// Settings, as a list of pages like the system's: the paired devices
/// first, then the app itself.
struct SettingsSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section("Connections") {
          NavigationLink {
            DevicesSettings { dismiss() }
          } label: {
            LabeledContent {
              Text(model.link == nil ? "" : "1")
            } label: {
              SettingsLabel("Devices", systemImage: "laptopcomputer")
            }
          }
        }
        Section("Interface") {
          NavigationLink {
            AppearanceSettings()
          } label: {
            SettingsLabel("Appearance", systemImage: "textformat.size")
          }
        }
        Section("App") {
          NavigationLink {
            AboutSettings()
          } label: {
            LabeledContent {
              Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
            } label: {
              SettingsLabel("About", systemImage: "info.circle")
            }
          }
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { dismiss() }
        }
      }
    }
    .presentationDetents([.height(560), .large])
  }
}

/// The computers this phone is paired with, one row each. A phone pairs
/// with one computer today; the list is ready for more.
private struct DevicesSettings: View {
  @Environment(AppModel.self) private var model
  let onForget: () -> Void

  var body: some View {
    let link = model.link
    Form {
      Section {
        ForEach(link.map { [$0] } ?? [], id: \.phoneKey) { device in
          NavigationLink {
            ComputerSettings(onForget: onForget)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text(device.computerName ?? "Computer")
              Text(computerStatus(device))
                .font(.subheadline)
                .foregroundStyle(device.phase == .refused ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
            .padding(.vertical, 2)
          }
        }
      }
    }
    .navigationTitle("Devices")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A settings row's name with its symbol in the text's colour, not the tint.
private struct SettingsLabel: View {
  let title: String
  let systemImage: String

  init(_ title: String, systemImage: String) {
    self.title = title
    self.systemImage = systemImage
  }

  var body: some View {
    Label {
      Text(title)
    } icon: {
      Image(systemName: systemImage).foregroundStyle(.primary)
    }
  }
}

private func computerStatus(_ link: LinkView?) -> String {
  switch link?.phase {
  case .open: return link?.host.map { "Connected · \($0)" } ?? "Connected"
  case .connecting, .idle, nil: return "Connecting…"
  case .waiting: return "Not reachable"
  case .refused: return "Needs pairing again"
  }
}

/// The paired computer: whether it answers, the keys that prove it is the one
/// you paired, and the way to forget it.
private struct ComputerSettings: View {
  @Environment(AppModel.self) private var model
  let onForget: () -> Void
  @State private var forgetting = false

  var body: some View {
    let link = model.link
    let name = link?.computerName ?? "Computer"
    Form {
      Section {
        NavigationLink {
          ComputerName()
        } label: {
          LabeledContent("Name", value: name)
        }
      }
      Section {
        LabeledContent("Status", value: link?.phase == .open ? "Connected" : computerStatus(link))
        if let host = link?.host, link?.phase == .open {
          LabeledContent("Address", value: host)
        }
        if let error = link?.error, link?.phase != .open {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        if link?.phase == .waiting {
          Button("Try Again") { model.send(["type": "reconnect"]) }
        }
      }
      Section {
        if let key = link?.computerKey {
          LabeledContent("Computer") {
            Text(key).font(.system(.subheadline, design: .monospaced))
          }
        }
        LabeledContent("This phone") {
          Text(link?.phoneKey ?? "").font(.system(.subheadline, design: .monospaced))
        }
      } header: {
        Text("Keys")
      } footer: {
        Text("The link is encrypted end to end and only this computer's key can answer it, over Wi‑Fi or Tailscale. Nothing passes through a server.")
      }
      Section {
        Button("Forget This Computer", role: .destructive) { forgetting = true }
          .alert("Forget \(name)?", isPresented: $forgetting) {
            Button("Cancel", role: .cancel) {}
            Button("Forget", role: .destructive) {
              onForget()
              model.send(["type": "forget"])
            }
          } message: {
            Text("This phone stops connecting and has to be paired again from the computer.")
          }
      }
    }
    .navigationTitle(name)
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// Renames the computer on this phone only; an empty name goes back to the computer's own.
private struct ComputerName: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    Form {
      Section {
        TextField(model.link?.defaultName ?? "Name", text: $draft)
          .focused($focused)
          .submitLabel(.done)
          .onSubmit { dismiss() }
      } footer: {
        if let own = model.link?.defaultName {
          Text("Only this phone uses this name. Leave it empty to use \(own).")
        }
      }
    }
    .navigationTitle("Name")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      draft = model.link?.computerName ?? ""
      focused = true
    }
    .onDisappear {
      let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      guard name != model.link?.computerName else { return }
      model.send(["type": "computer.rename", "name": name == model.link?.defaultName ? "" : name])
    }
  }
}

private struct AboutSettings: View {
  var body: some View {
    Form {
      LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
      LabeledContent("Build", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")
    }
    .navigationTitle("About")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// Choosing a project on the computer's disk, folder by folder.
struct FolderBrowser: View {
  let onAdded: (String) -> Void
  @State private var path: [String] = []

  var body: some View {
    NavigationStack(path: $path) {
      FolderList(folder: nil, onAdded: onAdded) { path = [$0] }
        .navigationDestination(for: String.self) { folder in
          FolderList(folder: folder, onAdded: onAdded) { path = [$0] }
        }
    }
  }
}

private struct FolderList: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let folder: String?
  let onAdded: (String) -> Void
  let onJump: (String) -> Void
  @State private var listing: BrowseResult?
  @State private var error: String?
  @State private var adding: String?
  @State private var query = ""

  var body: some View {
    List {
      if let listing {
        ForEach(matching(listing)) { entry in
          NavigationLink(value: entry.path) {
            HStack(spacing: 12) {
              Image(systemName: "folder")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 22)
              Text(entry.name)
                .lineLimit(1)
              Spacer(minLength: 8)
              if entry.added {
                Text("Added")
                  .font(.subheadline)
                  .foregroundStyle(.tertiary)
              } else if entry.repository {
                Button("Add") { add(entry.path) }
                  .font(.subheadline.weight(.semibold))
                  .buttonStyle(.borderless)
                  .disabled(adding != nil)
              }
            }
          }
        }
        if listing.truncated {
          Text("Only the first folders are listed.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
    }
    .listStyle(.plain)
    .overlay {
      if let error {
        ContentUnavailableView("Can't Open This Folder", systemImage: "folder.badge.questionmark", description: Text(error))
      } else if listing == nil {
        ProgressView()
      } else if listing?.folders.isEmpty == true {
        ContentUnavailableView("No Folders Inside", systemImage: "folder")
      } else if let listing, matching(listing).isEmpty {
        ContentUnavailableView.search(text: query)
      }
    }
    .searchable(text: $query, prompt: "Search folders")
    .searchPresentationToolbarBehavior(.avoidHidingContent)
    // Beside the Add button a full field would be cut to a few letters.
    .searchToolbarBehavior(canAdd ? .minimize : .automatic)
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .navigationSubtitle(listing?.path ?? "")
    .toolbar {
      if folder == nil {
        ToolbarItem(placement: .topBarLeading) {
          Button(role: .close) { dismiss() }
        }
      }
      if let listing, listing.roots.count > 1 {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            ForEach(listing.roots) { root in
              Button(root.name) { onJump(root.path) }
            }
          } label: {
            Image(systemName: "externaldrive")
          }
        }
      }
      if listing?.folders.isEmpty == false {
        DefaultToolbarItem(kind: .search, placement: .bottomBar)
      }
      if canAdd, let listing {
        ToolbarSpacer(.fixed, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
          Button {
            add(listing.path)
          } label: {
            Text(adding == nil ? "Add \(title)" : "Adding…")
              .fontWeight(.semibold)
              .foregroundStyle(Color(.systemBackground))
              .padding(.horizontal, 12)
          }
          .buttonStyle(.glassProminent)
          .disabled(adding != nil)
        }
      }
    }
    .task {
      do {
        listing = try await model.request(
          BrowseResult.self, ["type": "project.browse", "path": folder.map { $0 as Any } ?? NSNull()])
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// The open folder is neither home nor already a project.
  private var canAdd: Bool {
    guard let listing else { return false }
    return listing.path != listing.home && !model.chats.projects.contains(where: { $0.path == listing.path })
  }

  private var title: String {
    guard let listing else { return "Folders" }
    if listing.path == listing.home { return "Home" }
    return listing.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? listing.path
  }

  private func matching(_ listing: BrowseResult) -> [BrowsedFolder] {
    let needle = query.trimmingCharacters(in: .whitespaces)
    if needle.isEmpty { return listing.folders }
    return listing.folders.filter { $0.name.localizedStandardContains(needle) }
  }

  private func add(_ path: String) {
    adding = path
    Task {
      do {
        _ = try await model.request(["type": "project.add", "path": path])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onAdded(path)
      } catch {
        adding = nil
        self.error = error.localizedDescription
      }
    }
  }
}

/// What the chat changed in its checkout, file by file.
struct ChangesSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let threadId: String
  @State private var diff: SessionDiff?
  @State private var error: String?

  var body: some View {
    NavigationStack {
      List {
        ForEach(diff?.files ?? []) { file in
          NavigationLink {
            DiffScreen(file: file)
          } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(fileName(file.path))
                  .lineLimit(1)
                if fileName(file.path) != file.path {
                  Text(file.path)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                }
              }
              Spacer(minLength: 8)
              if file.binary {
                Text("Binary").font(.subheadline).foregroundStyle(.tertiary)
              } else {
                LineCounts(added: file.added, removed: file.removed)
                  .font(.subheadline)
              }
            }
          }
        }
      }
      .listStyle(.plain)
      .overlay {
        if let error {
          ContentUnavailableView("No Changes Shown", systemImage: "exclamationmark.triangle", description: Text(error))
        } else if diff == nil {
          ProgressView()
        } else if diff?.files.isEmpty == true {
          ContentUnavailableView(
            "No Changes", systemImage: "checkmark",
            description: Text("The checkout this chat works in has no uncommitted changes."))
        }
      }
      .navigationTitle("Changes")
      .navigationBarTitleDisplayMode(.inline)
      .navigationSubtitle(summary)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { dismiss() }
        }
      }
      .task {
        do {
          diff = try await model.request(SessionDiff.self, ["type": "thread.diff", "threadId": threadId])
        } catch {
          self.error = error.localizedDescription
        }
      }
    }
  }

  private var summary: String {
    guard let files = diff?.files, !files.isEmpty else { return "" }
    let added = files.reduce(0) { $0 + $1.added }
    let removed = files.reduce(0) { $0 + $1.removed }
    return "\(files.count) \(files.count == 1 ? "file" : "files") · +\(added) −\(removed)"
  }
}

private func fileName(_ path: String) -> String {
  path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
}

/// One file's changes, line by line, as a unified diff.
private struct DiffScreen: View {
  let file: DiffFile
  @State private var width: CGFloat = 0
  private let limit = 1500

  var body: some View {
    let lines = flattened
    ScrollView([.vertical, .horizontal]) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(lines.prefix(limit).enumerated()), id: \.offset) { _, line in
          Text(line.text.isEmpty ? " " : line.text)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(line.kind == "header" ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            .fixedSize()
            .padding(.horizontal, 16)
            .padding(.vertical, line.kind == "header" ? 6 : 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background(line.kind))
        }
        if lines.count > limit {
          Text("\(lines.count - limit) more lines on the computer")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(16)
        }
      }
      .frame(minWidth: width, alignment: .leading)
      .padding(.vertical, 8)
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .navigationTitle(fileName(file.path))
    .navigationBarTitleDisplayMode(.inline)
    .navigationSubtitle(fileName(file.path) == file.path ? "" : file.path)
  }

  private var flattened: [(kind: String, text: String)] {
    file.hunks.flatMap { hunk in
      [("header", hunk.header?.isEmpty == false ? hunk.header! : "@@ \(hunk.oldStart) → \(hunk.newStart) @@")]
        + hunk.lines.map { line in
          (line.kind, "\(line.kind == "addition" ? "+" : line.kind == "deletion" ? "−" : " ") \(line.text)")
        }
    }
  }

  private func background(_ kind: String) -> Color {
    switch kind {
    case "addition": return .green.opacity(0.14)
    case "deletion": return .red.opacity(0.14)
    default: return .clear
    }
  }
}
