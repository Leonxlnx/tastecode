import UIKit

/// What the layout knows of a reply's pictures: the size of each one loaded,
/// and which could not be had. Keyed by `ImageKey.of`.
struct ImageSizes: @unchecked Sendable {
  var loaded: [String: CGSize] = [:]
  var missing: Set<String> = []
}

enum ImageKey {
  /// One key per picture however a reply spells it: the path on the computer,
  /// or the web address.
  static func of(_ source: String) -> String { localImagePath(source) ?? source }
}

/// A reply laid out at one width: each block's frame and what it draws. Built
/// off the main thread; the views only place and draw it.
struct DocLayout: @unchecked Sendable {
  struct Block {
    let frame: CGRect
    let content: Content
  }

  enum Content {
    /// A paragraph, a heading or a whole list, drawn as one run of text.
    case text(NSAttributedString)
    case quote(NSAttributedString, text: CGRect)
    case code(CodeLayout)
    case table(TableLayout)
    case rule
    case image(ImageLayout)
  }

  let blocks: [Block]
  let width: CGFloat
  let height: CGFloat
  /// The pictures it shows, so it can be laid out again when one arrives.
  let images: Set<String>

  static let empty = DocLayout(blocks: [], width: 0, height: 0, images: [])
}

struct CodeLayout {
  let language: String
  let code: String
  /// The code in runs of lines, each drawn on its own, so a long block never
  /// becomes one enormous bitmap.
  let chunks: [(text: NSAttributedString, frame: CGRect)]
  /// The text's own size; it scrolls sideways when wider than the block.
  let content: CGSize
  static let inset = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 8)
  static let button: CGFloat = 40
}

struct TableLayout {
  let cells: [(text: NSAttributedString, frame: CGRect)]
  let divider: CGRect
  let content: CGSize
}

struct ImageLayout {
  enum State { case loading, loaded, missing }
  let key: String
  let source: String
  let alt: String
  let state: State
  /// The picture's frame inside the block; the block is the column's width.
  let frame: CGRect
  let label: NSAttributedString?
}

/// Measured blocks by their text, width and type size. A streaming reply
/// changes only its last block, so every other block comes from here.
final class BlockCache: @unchecked Sendable {
  static let shared = BlockCache()
  private let lock = NSLock()
  typealias Pieces = (pieces: [DocLayout.Block], height: CGFloat)
  private var entries: [String: Pieces] = [:]

  func value(_ key: String, make: () -> Pieces) -> Pieces {
    lock.lock()
    if let hit = entries[key] {
      lock.unlock()
      return hit
    }
    lock.unlock()
    let made = make()
    lock.lock()
    // A rough bound: a few thousand blocks is several long chats.
    if entries.count > 4000 { entries.removeAll(keepingCapacity: true) }
    entries[key] = made
    lock.unlock()
    return made
  }
}

enum DocumentBuilder {
  /// Lays a reply out at a width. Pure and thread-safe.
  static func layout(
    _ markdown: String, width: CGFloat, style: TranscriptStyle, images: ImageSizes, scale: CGFloat,
    color: UIColor = .label
  ) -> DocLayout {
    let parsed = MarkdownBlock.parse(markdown)
    var blocks: [DocLayout.Block] = []
    var shown: Set<String> = []
    var y: CGFloat = 0
    for (index, block) in parsed.enumerated() {
      if index > 0 { y += style.blockSpacing }
      if case .heading(let level, _) = block.kind { y += level <= 2 ? 6 : 2 }
      if case .image(let alt, let source) = block.kind {
        let key = ImageKey.of(source)
        shown.insert(key)
        let (content, height) = image(
          alt: alt, source: source, key: key, width: width, style: style, images: images, scale: scale)
        blocks.append(DocLayout.Block(frame: CGRect(x: 0, y: y, width: width, height: height), content: content))
        y += height
        continue
      }
      let cacheKey = "\(cacheTag(block.kind))|\(width)|\(style.sizeCategory.rawValue)|\(color.hash)"
      let measured = BlockCache.shared.value(cacheKey) {
        pieces(block.kind, width: width, style: style, scale: scale, color: color)
      }
      // A long paragraph or list comes in pieces, each its own block, so only the
      // pieces near the screen are drawn.
      for piece in measured.pieces {
        blocks.append(DocLayout.Block(frame: piece.frame.offsetBy(dx: 0, dy: y), content: piece.content))
      }
      y += measured.height
    }
    return DocLayout(blocks: blocks, width: width, height: ceil(y), images: shown)
  }

