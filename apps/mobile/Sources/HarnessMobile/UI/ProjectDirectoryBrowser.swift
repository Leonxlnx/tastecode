import SwiftUI

enum ProjectDirectorySort: String, CaseIterable, Sendable, Identifiable {
  case name
  case modified
  case kind

  var id: String { rawValue }

  var title: String {
    switch self {
    case .name: "Name"
    case .modified: "Modified"
    case .kind: "Kind"
    }
  }
}

enum ProjectDirectoryPresentation {
  static func entries(
    from entries: [ProjectDirectoryEntry],
    query: String,
    sort: ProjectDirectorySort
  ) -> [ProjectDirectoryEntry] {
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return
      entries
      .filter { trimmedQuery.isEmpty || $0.name.localizedCaseInsensitiveContains(trimmedQuery) }
      .sorted { left, right in
        if left.kind != right.kind { return left.kind == .directory }

        switch sort {
        case .name:
          return namePrecedes(left.name, right.name)
        case .modified:
          if left.modifiedAt != right.modifiedAt { return left.modifiedAt > right.modifiedAt }
          return namePrecedes(left.name, right.name)
        case .kind:
          let leftKind = fileKind(left)
          let rightKind = fileKind(right)
          if leftKind != rightKind { return namePrecedes(leftKind, rightKind) }
          return namePrecedes(left.name, right.name)
        }
      }
  }

  private static func namePrecedes(_ left: String, _ right: String) -> Bool {
    left.localizedStandardCompare(right) == .orderedAscending
  }

  private static func fileKind(_ entry: ProjectDirectoryEntry) -> String {
    guard entry.kind == .file else { return "" }
    return entry.name.split(separator: ".").last.map(String.init)?.lowercased() ?? ""
  }
}

struct ProjectDirectoryBrowser: View {
  @EnvironmentObject private var model: AppModel

  let onBack: () -> Void
  let onSelected: (ProjectRecord) -> Void

  @State private var directory: ProjectDirectoryListing?
  @State private var history: [ProjectDirectoryListing] = []
  @State private var query = ""
  @State private var sort = ProjectDirectorySort.name
  @State private var loading = true
  @State private var selecting = false
  @State private var errorMessage: String?

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(
        title: directoryTitle,
        leading: AnyView(
          GlassIconButton(
            icon: .arrowLeft,
            accessibilityLabel: history.isEmpty ? "Back to projects" : "Previous folder",
            disabled: loading || selecting,
            action: goBack
          )
        ),
        trailing: AnyView(doneButton)
      )

      if let directory {
        browserControls(directory: directory)
      }

