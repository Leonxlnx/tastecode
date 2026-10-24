import SwiftUI
import UIKit

/// An agent's reply as the desktop shows it: paragraphs, headings, lists, quotes,
/// tables and code blocks, with inline emphasis, code and links. Selectable, and
/// every code block has its own copy button.
struct MarkdownView: View {
  let markdown: String

  var body: some View {
    let blocks = MarkdownBlock.parse(markdown)
    VStack(alignment: .leading, spacing: 14) {
      ForEach(blocks) { block in
        MarkdownBlockView(block: block)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct MarkdownBlock: Identifiable {
  enum Kind {
    case paragraph(String)
    case heading(level: Int, text: String)
    case list(items: [ListItem])
    case quote(String)
    case code(language: String, code: String)
    case table(header: [String], rows: [[String]])
    case rule
    case image(alt: String, source: String)
  }

  struct ListItem: Hashable {
    let marker: String
    let text: String
    let depth: Int
    let checked: Bool?
  }

  let id: Int
  let kind: Kind

  static func parse(_ markdown: String) -> [MarkdownBlock] {
    var blocks: [Kind] = []
    var paragraph: [String] = []
    var list: [ListItem] = []
    var quote: [String] = []
    var table: [[String]] = []
    var fence: (marker: String, language: String, lines: [String])?

    func flush() {
      if !paragraph.isEmpty {
        blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        paragraph = []
      }
      if !list.isEmpty {
        blocks.append(.list(items: list))
        list = []
      }
      if !quote.isEmpty {
        blocks.append(.quote(quote.joined(separator: "\n")))
        quote = []
      }
      if !table.isEmpty {
        let header = table[0]
        let body = table.dropFirst().filter { !isSeparatorRow($0) }
        blocks.append(.table(header: header, rows: Array(body)))
        table = []
      }
    }

    for rawLine in markdown.components(separatedBy: "\n") {
      let line = rawLine.replacingOccurrences(of: "\t", with: "    ")
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if var open = fence {
        if trimmed.hasPrefix(open.marker) && trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "`~")).isEmpty {
          blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
          fence = nil
        } else {
          open.lines.append(line)
          fence = open
        }
        continue
      }

      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        flush()
        let marker = String(trimmed.prefix(3))
        let language = trimmed.dropFirst(3).trimmingCharacters(in: CharacterSet(charactersIn: "`~ "))
        fence = (marker, language, [])
        continue
      }

      if trimmed.isEmpty {
        flush()
        continue
      }

      if let heading = headingLevel(trimmed) {
        flush()
        blocks.append(.heading(level: heading, text: String(trimmed.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
        continue
      }

      if isRule(trimmed) {
        flush()
        blocks.append(.rule)
        continue
      }

      if trimmed.hasPrefix("|") {
        if !paragraph.isEmpty || !list.isEmpty || !quote.isEmpty { flush() }
        table.append(cells(trimmed))
        continue
      } else if !table.isEmpty {
        flush()
      }

      if trimmed.hasPrefix(">") {
        if !paragraph.isEmpty || !list.isEmpty { flush() }
        quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
        continue
      }

      if let item = listItem(line) {
        if !paragraph.isEmpty || !quote.isEmpty { flush() }
        list.append(item)
        continue
      }

      if !list.isEmpty, line.hasPrefix("  "), let last = list.popLast() {
        // A wrapped line continues the item above it.
        list.append(ListItem(marker: last.marker, text: last.text + " " + trimmed, depth: last.depth, checked: last.checked))
        continue
      }

      if let shown = images(trimmed) {
        // Agents show their screenshots on lines of their own.
        flush()
        blocks.append(contentsOf: shown)
        continue
      }

      if !list.isEmpty || !quote.isEmpty { flush() }
      paragraph.append(line)
    }

    if let open = fence {
      blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
    }
    flush()
    return blocks.enumerated().map { MarkdownBlock(id: $0.offset, kind: $0.element) }
  }

  // `![alt](destination "title")`, with the destination bare or in angle brackets.
  private static let imagePattern = /!\[((?:[^\]\\]|\\.)*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/

  /// A line that is nothing but images, as one image block each.
  private static func images(_ line: String) -> [Kind]? {
    let matches = line.matches(of: imagePattern)
    guard !matches.isEmpty, line.replacing(imagePattern, with: "").allSatisfy(\.isWhitespace) else { return nil }
    return matches.map { match in
      .image(alt: String(match.output.1), source: String(match.output.2 ?? match.output.3 ?? ""))
    }
  }

  private static func headingLevel(_ line: String) -> Int? {
    let hashes = line.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
    return hashes
  }

  private static func isRule(_ line: String) -> Bool {
    let compact = line.replacingOccurrences(of: " ", with: "")
    guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
    return compact.allSatisfy { $0 == first }
  }

  private static func listItem(_ line: String) -> ListItem? {
    let indent = line.prefix(while: { $0 == " " }).count
    let rest = line.dropFirst(indent)
    var marker: String
    var text: Substring
    if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
      marker = "•"
      text = rest.dropFirst(2)
    } else {
      let digits = rest.prefix(while: { $0.isNumber })
      guard !digits.isEmpty, digits.count < 4 else { return nil }
      let after = rest.dropFirst(digits.count)
      guard let dot = after.first, ".)".contains(dot), after.dropFirst().first == " " else { return nil }
      marker = "\(digits)."
      text = after.dropFirst(2)
    }
    var checked: Bool?
    if text.hasPrefix("[ ] ") {
      checked = false
      text = text.dropFirst(4)
    } else if text.lowercased().hasPrefix("[x] ") {
      checked = true
      text = text.dropFirst(4)
    }
    if checked != nil { marker = "" }
    return ListItem(marker: marker, text: String(text), depth: min(indent / 2, 4), checked: checked)
  }

  private static func cells(_ line: String) -> [String] {
    var inner = line
    if inner.hasPrefix("|") { inner.removeFirst() }
    if inner.hasSuffix("|") { inner.removeLast() }
    return inner.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
  }

  private static func isSeparatorRow(_ row: [String]) -> Bool {
    row.allSatisfy { cell in !cell.isEmpty && cell.allSatisfy { "-:".contains($0) } }
  }
}

/// Inline Markdown (emphasis, code, links, strikethrough) as SwiftUI text.
func inlineMarkdown(
  _ text: String, code codeFont: Font = .system(.subheadline, design: .monospaced)
) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(
    allowsExtendedAttributes: false,
    interpretedSyntax: .inlineOnlyPreservingWhitespace,
    failurePolicy: .returnPartiallyParsedIfPossible
  )
  var parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  // Inline code reads as a word set in another face, not a shout: a size down, on a faint fill.
  let code = parsed.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
  for range in code {
    parsed[range].font = codeFont
    parsed[range].backgroundColor = Color(.tertiarySystemFill)
  }
  return parsed
}

struct MarkdownBlockView: View {
  let block: MarkdownBlock

  var body: some View {
    switch block.kind {
    case .paragraph(let text):
      Text(inlineMarkdown(text))
        .font(.body)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    case .heading(let level, let text):
      Text(inlineMarkdown(text))
        .font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.semibold) : .headline)
        .padding(.top, level <= 2 ? 6 : 2)
        .textSelection(.enabled)
    case .list(let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let checked = item.checked {
              Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                .font(.subheadline)
                .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            } else {
              Text(item.marker)
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 14, alignment: .trailing)
            }
            Text(inlineMarkdown(item.text))
              .font(.body)
              .lineSpacing(3)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
          .padding(.leading, CGFloat(item.depth) * 18)
        }
      }
    case .quote(let text):
      HStack(alignment: .top, spacing: 12) {
        Capsule().fill(.quaternary).frame(width: 3)
        Text(inlineMarkdown(text))
          .font(.body)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
    case .code(let language, let code):
      CodeBlockView(language: language, code: code)
    case .table(let header, let rows):
      MarkdownTableView(header: header, rows: rows)
    case .rule:
      Divider().padding(.vertical, 4)
    case .image(let alt, let source):
      MarkdownImage(alt: alt, source: source)
    }
  }
}

