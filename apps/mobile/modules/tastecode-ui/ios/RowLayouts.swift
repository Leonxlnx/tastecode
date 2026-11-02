import UIKit

/// A row's open folds, copied off the row so its layout can be made anywhere.
struct RowUI: Sendable, Equatable {
  var expanded = false
  var openRuns: Set<String> = []
}

/// One transcript row laid out at one width: its height, the space it leaves
/// below, and what its cell places.
struct RowLayout: @unchecked Sendable {
  enum Content {
    case assistant(DocLayout)
    case user(UserLayout)
    case steps(StepsLayout)
    case notice(NSAttributedString)
    case error(NSAttributedString, text: CGRect)
    case working(NSAttributedString)
    case plan(PlanLayout)
    case older(loading: Bool)
    case placeholder(PlaceholderLayout)
  }

  let content: Content
  let height: CGFloat
  /// Added to the gap below the row: an answer follows its work closely.
  var after: CGFloat = 0
}

extension RowLayout {
  /// The pictures a row shows; it is laid out again when one of them arrives.
  var images: Set<String> {
    switch content {
    case .assistant(let doc): return doc.images
    case .user(let user): return Set(user.attachments.map(\.path))
    case .steps(let steps):
      return steps.pieces.reduce(into: Set<String>()) { result, placed in
        if case .note(let doc) = placed.piece { result.formUnion(doc.images) }
      }
    default: return []
    }
  }
}

struct UserLayout {
  /// The whole message, to select or copy.
  let text: NSAttributedString?
  /// The same text in pieces, placed inside the bubble.
  let doc: DocLayout
  let bubble: CGRect
  let attachments: [(path: String, frame: CGRect)]
  static let padding = UIEdgeInsets(top: 10, left: 15, bottom: 10, right: 15)
}

struct StepsLayout {
  enum Piece {
    /// Everything between two notes under one line: "Ran 3 commands and read 1 file".
    case batch(id: String, summary: String, symbol: String, failed: Bool, open: Bool)
    case line(
      id: String, title: String, symbol: String, failed: Bool, running: Bool, counts: (Int, Int)?, opens: Bool,
      open: Bool)
    /// A thought's whole text, or a command in full and how it ended.
    case text(NSAttributedString)
    /// What the agent wrote on the way, which reads exactly like its reply.
    case note(DocLayout)
  }

  struct Placed {
    /// Stable across layouts, so a cell keeps each piece's view.
    let id: String
    let frame: CGRect
    let piece: Piece
    /// The run it belongs to, which sets when it settles in on opening.
    let order: Int
  }

  let summary: String
  let duration: String?
  let live: Bool
  let failed: Bool
  let settled: Bool
  let expanded: Bool
  let header: CGFloat
  let divider: CGRect?
  /// Where the steps start; they are clipped away while the fold is shut.
  let top: CGFloat
  let pieces: [Placed]
  let lineHeight: CGFloat
}

struct PlanLayout {
  let title: NSAttributedString
  let items: [(status: String, text: NSAttributedString, frame: CGRect)]
  let lineHeight: CGFloat
}

struct PlaceholderLayout {
  let loading: Bool
  let message: NSAttributedString?
  let messageFrame: CGRect
  let buttonY: CGFloat
}

enum RowLayouts {
  static func make(
    _ row: RowView, ui: RowUI, width: CGFloat, style: TranscriptStyle, images: ImageSizes, scale: CGFloat
  ) -> RowLayout {
    switch row.kind {
    case .assistant:
      let doc = DocumentBuilder.layout(row.text ?? "", width: width, style: style, images: images, scale: scale)
      return RowLayout(content: .assistant(doc), height: doc.height)
    case .user:
      let layout = user(row, width: width, style: style, scale: scale)
      return RowLayout(content: .user(layout), height: layout.bubble.maxY)
    case .steps:
      let layout = steps(row, ui: ui, width: width, style: style, images: images, scale: scale)
      let collapsed = layout.divider.map { $0.maxY } ?? layout.header
      let height = ui.expanded ? (layout.pieces.map(\.frame.maxY).max() ?? layout.top) : collapsed
      return RowLayout(content: .steps(layout), height: ceil(height * scale) / scale, after: layout.settled ? -10 : 0)
    case .notice:
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      let text = NSAttributedString(
        string: row.text ?? "",
        attributes: [.font: style.footnote, .foregroundColor: UIColor.tertiaryLabel, .paragraphStyle: paragraph])
      return RowLayout(content: .notice(text), height: InlineText.measure(text, width: width, scale: scale).height)
    case .error:
      let text = NSAttributedString(
        string: row.text ?? "",
        attributes: [
          .font: style.subheadline, .foregroundColor: UIColor.label,
          .paragraphStyle: InlineText.paragraph(lineSpacing: 2),
        ])
      let icon: CGFloat = 26
      let size = InlineText.measure(text, width: width - icon, scale: scale)
      return RowLayout(
        content: .error(text, text: CGRect(x: icon, y: 0, width: width - icon, height: size.height)),
        height: size.height)
    }
  }