  private static func cacheTag(_ kind: MarkdownBlock.Kind) -> String {
    switch kind {
    case .paragraph(let text): return "p\(text)"
    case .heading(let level, let text): return "h\(level)\(text)"
    case .list(let items):
      return "l" + items.map { "\($0.depth)\($0.marker)\($0.checked.map { $0 ? "x" : "o" } ?? "-")\($0.text)" }.joined(separator: "\u{1}")
    case .quote(let text): return "q\(text)"
    case .code(let language, let code): return "c\(language)\u{1}\(code)"
    case .table(let header, let rows):
      return "t" + ([header] + rows).map { $0.joined(separator: "\u{2}") }.joined(separator: "\u{1}")
    case .rule: return "r"
    case .image(let alt, let source): return "i\(alt)\u{1}\(source)"
    }
  }

  /// A block measured at a width, as one piece or, for long text, several.
  private static func pieces(
    _ kind: MarkdownBlock.Kind, width: CGFloat, style: TranscriptStyle, scale: CGFloat, color: UIColor
  ) -> BlockCache.Pieces {
    let text: NSAttributedString?
    switch kind {
    case .paragraph(let words):
      text = InlineText.make(
        words, font: style.body, color: color, code: style.subheadlineMono,
        paragraph: InlineText.paragraph(lineSpacing: 3))
    case .list(let items):
      text = list(items, style: style, color: color)
    default:
      text = nil
    }
    if let text {
      let chunks = InlineText.chunks(text, width: width, scale: scale)
      let blocks = chunks.map { DocLayout.Block(frame: $0.frame, content: .text($0.text)) }
      return (blocks, chunks.last?.frame.maxY ?? 0)
    }
    let (content, height) = measure(kind, width: width, style: style, scale: scale, color: color)
    return ([DocLayout.Block(frame: CGRect(x: 0, y: 0, width: width, height: height), content: content)], height)
  }

  private static func measure(
    _ kind: MarkdownBlock.Kind, width: CGFloat, style: TranscriptStyle, scale: CGFloat, color: UIColor
  ) -> (DocLayout.Content, CGFloat) {
    switch kind {
    case .paragraph(let text):
      let attributed = InlineText.make(
        text, font: style.body, color: color, code: style.subheadlineMono,
        paragraph: InlineText.paragraph(lineSpacing: 3))
      return (.text(attributed), InlineText.measure(attributed, width: width, scale: scale).height)
    case .heading(let level, let text):
      let font = level == 1 ? style.title2 : level == 2 ? style.title3 : style.headline
      let attributed = InlineText.make(
        text, font: font, color: color, code: style.subheadlineMono, paragraph: InlineText.paragraph(lineSpacing: 1))
      return (.text(attributed), InlineText.measure(attributed, width: width, scale: scale).height)
    case .list(let items):
      let attributed = list(items, style: style, color: color)
      return (.text(attributed), InlineText.measure(attributed, width: width, scale: scale).height)
    case .quote(let text):
      let attributed = InlineText.make(
        text, font: style.body, color: .secondaryLabel, code: style.subheadlineMono,
        paragraph: InlineText.paragraph(lineSpacing: 3))
      let size = InlineText.measure(attributed, width: width - 15, scale: scale)
      return (.quote(attributed, text: CGRect(x: 15, y: 0, width: width - 15, height: size.height)), size.height)
    case .code(let language, let code):
      let layout = codeLayout(language: language, code: code, style: style, scale: scale)
      let height = max(layout.content.height + CodeLayout.inset.top + CodeLayout.inset.bottom, CodeLayout.button)
      return (.code(layout), height)
    case .table(let header, let rows):
      let layout = tableLayout(header: header, rows: rows, style: style, scale: scale, color: color)
      return (.table(layout), layout.content.height)
    case .rule:
      return (.rule, 8.5)
    case .image:
      return (.rule, 0)
    }
  }