/// A picture a reply shows. A screenshot on the computer is read through the
/// link the first time it shows, as attached pictures are; a web image loads
/// from the web. A tap opens it whole.
struct MarkdownImage: View {
  @Environment(AppModel.self) private var model
  @Environment(\.threadId) private var threadId
  let alt: String
  let source: String
  @State private var viewing = false

  var body: some View {
    Group {
      if let path = localImagePath(source) {
        local(path)
      } else if let url = URL(string: source), ["http", "https"].contains(url.scheme?.lowercased()) {
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            frame(image.resizable())
          } else if phase.error != nil {
            unavailable
          } else {
            loading
          }
        }
      } else {
        unavailable
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityLabel(alt.isEmpty ? "Picture" : alt)
    .fullScreenCover(isPresented: $viewing) {
      if let path = localImagePath(source), let image = model.images[path] {
        ImageViewer(image: image)
      }
    }
  }

  @ViewBuilder
  private func local(_ path: String) -> some View {
    Group {
      if let image = model.images[path] {
        Button {
          viewing = true
        } label: {
          frame(Image(uiImage: image).resizable())
        }
        .buttonStyle(.plain)
        .transition(.opacity)
      } else if model.missingImages.contains(path) {
        unavailable
      } else {
        loading
      }
    }
    .animation(.smooth(duration: 0.25), value: model.images[path] != nil)
    .task(id: path) { await model.loadImage(threadId: threadId, path: path) }
  }

