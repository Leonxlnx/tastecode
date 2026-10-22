import SwiftUI
import UIKit

/// The conversation, newest at the bottom. It follows a streaming reply while
/// you are at the bottom and stays put while you read further up.
struct Transcript: View {
  @Environment(AppModel.self) private var model
  let store: ThreadStore
  /// Changes whenever the screen wants the newest message in view, such as after sending.
  let jumpToken: Int
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var atBottom = true
  @State private var prepending = false
  /// The first rows arrive after the screen appears; they open at the newest message.
  @State private var placed = false

  var body: some View {
    let meta = store.meta
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 22) {
        if meta?.hasOlder == true {
          OlderMessages(loading: meta?.loadingOlder == true)
            .onAppear(perform: loadOlder)
        }
        ForEach(store.order, id: \.self) { key in
          if let row = store.rows[key] {
            RowCell(model: row)
          }
        }
        if let meta {
          if meta.waiting {
            WorkingLine(text: "Working")
          }
          if !meta.plan.isEmpty {
            PlanList(steps: meta.plan)
          }
          if store.order.isEmpty {
            placeholder(meta)
          }
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 14)
      .padding(.bottom, 24)
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.top, for: .alignment)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(atBottom || prepending ? .bottom : .top, for: .sizeChanges)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      // The bottom of what is readable: the visible rect less the composer over it.
      geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 48
    } action: { _, value in
      atBottom = value
    }
    .scrollDismissesKeyboard(.interactively)
    .overlay(alignment: .bottom) {
      if !atBottom && !store.order.isEmpty {
        Button {
          withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
        } label: {
          Image(systemName: "arrow.down")
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .padding(.bottom, 10)
        .transition(.scale(scale: 0.6).combined(with: .opacity))
        .accessibilityLabel("Scroll to the newest message")
      }
    }
    .animation(.smooth(duration: 0.25), value: atBottom)
    .onChange(of: jumpToken) {
      withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
    }
    .onAppear { placed = !store.order.isEmpty }
    .onChange(of: store.order) {
      if !placed && !store.order.isEmpty {
        placed = true
        atBottom = true
        Task { position.scrollTo(edge: .bottom) }
      }
      guard prepending else { return }
      Task {
        try? await Task.sleep(for: .milliseconds(400))
        prepending = false
      }
    }
  }

  @ViewBuilder private func placeholder(_ meta: ThreadMetaView) -> some View {
    switch meta.status {
    case .loading:
      ProgressView()
        .frame(maxWidth: .infinity)
        .padding(.top, 120)
    case .error:
      VStack(spacing: 12) {
        Text(meta.error ?? "The chat could not be loaded.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button("Try Again") {
          model.send(["type": "thread.open", "threadId": store.id])
        }
        .buttonStyle(.glass)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 120)
    case .ready:
      EmptyView()
    }
  }

  private func loadOlder() {
    guard store.meta?.loadingOlder != true else { return }
    prepending = true
    model.send(["type": "thread.loadOlder", "threadId": store.id])
  }
}

private struct OlderMessages: View {
  let loading: Bool

  var body: some View {
    HStack {
      Spacer()
      ProgressView()
        .controlSize(.small)
        .opacity(loading ? 1 : 0.4)
      Spacer()
    }
    .padding(.vertical, 6)
  }
}

struct RowCell: View {
  let model: RowModel

  var body: some View {
    let row = model.row
    switch row.kind {
    case .user:
      UserMessage(text: row.text ?? "", attachments: row.attachments ?? [])
    case .assistant:
      MarkdownView(markdown: row.text ?? "")
    case .steps:
      StepsRow(row: row)
    case .notice:
      Text(row.text ?? "")
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .frame(maxWidth: .infinity)
    case .error:
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.subheadline)
          .foregroundStyle(.red)
        Text(row.text ?? "")
          .font(.subheadline)
          .textSelection(.enabled)
      }
    }
  }
}

