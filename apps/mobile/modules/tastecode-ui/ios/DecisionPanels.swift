import UIKit

/// A permission the agent waits for, in place of the composer: what it wants
/// to do, in its own words, and the two answers. It sits on the bar's glass.
final class ApprovalPanelView: UIView {
  private let model = AppModel.shared
  private let threadId: String
  private let request: ApprovalView
  weak var host: UIViewController?

  private let title = UILabel()
  private let stop = UIButton(type: .system)
  private let subject = UILabel()
  private let reason = UILabel()
  private let place = UILabel()
  private let deny = UIButton(configuration: .glass())
  private let allow = UIButton(configuration: .prominentGlass())
  private let always = UIButton(type: .system)
  private var busy = false {
    didSet { refreshButtons() }
  }

  init(threadId: String, request: ApprovalView) {
    self.threadId = threadId
    self.request = request
    super.init(frame: .zero)
    build()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
      UITraitUserInterfaceStyle.self,
    ]) { (panel: ApprovalPanelView, _: UITraitCollection) in
      panel.applyFonts()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func build() {
    title.text = request.title
    title.numberOfLines = 0
    title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    stop.setTitle("Stop", for: .normal)
    stop.tintColor = .secondaryLabel
    stop.setContentHuggingPriority(.required, for: .horizontal)
    stop.setContentCompressionResistancePriority(.required, for: .horizontal)
    stop.addAction(UIAction { [weak self] _ in self?.decide("abort") }, for: .touchUpInside)
    let header = UIStackView(arrangedSubviews: [title, stop])
    header.axis = .horizontal
    header.alignment = .firstBaseline
    header.spacing = 8

    var rows: [UIView] = [header]
    if let text = request.subject {
      subject.text = text
      subject.numberOfLines = 6
      subject.textColor = .label
      let scroller = UIScrollView()
      scroller.showsHorizontalScrollIndicator = false
      scroller.alwaysBounceHorizontal = false
      subject.translatesAutoresizingMaskIntoConstraints = false
      scroller.addSubview(subject)
      NSLayoutConstraint.activate([
        subject.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor, constant: 12),
        subject.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor, constant: -12),
        subject.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor, constant: 10),
        subject.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor, constant: -10),
        scroller.frameLayoutGuide.heightAnchor.constraint(equalTo: scroller.contentLayoutGuide.heightAnchor),
      ])
      scroller.backgroundColor = .tertiarySystemFill
      scroller.layer.cornerRadius = 14
      scroller.layer.cornerCurve = .continuous
      rows.append(scroller)
    }
    if let text = request.reason {
      reason.text = text
      reason.numberOfLines = 4
      reason.textColor = .secondaryLabel
      rows.append(reason)
    }
    if let text = request.where {
      place.text = "In \(text)"
      place.textColor = .tertiaryLabel
      place.lineBreakMode = .byTruncatingMiddle
      rows.append(place)
    }

    deny.addAction(UIAction { [weak self] _ in self?.decide("deny") }, for: .touchUpInside)
    allow.addAction(UIAction { [weak self] _ in self?.decide("approve") }, for: .touchUpInside)
    let answers = UIStackView(arrangedSubviews: [deny, allow])
    answers.axis = .horizontal
    answers.spacing = 10
    answers.distribution = .fillEqually
    rows.append(answers)

    always.setTitle("Always allow in this chat", for: .normal)
    always.tintColor = .secondaryLabel
    always.addAction(UIAction { [weak self] _ in self?.decide("approve-session") }, for: .touchUpInside)
    rows.append(always)

    let column = UIStackView(arrangedSubviews: rows)
    column.axis = .vertical
    column.spacing = 12
    column.setCustomSpacing(14, after: rows[rows.count - 3])
    addPinned(column, insets: UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16))
    applyFonts()
  }

  private func applyFonts() {
    let traits = traitCollection
    title.font = .app(.headline, traits: traits)
    stop.titleLabel?.font = .app(.subheadline, traits: traits)
    subject.font = UIFont.monospacedSystemFont(
      ofSize: UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits).pointSize, weight: .regular)
    reason.font = .app(.subheadline, traits: traits)
    place.font = .app(.footnote, traits: traits)
    always.titleLabel?.font = .app(.footnote, traits: traits)
    refreshButtons()
  }

  private func refreshButtons() {
    let traits = traitCollection
    deny.configuration?.buttonSize = .large
    deny.configuration?.attributedTitle = AttributedString(
      "Deny", attributes: AttributeContainer([.font: UIFont.app(.body, traits: traits)]))
    deny.configuration?.baseForegroundColor = .label
    allow.showAnswer("Allow", ready: !busy, traits: traits)
    for button in [stop, deny, always] { button.isEnabled = !busy }
  }

  private func decide(_ decision: String) {
    busy = true
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    Task {
      do {
        _ = try await model.request([
          "type": "thread.decide", "threadId": threadId, "approvalId": request.id, "decision": decision,
        ])
      } catch {
        host?.showProblem(error.localizedDescription)
        busy = false
      }
    }
  }
}

