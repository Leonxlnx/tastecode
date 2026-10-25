import IOSurface
import UIKit

/// What a transcript's views ask of the screen that holds them.
@MainActor
protocol TranscriptContext: AnyObject {
  func image(for key: String) -> UIImage?
  /// Whether a picture could not be had, so a row stops waiting for it.
  func imageMissing(_ key: String) -> Bool
  /// Fetches a picture a row shows; the row is laid out again when it arrives.
  func loadImage(_ image: ImageLayout)
  func openImage(_ image: UIImage)
  func openLink(_ url: URL)
  /// Opens or shuts a row's fold, or one run or step inside it.
  func toggle(row: String, part: String?)
  func retryOpen()
}

/// Text as laid out off the main thread, shown as a picture `TextRenderer`
/// drew in the background. The same string drawing measured it, so it fills
/// its frame exactly. Only text that must appear in this very frame is drawn
/// on the main thread; text that changes keeps its last picture until the
/// next is ready.
final class TextBlockView: UIView {
  var text: NSAttributedString? {
    didSet {
      guard text !== oldValue else { return }
      if let text, let oldValue, text.isEqual(to: oldValue) {
        // Laid out again with the same words and look: what is drawn stays.
        self.text = oldValue
        return
      }
      accessibilityLabel = text?.string
      setNeedsLayout()
    }
  }
  private var shown: TextImageKey?
  private var pending: TextImageKey?
  private var ticket: TextRenderer.Ticket?
  private var urgent = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    // A frame that grew keeps the last picture at its top until the next is drawn.
    contentMode = .topLeft
    clipsToBounds = true
    isAccessibilityElement = true
    accessibilityTraits = .staticText
    registerForTraitChanges([
      UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self, UITraitDisplayScale.self,
    ]) { (view: TextBlockView, _: UITraitCollection) in
      // Drawn again at once, so it changes together with everything around it.
      view.urgent = true
      view.setNeedsLayout()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { setNeedsLayout() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    refresh()
  }

  /// Forgets what it showed, before it is taken up for other text.
  func clear() {
    text = nil
    ticket?.cancel()
    ticket = nil
    pending = nil
    shown = nil
    layer.contents = nil
  }

  private func refresh() {
    let now = urgent
    urgent = false
    guard window != nil else { return }
    guard let text, text.length > 0, bounds.width > 0, bounds.height > 0 else {
      if shown != nil { clear() }
      return
    }
    let key = TextImageKey(text: text, size: bounds.size, traits: traitCollection)
    guard key != shown, now || key != pending else { return }
    let renderer = TextRenderer.shared
    if let image = renderer.cached(key) { return show(image, key) }
    if (shown == nil || now) && onScreen { return show(renderer.renderNow(key), key) }
    ticket?.cancel()
    let ticket = TextRenderer.Ticket()
    self.ticket = ticket
    pending = key
    renderer.render(key, keep: shown == nil, ticket: ticket) { [weak self] image in
      guard let self, self.pending == key else { return }
      self.show(image, key)
    }
  }

  private func show(_ image: IOSurface?, _ key: TextImageKey) {
    if pending != key { ticket?.cancel() }
    ticket = nil
    pending = nil
    shown = key
    layer.contentsScale = key.scale
    layer.contents = image
  }

  /// Whether any of it is inside the window, so it cannot wait for the background.
  private var onScreen: Bool {
    guard let window, !isHidden else { return false }
    return convert(bounds, to: window).intersects(window.bounds)
  }

  /// The link under a point, laid out the same way the text was drawn.
  func link(at point: CGPoint) -> URL? {
    guard let text, text.length > 0, bounds.contains(point) else { return nil }
    var hasLink = false
    text.enumerateAttribute(.transcriptLink, in: NSRange(location: 0, length: text.length)) { value, _, stop in
      if value != nil {
        hasLink = true
        stop.pointee = true
      }
    }
    guard hasLink else { return nil }
    let storage = NSTextStorage(attributedString: text)
    let manager = NSLayoutManager()
    manager.usesFontLeading = true
    let container = NSTextContainer(size: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
    let glyph = manager.glyphIndex(for: point, in: container)
    let rect = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
    guard rect.insetBy(dx: -6, dy: -6).contains(point) else { return nil }
    return text.attribute(.transcriptLink, at: manager.characterIndexForGlyph(at: glyph), effectiveRange: nil) as? URL
  }
}

/// A reply's blocks, each placed where its layout says. Only blocks near the
/// screen have views: a long reply costs what is in view, not its length.
/// Views are kept per block, so a streaming reply redraws only the block that grew.
final class DocumentView: UIView {
  weak var context: TranscriptContext?
  /// The part of the reply on screen, in its own coordinates; infinite shows
  /// every block, as VoiceOver needs to read past the screen.
  var onScreen: CGRect = .infinite {
    didSet { if onScreen != oldValue { realize(reconfigure: false) } }
  }
  private var doc = DocLayout.empty
  private var views: [Int: UIView] = [:]
  private var spare: [ObjectIdentifier: [UIView]] = [:]
  /// How far past the screen blocks are kept ready, so a scroll finds them drawn.
  private static let margin: CGFloat = 500

  override init(frame: CGRect) {
    super.init(frame: frame)
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    tap.cancelsTouchesInView = false
    addGestureRecognizer(tap)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func apply(_ doc: DocLayout) {
    self.doc = doc
    realize(reconfigure: true)
  }

  private func realize(reconfigure: Bool) {
    let region =
      onScreen.isInfinite || UIAccessibility.isVoiceOverRunning ? nil : onScreen.insetBy(dx: 0, dy: -Self.margin)
    for (index, block) in doc.blocks.enumerated() {
      guard region.map({ block.frame.intersects($0) }) ?? true else {
        if let view = views.removeValue(forKey: index) { recycle(view) }
        continue
      }
      let type = Self.type(of: block.content)
      var view = views[index]
      var fresh = false
      if let existing = view, ObjectIdentifier(Swift.type(of: existing)) != type {
        recycle(existing)
        view = nil
      }
      if view == nil {
        view = take(type, for: block.content)
        views[index] = view
        fresh = true
      }
      guard let view else { continue }
      if view.frame != block.frame { view.frame = block.frame }
      if fresh || reconfigure { configure(view, block.content) }
    }
    for index in views.keys where index >= doc.blocks.count {
      if let view = views.removeValue(forKey: index) { recycle(view) }
    }
  }

  private func configure(_ view: UIView, _ content: DocLayout.Content) {
    switch content {
    case .text(let text):
      (view as? TextBlockView)?.text = text
    case .quote(let text, let frame):
      (view as? QuoteBlockView)?.apply(text, frame: frame)
    case .code(let code):
      (view as? CodeBlockView)?.apply(code)
    case .table(let table):
      (view as? TableBlockView)?.apply(table)
    case .rule:
      break
    case .image(let image):
      (view as? ImageBlockView)?.apply(image, context: context)
    }
  }

  private static func type(of content: DocLayout.Content) -> ObjectIdentifier {
    switch content {
    case .text: return ObjectIdentifier(TextBlockView.self)
    case .quote: return ObjectIdentifier(QuoteBlockView.self)
    case .code: return ObjectIdentifier(CodeBlockView.self)
    case .table: return ObjectIdentifier(TableBlockView.self)
    case .rule: return ObjectIdentifier(RuleView.self)
    case .image: return ObjectIdentifier(ImageBlockView.self)
    }
  }

  private func take(_ type: ObjectIdentifier, for content: DocLayout.Content) -> UIView {
    if let view = spare[type]?.popLast() {
      view.isHidden = false
      return view
    }
    let view: UIView
    switch content {
    case .text: view = TextBlockView()
    case .quote: view = QuoteBlockView()
    case .code: view = CodeBlockView()
    case .table: view = TableBlockView()
    case .rule: view = RuleView()
    case .image: view = ImageBlockView()
    }
    addSubview(view)
    return view
  }

  /// Kept hidden for the next block of its kind: hidden views are not drawn.
  private func recycle(_ view: UIView) {
    Self.clearText(view)
    let type = ObjectIdentifier(Swift.type(of: view))
    if spare[type, default: []].count < 6 {
      view.isHidden = true
      spare[type, default: []].append(view)
    } else {
      view.removeFromSuperview()
    }
  }

  /// So a block taken up again never shows the text it held before.
  private static func clearText(_ view: UIView) {
    if let text = view as? TextBlockView { return text.clear() }
    for subview in view.subviews { clearText(subview) }
  }

  /// The text of a reply's blocks within a region, at the sizes it is drawn,
  /// to draw ahead of a scroll.
  static func texts(in doc: DocLayout, within region: CGRect) -> [(text: NSAttributedString, size: CGSize)] {
    var result: [(text: NSAttributedString, size: CGSize)] = []
    for block in doc.blocks where block.frame.intersects(region) {
      switch block.content {
      case .text(let text): result.append((text, block.frame.size))
      case .quote(let text, let frame): result.append((text, frame.size))
      case .code(let code): result += code.chunks.map { ($0.text, $0.frame.size) }
      case .table(let table): result += table.cells.map { ($0.text, $0.frame.size) }
      case .rule, .image: break
      }
    }
    return result
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: self)
    for view in views.values where view.frame.contains(point) {
      let texts: [TextBlockView]
      if let text = view as? TextBlockView {
        texts = [text]
      } else {
        texts = view.subviews.compactMap { $0 as? TextBlockView }
      }
      for text in texts {
        if let url = text.link(at: gesture.location(in: text)) {
          context?.openLink(url)
          return
        }
      }
    }
  }

  /// The reply as text to select or copy: its words, code and tables, without the pictures.
  static func selectable(_ doc: DocLayout) -> NSAttributedString {
    let result = NSMutableAttributedString()
    let gap = NSAttributedString(string: "\n\n")
    for block in doc.blocks {
      let piece: NSAttributedString?
      switch block.content {
      case .text(let text), .quote(let text, _): piece = text
      case .code(let code):
        piece = NSAttributedString(
          string: code.code, attributes: code.chunks.first.map { $0.text.attributes(at: 0, effectiveRange: nil) } ?? [:])
      case .table(let table):
        let joined = NSMutableAttributedString()
        for (index, cell) in table.cells.enumerated() {
          if index > 0 { joined.append(NSAttributedString(string: "\t")) }
          joined.append(cell.text)
        }
        piece = joined
      case .rule, .image: piece = nil
      }
      guard let piece else { continue }
      if result.length > 0 { result.append(gap) }
      result.append(piece)
    }
    return result
  }
}

final class QuoteBlockView: UIView {
  private let bar = UIView()
  private let text = TextBlockView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    bar.backgroundColor = .quaternaryLabel
    bar.layer.cornerRadius = 1.5
    addSubview(bar)
    addSubview(text)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func apply(_ value: NSAttributedString, frame: CGRect) {
    text.text = value
    text.frame = frame
    bar.frame = CGRect(x: 0, y: 0, width: 3, height: frame.height)
  }
}

final class RuleView: UIView {
  private let line = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    line.backgroundColor = .separator
    addSubview(line)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    let pixel = 1 / max(traitCollection.displayScale, 1)
    line.frame = CGRect(x: 0, y: 4, width: bounds.width, height: pixel)
  }
}

/// A code block: its lines on a faint fill, scrolling sideways when wide, with
/// a copy button at the edge.
final class CodeBlockView: UIView {
  private let scroll = UIScrollView()
  private var chunks: [TextBlockView] = []
  private let copy = UIButton(type: .system)
  private var code = ""
  private var language = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .quaternarySystemFill
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    clipsToBounds = true
    scroll.showsHorizontalScrollIndicator = false
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceHorizontal = false
    scroll.isDirectionalLockEnabled = true
    addSubview(scroll)
    copy.setImage(UIImage(systemName: "square.on.square"), for: .normal)
    copy.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(textStyle: .footnote), forImageIn: .normal)
    copy.tintColor = .tertiaryLabel
    copy.addTarget(self, action: #selector(copyCode), for: .touchUpInside)
    addSubview(copy)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func apply(_ layout: CodeLayout) {
    code = layout.code
    language = layout.language
    copy.accessibilityLabel = "Copy \(language.isEmpty ? "code" : language)"
    let inset = CodeLayout.inset
    while chunks.count < layout.chunks.count {
      let view = TextBlockView()
      chunks.append(view)
      scroll.addSubview(view)
    }
    while chunks.count > layout.chunks.count {
      chunks.removeLast().removeFromSuperview()
    }
    for (view, chunk) in zip(chunks, layout.chunks) {
      view.text = chunk.text
      let frame = chunk.frame.offsetBy(dx: inset.left, dy: inset.top)
      if view.frame != frame { view.frame = frame }
    }
    scroll.contentSize = CGSize(
      width: layout.content.width + inset.left + inset.right, height: layout.content.height + inset.top + inset.bottom)
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let button = CodeLayout.button
    scroll.frame = CGRect(x: 0, y: 0, width: bounds.width - button, height: bounds.height)
    copy.frame = CGRect(x: bounds.width - button, y: 0, width: button, height: button)
  }

  @objc private func copyCode() {
    UIPasteboard.general.string = code
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    copy.setImage(UIImage(systemName: "checkmark"), for: .normal)
    copy.accessibilityLabel = "Copied"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
      guard let self else { return }
      self.copy.setImage(UIImage(systemName: "square.on.square"), for: .normal)
      self.copy.accessibilityLabel = "Copy \(self.language.isEmpty ? "code" : self.language)"
    }
  }
}