  static func working(_ text: String, style: TranscriptStyle, scale: CGFloat) -> RowLayout {
    let label = NSAttributedString(
      string: text, attributes: [.font: style.subheadline, .foregroundColor: UIColor.secondaryLabel])
    return RowLayout(content: .working(label), height: max(InlineText.lineHeight(style.subheadline, scale: scale), 20))
  }

  static func older(loading: Bool) -> RowLayout {
    RowLayout(content: .older(loading: loading), height: 32)
  }

  static func plan(_ steps: [PlanView], width: CGFloat, style: TranscriptStyle, scale: CGFloat) -> RowLayout {
    let title = NSAttributedString(
      string: "Plan", attributes: [.font: style.subheadlineSemibold, .foregroundColor: UIColor.label])
    let line = InlineText.lineHeight(style.subheadline, scale: scale)
    var y = line + 8
    var items: [(String, NSAttributedString, CGRect)] = []
    for (index, step) in steps.enumerated() {
      if index > 0 { y += 8 }
      let text = NSAttributedString(
        string: step.text,
        attributes: [
          .font: style.subheadline,
          .foregroundColor: step.status == "done" ? UIColor.secondaryLabel : UIColor.label,
          .paragraphStyle: InlineText.paragraph(lineSpacing: 2),
        ])
      let size = InlineText.measure(text, width: width - 28, scale: scale)
      items.append((step.status, text, CGRect(x: 28, y: y, width: width - 28, height: size.height)))
      y += size.height
    }
    return RowLayout(content: .plan(PlanLayout(title: title, items: items, lineHeight: line)), height: y)
  }

  static func placeholder(_ meta: ThreadMetaView, width: CGFloat, style: TranscriptStyle, scale: CGFloat) -> RowLayout {
    let top: CGFloat = 120
    if meta.status == .loading {
      return RowLayout(
        content: .placeholder(PlaceholderLayout(loading: true, message: nil, messageFrame: .zero, buttonY: 0)),
        height: top + 20)
    }
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let message = NSAttributedString(
      string: meta.error ?? "The chat could not be loaded.",
      attributes: [.font: style.subheadline, .foregroundColor: UIColor.secondaryLabel, .paragraphStyle: paragraph])
    let size = InlineText.measure(message, width: width - 40, scale: scale)
    let frame = CGRect(x: 20, y: top, width: width - 40, height: size.height)
    let layout = PlaceholderLayout(loading: false, message: message, messageFrame: frame, buttonY: frame.maxY + 12)
    return RowLayout(content: .placeholder(layout), height: frame.maxY + 12 + 44)
  }

  // MARK: Rows

  private static func user(_ row: RowView, width: CGFloat, style: TranscriptStyle, scale: CGFloat) -> UserLayout {
    let padding = UserLayout.padding
    let widest = width - 48
    var y: CGFloat = 0
    var attachments: [(String, CGRect)] = []
    let paths = row.attachments ?? []
    if !paths.isEmpty {
      // Right-aligned, as many to a row as fit.
      let side: CGFloat = 88
      let perRow = max(1, Int((widest + 6) / (side + 6)))
      for (index, path) in paths.enumerated() {
        let rowIndex = index / perRow
        let column = index % perRow
        let inRow = min(perRow, paths.count - rowIndex * perRow)
        let x = width - CGFloat(inRow - column) * (side + 6) + 6
        attachments.append((path, CGRect(x: x, y: CGFloat(rowIndex) * (side + 6), width: side, height: side)))
      }
      y = (attachments.last?.1.maxY ?? 0)
    }
    let words = row.text ?? ""
    guard !words.isEmpty else {
      return UserLayout(
        text: nil, doc: .empty, bubble: CGRect(x: width, y: y, width: 0, height: 0), attachments: attachments)
    }
    if !attachments.isEmpty { y += 6 }
    let text = NSAttributedString(
      string: words,
      attributes: [
        .font: style.body, .foregroundColor: UIColor.label,
        .paragraphStyle: InlineText.paragraph(lineSpacing: 2),
      ])
    let chunks = InlineText.chunks(text, width: widest - padding.left - padding.right, scale: scale)
    let textWidth = chunks.map(\.frame.width).max() ?? 0
    let textHeight = chunks.last?.frame.maxY ?? 0
    let doc = DocLayout(
      blocks: chunks.map {
        DocLayout.Block(frame: CGRect(x: 0, y: $0.frame.minY, width: textWidth, height: $0.frame.height), content: .text($0.text))
      },
      width: textWidth, height: textHeight, images: [])
    let bubbleWidth = textWidth + padding.left + padding.right
    let bubble = CGRect(
      x: width - bubbleWidth, y: y, width: bubbleWidth, height: textHeight + padding.top + padding.bottom)
    return UserLayout(text: text, doc: doc, bubble: bubble, attachments: attachments)
  }

