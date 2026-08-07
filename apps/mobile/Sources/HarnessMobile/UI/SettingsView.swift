import SwiftUI

private enum SettingsTint {
  static let blue = Color(uiColor: .systemBlue)
  static let green = Color(uiColor: .systemGreen)
  static let orange = Color(uiColor: .systemOrange)
  static let indigo = Color(uiColor: .systemIndigo)
  static let pink = Color(uiColor: .systemPink)
  static let purple = Color(uiColor: .systemPurple)
  static let teal = Color(uiColor: .systemTeal)
}

struct SettingsView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var selectedDetent: PresentationDetent = .medium

  var body: some View {
    NavigationStack {
      Form {
        Section("Connection") {
          NavigationLink {
            EnvironmentsView()
          } label: {
            SettingsDestinationLabel(
              icon: .monitor,
              tint: SettingsTint.blue,
              title: "Environments",
              value: "\(model.environments.count)"
            )
          }
        }

        Section("Interface") {
          SettingsToggle(
            icon: .checkCheck,
            tint: SettingsTint.indigo,
            title: "Show Settled Threads",
            isOn: preferenceBinding(\.showSettledThreads)
          )
          SettingsToggle(
            icon: .vibrate,
            tint: SettingsTint.pink,
            title: "Haptic Feedback",
            isOn: preferenceBinding(\.hapticsEnabled)
          )
        }

        Section("Threads") {
          NavigationLink {
            ArchivedThreadsView()
          } label: {
            SettingsDestinationLabel(
              icon: .archive,
              tint: SettingsTint.purple,
              title: "Archived Threads",
              value: "\(archivedCount)"
            )
          }
        }
      }
      .environment(\.defaultMinListRowHeight, 52)
      .scrollContentBackground(.hidden)
      .background(HarnessColor.background)
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
            .fontWeight(.semibold)
        }
      }
    }
    .tint(.white)
    .presentationDetents([.medium, .large], selection: $selectedDetent)
    .presentationContentInteraction(.resizes)
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(32)
  }

  private var archivedCount: Int {
    model.projects.reduce(0) { count, project in
      count + project.sessions.filter { $0.closedAt != nil }.count
    }
  }

  private func preferenceBinding(_ keyPath: WritableKeyPath<AppPreferences, Bool>) -> Binding<Bool>
  {
    Binding(
      get: { model.preferences[keyPath: keyPath] },
      set: { value in
        model.updatePreferences { $0[keyPath: keyPath] = value }
        if model.preferences.hapticsEnabled {
          UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        }
      }
    )
  }
}

private struct SettingsDestinationLabel: View {
  let icon: LucideIcon
  let tint: Color
  let title: String
  var value: String?