      ZStack {
        browserContent
        if loading, directory != nil {
          HarnessColor.background.opacity(0.72)
          LucideLoader(size: 18)
            .foregroundStyle(HarnessColor.secondary)
        }
      }
    }
    .background(HarnessColor.background)
    .task {
      guard directory == nil else { return }
      await loadDirectory(at: nil, rememberingCurrent: false)
    }
    .alert(
      "Couldn’t open folder",
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

  private var directoryTitle: String {
    guard let directory else { return "Choose folder" }
    return directory.parent == nil ? "Home" : directory.name
  }

  private var visibleEntries: [ProjectDirectoryEntry] {
    ProjectDirectoryPresentation.entries(
      from: directory?.entries ?? [], query: query, sort: sort)
  }

  private var doneButton: some View {
    Button {
      Task { await selectCurrentDirectory() }
    } label: {
      Group {
        if selecting {
          ProgressView()
            .controlSize(.small)
        } else {
          Text("Done")
        }
      }
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HarnessColor.blue)
      .frame(minWidth: 48, minHeight: 44, alignment: .trailing)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(directory == nil || loading || selecting)
    .opacity(directory == nil || loading ? 0.4 : 1)
    .accessibilityHint("Uses the current folder as the project")
  }

  private func browserControls(directory: ProjectDirectoryListing) -> some View {
    VStack(spacing: 5) {
      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          HStack(spacing: 8) {
            LucideIconView(.search, size: 14)
              .foregroundStyle(HarnessColor.secondary)
            TextField("Search this folder", text: $query)
              .font(.system(size: 14))
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .submitLabel(.search)
            if !query.isEmpty {
              Button {
                query = ""
              } label: {
                LucideIconView(.x, size: 12)
                  .foregroundStyle(HarnessColor.secondary)
                  .frame(width: 28, height: 40)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Clear search")
            }
          }
          .padding(.leading, 12)
          .padding(.trailing, query.isEmpty ? 12 : 2)
          .frame(height: 40)
          .harnessSurface(cornerRadius: 13)

          Menu {
            Picker("Sort by", selection: $sort) {
              ForEach(ProjectDirectorySort.allCases) { option in
                Text(option.title).tag(option)
              }
            }
          } label: {
            HStack(spacing: 6) {
              LucideIconView(.slidersHorizontal, size: 13)
              Text(sort.title)
                .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 11)
            .frame(height: 40)
            .harnessSurface(cornerRadius: 13, interactive: true)
          }
          .accessibilityLabel("Sort by \(sort.title)")
        }
      }

      Text(directory.path)
        .font(.system(size: 10.5, weight: .medium))
        .foregroundStyle(HarnessColor.tertiary)
        .lineLimit(1)
        .truncationMode(.head)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 2)
    }
    .padding(.horizontal, HarnessMetrics.pageInset)
    .padding(.top, 8)
    .padding(.bottom, 5)
    .disabled(loading || selecting)
  }

  @ViewBuilder
  private var browserContent: some View {
    if directory == nil, loading {
      LucideLoader(size: 18)
        .foregroundStyle(HarnessColor.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if directory == nil {
      ContentUnavailableView {
        Label {
          Text("Folders unavailable")
        } icon: {
          LucideIconView(.folderSearch, size: 38)
        }
      } description: {
        Text("Check the connection to your Harness machine and try again.")
      } actions: {
        Button("Try Again") {
          Task { await loadDirectory(at: nil, rememberingCurrent: false) }
        }
      }
    } else if visibleEntries.isEmpty {
      ContentUnavailableView {
        Label {
          Text(query.isEmpty ? "This folder is empty" : "No matches")
        } icon: {
          LucideIconView(query.isEmpty ? .folder : .search, size: 38)
        }
      } description: {
        if !query.isEmpty { Text("Try a different name in this folder.") }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(visibleEntries) { entry in
            entryRow(entry)
            if entry.path != visibleEntries.last?.path {
              Divider().overlay(HarnessColor.separator).padding(.leading, 35)
            }
          }
        }
        .harnessSurface()
        .padding(.horizontal, HarnessMetrics.pageInset)
        .padding(.top, 5)
        .padding(.bottom, 18)
      }
      .scrollDismissesKeyboard(.interactively)
    }
  }

  @ViewBuilder
  private func entryRow(_ entry: ProjectDirectoryEntry) -> some View {
    if entry.kind == .directory {
      Button {
        Task { await loadDirectory(at: entry.path, rememberingCurrent: true) }
      } label: {
        entryLabel(entry)
      }
      .buttonStyle(.plain)
      .disabled(loading || selecting)
      .accessibilityHint("Opens folder")
    } else {
      entryLabel(entry)
        .accessibilityLabel("\(entry.name), file")
    }
  }

  private func entryLabel(_ entry: ProjectDirectoryEntry) -> some View {
    HStack(spacing: 10) {
      LucideIconView(entry.kind == .directory ? .folder : .file, size: 12)
        .foregroundStyle(HarnessColor.secondary)
      Text(entry.name)
        .font(.system(size: 14, weight: entry.kind == .directory ? .semibold : .regular))
        .foregroundStyle(entry.kind == .directory ? .white : HarnessColor.secondary)
        .lineLimit(1)
      Spacer()
      if entry.kind == .directory {
        LucideIconView(.chevronRight, size: 10)
          .foregroundStyle(HarnessColor.tertiary)
      }
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 46)
    .contentShape(.rect)
  }

  private func goBack() {
    query = ""
    errorMessage = nil
    if let previous = history.popLast() {
      directory = previous
    } else {
      onBack()
    }
  }

  private func loadDirectory(at path: String?, rememberingCurrent: Bool) async {
    guard !loading || directory == nil else { return }
    let previous = directory
    loading = true
    defer { loading = false }

    do {
      let next = try await model.browseProjectDirectory(at: path)
      if rememberingCurrent, let previous { history.append(previous) }
      directory = next
      query = ""
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func selectCurrentDirectory() async {
    guard let directory, !selecting else { return }
    selecting = true
    defer { selecting = false }

    do {
      onSelected(try await model.addProject(at: directory.path))
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