  /// Fitted to the column and kept from towering over the reply, on a hairline.
  private func frame(_ image: Image) -> some View {
    image
      .scaledToFit()
      .frame(maxHeight: 440)
      .clipShape(.rect(cornerRadius: 14, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(.quaternary, lineWidth: 0.5)
      }
  }

  private var loading: some View {
    RoundedRectangle(cornerRadius: 14, style: .continuous)
      .fill(Color(.secondarySystemBackground))
      .aspectRatio(16 / 10, contentMode: .fit)
      .frame(maxWidth: 320)
      .overlay { ProgressView().controlSize(.small) }
  }

  private var unavailable: some View {
    Label(alt.isEmpty ? "Image unavailable" : "\(alt): Image unavailable", systemImage: "photo")
      .font(.subheadline)
      .foregroundStyle(.secondary)
  }
}

/// A Markdown image source as a path on the computer the chat runs on, or nil
/// for a web address: `/tmp/shot.png`, `C:\Shots\a.png` or a `file:` URL.
func localImagePath(_ source: String) -> String? {
  if source.lowercased().hasPrefix("file:") {
    guard let url = URL(string: source), [nil, "", "localhost"].contains(url.host) else { return nil }
    let path = url.path(percentEncoded: false)
    // file:///C:/Shots/a.png names C:/Shots/a.png.
    return path.wholeMatch(of: /\/[A-Za-z]:\/.*/) != nil ? String(path.dropFirst()) : path
  }
  let decoded = source.removingPercentEncoding ?? source
  if decoded.hasPrefix("//") { return nil }
  if decoded.hasPrefix("/") || decoded.prefixMatch(of: /[A-Za-z]:[\\\/]/) != nil { return decoded }
  return nil
}

struct CodeBlockView: View {
  let language: String
  let code: String
  @State private var copied = false

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .font(.system(.footnote, design: .monospaced))
          .lineSpacing(3)
          .fixedSize(horizontal: true, vertical: true)
          .textSelection(.enabled)
          .padding(.leading, 14)
          .padding(.trailing, 8)
          .padding(.vertical, 12)
      }
      Button {
        UIPasteboard.general.string = code
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.snappy) { copied = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
          withAnimation(.snappy) { copied = false }
        }
      } label: {
        Image(systemName: copied ? "checkmark" : "square.on.square")
          .font(.footnote)
          .foregroundStyle(.tertiary)
          .contentTransition(.symbolEffect(.replace))
          .frame(width: 40, height: 40)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(copied ? "Copied" : "Copy \(language.isEmpty ? "code" : language)")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quaternary, in: .rect(cornerRadius: 14, style: .continuous))
  }
}

struct MarkdownTableView: View {
  let header: [String]
  let rows: [[String]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
        GridRow {
          ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
            Text(inlineMarkdown(cell)).font(.subheadline.weight(.semibold))
          }
        }
        Divider()
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(inlineMarkdown(cell)).font(.subheadline)
            }
          }
        }
      }
      .padding(14)
    }
    .background(.fill.quaternary, in: .rect(cornerRadius: 14, style: .continuous))
  }
}