  /// A list as one run of text: each item a paragraph whose marker sits right-
  /// aligned in its own column, with wrapped lines hanging under the text.
  private static func list(_ items: [MarkdownBlock.ListItem], style: TranscriptStyle, color: UIColor) -> NSAttributedString {
    let result = NSMutableAttributedString()
    for (index, item) in items.enumerated() {
      let indent = CGFloat(item.depth) * 18
      let markerColumn: CGFloat = item.checked == nil ? 14 : 18
      let textStart = indent + markerColumn + 8
      let paragraph = InlineText.paragraph(lineSpacing: 3, spacingAfter: index == items.count - 1 ? 0 : 6)
      paragraph.firstLineHeadIndent = indent
      paragraph.headIndent = textStart
      paragraph.tabStops = [
        NSTextTab(textAlignment: .right, location: indent + markerColumn),
        NSTextTab(textAlignment: .left, location: textStart),
      ]
      var base: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph, .font: style.body, .foregroundColor: color]
      if index > 0 { result.append(NSAttributedString(string: "\n", attributes: base)) }
      result.append(NSAttributedString(string: "\t", attributes: base))
      if let checked = item.checked {
        // The text size is already in the font, so the icon is not scaled again.
        let symbol = Tabler.image(
          checked ? "circle-check-filled" : "circle", size: ceil(style.subheadline.pointSize * 1.15), fixed: true
        )
        .withTintColor(checked ? color : .secondaryLabel, renderingMode: .alwaysOriginal)
        let attachment = NSTextAttachment()
        attachment.image = symbol
        let size = symbol.size
        attachment.bounds = CGRect(x: 0, y: (style.body.capHeight - size.height) / 2, width: size.width, height: size.height)
        let mark = NSMutableAttributedString(attachment: attachment)
        mark.addAttributes([.paragraphStyle: paragraph], range: NSRange(location: 0, length: mark.length))
        result.append(mark)
      } else {
        base[.font] = item.marker == "•" ? style.body : style.bodyDigits
        base[.foregroundColor] = UIColor.secondaryLabel
        result.append(NSAttributedString(string: item.marker, attributes: base))
      }
      base[.font] = style.body
      base[.foregroundColor] = color
      result.append(NSAttributedString(string: "\t", attributes: base))
      result.append(
        InlineText.make(item.text, font: style.body, color: color, code: style.subheadlineMono, paragraph: paragraph))
    }
    return result
  }

  private static func codeLayout(language: String, code: String, style: TranscriptStyle, scale: CGFloat) -> CodeLayout {
    let paragraph = InlineText.paragraph(lineSpacing: 3)
    paragraph.lineBreakMode = .byClipping
    let attributes: [NSAttributedString.Key: Any] = [
      .font: style.footnoteMono, .foregroundColor: UIColor.label, .paragraphStyle: paragraph,
    ]
    // One line's height and the step between lines, so runs of lines stack seamlessly.
    let one = NSAttributedString(string: "X", attributes: attributes).boundingRect(
      with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil
    ).height
    let two = NSAttributedString(string: "X\nX", attributes: attributes).boundingRect(
      with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil
    ).height
    let step = two - one
    let lines = code.components(separatedBy: "\n")
    let perChunk = 60
    var chunks: [(NSAttributedString, CGRect)] = []
    var widest: CGFloat = 0
    var start = 0
    while start < lines.count {
      let end = min(start + perChunk, lines.count)
      let text = NSAttributedString(string: lines[start..<end].joined(separator: "\n"), attributes: attributes)
      let size = InlineText.measure(text, width: .greatestFiniteMagnitude, scale: scale)
      widest = max(widest, size.width)
      let y = CGFloat(start) * step
      let height = ceil((one + CGFloat(end - start - 1) * step) * scale) / scale
      chunks.append((text, CGRect(x: 0, y: y, width: 0, height: height)))
      start = end
    }
    let height = ceil((one + CGFloat(max(lines.count - 1, 0)) * step) * scale) / scale
    let sized = chunks.map { ($0.0, CGRect(x: 0, y: $0.1.minY, width: widest, height: $0.1.height)) }
    return CodeLayout(language: language, code: code, chunks: sized, content: CGSize(width: widest, height: height))
  }

  private static func tableLayout(
    header: [String], rows: [[String]], style: TranscriptStyle, scale: CGFloat, color: UIColor
  ) -> TableLayout {
    let padding: CGFloat = 14
    let columnGap: CGFloat = 18
    let rowGap: CGFloat = 8
    let all = [header] + rows
    let columns = all.map(\.count).max() ?? 0
    let paragraph = InlineText.paragraph(lineSpacing: 1)
    var texts: [[NSAttributedString]] = []
    var sizes: [[CGSize]] = []
    var widths = [CGFloat](repeating: 0, count: columns)
    for (rowIndex, row) in all.enumerated() {
      var rowTexts: [NSAttributedString] = []
      var rowSizes: [CGSize] = []
      for column in 0..<columns {
        let cell = column < row.count ? row[column] : ""
        let text = InlineText.make(
          cell, font: rowIndex == 0 ? style.subheadlineSemibold : style.subheadline, color: color,
          code: style.subheadlineMono, paragraph: paragraph)
        // A column grows to its widest cell, and wraps past a readable width.
        let size = InlineText.measure(text, width: 280, scale: scale)
        widths[column] = max(widths[column], size.width)
        rowTexts.append(text)
        rowSizes.append(size)
      }
      texts.append(rowTexts)
      sizes.append(rowSizes)
    }
    var cells: [(NSAttributedString, CGRect)] = []
    var y = padding
    var divider = CGRect.zero
    for (rowIndex, rowTexts) in texts.enumerated() {
      var x = padding
      var rowHeight: CGFloat = 0
      for (column, text) in rowTexts.enumerated() {
        let height = column < widths.count
          ? InlineText.measure(text, width: widths[column], scale: scale).height : sizes[rowIndex][column].height
        cells.append((text, CGRect(x: x, y: y, width: widths[column], height: height)))
        rowHeight = max(rowHeight, height)
        x += widths[column] + columnGap
      }
      y += rowHeight
      if rowIndex == 0 {
        y += rowGap
        divider = CGRect(x: padding, y: y, width: 0, height: 1 / scale)
        y += 1 / scale + rowGap
      } else if rowIndex < texts.count - 1 {
        y += rowGap
      }
    }
    let contentWidth = widths.reduce(0, +) + columnGap * CGFloat(max(columns - 1, 0)) + padding * 2
    divider.size.width = contentWidth - padding * 2
    return TableLayout(cells: cells, divider: divider, content: CGSize(width: contentWidth, height: y + padding))
  }

  private static func image(
    alt: String, source: String, key: String, width: CGFloat, style: TranscriptStyle, images: ImageSizes, scale: CGFloat
  ) -> (DocLayout.Content, CGFloat) {
    if let size = images.loaded[key], size.width > 0, size.height > 0 {
      // Fitted to the column and kept from towering over the reply, never enlarged.
      let fit = min(1, width / size.width, 440 / size.height)
      let frame = CGRect(
        x: 0, y: 0, width: floor(size.width * fit * scale) / scale, height: floor(size.height * fit * scale) / scale)
      return (.image(ImageLayout(key: key, source: source, alt: alt, state: .loaded, frame: frame, label: nil)), frame.height)
    }
    if images.missing.contains(key) {
      let label = NSAttributedString(
        string: alt.isEmpty ? "Image unavailable" : "\(alt): Image unavailable",
        attributes: [.font: style.subheadline, .foregroundColor: UIColor.secondaryLabel])
      let size = InlineText.measure(label, width: width - 26, scale: scale)
      let frame = CGRect(x: 26, y: 0, width: width - 26, height: size.height)
      return (
        .image(ImageLayout(key: key, source: source, alt: alt, state: .missing, frame: frame, label: label)),
        size.height
      )
    }
    let placeholder = min(320, width)
    let frame = CGRect(x: 0, y: 0, width: placeholder, height: floor(placeholder / 1.6))
    return (.image(ImageLayout(key: key, source: source, alt: alt, state: .loading, frame: frame, label: nil)), frame.height)
  }
}
