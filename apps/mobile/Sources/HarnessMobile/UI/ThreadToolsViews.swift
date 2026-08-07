import SwiftUI
import UIKit

struct TerminalView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let threadID: String

  @State private var terminalID: String?
  @State private var output = ""
  @State private var input = ""
  @State private var exitCode: Int?
  @State private var errorMessage: String?
  @FocusState private var inputFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(
        title: "Terminal",
        leading: AnyView(
          GlassIconButton(icon: .x, accessibilityLabel: "Close terminal") { dismiss() }),
        trailing: AnyView(
          GlassIconButton(
            icon: .copy,
            accessibilityLabel: "Copy terminal output",
            size: 44,
            iconSize: 17
          ) {
            UIPasteboard.general.string = output
          }
        )
      )

      ScrollViewReader { proxy in
        ScrollView([.horizontal, .vertical]) {
          Text(output.isEmpty ? "Opening session shell…" : output)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(output.isEmpty ? HarnessColor.secondary : .white.opacity(0.90))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(15)
          Color.clear.frame(width: 1, height: 1).id("terminal-bottom")
        }
        .harnessSurface(
          fill: Color(red: 0.025, green: 0.025, blue: 0.028)
        )
        .padding(.horizontal, HarnessMetrics.pageInset)
        .onChange(of: output) { _, _ in proxy.scrollTo("terminal-bottom", anchor: .bottom) }
      }

      if let exitCode {
        Text("Process exited with code \(exitCode)")
          .font(.caption.monospaced())
          .foregroundStyle(exitCode == 0 ? HarnessColor.green : HarnessColor.red)
          .padding(.top, 6)
      }

      HStack(spacing: 10) {
        TextField("Type a command", text: $input)
          .font(.system(.body, design: .monospaced))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($inputFocused)
          .submitLabel(.send)
          .onSubmit { Task { await send() } }
          .padding(.horizontal, 15)
          .frame(height: 48)
          .glassEffect(.regular, in: .capsule)
        GlassIconButton(
          icon: .cornerDownLeft,
          accessibilityLabel: "Send command",
          size: 48,
          prominent: !input.isEmpty,
          disabled: input.isEmpty || terminalID == nil
        ) { Task { await send() } }
      }
      .padding(14)
    }
    .background(HarnessColor.background)
    .presentationDetents([.large])
    .task { await observeTerminal() }
    .onDisappear { Task { await close() } }
    .alert(
      "Terminal",
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

  private func open() async {
    do {
      let result = try await model.request(
        "terminal.open",
        params: .object([
          "threadId": .string(threadID),
          "columns": .number(90),
          "rows": .number(30),
        ]))
      guard let id = result["terminalId"]?.stringValue else {
        throw RPCFailure(message: "Harness didn’t return a terminal identifier.", detail: nil)
      }
      terminalID = id
      inputFocused = true
    } catch { errorMessage = error.localizedDescription }
  }

  private func observeTerminal() async {
    let pushes = model.pushStream()
    await open()
    for await push in pushes {
      guard !Task.isCancelled else { return }
      receive(push)
    }
  }

  private func send() async {
    guard let terminalID else { return }
    let command = input
    guard !command.isEmpty else { return }
    input = ""
    do {
      _ = try await model.request(
        "terminal.input",
        params: .object([
          "terminalId": .string(terminalID),
          "data": .string(command + "\n"),
        ]))
    } catch { errorMessage = error.localizedDescription }
  }

  private func close() async {
    guard let terminalID else { return }
    _ = try? await model.request(
      "terminal.close", params: .object(["terminalId": .string(terminalID)]))
    self.terminalID = nil
  }

  private func receive(_ push: PushMessage) {
    guard push.data["terminalId"]?.stringValue == terminalID else { return }
    if push.channel == "terminal.output", let chunk = push.data["data"]?.stringValue {
      output += stripANSI(chunk)
      if output.count > 500_000 { output = String(output.suffix(500_000)) }
    } else if push.channel == "terminal.exit" {
      exitCode = push.data["exitCode"]?.intValue
      terminalID = nil
    }
  }

  private func stripANSI(_ value: String) -> String {
    value.replacingOccurrences(
      of: "\u{001B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
  }
}

struct WorkspaceChangesView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let project: ProjectRecord
  let thread: ThreadSummary

  @State private var diff: SessionDiff?
  @State private var loading = true
  @State private var errorMessage: String?

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(
        title: "Changes",
        leading: AnyView(
          GlassIconButton(icon: .x, accessibilityLabel: "Close changes") { dismiss() }),
        trailing: AnyView(
          GlassIconButton(
            icon: .refreshCw,
            accessibilityLabel: "Refresh changes",
            size: 44,
            iconSize: 17
          ) {
            Task { await load() }
          }
        )
      )
      if loading {
        HStack(spacing: 9) {
          LucideLoader(size: 16)
          Text("Loading diff…")
        }
        .foregroundStyle(HarnessColor.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let diff, !diff.files.isEmpty {
        ScrollView {
          GlassEffectContainer(spacing: 12) {
            LazyVStack(spacing: 12) {
              ForEach(diff.files) { file in
                DiffFileCard(file: file) { decision in
                  Task { await review(file: file, decision: decision) }
                }
              }
            }
          }
          .padding(.horizontal, HarnessMetrics.pageInset)
          .padding(.bottom, 28)
        }
      } else {
        ContentUnavailableView {
          Label {
            Text("No changes")
          } icon: {
            LucideIconView(.circleCheck, size: 40)
          }
        } description: {
          Text("This session has no reviewable diff right now.")
        }
      }
    }
    .background(HarnessColor.background)
    .presentationDetents([.large])
    .task { await load() }
    .alert(
      "Changes",
      isPresented: Binding(
        get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("OK", role: .cancel) { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      diff = try await model.request(
        "thread.diff",
        params: .object(["threadId": .string(thread.id)]),
        as: SessionDiff.self
      )
    } catch { errorMessage = error.localizedDescription }
  }

  private func review(file: DiffFile, decision: String) async {
    guard let diff else { return }
    do {
      let result = try await model.request(
        "thread.reviewFile",
        params: .object([
          "threadId": .string(thread.id),
          "version": .string(diff.version),
          "path": .string(file.path),
          "decision": .string(decision),
        ]))
      self.diff = try result["diff"]?.decoded(as: SessionDiff.self)
    } catch { errorMessage = error.localizedDescription }
  }
}

private struct DiffFileCard: View {
  let file: DiffFile
  let review: (String) -> Void
  @State private var expanded = false

  var body: some View {
    VStack(spacing: 0) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 12) {
          LucideIconView(file.binary ? .fileArchive : .fileText, size: 17)
            .foregroundStyle(statusColor)
          VStack(alignment: .leading, spacing: 3) {
            Text(file.path)
              .font(.system(size: 15, weight: .semibold, design: .monospaced))
              .foregroundStyle(.white)
              .lineLimit(2)
            HStack(spacing: 8) {
              Text(file.status.capitalized)
              if additions > 0 { Text("+\(additions)").foregroundStyle(HarnessColor.green) }
              if deletions > 0 { Text("−\(deletions)").foregroundStyle(HarnessColor.red) }
            }
            .font(.caption)
            .foregroundStyle(HarnessColor.secondary)
          }
          Spacer()
          if let decision = file.decision {
            LucideIconView(decision == "accept" ? .circleCheck : .circleX, size: 17)
              .foregroundStyle(decision == "accept" ? HarnessColor.green : HarnessColor.red)
          }
          LucideIconView(.chevronRight, size: 15)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .foregroundStyle(HarnessColor.tertiary)
        }
        .padding(16)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)

      if expanded {
        Divider().overlay(HarnessColor.separator)
        if file.binary {
          Text("Binary file")
            .foregroundStyle(HarnessColor.secondary)
            .padding(16)
        } else {
          ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(file.hunks) { hunk in
                Text(hunk.header)
                  .foregroundStyle(HarnessColor.secondary)
                  .padding(.vertical, 7)
                ForEach(hunk.lines) { line in
                  Text(line.prefix + line.text)
                    .foregroundStyle(line.color)
                    .padding(.horizontal, 7)
                    .background(line.background)
                }
              }
            }
            .font(.system(size: 11.5, design: .monospaced))
            .padding(12)
          }
        }
        HStack {
          Button("Reject", role: .destructive) { review("reject") }
            .buttonStyle(.bordered)
          Spacer()
          Button("Accept") { review("accept") }
            .buttonStyle(.borderedProminent)
        }
        .padding(14)
      }
    }
    .harnessSurface()
    .clipShape(.rect(cornerRadius: HarnessMetrics.surfaceRadius))
    .animation(.snappy(duration: 0.25), value: expanded)
  }

  private var additions: Int { file.hunks.flatMap(\.lines).filter { $0.kind == "addition" }.count }
  private var deletions: Int { file.hunks.flatMap(\.lines).filter { $0.kind == "deletion" }.count }
  private var statusColor: Color {
    switch file.status {
    case "added": HarnessColor.green
    case "deleted": HarnessColor.red
    default: HarnessColor.secondary
    }
  }
}