/// What you sent: right-aligned on a quiet fill, with the pictures above it.
struct UserMessage: View {
  @Environment(AppModel.self) private var model
  let text: String
  let attachments: [String]

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if !attachments.isEmpty {
        HStack(spacing: 6) {
          ForEach(attachments, id: \.self) { path in
            if let image = model.images[path] {
              Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 88, height: 88)
                .clipShape(.rect(cornerRadius: 16, style: .continuous))
            }
          }
          let missing = attachments.filter { model.images[$0] == nil }.count
          if missing > 0 {
            Label(missing == 1 ? "1 image" : "\(missing) images", systemImage: "photo")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
      }
      if !text.isEmpty {
        Text(text)
          .font(.body)
          .lineSpacing(2)
          .textSelection(.enabled)
          .padding(.horizontal, 15)
          .padding(.vertical, 10)
          .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 20, style: .continuous))
      }
    }
    .padding(.leading, 48)
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// The agent's work between messages, folded into one line until you open it.
struct StepsRow: View {
  let row: RowView
  @State private var expanded = false

  var body: some View {
    let live = row.live == true
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.snappy(duration: 0.28)) { expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          if live {
            ProgressView()
              .controlSize(.mini)
          } else if row.failed == true {
            Image(systemName: "exclamationmark.circle")
              .font(.footnote)
              .foregroundStyle(.red)
          }
          Text(row.summary ?? "")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          if let duration = row.duration {
            Text(duration)
              .font(.subheadline)
              .monospacedDigit()
              .foregroundStyle(.tertiary)
          }
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if expanded {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(row.steps ?? []) { step in
            StepLine(step: step)
          }
        }
        .padding(.top, 12)
        .padding(.leading, 4)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct StepLine: View {
  let step: StepView

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .font(.footnote)
        .foregroundStyle(step.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.tertiary))
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 3) {
        Text(step.title)
          .font(step.kind == .command ? .system(.footnote, design: .monospaced) : .footnote)
          .lineLimit(step.kind == .command ? 3 : 2)
        if let detail = step.detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(step.kind == .thinking ? 12 : 3)
        }
      }
      Spacer(minLength: 8)
      if step.running {
        ProgressView()
          .controlSize(.mini)
      } else if step.kind == .file {
        LineCounts(added: step.added ?? 0, removed: step.removed ?? 0)
          .font(.caption)
      }
    }
  }

  private var symbol: String {
    switch step.kind {
    case .command: return "terminal"
    case .file: return "pencil"
    case .tool: return "wrench.adjustable"
    case .agent: return "person.2"
    case .thinking: return "brain"
    case .plan: return "list.bullet"
    case .other: return "circle.dashed"
    }
  }
}

/// "+12 −3", green and red: the one place a change's size is coloured.
struct LineCounts: View {
  let added: Int
  let removed: Int

  var body: some View {
    HStack(spacing: 4) {
      if added > 0 || removed == 0 {
        Text("+\(added)").foregroundStyle(.green)
      }
      if removed > 0 {
        Text("−\(removed)").foregroundStyle(.red)
      }
    }
    .monospacedDigit()
  }
}

struct WorkingLine: View {
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.mini)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }
}

/// The agent's plan for the turn under way, ticked off as it goes.
struct PlanList: View {
  let steps: [PlanView]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Plan")
        .font(.subheadline.weight(.semibold))
      ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Image(systemName: step.status == "done" ? "checkmark.circle.fill" : step.status == "running" ? "circle.dotted" : "circle")
            .font(.footnote)
            .foregroundStyle(step.status == "pending" ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.primary))
            .symbolEffect(.rotate, options: .repeat(.continuous), isActive: step.status == "running")
          Text(step.text)
            .font(.subheadline)
            .foregroundStyle(step.status == "done" ? .secondary : .primary)
        }
      }
    }
  }
}
