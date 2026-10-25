import UIKit

/// The transcript's type and spacing, read from UIKit once per text size so the
/// layout queue never has to ask it. Immutable, so it crosses threads freely.
final class TranscriptStyle: @unchecked Sendable {
  let body: UIFont
  let bodyDigits: UIFont
  let title2: UIFont
  let title3: UIFont
  let headline: UIFont
  let subheadline: UIFont
  let subheadlineSemibold: UIFont
  let subheadlineMono: UIFont
  let footnote: UIFont
  let footnoteMono: UIFont
  let caption: UIFont
  let caption2Bold: UIFont
  /// Identifies the text size, so a cached measurement is never reused at another one.
  let sizeCategory: UIContentSizeCategory

  /// Between rows, and between a reply's blocks.
  let rowSpacing: CGFloat = 22
  let blockSpacing: CGFloat = 14
  let sideInset: CGFloat = 20

  init(traits: UITraitCollection) {
    func font(_ style: UIFont.TextStyle, weight: UIFont.Weight? = nil) -> UIFont {
      let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
      guard let weight else { return base }
      let descriptor = base.fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
      return UIFont(descriptor: descriptor, size: base.pointSize)
    }
    func mono(_ style: UIFont.TextStyle) -> UIFont {
      UIFont.monospacedSystemFont(
        ofSize: UIFont.preferredFont(forTextStyle: style, compatibleWith: traits).pointSize, weight: .regular)
    }
    body = font(.body)
    bodyDigits = UIFont.monospacedDigitSystemFont(ofSize: body.pointSize, weight: .regular)
    title2 = font(.title2, weight: .bold)
    title3 = font(.title3, weight: .semibold)
    headline = font(.headline)
    subheadline = font(.subheadline)
    subheadlineSemibold = font(.subheadline, weight: .semibold)
    subheadlineMono = mono(.subheadline)
    footnote = font(.footnote)
    footnoteMono = mono(.footnote)
    caption = font(.caption1)
    caption2Bold = font(.caption2, weight: .bold)
    sizeCategory = traits.preferredContentSizeCategory
  }
}

extension NSAttributedString.Key {
  /// Where a link in the transcript goes. Not `.link`: string drawing ignores
  /// that one, and the transcript styles its links itself.
  static let transcriptLink = NSAttributedString.Key("TasteTranscriptLink")
}

extension UIFont {
  func adding(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
    guard let descriptor = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(traits)) else { return self }
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

enum InlineText {
  private static let options = AttributedString.MarkdownParsingOptions(
    allowsExtendedAttributes: false,
    interpretedSyntax: .inlineOnlyPreservingWhitespace,
    failurePolicy: .returnPartiallyParsedIfPossible
  )

  /// Inline Markdown (emphasis, code, links, strikethrough) as attributed text
  /// in one font and colour. Safe off the main thread.
  static func make(
    _ text: String, font: UIFont, color: UIColor, code: UIFont, paragraph: NSParagraphStyle? = nil
  ) -> NSMutableAttributedString {
    let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    let result = NSMutableAttributedString()
    for run in parsed.runs {
      let piece = String(parsed[run.range].characters)
      let intent = run.inlinePresentationIntent ?? []
      var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
      if intent.contains(.code) {
        // Inline code reads as a word set in another face: a size down, on a faint fill.
        attributes[.font] = code
        attributes[.backgroundColor] = UIColor.tertiarySystemFill
      } else {
        var traits: UIFontDescriptor.SymbolicTraits = []
        if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
        if intent.contains(.emphasized) { traits.insert(.traitItalic) }
        attributes[.font] = traits.isEmpty ? font : font.adding(traits)
      }
      if intent.contains(.strikethrough) {
        attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      if let link = run.link {
        attributes[.transcriptLink] = link
        attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        attributes[.underlineColor] = UIColor.tertiaryLabel
      }
      if let paragraph { attributes[.paragraphStyle] = paragraph }
      result.append(NSAttributedString(string: piece, attributes: attributes))
    }
    return result
  }

  static func paragraph(lineSpacing: CGFloat, spacingAfter: CGFloat = 0) -> NSMutableParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineSpacing = lineSpacing
    style.paragraphSpacing = spacingAfter
    style.lineBreakMode = .byWordWrapping
    return style
  }

  /// The height and width text takes at a width, rounded up to whole pixels.
  /// The same string drawing measures and draws it, so the two always agree.
  static func measure(_ text: NSAttributedString, width: CGFloat, scale: CGFloat) -> CGSize {
    guard text.length > 0 else { return .zero }
    let rect = text.boundingRect(
      with: CGSize(width: width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil)
    return CGSize(width: ceil(rect.width * scale) / scale, height: ceil(rect.height * scale) / scale)
  }

  /// Long text split at paragraph breaks into pieces of about `budget`
  /// characters, each measured on its own and placed with the gap string
  /// drawing leaves between those paragraphs. A tall run of text is then many
  /// small drawings, of which only those near the screen exist.
  static func chunks(
    _ text: NSAttributedString, width: CGFloat, scale: CGFloat, budget: Int = 1500
  ) -> [(text: NSAttributedString, frame: CGRect)] {
    let string = text.string as NSString
    guard string.length > budget else {
      let size = measure(text, width: width, scale: scale)
      return [(text, CGRect(x: 0, y: 0, width: size.width, height: size.height))]
    }
    var ranges: [NSRange] = []
    var start = 0
    string.enumerateSubstrings(
      in: NSRange(location: 0, length: string.length), options: [.byParagraphs, .substringNotRequired]
    ) { _, _, enclosing, _ in
      let end = enclosing.location + enclosing.length
      if end - start >= budget {
        ranges.append(NSRange(location: start, length: end - start))
        start = end
      }
    }
    if start < string.length { ranges.append(NSRange(location: start, length: string.length - start)) }
    var result: [(NSAttributedString, CGRect)] = []
    var y: CGFloat = 0
    for (index, range) in ranges.enumerated() {
      var piece = text.attributedSubstring(from: range)
      if piece.string.hasSuffix("\n") {
        piece = piece.attributedSubstring(from: NSRange(location: 0, length: piece.length - 1))
      }
      if index > 0 { y += gap(text, at: range.location, width: width, scale: scale) }
      let size = measure(piece, width: width, scale: scale)
      result.append((piece, CGRect(x: 0, y: y, width: size.width, height: size.height)))
      y += size.height
    }
    return result
  }

  /// The space between the paragraph that ends just before `index` and the one
  /// that starts at it, as string drawing lays the two out together.
  private static func gap(_ text: NSAttributedString, at index: Int, width: CGFloat, scale: CGFloat) -> CGFloat {
    guard index >= 2, index < text.length else { return 0 }
    let before = text.attributedSubstring(from: NSRange(location: index - 2, length: 1))
    let after = text.attributedSubstring(from: NSRange(location: index, length: 1))
    let joined = NSMutableAttributedString(attributedString: before)
    joined.append(text.attributedSubstring(from: NSRange(location: index - 1, length: 1)))
    joined.append(after)
    let both = measure(joined, width: width, scale: scale).height
    return max(0, both - measure(before, width: width, scale: scale).height - measure(after, width: width, scale: scale).height)
  }

  /// One line's height in a font, as string drawing lays it out.
  static func lineHeight(_ font: UIFont, scale: CGFloat) -> CGFloat {
    ceil(font.lineHeight * scale) / scale
  }
}