struct CheckoutDetailsView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let project: ProjectRecord
  let thread: ThreadSummary

  @State private var info: WorkspaceInfo?
  @State private var isolated: Bool?
  @State private var uncommitted: Bool?

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(
        title: "Checkout",
        leading: AnyView(
          GlassIconButton(icon: .x, accessibilityLabel: "Close checkout") { dismiss() })
      )
      ScrollView {
        GlassEffectContainer(spacing: 16) {
          VStack(spacing: 16) {
            CheckoutDetail(icon: .folder, label: "Project", value: project.path)
            CheckoutDetail(
              icon: .gitBranch,
              label: isolated == true ? "Worktree branch" : "Branch",
              value: thread.worktreeBranch ?? info?.branch ?? "Current checkout"
            )
            if let info {
              HStack(spacing: 0) {
                Metric(value: "\(info.dirtyFiles)", label: "Files")
                Metric(value: "+\(info.added)", label: "Added", color: HarnessColor.green)
                Metric(value: "−\(info.removed)", label: "Removed", color: HarnessColor.red)
              }
              .padding(.vertical, 18)
              .harnessSurface()
            }
            if isolated == true {
              LucideLabel(
                uncommitted == true
                  ? "This worktree has uncommitted changes."
                  : "This session uses an isolated worktree.",
                icon: uncommitted == true ? .triangleAlert : .shieldCheck
              )
              .font(.subheadline)
              .foregroundStyle(uncommitted == true ? .orange : HarnessColor.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(16)
              .harnessSurface()
            }
          }
        }
        .padding(20)
      }
    }
    .background(HarnessColor.background)
    .presentationDetents([.medium, .large])
    .task { await load() }
  }

  private func load() async {
    info = try? await model.request(
      "workspace.info",
      params: .object(["path": .string(project.path)]),
      as: WorkspaceInfo.self
    )
    if let result = try? await model.request(
      "thread.unsavedWork",
      params: .object(["threadId": .string(thread.id)])
    ) {
      isolated = result["isolated"]?.boolValue
      uncommitted = result["uncommitted"]?.boolValue
    }
  }
}

