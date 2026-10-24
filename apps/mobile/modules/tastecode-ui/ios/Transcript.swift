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
  /// After sending, the new message is held at the top with its reply below, as on the desktop.
  @State private var pinned: String?
  @State private var awaitingPin = false
  /// Where each row starts in the transcript, for the pinned one's room below.
  @State private var rowTops: [String: CGFloat] = [:]
  @State private var stackHeight: CGFloat = 0
  @State private var viewport: CGFloat = 0

  /// Room under a pinned message's turn, so the message can reach the top while the reply is short.
  private var filler: CGFloat {
    guard let pinned, let top = rowTops[pinned] else { return 0 }
    return max(0, viewport - (stackHeight - top))
  }

  var body: some View {
    let meta = store.meta
    ScrollView {
      VStack(spacing: 0) {
        LazyVStack(alignment: .leading, spacing: 22) {
          if meta?.hasOlder == true {
            OlderMessages(loading: meta?.loadingOlder == true)
              .onAppear(perform: loadOlder)
          }
          ForEach(store.order, id: \.self) { key in
            if let row = store.rows[key] {
              RowCell(model: row)
                .onGeometryChange(for: CGFloat.self) { geometry in
                  geometry.frame(in: .named("transcript")).minY
                } action: { top in
                  rowTops[key] = top
                }
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
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stackHeight = $0 }
        Color.clear
          .frame(height: filler)
      }
      .coordinateSpace(.named("transcript"))
    }
    .environment(\.threadId, store.id)
    .scrollPosition($position)
    // The title bar fades the messages under it rather than cutting them off.
    .scrollEdgeEffectHidden(true, for: .top)
    .overlay(alignment: .top) {
      GeometryReader { geometry in
        TopFade(height: geometry.safeAreaInsets.top + 36)
          .ignoresSafeArea(edges: .top)
      }
      .allowsHitTesting(false)
    }
    .defaultScrollAnchor(.top, for: .alignment)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    // A pinned message stays where it is while its reply grows below it.
    .defaultScrollAnchor((atBottom && pinned == nil) || prepending ? .bottom : .top, for: .sizeChanges)
    .onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.height } action: { _, height in
      viewport = height
    }
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
          pinned = nil
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
      // The message just sent arrives as a new row; it is pinned when it does.
      awaitingPin = true
      Task {
        try? await Task.sleep(for: .seconds(4))
        awaitingPin = false
      }
    }
    .onAppear { placed = !store.order.isEmpty }
    .onChange(of: store.order) {
      let lastUser = store.order.last { store.rows[$0]?.row.kind == .user }
      if awaitingPin, let lastUser, lastUser != pinned {
        awaitingPin = false
        pinned = lastUser
        Task {
          // One layout pass first, so the room under the message exists to scroll into.
          try? await Task.sleep(for: .milliseconds(60))
          // By offset, not by id: an id target makes the stack a scroll target
          // layout, which shifted the column sideways whenever a row resized.
          guard let top = rowTops[lastUser] else { return }
          withAnimation(.smooth(duration: 0.45)) { position.scrollTo(y: max(0, top - 8)) }
        }
      } else if let pinned, !store.order.contains(pinned) {
        // The sent message came back from the computer under its own id.
        self.pinned = lastUser
      }
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
      StepsRow(model: model)
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

extension EnvironmentValues {
  /// The chat a transcript row belongs to, for reading what its messages attached.
  @Entry var threadId: String = ""
}

/// What you sent: right-aligned on a quiet fill, with the pictures above it.
struct UserMessage: View {
  let text: String
  let attachments: [String]

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if !attachments.isEmpty {
        HStack(spacing: 6) {
          ForEach(attachments, id: \.self) { path in
            AttachedThumbnail(path: path)
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
  let model: RowModel
  /// Set on the first opening; the steps stay built after it so closing can animate.
  @State private var built = false
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    let row = model.row
    let expanded = model.expanded
    let live = row.live == true
    let steps = row.steps ?? []
    // A settled group comes in runs; a live one lists each step as it comes.
    let runs = row.runs ?? steps.map { StepRunView(id: $0.id, summary: nil, steps: [$0]) }
    VStack(alignment: .leading, spacing: 0) {
      Button {
        if !built { built = true }
        withAnimation(.smooth(duration: expanded ? 0.26 : 0.38)) { model.expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          if live {
            ProgressView()
              .controlSize(.mini)
          } else if row.failed == true && row.settled != true {
            Image(systemName: "exclamationmark.circle")
              .font(.footnote)
              .foregroundStyle(.red)
          }
          // The live label slides to the next step, as the desktop's does.
          Text(row.summary ?? "")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .id(row.summary ?? "")
            .transition(
              .asymmetric(
                insertion: .offset(y: 8).combined(with: .opacity),
                removal: .offset(y: -8).combined(with: .opacity)))
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
        .animation(.smooth(duration: 0.3), value: row.summary)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if row.settled == true {
        // A hairline under "Worked for" sets the work apart from the answer.
        Divider()
          .padding(.top, 10)
      }
      if built || expanded {
        // The steps open to their measured height, so the rows below move with
        // them instead of jumping, and each step settles in after the one above.
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
            Group {
              if let summary = run.summary {
                StepBatch(summary: summary, steps: run.steps, open: openBinding(run.id), stepOpen: openBinding)
              } else {
                ForEach(run.steps) { step in
                  StepLine(step: step, open: openBinding("step:\(step.id)"))
                }
              }
            }
              .opacity(expanded ? 1 : 0)
              .offset(y: expanded ? 0 : -8)
              .blur(radius: expanded ? 0 : 3)
              .animation(
                expanded
                  ? .smooth(duration: 0.34).delay(0.04 + Double(min(index, 10)) * 0.035)
                  : .smooth(duration: 0.18),
                value: expanded
              )
              .transition(.opacity.combined(with: .offset(y: -6)))
          }
        }
        .padding(.top, 10)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        .animation(.smooth(duration: 0.3), value: steps.count)
        // Until measured, an open fold (one scrolled back into view) takes its own height.
        .frame(height: expanded ? (contentHeight > 0 ? contentHeight : nil) : 0, alignment: .top)
        .clipped()
        .allowsHitTesting(expanded)
        .accessibilityHidden(!expanded)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // The answer follows its work closely, not at the gap between messages.
    .padding(.bottom, row.settled == true ? -10 : 0)
  }

  private func openBinding(_ run: String) -> Binding<Bool> {
    Binding {
      model.openRuns.contains(run)
    } set: { open in
      if open { model.openRuns.insert(run) } else { model.openRuns.remove(run) }
    }
  }
}

/// Everything between two notes under one line, "Ran 3 commands and read
/// 1 file", opening to one line per step under the same icon column.
private struct StepBatch: View {
  let summary: String
  let steps: [StepView]
  @Binding var open: Bool
  let stepOpen: (String) -> Binding<Bool>

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.smooth(duration: open ? 0.22 : 0.32)) { open.toggle() }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Image(systemName: symbol)
            .font(.footnote)
            .foregroundStyle(steps.contains(where: \.failed) ? AnyShapeStyle(.red) : AnyShapeStyle(.tertiary))
            .frame(width: 18)
          Text(summary)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer(minLength: 8)
          Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 180 : 0))
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if open {
        VStack(alignment: .leading, spacing: 8) {
          if steps.count == 1, let thought = steps.first, thought.kind == .thinking {
            // A thought on its own opens to what it thought.
            Text(inlineMarkdown(thought.detail ?? "", code: .system(.footnote, design: .monospaced)))
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
              .padding(.leading, 28)
          } else {
            ForEach(steps) { step in
              StepLine(step: step, open: stepOpen("step:\(step.id)"))
            }
          }
        }
        .padding(.top, 8)
        .transition(.opacity.combined(with: .offset(y: -6)))
      }
    }
  }

  /// The kind of call it holds, or a hammer for a mix; thoughts don't count.
  private var symbol: String {
    let kinds = Set(steps.map(\.kind).filter { $0 != .thinking })
    if kinds.count > 1 { return "hammer" }
    return StepLine.symbol(for: kinds.first ?? steps.first?.kind ?? .other)
  }
}

/// One step on one line: its icon, what it did, and a chevron at the edge
/// when there is more to read, which opens under the line.
private struct StepLine: View {
  let step: StepView
  @Binding var open: Bool

  var body: some View {
    if step.kind == .note {
      // What the agent wrote on the way reads exactly like its reply.
      MarkdownView(markdown: step.title)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      VStack(alignment: .leading, spacing: 6) {
        if opens {
          Button {
            withAnimation(.smooth(duration: open ? 0.2 : 0.28)) { open.toggle() }
          } label: {
            line
          }
          .buttonStyle(.plain)
        } else {
          line
        }
        if open && opens {
          more
            .padding(.leading, 28)
            .transition(.opacity.combined(with: .offset(y: -4)))
        }
      }
    }
  }

  private var line: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .font(.footnote)
        .foregroundStyle(step.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.tertiary))
        .frame(width: 18)
      Text(step.title)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 8)
      if step.running {
        ProgressView()
          .controlSize(.mini)
      } else if step.kind == .file {
        LineCounts(added: step.added ?? 0, removed: step.removed ?? 0)
          .font(.caption)
      }
      if opens {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.tertiary)
          .rotationEffect(.degrees(open ? 90 : 0))
      }
    }
    .contentShape(.rect)
  }

  /// The rest: a thought's whole text, a command in full and how it ended.
  @ViewBuilder private var more: some View {
    VStack(alignment: .leading, spacing: 4) {
      if step.kind == .thinking, let detail = step.detail {
        Text(inlineMarkdown(detail, code: .system(.footnote, design: .monospaced)))
          .font(.footnote)
      } else {
        Text(step.title)
          .font(step.kind == .command ? .system(.footnote, design: .monospaced) : .footnote)
        if let detail = step.detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      }
    }
    .foregroundStyle(.secondary)
    .textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// A line that already says everything has nothing to open.
  private var opens: Bool {
    step.detail != nil || step.title.count > 36 || step.title.contains("\n")
  }

  private var symbol: String { Self.symbol(for: step.kind) }

  static func symbol(for kind: StepView.Kind) -> String {
    switch kind {
    case .command: return "terminal"
    case .file: return "pencil"
    case .read: return "eye"
    case .tool: return "wrench.adjustable"
    case .agent: return "person.2"
    case .thinking: return "brain"
    case .plan: return "list.bullet"
    case .note: return "text.alignleft"
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

/// A progressive blur under the title bar: strongest at the top, gone at its foot.
private struct TopFade: View {
  let height: CGFloat

  var body: some View {
    ZStack {
      Rectangle()
        .fill(.ultraThinMaterial)
        .mask(
          LinearGradient(
            stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.7), .init(color: .clear, location: 1)],
            startPoint: .top, endPoint: .bottom))
      LinearGradient(
        stops: [
          .init(color: Color(.systemBackground).opacity(0.94), location: 0),
          .init(color: Color(.systemBackground).opacity(0.86), location: 0.68),
          .init(color: Color(.systemBackground).opacity(0), location: 1),
        ],
        startPoint: .top, endPoint: .bottom)
    }
    .frame(height: height)
    .frame(maxWidth: .infinity)
  }
}

/// One attached picture, read from the computer the first time it shows; a
/// tap opens it whole.
private struct AttachedThumbnail: View {
  @Environment(AppModel.self) private var model
  @Environment(\.threadId) private var threadId
  let path: String
  @State private var viewing = false

  var body: some View {
    let image = model.images[path]
    Button {
      viewing = true
    } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(Color(.secondarySystemBackground))
        if let image {
          Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .transition(.opacity)
        } else if model.missingImages.contains(path) {
          Image(systemName: "photo")
            .font(.title3)
            .foregroundStyle(.tertiary)
        } else {
          ProgressView()
            .controlSize(.small)
        }
      }
      .frame(width: 88, height: 88)
      .clipShape(.rect(cornerRadius: 16, style: .continuous))
      .animation(.smooth(duration: 0.25), value: image != nil)
    }
    .buttonStyle(.plain)
    .disabled(image == nil)
    .accessibilityLabel("Attached picture")
    .task(id: path) { await model.loadImage(threadId: threadId, path: path) }
    .fullScreenCover(isPresented: $viewing) {
      if let image {
        ImageViewer(image: image)
      }
    }
  }
}

/// A picture on black, fitted to the screen, pinch to zoom.
struct ImageViewer: View {
  @Environment(\.dismiss) private var dismiss
  let image: UIImage
  @State private var scale: CGFloat = 1
  @GestureState private var pinch: CGFloat = 1

  var body: some View {
    NavigationStack {
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .scaleEffect(max(1, scale * pinch))
        .gesture(
          MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
              withAnimation(.smooth) { scale = min(4, max(1, scale * value.magnification)) }
            }
        )
        .onTapGesture(count: 2) {
          withAnimation(.smooth) { scale = scale > 1 ? 1 : 2 }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button(role: .close) { dismiss() }
          }
          ToolbarItem(placement: .topBarTrailing) {
            ShareLink(item: Image(uiImage: image), preview: SharePreview("Picture", image: Image(uiImage: image)))
          }
        }
        .toolbarColorScheme(.dark, for: .navigationBar)
    }
  }
}
