import UIKit

/// A transcript row. It places what its layout says at the frames it says,
/// with no constraints and no measuring of its own.
class TranscriptCell: UICollectionViewCell {
  weak var context: TranscriptContext?
  var key = ""

  func apply(_ layout: RowLayout, animated: Bool) {}

  /// Builds what is near the part of the list on screen; rows with long text override it.
  func reveal(_ visible: CGRect, in list: UIView) {}
}

final class AssistantCell: TranscriptCell {
  private let document = DocumentView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(document)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    // Nothing is built until the list says which part of the reply is on screen.
    document.onScreen = .zero
  }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .assistant(let doc) = layout.content else { return }
    document.context = context
    document.frame = CGRect(x: 0, y: 0, width: doc.width, height: doc.height)
    document.apply(doc)
  }

  override func reveal(_ visible: CGRect, in list: UIView) {
    document.onScreen = document.convert(visible, from: list)
  }
}

/// What you sent: right-aligned on a quiet fill, with the pictures above it.
final class UserCell: TranscriptCell {
  private let bubble = UIView()
  private let text = DocumentView()
  private var thumbs: [AttachmentThumb] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    bubble.backgroundColor = .secondarySystemBackground
    bubble.layer.cornerRadius = 20
    bubble.layer.cornerCurve = .continuous
    bubble.addSubview(text)
    contentView.addSubview(bubble)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    text.onScreen = .zero
  }

  override func reveal(_ visible: CGRect, in list: UIView) {
    text.onScreen = text.convert(visible, from: list)
  }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .user(let user) = layout.content else { return }
    bubble.isHidden = user.text == nil
    bubble.frame = user.bubble
    text.frame = CGRect(origin: .zero, size: user.bubble.size).inset(by: UserLayout.padding)
    text.apply(user.doc)
    while thumbs.count < user.attachments.count {
      let thumb = AttachmentThumb()
      thumbs.append(thumb)
      contentView.addSubview(thumb)
    }
    while thumbs.count > user.attachments.count {
      thumbs.removeLast().removeFromSuperview()
    }
    for (thumb, attachment) in zip(thumbs, user.attachments) {
      thumb.frame = attachment.frame
      thumb.show(attachment.path, context: context)
    }
  }
}