private struct CheckoutDetail: View {
  let icon: LucideIcon
  let label: String
  let value: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      LucideIconView(icon, size: 17)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 5) {
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(HarnessColor.secondary)
        Text(value)
          .font(.system(size: 15, design: .monospaced))
          .textSelection(.enabled)
      }
      Spacer()
    }
    .padding(17)
    .harnessSurface()
  }
}

private struct Metric: View {
  let value: String
  let label: String
  var color: Color = .white

  var body: some View {
    VStack(spacing: 4) {
      Text(value).font(.title3.bold()).foregroundStyle(color)
      Text(label).font(.caption).foregroundStyle(HarnessColor.secondary)
    }
    .frame(maxWidth: .infinity)
  }
}

private struct SessionDiff: Codable, Sendable {
  let threadId: String
  let version: String
  let files: [DiffFile]
}

private struct DiffFile: Codable, Identifiable, Sendable {
  var id: String { path }
  let path: String
  let previousPath: String?
  let status: String
  let binary: Bool
  let hunks: [DiffHunk]
  let decision: String?
}

private struct DiffHunk: Codable, Identifiable, Sendable {
  let id: String
  let header: String
  let oldStart: Int
  let oldLines: Int
  let newStart: Int
  let newLines: Int
  let lines: [DiffLine]
  let decision: String?
}

private struct DiffLine: Codable, Identifiable, Sendable {
  var id: String { "\(kind)-\(oldLine ?? -1)-\(newLine ?? -1)-\(text.hashValue)" }
  let kind: String
  let oldLine: Int?
  let newLine: Int?
  let text: String
  let noNewlineAtEnd: Bool?

  var prefix: String {
    switch kind {
    case "addition": "+"
    case "deletion": "−"
    default: " "
    }
  }
  var color: Color {
    switch kind {
    case "addition": HarnessColor.green
    case "deletion": HarnessColor.red
    default: .white.opacity(0.80)
    }
  }
  var background: Color {
    switch kind {
    case "addition": HarnessColor.green.opacity(0.07)
    case "deletion": HarnessColor.red.opacity(0.07)
    default: .clear
    }
  }
}