  var body: some View {
    HStack(spacing: 12) {
      SettingsLabel(icon: icon, tint: tint, title: title)
      Spacer(minLength: 12)
      if let value {
        Text(value)
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct SettingsToggle: View {
  let icon: LucideIcon
  let tint: Color
  let title: String
  @Binding var isOn: Bool

  var body: some View {
    Toggle(isOn: $isOn) {
      SettingsLabel(icon: icon, tint: tint, title: title)
    }
    .toggleStyle(.switch)
    .tint(SettingsTint.green)
  }
}

private struct SettingsLabel: View {
  let icon: LucideIcon
  let tint: Color
  let title: String

  var body: some View {
    HStack(spacing: 12) {
      HarnessIconBadge(icon: icon, tint: tint, size: 30, iconSize: 15)
      Text(title)
        .font(.body)
        .foregroundStyle(.primary)
    }
  }
}

private struct EnvironmentsView: View {
  @EnvironmentObject private var model: AppModel
  @State private var addPresented = false
  @State private var selectedEnvironment: PairedEnvironment?

  var body: some View {
    List {
      if !model.environments.isEmpty {
        Section {
          ForEach(model.environments) { environment in
            EnvironmentRow(
              environment: environment,
              active: model.activeEnvironment?.id == environment.id,
              state: model.activeEnvironment?.id == environment.id
                ? model.connectionState : .closed,
              edit: { selectedEnvironment = environment }
            )
          }
        } header: {
          Text("Paired Environments")
        } footer: {
          Text("Credentials stay in the iOS Keychain on this iPhone.")
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(HarnessColor.background)
    .overlay {
      if model.environments.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Environments")
          } icon: {
            LucideIconView(.monitorX, size: 40)
          }
        } description: {
          Text("Pair a Mac or headless Harness machine to get started.")
        }
      }
    }
    .navigationTitle("Environments")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          addPresented = true
        } label: {
          LucideActionLabel(title: "Add Environment", icon: .plus)
        }
      }
    }
    .refreshable {
      if model.connectionState == .open {
        await model.refreshEverything()
      } else {
        await model.reconnect()
      }
    }
    .sheet(isPresented: $addPresented) {
      AddEnvironmentView()
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .sheet(item: $selectedEnvironment) { environment in
      EnvironmentEditorSheet(environment: environment)
        .environmentObject(model)
        .harnessSheetBackground()
    }
  }
}

private struct EnvironmentRow: View {
  let environment: PairedEnvironment
  let active: Bool
  let state: ConnectionState
  let edit: () -> Void

  var body: some View {
    Button(action: edit) {
      HStack(spacing: 12) {
        EnvironmentIconBadge(
          icon: environment.displayIcon,
          accent: environment.displayAccent,
          statusColor: statusColor
        )

        VStack(alignment: .leading, spacing: 3) {
          Text(environment.displayName)
            .font(.body.weight(.medium))
            .foregroundStyle(.primary)
          Text(statusText)
            .font(.subheadline)
            .foregroundStyle(.secondary)
          if let route = environment.preferredEndpoint {
            Text(route.replacingOccurrences(of: "ws://", with: ""))
              .font(.caption.monospaced())
              .foregroundStyle(.tertiary)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 12)

        LucideIconView(.ellipsis, size: 17)
          .foregroundStyle(.tertiary)
          .frame(width: 28, height: 44)
          .accessibilityHidden(true)
      }
      .padding(.vertical, 4)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityHint("Opens environment settings")
  }

  private var statusColor: Color {
    active && state == .open ? SettingsTint.green : Color(uiColor: .tertiaryLabel)
  }

  private var statusText: String {
    guard active else { return "Paired" }
    return switch state {
    case .open: "Connected"
    case .connecting: "Connecting…"
    case .reconnecting: "Reconnecting…"
    case .failed: "Failed to connect"
    case .closed: "Disconnected"
    }
  }
}

private struct EnvironmentIconBadge: View {
  let icon: EnvironmentIcon
  let accent: EnvironmentAccent
  var size: CGFloat = 36
  var statusColor: Color?

  var body: some View {
    LucideIconView(icon.lucideIcon, size: size * 0.48)
      .foregroundStyle(accent.color)
      .frame(width: size, height: size)
      .background(accent.color.opacity(0.16), in: .circle)
      .overlay(alignment: .bottomTrailing) {
        if let statusColor {
          Circle()
            .fill(statusColor)
            .frame(width: max(8, size * 0.24), height: max(8, size * 0.24))
            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
            .offset(x: 2, y: 2)
        }
      }
      .accessibilityHidden(true)
  }
}

private struct EnvironmentEditorSheet: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss

  let environment: PairedEnvironment
  @State private var name: String
  @State private var icon: EnvironmentIcon
  @State private var accent: EnvironmentAccent
  @State private var disconnectConfirmation = false
  @State private var disconnecting = false
  @State private var disconnected = false

  init(environment: PairedEnvironment) {
    self.environment = environment
    _name = State(initialValue: environment.displayName)
    _icon = State(initialValue: environment.displayIcon)
    _accent = State(initialValue: environment.displayAccent)
  }

  var body: some View {
    ZStack {
      NavigationStack {
        Form {
          Section {
            VStack(spacing: 10) {
              EnvironmentIconBadge(icon: icon, accent: accent, size: 66)
              Text(previewName)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
              if previewName != environment.serverName {
                Text(environment.serverName)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .listRowBackground(Color.clear)
          }

          Section("Name") {
            TextField(environment.serverName, text: $name)
              .textInputAutocapitalization(.words)
              .autocorrectionDisabled()
              .submitLabel(.done)
          }

          Section("Icon") {
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4),
              spacing: 8
            ) {
              ForEach(EnvironmentIcon.allCases) { candidate in
                Button {
                  icon = candidate
                  selectionFeedback()
                } label: {
                  LucideIconView(candidate.lucideIcon, size: 19)
                    .foregroundStyle(candidate == icon ? accent.color : Color.secondary)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .harnessSurface(
                      cornerRadius: 11,
                      fill: candidate == icon ? accent.color.opacity(0.14) : .clear,
                      outline: candidate == icon
                        ? accent.color.opacity(0.6) : HarnessColor.outline,
                      interactive: true
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(candidate.label)
                .accessibilityValue(candidate == icon ? "Selected" : "")
              }
            }
            .padding(.vertical, 4)
          }

          Section("Color") {
            HStack(spacing: 0) {
              ForEach(EnvironmentAccent.allCases) { candidate in
                Button {
                  accent = candidate
                  selectionFeedback()
                } label: {
                  Circle()
                    .fill(candidate.color)
                    .frame(width: 28, height: 28)
                    .overlay {
                      if candidate == accent {
                        LucideIconView(.check, size: 12)
                          .foregroundStyle(.white)
                      }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(candidate.label)
                .accessibilityValue(candidate == accent ? "Selected" : "")
              }
            }
          }

          Section {
            Button(role: .destructive) {
              disconnectConfirmation = true
            } label: {
              LucideLabel(
                "Disconnect Environment",
                icon: .wifiOff,
                iconColor: Color(uiColor: .systemRed)
              )
            }
            .frame(maxWidth: .infinity, alignment: .center)
          } footer: {
            Text("Disconnecting removes this environment’s credential from this iPhone.")
          }
        }
        .scrollContentBackground(.hidden)
        .background(HarnessColor.background)
        .navigationTitle("Environment")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
              .fontWeight(.semibold)
          }
        }
      }
    }
    .alert("Disconnect \(previewName)?", isPresented: $disconnectConfirmation) {
      Button("Cancel", role: .cancel) {}
      Button("Disconnect", role: .destructive) { disconnectEnvironment() }
        .disabled(disconnecting)
    } message: {
      Text("This removes its credential from this iPhone. You can pair it again later.")
    }
    .interactiveDismissDisabled(disconnecting)
    .tint(accent.color)
    .presentationDetents([.medium, .large])
    .presentationContentInteraction(.resizes)
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(32)
    .onDisappear {
      guard !disconnected else { return }
      model.updateEnvironmentAppearance(
        id: environment.id,
        name: name,
        icon: icon,
        accent: accent
      )
    }
  }

  private var previewName: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? environment.serverName : trimmed
  }

  private func disconnectEnvironment() {
    guard !disconnecting else { return }
    disconnecting = true
    Task { @MainActor in
      do {
        try await model.removeEnvironment(environment)
        disconnected = true
        dismiss()
      } catch {
        disconnecting = false
        model.errorMessage = error.localizedDescription
      }
    }
  }

  private func selectionFeedback() {
    guard model.preferences.hapticsEnabled else { return }
    UISelectionFeedbackGenerator().selectionChanged()
  }
}

extension EnvironmentIcon {
  fileprivate var lucideIcon: LucideIcon {
    switch self {
    case .desktop: .monitor
    case .laptop: .laptop
    case .macBook: .laptopMinimal
    case .server: .server
    case .storage: .hardDrive
    case .terminal: .squareTerminal
    case .network: .network
    case .home: .house
    }
  }

  fileprivate var label: String {
    switch self {
    case .desktop: "Desktop"
    case .laptop: "Laptop"
    case .macBook: "MacBook"
    case .server: "Server"
    case .storage: "Storage"
    case .terminal: "Terminal"
    case .network: "Network"
    case .home: "Home"
    }
  }
}

extension EnvironmentAccent {
  fileprivate var label: String { rawValue.capitalized }

  fileprivate var color: Color {
    switch self {
    case .blue: SettingsTint.blue
    case .indigo: SettingsTint.indigo
    case .purple: SettingsTint.purple
    case .pink: SettingsTint.pink
    case .red: Color(uiColor: .systemRed)
    case .orange: SettingsTint.orange
    case .green: SettingsTint.green
    case .teal: SettingsTint.teal
    }
  }
}

private struct ArchivedThreadsView: View {
  @EnvironmentObject private var model: AppModel
  @State private var deletion: ThreadSummary?

  var body: some View {
    List {
      if !archived.isEmpty {
        Section {
          ForEach(archived, id: \.thread.id) { value in
            ArchivedThreadRow(project: value.project, thread: value.thread)
              .swipeActions {
                Button(role: .destructive) {
                  deletion = value.thread
                } label: {
                  LucideActionLabel(title: "Delete", icon: .trash)
                }
              }
              .contextMenu {
                Button(role: .destructive) {
                  deletion = value.thread
                } label: {
                  LucideActionLabel(title: "Delete", icon: .trash)
                }
              }
          }
        } footer: {
          Text("Archived conversations stay on the paired Harness machine.")
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(HarnessColor.background)
    .overlay {
      if archived.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Archived Threads")
          } icon: {
            LucideIconView(.archive, size: 40)
          }
        } description: {
          Text("Archived conversations will appear here.")
        }
      }
    }
    .navigationTitle("Archived Threads")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog(
      "Delete this thread permanently?",
      isPresented: Binding(
        get: { deletion != nil },
        set: { if !$0 { deletion = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete Thread", role: .destructive) {
        guard let thread = deletion else { return }
        deletion = nil
        Task {
          do {
            _ = try await model.request(
              "thread.delete", params: .object(["threadId": .string(thread.id)]))
            await model.refreshProjects()
          } catch {
            model.errorMessage = error.localizedDescription
          }
        }
      }
      Button("Cancel", role: .cancel) { deletion = nil }
    }
  }

  private var archived: [(project: ProjectRecord, thread: ThreadSummary)] {
    model.projects.flatMap { project in
      project.sessions.filter { $0.closedAt != nil }.map { (project, $0) }
    }.sorted { ($0.thread.closedAt ?? 0) > ($1.thread.closedAt ?? 0) }
  }
}

private struct ArchivedThreadRow: View {
  let project: ProjectRecord
  let thread: ThreadSummary

  var body: some View {
    HStack(spacing: 12) {
      HarnessIconBadge(icon: .archive, tint: SettingsTint.purple, size: 32, iconSize: 15)

      VStack(alignment: .leading, spacing: 3) {
        Text(thread.title)
          .font(.body)
          .lineLimit(1)
        Text(HarnessFormat.projectLabel(project.path))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      Text(HarnessFormat.relativeTime(from: thread.closedAt ?? thread.createdAt))
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
    .padding(.vertical, 4)
  }
}

private struct ClientStorageView: View {
  @EnvironmentObject private var model: AppModel
  @State private var resetPresented = false

  var body: some View {
    Form {
      Section("Stored Data") {
        StorageInfoRow(
          icon: .keyRound,
          tint: SettingsTint.orange,
          title: "Environment Credentials",
          detail: "Stored in the iOS Keychain and available only while this device is unlocked."
        )
        StorageInfoRow(
          icon: .database,
          tint: SettingsTint.blue,
          title: "Project and Thread Data",
          detail:
            "Owned by your Harness machine. This iPhone keeps only the current in-memory view while connected."
        )
        StorageInfoRow(
          icon: .settings,
          tint: SettingsTint.purple,
          title: "Interface Settings",
          detail:
            "Model, runtime, worktree, and display preferences are stored on this iPhone."
        )
      }

      Section {
        Button("Reset Interface Settings", role: .destructive) {
          resetPresented = true
        }
        .frame(maxWidth: .infinity, alignment: .center)
      } footer: {
        Text("Pairing credentials and server-side threads won’t be removed.")
      }
    }
    .scrollContentBackground(.hidden)
    .background(HarnessColor.background)
    .navigationTitle("Client Storage")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog(
      "Reset interface settings?",
      isPresented: $resetPresented,
      titleVisibility: .visible
    ) {
      Button("Reset", role: .destructive) { model.resetInterfacePreferences() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Pairing credentials and server-side threads won’t be removed.")
    }
  }
}

private struct StorageInfoRow: View {
  let icon: LucideIcon
  let tint: Color
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      HarnessIconBadge(icon: icon, tint: tint, size: 30, iconSize: 15)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.body.weight(.medium))
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct LegalView: View {
  var body: some View {
    Form {
      Section("Privacy by Architecture") {
        VStack(alignment: .leading, spacing: 18) {
          Text(
            "Harness has no mobile relay or Harness cloud in this client. Mobile traffic goes directly between this iPhone and the Harness machine you paired; installed agents may still send prompts to their configured providers."
          )
          Text(
            "A paired machine can execute commands and change files according to the runtime mode you choose. Full Access is intentionally powerful; use it only with machines and projects you trust."
          )
          Text(
            "Third-party agent providers remain governed by their own terms and privacy policies. Harness asks their installed binaries for status and never reads their credential files."
          )
        }
        .font(.body)
        .foregroundStyle(.primary)
        .lineSpacing(3)
        .padding(.vertical, 4)
      }
    }
    .scrollContentBackground(.hidden)
    .background(HarnessColor.background)
    .navigationTitle("Legal")
    .navigationBarTitleDisplayMode(.inline)
  }
}
