import SwiftUI

struct ThreadListView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let openThread: (ProjectRecord, ThreadSummary) -> Void
  let openSettings: () -> Void
  let newThread: () -> Void

  @State private var searching = false
  @State private var query = ""
  @State private var pendingDeletion: ThreadRow?

  var body: some View {
    VStack(spacing: 0) {
      header
      Group {
        if connectionBannerVisible {
          connectionBanner
            .transition(.move(edge: .top))
        }
      }
      .zIndex(1)
      if searching { searchField }
      threadList
    }
    .animation(
      reduceMotion ? nil : .smooth(duration: 0.32),
      value: connectionBannerVisible
    )
    .background(HarnessColor.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .toolbar(.hidden, for: .navigationBar)
    .confirmationDialog(
      "Delete this thread permanently?",
      isPresented: Binding(
        get: { pendingDeletion != nil },
        set: { if !$0 { pendingDeletion = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete Thread", role: .destructive) {
        if let row = pendingDeletion { Task { await delete(row) } }
        pendingDeletion = nil
      }
      Button("Cancel", role: .cancel) { pendingDeletion = nil }
    } message: {
      Text(
        "This removes the conversation record. Work in the project remains on the Harness machine.")
    }
  }

  private var header: some View {
    HStack {
      Text("Threads")
        .font(.system(size: 17, weight: .semibold))
      Spacer()
      Menu {
        Button {
          Task { await model.refreshEverything() }
        } label: {
          LucideActionLabel(title: "Refresh", icon: .refreshCw)
        }
        Button {
          openSettings()
        } label: {
          LucideActionLabel(title: "Settings", icon: .settings)
        }
      } label: {
        GlassIconLabel(
          icon: .ellipsis, size: 36, iconSize: 16
        )
        .frame(width: 44, height: 44)
        .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("More")
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
    .padding(.bottom, 8)
  }

  private var connectionBanner: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle()
          .fill(connectionTint.opacity(0.16))
        if connectionBusy {
          LucideLoader(size: 14)
            .foregroundStyle(connectionTint)
        } else {
          LucideIconView(connectionIcon, size: 14)
            .foregroundStyle(connectionTint)
        }
      }
      .frame(width: 32, height: 32)

      Text(connectionText)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.primary)
        .lineLimit(1)
      Spacer()

      Button {
        Task { await model.reconnect() }
      } label: {
        HarnessPillLabel(title: "Retry")
      }
      .buttonStyle(.plain)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
    }
    .padding(.leading, 10)
    .padding(.trailing, 8)
    .frame(minHeight: HarnessMetrics.rowHeight)
    .glassEffect(.regular, in: .rect(cornerRadius: HarnessMetrics.surfaceRadius))
    .padding(.horizontal, HarnessMetrics.pageInset)
    .padding(.bottom, 8)
  }

  private var searchField: some View {
    HStack(spacing: 10) {
      HStack(spacing: 10) {
        LucideIconView(.search, size: 15)
          .foregroundStyle(HarnessColor.secondary)
        TextField("Search threads", text: $query)
          .font(.system(size: 14))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      .padding(.horizontal, 12)
      .frame(height: 38)
      .glassEffect(.regular, in: .capsule)
      Button("Cancel") {
        searching = false
        query = ""
      }
      .font(.system(size: 13, weight: .semibold))
    }
    .padding(.horizontal, 14)
    .padding(.bottom, 6)
  }

  private var threadList: some View {
    let sections = threadSections
    return ScrollView {
      GlassEffectContainer(spacing: 8) {
        LazyVStack(spacing: 8) {
          ForEach(sections.active) { row in
            ActiveThreadCard(row: row) {
              openThread(row.project, row.thread)
            }
            .contextMenu { contextActions(for: row) }
          }

          if model.preferences.showSettledThreads, !sections.settled.isEmpty {
            HStack(spacing: 6) {
              Text("Settled")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(HarnessColor.secondary)
              Text("\(sections.settled.count)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(HarnessColor.tertiary)
              Spacer()
            }
            .padding(.top, sections.active.isEmpty ? 2 : 8)
            .padding(.bottom, -2)
          }

          if model.preferences.showSettledThreads {
            ForEach(sections.settled) { row in
              SettledThreadRow(row: row) {
                openThread(row.project, row.thread)
              }
              .contextMenu { contextActions(for: row) }
            }
          }

          if sections.isEmpty, model.connectionState == .open {
            ContentUnavailableView {
              Label {
                Text(query.isEmpty ? "No threads yet" : "No matching threads")
              } icon: {
                LucideIconView(query.isEmpty ? .messagesSquare : .search, size: 40)
              }
            } description: {
              Text(
                query.isEmpty
                  ? "Start a coding task in one of your projects." : "Try another project or title."
              )
            }
            .frame(minHeight: 340)
          }
        }
      }
      .animation(
        reduceMotion ? nil : .smooth(duration: 0.24),
        value: sections.rowIdentities
      )
      .padding(.horizontal, HarnessMetrics.pageInset)
      .padding(.bottom, 72)
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await model.refreshEverything() }
  }

  private var bottomBar: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(spacing: 8) {
        Button {
          searching = true
        } label: {
          HStack(spacing: 8) {
            LucideIconView(.search, size: 14)
            Text(query.isEmpty ? "Search" : query)
              .font(.system(size: 15, weight: .medium))
              .foregroundStyle(query.isEmpty ? HarnessColor.secondary : .white)
              .lineLimit(1)
            Spacer()
          }
          .padding(.horizontal, 14)
          .frame(maxWidth: .infinity, minHeight: 52)
          .harnessGlassCapsule()
        }
        .buttonStyle(.plain)
        GlassIconButton(
          icon: .squarePen, accessibilityLabel: "New thread", size: 52,
          action: newThread)
      }
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, HarnessMetrics.pageInset)
    .padding(.top, 6)
    .padding(.bottom, 5)
    .background(HarnessColor.background.opacity(0.92))
  }

  @ViewBuilder
  private func contextActions(for row: ThreadRow) -> some View {
    if row.thread.lifecycle?.state == .settled {
      Button {
        Task { await model.transitionThreadLifecycle(.unsettle, threadID: row.thread.id) }
      } label: {
        LucideActionLabel(title: "Unsettle", icon: .rotateCcw)
      }
      .disabled(model.threadLifecycleUpdateIsPending(row.thread.id))
    } else if !row.thread.running {
      Button {
        Task { await model.transitionThreadLifecycle(.settle, threadID: row.thread.id) }
      } label: {
        LucideActionLabel(title: "Settle", icon: .checkCheck)
      }
      .disabled(model.threadLifecycleUpdateIsPending(row.thread.id))
    }
    Button {
      Task { await update(row, method: "thread.close") }
    } label: {
      LucideActionLabel(title: "Archive", icon: .archive)
    }
    Divider()
    Button(role: .destructive) {
      pendingDeletion = row
    } label: {
      LucideActionLabel(title: "Delete", icon: .trash)
    }
  }

  private var threadSections: ThreadSections {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var visible: [ThreadRow] = []
    for project in model.projects {
      let projectMatches =
        needle.isEmpty || project.name.lowercased().contains(needle)
        || project.path.lowercased().contains(needle)
      for thread in project.sessions where thread.closedAt == nil {
        guard projectMatches || thread.title.lowercased().contains(needle) else { continue }
        visible.append(ThreadRow(project: project, thread: thread))
      }
    }
    visible.sort { $0.thread.createdAt > $1.thread.createdAt }

    return ThreadSections.partition(visible)
  }

  private var connectionText: String {
    let environment = model.activeEnvironment?.displayName ?? "Harness"
    return switch model.connectionState {
    case .connecting: "Connecting to \(environment)…"
    case .reconnecting: "Reconnecting to \(environment)…"
    case .failed: "Couldn’t connect to \(environment)"
    case .closed: "\(environment) is disconnected"
    case .open: "Connected"
    }
  }

  private var connectionBannerVisible: Bool {
    model.connectionState != .open
  }

  private var connectionBusy: Bool {
    model.connectionState == .connecting || model.connectionState == .reconnecting
  }

  private var connectionTint: Color {
    switch model.connectionState {
    case .connecting, .reconnecting, .open: HarnessColor.blue
    case .failed, .closed: HarnessColor.red
    }
  }

  private var connectionIcon: LucideIcon {
    switch model.connectionState {
    case .failed, .closed: .wifiOff
    case .connecting, .reconnecting, .open: .wifi
    }
  }

  private func update(_ row: ThreadRow, method: String) async {
    do {
      let result = try await model.request(
        method,
        params: .object(["threadId": .string(row.thread.id)])
      )
      if let lifecycleValue = result["lifecycle"],
        let lifecycle = try? lifecycleValue.decoded(as: ThreadLifecycle.self)
      {
        model.applyThreadLifecycle(lifecycle, to: row.thread.id)
      }
      await model.refreshProjects()
    } catch {
      await model.refreshProjects()
      model.errorMessage = error.localizedDescription
    }
  }

  private func delete(_ row: ThreadRow) async {
    await update(row, method: "thread.delete")
  }
}