/// One attached picture, read from the computer the first time it shows; a tap opens it whole.
final class AttachmentThumb: UIView {
  private let picture = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let icon = UIImageView(image: UIImage(systemName: "photo"))
  private weak var context: TranscriptContext?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .secondarySystemBackground
    layer.cornerRadius = 16
    layer.cornerCurve = .continuous
    clipsToBounds = true
    picture.contentMode = .scaleAspectFill
    icon.tintColor = .tertiaryLabel
    icon.contentMode = .center
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
    [picture, spinner, icon].forEach(addSubview)
    isAccessibilityElement = true
    accessibilityLabel = "Attached picture"
    accessibilityTraits = [.image, .button]
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(_ path: String, context: TranscriptContext?) {
    self.context = context
    let image = context?.image(for: path)
    picture.image = image
    picture.isHidden = image == nil
    let missing = image == nil && context?.imageMissing(path) == true
    icon.isHidden = !missing
    if image == nil && !missing {
      spinner.startAnimating()
      context?.loadImage(ImageLayout(key: path, source: path, alt: "", state: .loading, frame: .zero, label: nil))
    } else {
      spinner.stopAnimating()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picture.frame = bounds
    icon.frame = bounds
    spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
  }

  @objc private func open() {
    guard let image = picture.image else { return }
    context?.openImage(image)
  }
}

/// The agent's work between messages, folded into one line until you open it.
final class StepsCell: TranscriptCell {
  private let header = UIView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let failed = UIImageView(image: UIImage(systemName: "exclamationmark.circle"))
  private let summary = UILabel()
  private let duration = UILabel()
  private let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
  private let divider = UIView()
  private var pieces: [String: UIView] = [:]
  private var shown: StepsLayout?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    contentView.clipsToBounds = true
    spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
    spinner.hidesWhenStopped = true
    failed.tintColor = .systemRed
    failed.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
    summary.textColor = .secondaryLabel
    summary.font = .preferredFont(forTextStyle: .subheadline)
    summary.adjustsFontForContentSizeCategory = true
    duration.textColor = .tertiaryLabel
    duration.font = .monospacedDigitSystemFont(
      ofSize: UIFont.preferredFont(forTextStyle: .subheadline).pointSize, weight: .regular)
    chevron.tintColor = .tertiaryLabel
    chevron.contentMode = .center
    chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
      font: .systemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption2).pointSize, weight: .bold))
    divider.backgroundColor = .separator
    [spinner, failed, summary, duration, chevron].forEach(header.addSubview)
    contentView.addSubview(header)
    contentView.addSubview(divider)
    header.isAccessibilityElement = true
    header.accessibilityTraits = .button
    header.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggle)))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    pieces.values.forEach { $0.removeFromSuperview() }
    pieces = [:]
    shown = nil
  }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .steps(let steps) = layout.content else { return }
    let previous = shown
    shown = steps
    let width = bounds.width > 0 ? bounds.width : steps.divider?.width ?? 0
    layoutHeader(steps, width: width, previous: previous, animated: animated)
    divider.isHidden = steps.divider == nil
    if let frame = steps.divider { divider.frame = CGRect(x: 0, y: frame.minY, width: width, height: frame.height) }

    let opening = animated && previous?.expanded == false && steps.expanded
    let closing = animated && previous?.expanded == true && !steps.expanded
    guard steps.expanded || closing else {
      // A shut fold builds nothing: rows scroll past far more often than they open.
      pieces.values.forEach { $0.removeFromSuperview() }
      pieces = [:]
      return
    }
    var keep: Set<String> = []
    for placed in steps.pieces {
      keep.insert(placed.id)
      let existing = pieces[placed.id]
      let view = existing ?? makePiece(placed.piece)
      if existing == nil {
        pieces[placed.id] = view
        contentView.insertSubview(view, belowSubview: header)
        view.frame = placed.frame
        view.alpha = 0
      }
      configure(view, placed.piece)
      view.frame = placed.frame
      if closing {
        UIView.animate(withDuration: 0.18, animations: { view.alpha = 0 }) { [weak self] _ in
          // Gone once shut, unless it opened again meanwhile.
          guard let self, self.shown?.expanded == false, self.pieces[placed.id] === view else { return }
          view.removeFromSuperview()
          self.pieces[placed.id] = nil
        }
      } else if opening || (animated && existing == nil) {
        // Each run settles in a beat after the one above it.
        view.alpha = 0
        view.transform = CGAffineTransform(translationX: 0, y: -8)
        UIView.animate(
          withDuration: 0.34, delay: 0.04 + Double(placed.order) * 0.035, usingSpringWithDamping: 1,
          initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
          view.alpha = 1
          view.transform = .identity
        }
      } else {
        view.alpha = 1
        view.transform = .identity
      }
    }
    for (id, view) in pieces where !keep.contains(id) {
      pieces[id] = nil
      if animated {
        UIView.animate(withDuration: 0.16, animations: { view.alpha = 0 }) { _ in view.removeFromSuperview() }
      } else {
        view.removeFromSuperview()
      }
    }
  }

  private func layoutHeader(_ steps: StepsLayout, width: CGFloat, previous: StepsLayout?, animated: Bool) {
    header.frame = CGRect(x: 0, y: 0, width: width, height: steps.header)
    let mid = steps.header / 2
    var x: CGFloat = 0
    if steps.live {
      spinner.startAnimating()
      spinner.center = CGPoint(x: 8, y: mid)
      x = 24
    } else {
      spinner.stopAnimating()
    }
    failed.isHidden = !steps.failed || steps.live
    if !failed.isHidden {
      failed.sizeToFit()
      failed.center = CGPoint(x: failed.bounds.width / 2, y: mid)
      x = failed.bounds.width + 8
    }
    if summary.text != steps.summary {
      // The live label moves on to the next step, as the desktop's does.
      if animated || (previous != nil && steps.live) {
        UIView.transition(with: summary, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
          self.summary.text = steps.summary
        }
      } else {
        summary.text = steps.summary
      }
    }
    duration.text = steps.duration
    duration.isHidden = steps.duration == nil
    let chevronWidth: CGFloat = 12
    let durationWidth = duration.isHidden ? 0 : ceil(duration.sizeThatFits(CGSize(width: 200, height: 40)).width) + 8
    let room = max(0, width - x - durationWidth - chevronWidth - 8)
    let summaryWidth = min(ceil(summary.sizeThatFits(CGSize(width: room, height: 40)).width), room)
    summary.frame = CGRect(x: x, y: 0, width: summaryWidth, height: steps.header)
    x += summaryWidth + 8
    if !duration.isHidden {
      duration.frame = CGRect(x: x, y: 0, width: durationWidth - 8, height: steps.header)
      x += durationWidth
    }
    chevron.bounds = CGRect(x: 0, y: 0, width: chevronWidth, height: chevronWidth)
    chevron.center = CGPoint(x: x + chevronWidth / 2, y: mid)
    let turn = steps.expanded ? CGAffineTransform(rotationAngle: .pi / 2) : .identity
    if animated {
      UIView.animate(withDuration: 0.3) { self.chevron.transform = turn }
    } else {
      chevron.transform = turn
    }
    header.accessibilityLabel = [steps.summary, steps.duration].compactMap { $0 }.joined(separator: ", ")
    header.accessibilityValue = steps.expanded ? "Open" : "Closed"
  }

  private func makePiece(_ piece: StepsLayout.Piece) -> UIView {
    switch piece {
    case .batch, .line: return StepLineView()
    case .text: return TextBlockView()
    case .note: return DocumentView()
    }
  }

  private func configure(_ view: UIView, _ piece: StepsLayout.Piece) {
    switch piece {
    case .batch(let id, let summary, let symbol, let failed, let open):
      (view as? StepLineView)?.show(
        title: summary, symbol: symbol, failed: failed, running: false, counts: nil, chevron: .down(open: open)
      ) { [weak self] in
        guard let self else { return }
        self.context?.toggle(row: self.key, part: id)
      }
    case .line(let id, let title, let symbol, let failed, let running, let counts, let opens, let open):
      (view as? StepLineView)?.show(
        title: title, symbol: symbol, failed: failed, running: running, counts: counts,
        chevron: opens ? .right(open: open) : nil
      ) { [weak self] in
        guard let self, opens else { return }
        self.context?.toggle(row: self.key, part: "step:\(id)")
      }
    case .text(let text):
      (view as? TextBlockView)?.text = text
    case .note(let doc):
      guard let document = view as? DocumentView else { return }
      document.context = context
      document.apply(doc)
    }
  }

  @objc private func toggle() {
    context?.toggle(row: key, part: nil)
  }
}