/// The agent's questions, one at a time, answered where the composer was.
final class QuestionPanelView: UIView, UITextViewDelegate, UITextFieldDelegate {
  private let model = AppModel.shared
  private let threadId: String
  private let request: QuestionsView
  weak var host: UIViewController?
  /// Asks the bar to take the panel's new height on its glass.
  var onResize: () -> Void = {}

  private var index = 0
  private var chosen: [String: [String]] = [:]
  private var typed: [String: String] = [:]
  private var busy = false

  private let header = UILabel()
  private let counter = UILabel()
  private let question = UILabel()
  private let options = UIScrollView()
  private let optionList = UIStackView()
  private var optionsHeight: NSLayoutConstraint!
  /// The same glass as the buttons under it, so the field and they read as one set.
  private let answerBox = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
  private let answerText = UITextView()
  private let answerSecret = UITextField()
  private let answerPlaceholder = UILabel()
  private var answerHeight: NSLayoutConstraint!
  /// Above and below the typed text, so one line sits in the middle of a button-high field.
  private var answerInsets: [NSLayoutConstraint] = []
  private var fieldRadius: CGFloat = 0
  private let backButton = UIButton(configuration: .glass())
  private let nextButton = UIButton(configuration: .prominentGlass())

  init(threadId: String, request: QuestionsView) {
    self.threadId = threadId
    self.request = request
    super.init(frame: .zero)
    build()
    show()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
      UITraitUserInterfaceStyle.self,
    ]) { (panel: QuestionPanelView, _: UITraitCollection) in
      panel.show()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private var current: QuestionView { request.questions[min(index, request.questions.count - 1)] }
  private var last: Bool { index >= request.questions.count - 1 }

  private func build() {
    header.textColor = .secondaryLabel
    header.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    counter.textColor = .tertiaryLabel
    counter.setContentHuggingPriority(.required, for: .horizontal)
    let top = UIStackView(arrangedSubviews: [header, counter])
    top.axis = .horizontal
    top.alignment = .firstBaseline
    top.spacing = 8
    question.numberOfLines = 0

    optionList.axis = .vertical
    optionList.translatesAutoresizingMaskIntoConstraints = false
    options.addSubview(optionList)
    options.alwaysBounceVertical = false
    optionsHeight = options.heightAnchor.constraint(equalToConstant: 1)
    NSLayoutConstraint.activate([
      optionList.leadingAnchor.constraint(equalTo: options.contentLayoutGuide.leadingAnchor),
      optionList.trailingAnchor.constraint(equalTo: options.contentLayoutGuide.trailingAnchor),
      optionList.topAnchor.constraint(equalTo: options.contentLayoutGuide.topAnchor),
      optionList.bottomAnchor.constraint(equalTo: options.contentLayoutGuide.bottomAnchor),
      optionList.widthAnchor.constraint(equalTo: options.frameLayoutGuide.widthAnchor),
      optionsHeight,
    ])

    answerText.backgroundColor = .clear
    answerText.textContainerInset = .zero
    answerText.textContainer.lineFragmentPadding = 0
    answerText.isScrollEnabled = false
    answerText.delegate = self
    answerPlaceholder.textColor = .placeholderText
    answerPlaceholder.isUserInteractionEnabled = false
    answerSecret.isSecureTextEntry = true
    answerSecret.delegate = self
    answerSecret.addAction(UIAction { [weak self] _ in self?.secretChanged() }, for: .editingChanged)
    for field in [answerText, answerSecret] as [UIView] {
      field.translatesAutoresizingMaskIntoConstraints = false
      answerBox.contentView.addSubview(field)
      let top = field.topAnchor.constraint(equalTo: answerBox.contentView.topAnchor, constant: 10)
      let bottom = answerBox.contentView.bottomAnchor.constraint(equalTo: field.bottomAnchor, constant: 10)
      answerInsets += [top, bottom]
      NSLayoutConstraint.activate([
        top, bottom,
        field.leadingAnchor.constraint(equalTo: answerBox.contentView.leadingAnchor, constant: 18),
        field.trailingAnchor.constraint(equalTo: answerBox.contentView.trailingAnchor, constant: -18),
      ])
    }
    answerPlaceholder.translatesAutoresizingMaskIntoConstraints = false
    answerBox.contentView.addSubview(answerPlaceholder)
    answerHeight = answerText.heightAnchor.constraint(equalToConstant: 22)
    NSLayoutConstraint.activate([
      answerHeight,
      answerPlaceholder.leadingAnchor.constraint(equalTo: answerText.leadingAnchor),
      answerPlaceholder.topAnchor.constraint(equalTo: answerText.topAnchor),
    ])

    backButton.addAction(UIAction { [weak self] _ in self?.go(by: -1) }, for: .touchUpInside)
    nextButton.addAction(UIAction { [weak self] _ in self?.advance() }, for: .touchUpInside)
    let buttons = UIStackView(arrangedSubviews: [backButton, nextButton])
    buttons.axis = .horizontal
    buttons.spacing = 10
    buttons.distribution = .fillEqually

    let column = UIStackView(arrangedSubviews: [top, question, options, answerBox, buttons])
    column.axis = .vertical
    column.spacing = 12
    addPinned(column, insets: UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16))
  }

  /// The field has the buttons' height and round ends, so the two read as one set.
  override func layoutSubviews() {
    super.layoutSubviews()
    let pill = nextButton.bounds.height
    guard pill > 0 else { return }
    if fieldRadius != pill / 2 {
      fieldRadius = pill / 2
      answerBox.cornerConfiguration = .corners(radius: .fixed(fieldRadius))
    }
    let line = ceil(answerText.font?.lineHeight ?? 22)
    let inset = max(10, ((pill - line) / 2).rounded(.down))
    if answerInsets.contains(where: { $0.constant != inset }) {
      for constraint in answerInsets { constraint.constant = inset }
      setNeedsLayout()
    }
  }

  /// Draws the question at `index`.
  private func show() {
    let traits = traitCollection
    let question = current
    header.font = .app(.subheadline, weight: .medium, traits: traits)
    header.text = question.header
    counter.font = UIFont.app(.subheadline, traits: traits).monospacedDigits
    counter.text = "\(index + 1) of \(request.questions.count)"
    counter.isHidden = request.questions.count < 2
    self.question.font = .app(.headline, traits: traits)
    self.question.text = question.question

    for view in optionList.arrangedSubviews { view.removeFromSuperview() }
    for (offset, option) in question.options.enumerated() {
      if offset > 0 {
        let line = UIView()
        line.backgroundColor = .separator
        line.heightAnchor.constraint(equalToConstant: 1 / max(1, traits.displayScale)).isActive = true
        optionList.addArrangedSubview(line)
      }
      let row = OptionRow(option: option, traits: traits)
      row.picked = chosen[question.id, default: []].contains(option.label)
      row.addAction(UIAction { [weak self, weak row] _ in
        guard let self, let row else { return }
        self.toggle(option.label)
        row.picked = self.chosen[question.id, default: []].contains(option.label)
      }, for: .touchUpInside)
      optionList.addArrangedSubview(row)
    }
    options.isHidden = question.options.isEmpty
    optionList.layoutIfNeeded()
    let fits = optionList.systemLayoutSizeFitting(
      CGSize(width: max(bounds.width - 32, 300), height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
    ).height
    optionsHeight.constant = min(max(fits, 1), 280)

    let prompt = question.options.isEmpty ? "Your answer" : "Something else"
    let font = UIFont.app(.body, traits: traits)
    answerBox.isHidden = !question.other
    answerText.isHidden = question.secret
    answerSecret.isHidden = !question.secret
    answerText.font = font
    answerText.textColor = .label
    answerSecret.font = font
    answerSecret.placeholder = prompt
    answerPlaceholder.font = font
    answerPlaceholder.text = prompt
    let text = typed[question.id] ?? ""
    if question.secret {
      answerSecret.text = text
    } else {
      answerText.text = text
    }
    answerChanged()

    backButton.isHidden = index == 0
    backButton.configuration?.buttonSize = .large
    backButton.configuration?.baseForegroundColor = .label
    backButton.configuration?.attributedTitle = AttributedString(
      "Back", attributes: AttributeContainer([.font: UIFont.app(.body, traits: traits)]))
    refreshNext()
  }

  private func refreshNext() {
    let ready = !answer(current).isEmpty && !busy
    nextButton.showAnswer(last ? "Send" : "Next", ready: ready, traits: traitCollection)
    backButton.isEnabled = !busy
  }

  // MARK: Answers

  func textViewDidChange(_ textView: UITextView) {
    typed[current.id] = answerText.text
    answerChanged()
    refreshNext()
  }

  private func secretChanged() {
    typed[current.id] = answerSecret.text
    refreshNext()
  }

  /// One to four lines tall; past four it scrolls.
  private func answerChanged() {
    answerPlaceholder.isHidden = current.secret || !answerText.text.isEmpty
    guard let font = answerText.font else { return }
    let width = answerText.bounds.width > 0 ? answerText.bounds.width : 280
    let fits = ceil(answerText.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    let most = ceil(font.lineHeight * 4)
    let height = current.secret ? ceil(font.lineHeight) : min(max(fits, ceil(font.lineHeight)), most)
    answerText.isScrollEnabled = fits > most
    guard answerHeight.constant != height else { return }
    answerHeight.constant = height
    onResize()
  }

  private func toggle(_ label: String) {
    UISelectionFeedbackGenerator().selectionChanged()
    let question = current
    var picked = chosen[question.id, default: []]
    if question.multiple {
      if let at = picked.firstIndex(of: label) { picked.remove(at: at) } else { picked.append(label) }
    } else {
      picked = picked == [label] ? [] : [label]
    }
    chosen[question.id] = picked
    if !question.multiple {
      // One choice: the others let go of theirs.
      for case let row as OptionRow in optionList.arrangedSubviews {
        row.picked = picked.contains(row.label)
      }
    }
    refreshNext()
  }

  private func answer(_ question: QuestionView) -> [String] {
    let other = typed[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return chosen[question.id, default: []] + (other.isEmpty ? [] : [other])
  }

  private func go(by step: Int) {
    let target = index + step
    guard request.questions.indices.contains(target) else { return }
    endEditing(true)
    index = target
    UIView.transition(with: self, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
      self.show()
    }
    onResize()
  }

  private func advance() {
    if last { submit() } else { go(by: 1) }
  }

  private func submit() {
    busy = true
    refreshNext()
    endEditing(true)
    let answers = Dictionary(uniqueKeysWithValues: request.questions.map { ($0.id, answer($0)) })
    Task {
      do {
        _ = try await model.request([
          "type": "thread.answer", "threadId": threadId, "requestId": request.id, "answers": answers,
        ])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      } catch {
        host?.showProblem(error.localizedDescription)
        busy = false
        refreshNext()
      }
    }
  }
}

/// One answer to pick: its label, what it means, and a ring that fills when picked.
private final class OptionRow: UIControl {
  let label: String
  private let ring = UIImageView()

  var picked = false {
    didSet {
      ring.image = Tabler.image(picked ? "circle-check-filled" : "circle", size: 22)
      ring.tintColor = picked ? .label : .tertiaryLabel
      accessibilityTraits = picked ? [.button, .selected] : .button
    }
  }

  init(option: OptionView, traits: UITraitCollection) {
    label = option.label
    super.init(frame: .zero)
    let title = UILabel()
    title.text = option.label
    title.font = .app(.body, traits: traits)
    title.numberOfLines = 0
    let detail = UILabel()
    let codeSize = UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits).pointSize
    detail.attributedText = InlineText.make(
      option.detail, font: .app(.footnote, traits: traits), color: .secondaryLabel,
      code: .monospacedSystemFont(ofSize: codeSize, weight: .regular))
    detail.numberOfLines = 0
    let words = UIStackView(arrangedSubviews: [title, detail])
    words.axis = .vertical
    words.spacing = 2
    ring.setContentHuggingPriority(.required, for: .horizontal)
    ring.setContentCompressionResistancePriority(.required, for: .horizontal)
    let row = UIStackView(arrangedSubviews: [words, ring])
    row.axis = .horizontal
    row.alignment = .firstBaseline
    row.spacing = 12
    row.isUserInteractionEnabled = false
    addPinned(row, insets: UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0))
    picked = false
    isAccessibilityElement = true
    accessibilityLabel = [option.label, option.detail].filter { !$0.isEmpty }.joined(separator: ", ")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.05 : 0.2) { self.alpha = self.isHighlighted ? 0.5 : 1 }
    }
  }
}

extension UIButton {
  /// A panel's one filled answer: the text's colour as the fill and the
  /// background's on it while it can be pressed; plain glass with a grey
  /// label while it waits. It is never disabled, which dims both into grey on
  /// grey; it takes no touch instead.
  func showAnswer(_ title: String, ready: Bool, traits: UITraitCollection) {
    var answer: UIButton.Configuration = ready ? .prominentGlass() : .glass()
    answer.buttonSize = .large
    answer.attributedTitle = AttributedString(
      title, attributes: AttributeContainer([.font: UIFont.app(.body, weight: .semibold, traits: traits)]))
    // Fixed colours: on the glass, dynamic ones turn into vibrancy and fade into the fill.
    answer.baseForegroundColor = (ready ? UIColor.systemBackground : .secondaryLabel).resolvedColor(with: traits)
    configuration = answer
    tintColor = .label
    isEnabled = true
    isUserInteractionEnabled = ready
    accessibilityTraits = ready ? .button : [.button, .notEnabled]
  }
}