  private static func steps(
    _ row: RowView, ui: RowUI, width: CGFloat, style: TranscriptStyle, images: ImageSizes, scale: CGFloat
  ) -> StepsLayout {
    let line = max(InlineText.lineHeight(style.subheadline, scale: scale), 18)
    let settled = row.settled == true
    let divider = settled ? CGRect(x: 0, y: line + 10, width: width, height: 1 / scale) : nil
    let top = (divider?.maxY ?? line) + 10
    let runs = row.runs ?? (row.steps ?? []).map { StepRunView(id: $0.id, summary: nil, steps: [$0]) }
    var pieces: [StepsLayout.Placed] = []
    var y: CGFloat = 0

    func place(_ step: StepView, order: Int) {
      if step.kind == .note {
        let doc = DocumentBuilder.layout(step.title, width: width, style: style, images: images, scale: scale)
        pieces.append(.init(id: "n:\(step.id)", frame: CGRect(x: 0, y: y, width: width, height: doc.height), piece: .note(doc), order: order))
        y += doc.height
        return
      }
      let opens = step.detail != nil || step.title.count > 36 || step.title.contains("\n")
      let open = opens && ui.openRuns.contains("step:\(step.id)")
      let counts = step.kind == .file ? (step.added ?? 0, step.removed ?? 0) : nil
      pieces.append(
        .init(
          id: "s:\(step.id)", frame: CGRect(x: 0, y: y, width: width, height: line),
          piece: .line(
            id: step.id, title: step.title, symbol: symbol(step.kind), failed: step.failed, running: step.running,
            counts: counts, opens: opens, open: open),
          order: order))
      y += line
      guard open else { return }
      y += 6
      let more = moreText(step, style: style)
      let size = InlineText.measure(more, width: width - 28, scale: scale)
      pieces.append(
        .init(id: "m:\(step.id)", frame: CGRect(x: 28, y: y, width: width - 28, height: size.height), piece: .text(more), order: order))
      y += size.height
    }

    for (index, run) in runs.enumerated() {
      if index > 0 { y += 10 }
      let order = min(index, 10)
      if let summary = run.summary {
        let open = ui.openRuns.contains(run.id)
        let kinds = Set(run.steps.map(\.kind).filter { $0 != .thinking })
        let runSymbol = kinds.count > 1 ? "hammer" : symbol(kinds.first ?? run.steps.first?.kind ?? .other)
        pieces.append(
          .init(
            id: "b:\(run.id)", frame: CGRect(x: 0, y: y, width: width, height: line),
            piece: .batch(id: run.id, summary: summary, symbol: runSymbol, failed: run.steps.contains(where: \.failed), open: open),
            order: order))
        y += line
        guard open else { continue }
        y += 8
        if run.steps.count == 1, let thought = run.steps.first, thought.kind == .thinking {
          // A thought on its own opens to what it thought.
          let text = InlineText.make(
            thought.detail ?? "", font: style.subheadline, color: .secondaryLabel, code: style.footnoteMono,
            paragraph: InlineText.paragraph(lineSpacing: 2))
          let size = InlineText.measure(text, width: width - 28, scale: scale)
          pieces.append(
            .init(id: "t:\(run.id)", frame: CGRect(x: 28, y: y, width: width - 28, height: size.height), piece: .text(text), order: order))
          y += size.height
        } else {
          for (stepIndex, step) in run.steps.enumerated() {
            if stepIndex > 0 { y += 8 }
            place(step, order: order)
          }
        }
      } else {
        for (stepIndex, step) in run.steps.enumerated() {
          if stepIndex > 0 { y += 10 }
          place(step, order: order)
        }
      }
    }

    let shifted = pieces.map { StepsLayout.Placed(id: $0.id, frame: $0.frame.offsetBy(dx: 0, dy: top), piece: $0.piece, order: $0.order) }
    return StepsLayout(
      summary: row.summary ?? "", duration: row.duration, live: row.live == true,
      failed: row.failed == true && !settled, settled: settled, expanded: ui.expanded, header: line,
      divider: divider, top: top, pieces: shifted, lineHeight: line)
  }

  /// The rest of a step: a thought's whole text, or a command in full and how it ended.
  private static func moreText(_ step: StepView, style: TranscriptStyle) -> NSAttributedString {
    if step.kind == .thinking, let detail = step.detail {
      return InlineText.make(
        detail, font: style.footnote, color: .secondaryLabel, code: style.footnoteMono,
        paragraph: InlineText.paragraph(lineSpacing: 2))
    }
    let result = NSMutableAttributedString(
      string: step.title,
      attributes: [
        .font: step.kind == .command ? style.footnoteMono : style.footnote, .foregroundColor: UIColor.secondaryLabel,
        .paragraphStyle: InlineText.paragraph(lineSpacing: 2, spacingAfter: 4),
      ])
    if let detail = step.detail {
      result.append(
        NSAttributedString(
          string: "\n" + detail,
          attributes: [
            .font: style.caption, .foregroundColor: UIColor.tertiaryLabel,
            .paragraphStyle: InlineText.paragraph(lineSpacing: 2),
          ]))
    }
    return result
  }

  static func symbol(_ kind: StepView.Kind) -> String {
    switch kind {
    case .command: return "terminal-2"
    case .file: return "pencil"
    case .read: return "eye"
    case .tool: return "tool"
    case .agent: return "users"
    case .thinking: return "brain"
    case .plan: return "list"
    case .note: return "align-left"
    case .other: return "circle-dashed"
    }
  }
}
