import UIKit

/// A reply split into its blocks: paragraphs, headings, lists, quotes, code,
/// tables, rules and images on lines of their own. The transcript lays them out.
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