/// A table on a faint fill, its header over a hairline, scrolling sideways when wide.
final class TableBlockView: UIView {
  private let scroll = UIScrollView()
  private var cells: [TextBlockView] = []
  private let divider = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .quaternarySystemFill
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    clipsToBounds = true
    scroll.showsHorizontalScrollIndicator = false
    scroll.isDirectionalLockEnabled = true
    addSubview(scroll)
    divider.backgroundColor = .separator
    scroll.addSubview(divider)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func apply(_ layout: TableLayout) {
    while cells.count < layout.cells.count {
      let view = TextBlockView()
      cells.append(view)
      scroll.addSubview(view)
    }
    while cells.count > layout.cells.count {
      cells.removeLast().removeFromSuperview()
    }
    for (view, cell) in zip(cells, layout.cells) {
      view.text = cell.text
      if view.frame != cell.frame { view.frame = cell.frame }
    }
    divider.frame = layout.divider
    scroll.contentSize = layout.content
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scroll.frame = bounds
  }
}

/// A picture a reply shows: a spinner on a quiet fill while it is fetched,
/// then the picture on a hairline, which a tap opens whole.
final class ImageBlockView: UIView {
  private let picture = UIImageView()
  private let placeholder = UIView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let icon = UIImageView(image: UIImage(systemName: "photo"))
  private let label = TextBlockView()
  private weak var context: TranscriptContext?
  private var layout: ImageLayout?