struct ThreadRow: Identifiable {
  struct ID: Hashable {
    let threadID: String
    let lifecycleState: ThreadLifecycleState?
  }

  var id: ID {
    ID(threadID: thread.id, lifecycleState: thread.lifecycle?.state)
  }
  let project: ProjectRecord
  let thread: ThreadSummary
}

struct ThreadSections {
  let active: [ThreadRow]
  let settled: [ThreadRow]

  var isEmpty: Bool { active.isEmpty && settled.isEmpty }
  var rowIdentities: [ThreadRow.ID] { (active + settled).map(\.id) }

  static func partition(_ rows: [ThreadRow]) -> ThreadSections {
    var active: [ThreadRow] = []
    var settled: [ThreadRow] = []
    active.reserveCapacity(rows.count)
    settled.reserveCapacity(rows.count)
    for row in rows {
      if row.thread.lifecycle?.state == .settled {
        settled.append(row)
      } else {
        active.append(row)
      }
    }
    return ThreadSections(active: active, settled: settled)
  }
}

private struct ActiveThreadCard: View {
  let row: ThreadRow
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Circle()
            .fill(row.thread.running ? HarnessColor.blue : HarnessColor.tertiary)
            .frame(width: 5, height: 5)
          Text(HarnessFormat.projectLabel(row.project.path))
            .lineLimit(1)
          Spacer()
          Text(HarnessFormat.relativeTime(from: row.thread.createdAt))
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(HarnessColor.secondary)
        HStack(alignment: .bottom) {
          Text(row.thread.title)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white)
            .multilineTextAlignment(.leading)
            .lineLimit(2)
          Spacer(minLength: 12)
          if row.thread.running {
            LucideLoader(size: 13)
              .foregroundStyle(HarnessColor.secondary)
          } else {
            ProviderGlyph(provider: row.thread.provider, size: 17)
              .scaleEffect(0.7)
              .foregroundStyle(HarnessColor.tertiary)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(minHeight: 58)
      .harnessSurface(
        cornerRadius: 15,
        fill: row.thread.running ? HarnessColor.blue.opacity(0.045) : .clear,
        interactive: true
      )
      .contentShape(.rect(cornerRadius: 15))
    }
    .buttonStyle(.plain)
  }
}

private struct SettledThreadRow: View {
  let row: ThreadRow
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(row.thread.title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white.opacity(0.72))
            .lineLimit(1)
          HStack(spacing: 5) {
            Text(HarnessFormat.projectLabel(row.project.path))
              .lineLimit(1)
            RoundedRectangle(cornerRadius: 1)
              .fill(HarnessColor.tertiary)
              .frame(width: 2, height: 2)
            Text(HarnessFormat.relativeTime(from: row.thread.createdAt))
              .lineLimit(1)
              .fixedSize(horizontal: true, vertical: false)
          }
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(HarnessColor.tertiary)
        }
        Spacer(minLength: 10)
        LucideIconView(.checkCheck, size: 12)
          .foregroundStyle(HarnessColor.tertiary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .frame(minHeight: HarnessMetrics.rowHeight)
      .harnessSurface(cornerRadius: 14, interactive: true)
      .contentShape(.rect(cornerRadius: 14))
    }
    .buttonStyle(.plain)
  }
}
