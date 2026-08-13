import Foundation
import SwiftUI
import UIKit

struct TurnTranscriptView: View {
  let turn: TimelineTurn
  let running: Bool
  let workExpanded: Bool
  let toggleWork: () -> Void

  private var presentation: TimelineTurnPresentation {
    TimelineTranscriptPresentation.present(turn)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      ForEach(presentation.userMessages) { item in
        UserMessageView(item: item)
      }

      if presentation.complete, !running, let answer = presentation.finalAnswer {
        CompletedTurnView(
          presentation: presentation,
          answer: answer,
          plan: turn.plan,
          expanded: workExpanded,
          toggle: toggleWork
        )
      } else {
        if running {
          WorkingRail(startedAt: turn.createdAt)
        }
        if !turn.plan.isEmpty {
          PlanView(steps: turn.plan)
        }
        WorkTranscript(
          items: turn.items.filter { !$0.isUserMessage },
          cacheMarkdown: !running
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct UserMessageView: View {
  let item: TimelineItem

  var body: some View {
    VStack(alignment: .trailing, spacing: 7) {
      MarkdownText(item.text, tintLinks: false)
        .font(.system(size: 15))
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(
          HarnessColor.blue.opacity(0.16),
          in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(HarnessColor.blue.opacity(0.24), lineWidth: 1)
            .allowsHitTesting(false)
        }
        .contextMenu {
          Button {
            UIPasteboard.general.string = item.text
          } label: {
            LucideActionLabel(title: "Copy", icon: .copy)
          }
        }
        .frame(maxWidth: 320, alignment: .trailing)
      Text(HarnessFormat.clockTime(from: item.createdAt))
        .font(.caption)
        .foregroundStyle(HarnessColor.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

private struct CompletedTurnView: View {
  let presentation: TimelineTurnPresentation
  let answer: TimelineItem
  let plan: [PlanStep]
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      WorkDisclosure(
        presentation: presentation,
        plan: plan,
        expanded: expanded,
        toggle: toggle
      )
      AssistantResponseView(item: answer)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkingRail: View {
  let startedAt: Double

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      HStack(spacing: 8) {
        LucideLoader(size: 14)
          .foregroundStyle(HarnessColor.secondary)
        Text("Working")
          .fontWeight(.medium)
        Text(
          "· \(HarnessFormat.elapsed(milliseconds: max(1_000, context.date.timeIntervalSince1970 * 1_000 - startedAt)))"
        )
        .foregroundStyle(HarnessColor.tertiary)
      }
      .font(.system(size: 16))
      .foregroundStyle(HarnessColor.secondary)
      .frame(minHeight: 34)
    }
  }
}

private struct AssistantResponseView: View {
  let item: TimelineItem

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      MarkdownText(item.text)
        .font(.system(size: 15))
        .lineSpacing(3)
        .textSelection(.enabled)
      Text(HarnessFormat.clockTime(from: item.createdAt))
        .font(.caption)
        .foregroundStyle(HarnessColor.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkDisclosure: View {
  let presentation: TimelineTurnPresentation
  let plan: [PlanStep]
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if hasDetails {
        Button(action: toggle) { header }
          .buttonStyle(.plain)
          .accessibilityLabel("\(expanded ? "Hide" : "Show") work from this turn")
          .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      } else {
        header
      }

      if expanded, hasDetails {
        VStack(alignment: .leading, spacing: 20) {
          if !plan.isEmpty {
            PlanView(steps: plan)
          }
          CompletedWorkTranscript(items: presentation.workItems)
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .animation(.snappy(duration: 0.24), value: expanded)
    .sensoryFeedback(.selection, trigger: expanded)
  }

  private var header: some View {
    HStack(spacing: 7) {
      Text("Worked for \(HarnessFormat.elapsed(milliseconds: max(1_000, presentation.elapsedMs)))")
        .font(.system(size: 16, weight: .regular))
      if hasDetails {
        LucideIconView(.chevronRight, size: 13)
          .rotationEffect(.degrees(expanded ? 90 : 0))
      }
      Spacer(minLength: 0)
    }
    .foregroundStyle(HarnessColor.secondary)
    .frame(minHeight: 34)
    .contentShape(.rect)
  }

  private var hasDetails: Bool {
    !plan.isEmpty || presentation.workItems.contains(where: isVisibleCompletedWorkItem)
  }
}

private struct CompletedWorkTranscript: View {
  let items: [TimelineItem]

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      ForEach(items.filter(isVisibleCompletedWorkItem)) { item in
        if item.type == "message" {
          MarkdownText(item.text)
            .font(.system(size: 15))
            .lineSpacing(3)
            .foregroundStyle(.white.opacity(0.92))
            .textSelection(.enabled)
        } else {
          HStack(spacing: 9) {
            LucideIconView(.filePen, size: 14)
              .frame(width: 17)
            Text("Edited files")
              .font(.system(size: 15))
          }
          .foregroundStyle(HarnessColor.secondary)
          .frame(minHeight: 30)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private func isVisibleCompletedWorkItem(_ item: TimelineItem) -> Bool {
  item.type == "file_change"
    || (item.type == "message" && item.role == "assistant" && item.status == "completed"
      && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
}

private struct WorkTranscript: View {
  let items: [TimelineItem]
  let cacheMarkdown: Bool

  var body: some View {
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 20) {
        ForEach(TimelineTranscriptPresentation.workBlocks(from: items)) { block in
          switch block {
          case .narrative(let item):
            MarkdownText(item.text, cacheResult: cacheMarkdown || item.status == "completed")
              .font(.system(size: 15))
              .lineSpacing(3)
              .foregroundStyle(
                item.type == "reasoning" ? HarnessColor.secondary : .white.opacity(0.92)
              )
              .textSelection(.enabled)
          case .toolCalls(let items):
            ToolCallGroup(items: items)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct ToolCallGroup: View {
  let items: [TimelineItem]
  @State private var showingPrevious = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if showingPrevious {
        ForEach(items) { item in
          ToolCallRow(item: item)
        }
      } else if let item = items.last {
        ToolCallRow(item: item)
      }

      if items.count > 1 {
        Button {
          withAnimation(.snappy(duration: 0.2)) { showingPrevious.toggle() }
        } label: {
          HStack(spacing: 8) {
            LucideIconView(showingPrevious ? .chevronUp : .chevronDown, size: 12)
              .frame(width: 18)
            Text(showingPrevious ? "Show fewer tool calls" : previousCallsLabel)
          }
          .font(.system(size: 14))
          .foregroundStyle(HarnessColor.secondary)
          .frame(minHeight: 30)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .sensoryFeedback(.selection, trigger: showingPrevious)
  }

  private var previousCallsLabel: String {
    "+\(items.count - 1) previous tool \(items.count == 2 ? "call" : "calls")"
  }
}

private struct ToolCallRow: View {
  let item: TimelineItem
  @State private var expanded = false

  private var presentation: ToolCallPresentation { ToolCallPresentation(item: item) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if presentation.output == nil {
        row
      } else {
        Button {
          withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
        } label: {
          row
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      }

      if expanded, let output = presentation.output {
        Text(output)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(HarnessColor.secondary)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .padding(10)
          .harnessSurface(cornerRadius: 10)
          .padding(.leading, 25)
          .frame(maxWidth: .infinity, alignment: .leading)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .sensoryFeedback(.selection, trigger: expanded)
  }

  private var row: some View {
    HStack(spacing: 9) {
      LucideIconView(presentation.icon, size: 14)
        .foregroundStyle(item.status == "failed" ? HarnessColor.red : HarnessColor.secondary)
        .frame(width: 17, height: 20)
      Text(presentation.label)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(item.status == "failed" ? HarnessColor.red : .white.opacity(0.88))
        .lineLimit(1)
      if let detail = presentation.detail {
        Text(detail)
          .font(.system(size: 13, design: item.type == "command" ? .monospaced : .default))
          .foregroundStyle(HarnessColor.tertiary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
      if item.status == "started" {
        LucideLoader(size: 13)
          .foregroundStyle(HarnessColor.secondary)
      } else if item.status == "failed" {
        LucideIconView(.x, size: 12)
          .foregroundStyle(HarnessColor.red)
      } else if presentation.output != nil {
        LucideIconView(.chevronDown, size: 11)
          .foregroundStyle(HarnessColor.tertiary)
          .rotationEffect(expanded ? .degrees(180) : .zero)
      }
    }
    .frame(minHeight: 30)
    .contentShape(.rect)
  }
}

private struct ToolCallPresentation {
  let label: String
  let detail: String?
  let output: String?
  let icon: LucideIcon

  init(item: TimelineItem) {
    let toolText = "\(item.text) \(item.command ?? "")".lowercased()
    let ongoing = item.status == "started"
    label = Self.label(for: item, toolText: toolText, ongoing: ongoing)
    detail = Self.detail(for: item)
    output = Self.output(for: item)
    icon = Self.icon(for: item, toolText: toolText)
  }

  private static func label(for item: TimelineItem, toolText: String, ongoing: Bool) -> String {
    switch item.type {
    case "command": ongoing ? "Running a command" : "Ran a command"
    case "file_change": ongoing ? "Editing files" : "Edited files"
    case "plan": ongoing ? "Updating the plan" : "Updated the plan"
    case "error": "Error"
    case "tool_call" where toolText.contains("image"):
      ongoing ? "Viewing an image" : "Viewed an image"
    case "tool_call"
    where toolText.contains("read") || toolText.contains("open")
      || toolText.contains("file"):
      ongoing ? "Reading files" : "Read files"
    case "tool_call" where toolText.contains("search") || toolText.contains("find"):
      ongoing ? "Searching" : "Searched"
    default: ongoing ? "Using a tool" : "Used a tool"
    }
  }

  private static func detail(for item: TimelineItem) -> String? {
    switch item.type {
    case "command": clean(item.command)
    case "file_change": clean(item.path) ?? firstLine(of: item.text)
    default: firstLine(of: item.text)
    }
  }

  private static func output(for item: TimelineItem) -> String? {
    switch item.type {
    case "command", "error", "unknown": return clean(item.text)
    case "file_change": return clean(item.text)
    case "tool_call":
      let lines = item.text.split(separator: "\n", omittingEmptySubsequences: false)
      return lines.count > 1 ? clean(lines.dropFirst().joined(separator: "\n")) : nil
    default: return nil
    }
  }

  private static func icon(for item: TimelineItem, toolText: String) -> LucideIcon {
    switch item.type {
    case "command": .squareTerminal
    case "file_change": .filePen
    case "plan": .listChecks
    case "error": .circleAlert
    case "tool_call" where toolText.contains("image"): .images
    case "tool_call"
    where toolText.contains("read") || toolText.contains("open")
      || toolText.contains("file"):
      .bookOpen
    case "tool_call" where toolText.contains("search") || toolText.contains("find"):
      .search
    default: .wrench
    }
  }

  private static func firstLine(of text: String) -> String? {
    clean(text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init))
  }

  private static func clean(_ text: String?) -> String? {
    let value = text?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
  }
}

private struct PlanView: View {
  let steps: [PlanStep]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Plan")
        .font(.headline)
      ForEach(steps) { step in
        HStack(alignment: .top, spacing: 10) {
          LucideIconView(icon(for: step.status), size: 15)
            .foregroundStyle(color(for: step.status))
          Text(step.text)
            .foregroundStyle(step.status == "done" ? HarnessColor.secondary : .white)
          Spacer(minLength: 0)
        }
      }
    }
    .padding(16)
    .harnessSurface()
  }

  private func icon(for status: String) -> LucideIcon {
    switch status {
    case "done": .check
    case "running": .loader
    default: .circle
    }
  }

  private func color(for status: String) -> Color {
    status == "done" ? HarnessColor.green : HarnessColor.secondary
  }
}

struct ApprovalCard: View {
  let approval: PendingApproval
  let respond: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 13) {
      HStack(spacing: 10) {
        HarnessIconBadge(icon: .shieldAlert, tint: .orange)
        Text("Approval required")
          .font(.caption.bold())
          .foregroundStyle(.orange)
          .textCase(.uppercase)
      }
      Text(primaryText)
        .font(
          .system(
            size: 16, weight: .semibold, design: approval.command == nil ? .default : .monospaced)
        )
        .textSelection(.enabled)
      if let reason = approval.reason, reason != primaryText {
        Text(reason)
          .font(.subheadline)
          .foregroundStyle(HarnessColor.secondary)
      }
      HStack {
        Button("Deny", role: .destructive) { respond("deny") }
          .buttonStyle(.bordered)
        Spacer()
        Menu("Approve") {
          Button("Approve once") { respond("approve") }
          Button("Approve for session") { respond("approve-session") }
          Divider()
          Button("Abort turn", role: .destructive) { respond("abort") }
        }
        .buttonStyle(.borderedProminent)
      }
    }
    .padding(17)
    .harnessSurface(outline: Color.orange.opacity(0.25))
  }

  private var primaryText: String {
    approval.command ?? approval.path ?? approval.reason
      ?? "The agent needs permission to continue."
  }
}

struct UserInputCard: View {
  let request: PendingUserInput
  let submit: ([String: [String]]) -> Void

  @State private var answers: [String: String] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 10) {
        HarnessIconBadge(icon: .circleQuestion, tint: HarnessColor.blue)
        Text("Input needed")
          .font(.caption.bold())
          .foregroundStyle(HarnessColor.blue)
          .textCase(.uppercase)
      }
      ForEach(request.questions) { question in
        VStack(alignment: .leading, spacing: 10) {
          Text(question.header)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HarnessColor.secondary)
          Text(question.question)
            .font(.headline)
          if let options = question.options {
            ForEach(options) { option in
              Button {
                answers[question.id] = option.label
              } label: {
                HStack(alignment: .top) {
                  LucideIconView(
                    answers[question.id] == option.label ? .circleCheck : .circle,
                    size: 17
                  )
                  VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).fontWeight(.semibold)
                    Text(option.description)
                      .font(.caption)
                      .foregroundStyle(HarnessColor.secondary)
                  }
                  Spacer()
                }
                .padding(10)
                .harnessSurface(
                  cornerRadius: 12,
                  fill: answers[question.id] == option.label
                    ? HarnessColor.blue.opacity(0.12) : .clear,
                  outline: answers[question.id] == option.label
                    ? HarnessColor.blue.opacity(0.35) : HarnessColor.outline,
                  interactive: true
                )
              }
              .buttonStyle(.plain)
            }
          }
          if question.allowOther || question.options == nil {
            answerField(for: question)
          }
        }
      }
      Button("Submit") {
        submit(
          answers.reduce(into: [:]) { result, entry in
            if !entry.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              result[entry.key] = [entry.value]
            }
          })
      }
      .buttonStyle(.borderedProminent)
      .disabled(
        request.questions.contains {
          answers[$0.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        }
      )
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(17)
    .harnessSurface(outline: HarnessColor.blue.opacity(0.26))
  }

  private func answerBinding(for id: String) -> Binding<String> {
    Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0 })
  }

  @ViewBuilder
  private func answerField(for question: UserInputQuestion) -> some View {
    if question.secret {
      SecureField("Private answer", text: answerBinding(for: question.id))
        .textContentType(.password)
        .privacySensitive()
        .padding(12)
        .harnessSurface(cornerRadius: 13)
    } else {
      TextField("Your answer", text: answerBinding(for: question.id))
        .padding(12)
        .harnessSurface(cornerRadius: 13)
    }
  }
}

struct MarkdownText: View {
  let source: String
  var tintLinks = true
  var cacheResult = true

  init(_ source: String, tintLinks: Bool = true, cacheResult: Bool = true) {
    self.source = source
    self.tintLinks = tintLinks
    self.cacheResult = cacheResult
  }

  var body: some View {
    Text(attributed)
      .tint(tintLinks ? HarnessColor.blue : .white)
  }

  private var attributed: AttributedString {
    MarkdownRenderer.render(source, cacheResult: cacheResult)
  }
}

@MainActor
private enum MarkdownRenderer {
  private final class Box {
    let value: AttributedString

    init(_ value: AttributedString) { self.value = value }
  }

  private static let cache: NSCache<NSString, Box> = {
    let cache = NSCache<NSString, Box>()
    cache.countLimit = 256
    cache.totalCostLimit = 2 * 1_024 * 1_024
    return cache
  }()

  static func render(_ source: String, cacheResult: Bool) -> AttributedString {
    let key = NSString(string: source)
    if cacheResult, let cached = cache.object(forKey: key) { return cached.value }
    let rendered =
      (try? AttributedString(
        markdown: source,
        options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
      )) ?? AttributedString(source)
    if cacheResult {
      cache.setObject(Box(rendered), forKey: key, cost: source.utf8.count)
    }
    return rendered
  }
}