/// One step on one line: its icon, what it did, and at the edge a spinner,
/// its line counts or a chevron when there is more to open.
final class StepLineView: UIView {
  enum Chevron { case down(open: Bool), right(open: Bool) }

  private let icon = UIImageView()
  private let title = UILabel()
  private let trailing = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let chevron = UIImageView()
  private var action: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    icon.contentMode = .center
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
    title.font = .preferredFont(forTextStyle: .subheadline)
    title.textColor = .secondaryLabel
    trailing.font = .monospacedDigitSystemFont(
      ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular)
    spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
    spinner.hidesWhenStopped = true
    chevron.tintColor = .tertiaryLabel
    chevron.contentMode = .center
    chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
    [icon, title, trailing, spinner, chevron].forEach(addSubview)
    isAccessibilityElement = true
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(
    title text: String, symbol: String, failed: Bool, running: Bool, counts: (Int, Int)?, chevron kind: Chevron?,
    action: @escaping () -> Void
  ) {
    self.action = action
    icon.image = UIImage(systemName: symbol)
    icon.tintColor = failed ? .systemRed : .tertiaryLabel
    title.text = text
    if running {
      spinner.startAnimating()
      trailing.isHidden = true
    } else {
      spinner.stopAnimating()
      if let (added, removed) = counts {
        trailing.attributedText = Self.counts(added: added, removed: removed)
        trailing.isHidden = false
      } else {
        trailing.isHidden = true
      }
    }
    switch kind {
    case .down(let open):
      chevron.isHidden = false
      chevron.image = UIImage(systemName: "chevron.down")
      rotate(open ? .pi : 0)
    case .right(let open):
      chevron.isHidden = false
      chevron.image = UIImage(systemName: "chevron.right")
      rotate(open ? .pi / 2 : 0)
    case nil:
      chevron.isHidden = true
    }
    accessibilityLabel = text
    accessibilityTraits = kind == nil ? .staticText : .button
    setNeedsLayout()
  }

  private func rotate(_ angle: CGFloat) {
    let turn = CGAffineTransform(rotationAngle: angle)
    guard chevron.transform != turn else { return }
    if window != nil {
      UIView.animate(withDuration: 0.25) { self.chevron.transform = turn }
    } else {
      chevron.transform = turn
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let mid = bounds.height / 2
    icon.frame = CGRect(x: 0, y: 0, width: 18, height: bounds.height)
    var right = bounds.width
    if !chevron.isHidden {
      chevron.bounds = CGRect(x: 0, y: 0, width: 12, height: 12)
      chevron.center = CGPoint(x: right - 6, y: mid)
      right -= 12 + 8
    }
    if spinner.isAnimating {
      spinner.center = CGPoint(x: right - 8, y: mid)
      right -= 16 + 8
    } else if !trailing.isHidden {
      let width = ceil(trailing.sizeThatFits(bounds.size).width)
      trailing.frame = CGRect(x: right - width, y: 0, width: width, height: bounds.height)
      right -= width + 8
    }
    title.frame = CGRect(x: 28, y: 0, width: max(0, right - 28), height: bounds.height)
  }

  /// "+12 −3", green and red: the one place a change's size is coloured.
  static func counts(added: Int, removed: Int) -> NSAttributedString {
    let result = NSMutableAttributedString()
    if added > 0 || removed == 0 {
      result.append(NSAttributedString(string: "+\(added)", attributes: [.foregroundColor: UIColor.systemGreen]))
    }
    if removed > 0 {
      if result.length > 0 { result.append(NSAttributedString(string: " ")) }
      result.append(NSAttributedString(string: "−\(removed)", attributes: [.foregroundColor: UIColor.systemRed]))
    }
    return result
  }

  @objc private func tapped() {
    action?()
  }
}

final class NoticeCell: TranscriptCell {
  private let text = TextBlockView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(text)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .notice(let value) = layout.content else { return }
    text.text = value
    text.frame = CGRect(x: 0, y: 0, width: bounds.width, height: layout.height)
  }
}