  override init(frame: CGRect) {
    super.init(frame: frame)
    picture.contentMode = .scaleAspectFill
    picture.clipsToBounds = true
    picture.layer.cornerRadius = 14
    picture.layer.cornerCurve = .continuous
    picture.layer.borderWidth = 0.5
    picture.isUserInteractionEnabled = true
    picture.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    placeholder.backgroundColor = .secondarySystemBackground
    placeholder.layer.cornerRadius = 14
    placeholder.layer.cornerCurve = .continuous
    spinner.hidesWhenStopped = true
    icon.tintColor = .secondaryLabel
    icon.contentMode = .scaleAspectFit
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
    [placeholder, spinner, picture, icon, label].forEach(addSubview)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: ImageBlockView, _: UITraitCollection) in
      view.updateBorder()
    }
    updateBorder()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func apply(_ layout: ImageLayout, context: TranscriptContext?) {
    self.layout = layout
    self.context = context
    accessibilityLabel = layout.alt.isEmpty ? "Picture" : layout.alt
    isAccessibilityElement = true
    switch layout.state {
    case .loaded:
      let image = context?.image(for: layout.key)
      if picture.image !== image {
        picture.image = image
        if image != nil, picture.alpha == 0 {
          UIView.animate(withDuration: 0.25) { self.picture.alpha = 1 }
        }
      }
      picture.frame = layout.frame
      picture.isHidden = false
      placeholder.isHidden = true
      spinner.stopAnimating()
      icon.isHidden = true
      label.isHidden = true
      accessibilityTraits = [.image, .button]
    case .loading:
      picture.isHidden = true
      picture.image = nil
      picture.alpha = 0
      placeholder.isHidden = false
      placeholder.frame = layout.frame
      spinner.center = CGPoint(x: layout.frame.midX, y: layout.frame.midY)
      spinner.startAnimating()
      icon.isHidden = true
      label.isHidden = true
      accessibilityTraits = .image
      context?.loadImage(layout)
    case .missing:
      picture.isHidden = true
      placeholder.isHidden = true
      spinner.stopAnimating()
      icon.isHidden = false
      label.isHidden = false
      label.text = layout.label
      label.frame = layout.frame
      icon.frame = CGRect(x: 0, y: layout.frame.minY, width: 20, height: max(layout.frame.height, 18))
      accessibilityTraits = .staticText
    }
  }

  private func updateBorder() {
    picture.layer.borderColor = UIColor.quaternaryLabel.resolvedColor(with: traitCollection).cgColor
  }

  @objc private func open() {
    guard let image = picture.image else { return }
    context?.openImage(image)
  }
}