final class ErrorCell: TranscriptCell {
  private let icon = UIImageView(image: UIImage(systemName: "exclamationmark.triangle.fill"))
  private let text = TextBlockView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    icon.tintColor = .systemRed
    icon.contentMode = .center
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
    contentView.addSubview(icon)
    contentView.addSubview(text)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .error(let value, let frame) = layout.content else { return }
    text.text = value
    text.frame = frame
    let line = (value.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.lineHeight ?? 18
    icon.frame = CGRect(x: 0, y: 0, width: 18, height: ceil(line))
  }
}

final class WorkingCell: TranscriptCell {
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let text = TextBlockView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
    contentView.addSubview(spinner)
    contentView.addSubview(text)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .working(let value) = layout.content else { return }
    spinner.startAnimating()
    spinner.center = CGPoint(x: 8, y: layout.height / 2)
    text.text = value
    let line = (value.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.lineHeight ?? 18
    text.frame = CGRect(x: 24, y: (layout.height - ceil(line)) / 2, width: 200, height: ceil(line))
  }
}

/// The agent's plan for the turn under way, ticked off as it goes.
final class PlanCell: TranscriptCell {
  private let title = TextBlockView()
  private var rows: [(icon: UIImageView, text: TextBlockView)] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(title)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .plan(let plan) = layout.content else { return }
    title.text = plan.title
    title.frame = CGRect(x: 0, y: 0, width: bounds.width, height: plan.lineHeight)
    while rows.count < plan.items.count {
      let icon = UIImageView()
      icon.contentMode = .center
      icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
      let text = TextBlockView()
      contentView.addSubview(icon)
      contentView.addSubview(text)
      rows.append((icon, text))
    }
    while rows.count > plan.items.count {
      let row = rows.removeLast()
      row.icon.removeFromSuperview()
      row.text.removeFromSuperview()
    }
    for (row, item) in zip(rows, plan.items) {
      let symbol = item.status == "done" ? "checkmark.circle.fill" : item.status == "running" ? "circle.dotted" : "circle"
      if row.icon.image != UIImage(systemName: symbol) { row.icon.image = UIImage(systemName: symbol) }
      row.icon.tintColor = item.status == "pending" ? .tertiaryLabel : .label
      row.icon.frame = CGRect(x: 0, y: item.frame.minY, width: 18, height: plan.lineHeight)
      if item.status == "running" {
        row.icon.addSymbolEffect(.rotate, options: .repeat(.continuous))
      } else {
        row.icon.removeAllSymbolEffects()
      }
      row.text.text = item.text
      row.text.frame = item.frame
    }
  }
}

final class OlderCell: TranscriptCell {
  private let spinner = UIActivityIndicatorView(style: .medium)

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(spinner)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .older(let loading) = layout.content else { return }
    spinner.startAnimating()
    spinner.alpha = loading ? 1 : 0.4
    spinner.center = CGPoint(x: bounds.width / 2, y: layout.height / 2)
  }
}

final class PlaceholderCell: TranscriptCell {
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let message = TextBlockView()
  private let retry = UIButton(configuration: .glass())

  override init(frame: CGRect) {
    super.init(frame: frame)
    var configuration = UIButton.Configuration.glass()
    configuration.title = "Try Again"
    retry.configuration = configuration
    retry.addTarget(self, action: #selector(tryAgain), for: .touchUpInside)
    [spinner, message, retry].forEach(contentView.addSubview)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func apply(_ layout: RowLayout, animated: Bool) {
    guard case .placeholder(let placeholder) = layout.content else { return }
    let width = bounds.width
    if placeholder.loading {
      spinner.startAnimating()
      spinner.center = CGPoint(x: width / 2, y: 130)
      message.isHidden = true
      retry.isHidden = true
    } else {
      spinner.stopAnimating()
      message.isHidden = false
      retry.isHidden = false
      message.text = placeholder.message
      message.frame = placeholder.messageFrame
      let size = retry.sizeThatFits(CGSize(width: width, height: 44))
      retry.frame = CGRect(x: (width - size.width) / 2, y: placeholder.buttonY, width: size.width, height: max(size.height, 36))
    }
  }

  @objc private func tryAgain() {
    context?.retryOpen()
  }
}
