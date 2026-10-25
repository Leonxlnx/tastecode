import SwiftUI
import UIKit

/// The typeface for the app's text. Code keeps its monospaced font.
enum FontChoice: String, CaseIterable, Identifiable {
  case standard, rounded, serif, monospaced

  var id: Self { self }

  var title: String {
    switch self {
    case .standard: return "Default"
    case .rounded: return "Rounded"
    case .serif: return "Serif"
    case .monospaced: return "Mono"
    }
  }

  var design: Font.Design {
    switch self {
    case .standard: return .default
    case .rounded: return .rounded
    case .serif: return .serif
    case .monospaced: return .monospaced
    }
  }
}

enum AppearanceKey {
  static let followSystemSize = "appearance.followSystemSize"
  static let sizeStep = "appearance.sizeStep"
  static let font = "appearance.font"
  static let bold = "appearance.bold"
}

/// The text sizes the slider steps through, smallest first; `large` is the iPhone's default.
let textSizeSteps: [DynamicTypeSize] = [.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge]
private let defaultSizeStep = 3

/// Applies the chosen text size, typeface and weight to everything below it.
/// One unbranched chain: a branch would make a change rebuild the screens and close any open sheet.
struct AppearanceModifier: ViewModifier {
  @AppStorage(AppearanceKey.followSystemSize) private var followSystem = true
  @AppStorage(AppearanceKey.sizeStep) private var step = defaultSizeStep
  @AppStorage(AppearanceKey.font) private var font = FontChoice.standard
  @AppStorage(AppearanceKey.bold) private var bold = false
  @Environment(\.dynamicTypeSize) private var systemSize

  func body(content: Content) -> some View {
    content
      .fontDesign(font.design)
      .environment(\.legibilityWeight, bold ? .bold : nil)
      .dynamicTypeSize(followSystem ? systemSize : textSizeSteps[clamped(step)])
  }
}

private func clamped(_ step: Int) -> Int {
  min(max(step, 0), textSizeSteps.count - 1)
}

/// The appearance chosen in Settings, read from where its page keeps it, for UIKit.
struct AppearanceChoice {
  /// Nil while the app follows the iPhone's text size.
  let contentSize: UIContentSizeCategory?
  let bold: Bool
  let font: FontChoice

  static var current: AppearanceChoice {
    let defaults = UserDefaults.standard
    let follow = defaults.object(forKey: AppearanceKey.followSystemSize) as? Bool ?? true
    let step = defaults.object(forKey: AppearanceKey.sizeStep) as? Int ?? defaultSizeStep
    return AppearanceChoice(
      contentSize: follow ? nil : UIContentSizeCategory(textSizeSteps[clamped(step)]),
      bold: defaults.bool(forKey: AppearanceKey.bold),
      font: FontChoice(rawValue: defaults.string(forKey: AppearanceKey.font) ?? "") ?? .standard)
  }
}

/// The typeface chosen in Settings, carried down the view tree like the text size.
struct FontDesignTrait: UITraitDefinition {
  static let defaultValue = FontChoice.standard
  static let name = "TasteFontDesign"
}

extension UIFont {
  /// A text style in the chosen typeface, at the size the traits ask for,
  /// a step heavier when Bold Text is on, as SwiftUI draws it.
  static func app(
    _ style: TextStyle, weight: Weight? = nil, traits: UITraitCollection
  ) -> UIFont {
    let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
    var descriptor = base.fontDescriptor
    if var weight {
      if traits.legibilityWeight == .bold { weight = weight.bolder }
      descriptor = descriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
    }
    if let design = traits[FontDesignTrait.self].systemDesign, let designed = descriptor.withDesign(design) {
      descriptor = designed
    }
    return UIFont(descriptor: descriptor, size: base.pointSize)
  }
}

extension UIFont.Weight {
  /// The next weight up, as Bold Text turns regular into semibold.
  var bolder: UIFont.Weight {
    switch self {
    case .ultraLight: return .light
    case .thin, .light: return .regular
    case .regular: return .semibold
    case .medium, .semibold: return .bold
    default: return .heavy
    }
  }
}

extension FontChoice {
  var systemDesign: UIFontDescriptor.SystemDesign? {
    switch self {
    case .standard: return nil
    case .rounded: return .rounded
    case .serif: return .serif
    case .monospaced: return .monospaced
    }
  }
}

extension UIContentSizeCategory {
  init(_ size: DynamicTypeSize) {
    switch size {
    case .xSmall: self = .extraSmall
    case .small: self = .small
    case .medium: self = .medium
    case .large: self = .large
    case .xLarge: self = .extraLarge
    case .xxLarge: self = .extraExtraLarge
    default: self = .extraExtraExtraLarge
    }
  }
}

/// Settings › Appearance: a live sample of a chat, then text size, typeface and weight.
final class AppearanceController: FormController {
  private let defaults = UserDefaults.standard
  private let sample = ChatSampleView()
  private let follow = UISwitch()
  private let bold = UISwitch()
  private let slider = SizeSliderView()
  private let fonts = FontRowView()

  private var followsSystem: Bool { defaults.object(forKey: AppearanceKey.followSystemSize) as? Bool ?? true }
  private var step: Int { clamped(defaults.object(forKey: AppearanceKey.sizeStep) as? Int ?? defaultSizeStep) }
  private var font: FontChoice { FontChoice(rawValue: defaults.string(forKey: AppearanceKey.font) ?? "") ?? .standard }
  private var isBold: Bool { defaults.bool(forKey: AppearanceKey.bold) }

  /// The iPhone's own text size, from outside the app's choice.
  private var systemSize: UIContentSizeCategory {
    view.window?.windowScene?.traitCollection.preferredContentSizeCategory ?? .large
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Appearance"
    // The page keeps its own size steady, so the slider does not move under the finger.
    traitOverrides.preferredContentSizeCategory = .large
    follow.onTintColor = .systemGreen
    follow.addAction(UIAction { [weak self] _ in self?.setFollows() }, for: .valueChanged)
    bold.onTintColor = .systemGreen
    bold.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.defaults.set(self.bold.isOn, forKey: AppearanceKey.bold)
      self.reload()
    }, for: .valueChanged)
    slider.onStep = { [weak self] step in
      self?.defaults.set(step, forKey: AppearanceKey.sizeStep)
      self?.reload()
    }
    fonts.onPick = { [weak self] font in
      self?.defaults.set(font.rawValue, forKey: AppearanceKey.font)
      self?.reload()
    }
    sync()
  }

  override func reload(force: Bool = false) {
    sync()
    super.reload(force: force)
  }

  /// Puts the controls and the sample where the settings are.
  private func sync() {
    guard isViewLoaded else { return }
    let follows = followsSystem
    if follow.isOn != follows { follow.setOn(follows, animated: view.window != nil) }
    if bold.isOn != isBold { bold.setOn(isBold, animated: view.window != nil) }
    slider.step = step
    fonts.selected = font
    sample.show(
      traitCollection.modifyingTraits {
        $0.preferredContentSizeCategory = follows ? systemSize : sizeCategories[step]
        $0.legibilityWeight = isBold ? .bold : .regular
        $0[FontDesignTrait.self] = font
      }, animated: view.window != nil)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    // Its sample and controls need the whole height.
    navigationController?.expandSheet()
  }

  private func setFollows() {
    if !follow.isOn {
      // Turning it off starts the slider where the iPhone's setting is.
      defaults.set(sizeCategories.firstIndex(of: systemSize) ?? defaultSizeStep, forKey: AppearanceKey.sizeStep)
    }
    defaults.set(follow.isOn, forKey: AppearanceKey.followSystemSize)
    reload()
  }

  override func sections() -> [Section] {
    let follows = followsSystem
    var size = [toggleRow("follow", "Same as iPhone", toggle: follow)]
    if !follows {
      size.append(viewRow("slider", slider, insets: NSDirectionalEdgeInsets(top: 13.5, leading: 16, bottom: 13.5, trailing: 16)))
    }
    return [
      Section(id: "sample", rows: [
        viewRow(
          "sample", sample, insets: NSDirectionalEdgeInsets(top: 18, leading: 16, bottom: 18, trailing: 16),
          version: "\(follows ? systemSize.rawValue : "\(step)")|\(font)|\(isBold)")
      ]),
      Section(
        id: "size", header: "Text Size",
        footer: follows ? "Follows Settings › Display & Brightness › Text Size." : "Only TasteCode uses this size.",
        rows: size),
      Section(id: "font", header: "Font", rows: [
        viewRow("fonts", fonts, insets: NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12)),
        toggleRow("bold", "Bold Text", toggle: bold),
      ]),
    ]
  }
}

/// The slider's steps as UIKit's text sizes.
private let sizeCategories = textSizeSteps.map(UIContentSizeCategory.init)

/// A user message and a reply, drawn with the settings being chosen.
private final class ChatSampleView: UIView {
  private let bubble = UIView()
  private let question = UILabel()
  private let reply = UILabel()
  private var shown: UITraitCollection?

  override init(frame: CGRect) {
    super.init(frame: frame)
    bubble.backgroundColor = .tertiarySystemFill
    bubble.layer.cornerRadius = 18
    bubble.layer.cornerCurve = .continuous
    question.numberOfLines = 0
    question.text = "Why does the date test fail at midnight?"
    bubble.addPinned(question, insets: UIEdgeInsets(top: 8, left: 13, bottom: 8, right: 13))
    reply.numberOfLines = 0
    bubble.translatesAutoresizingMaskIntoConstraints = false
    reply.translatesAutoresizingMaskIntoConstraints = false
    addSubview(bubble)
    addSubview(reply)
    NSLayoutConstraint.activate([
      bubble.topAnchor.constraint(equalTo: topAnchor),
      bubble.trailingAnchor.constraint(equalTo: trailingAnchor),
      bubble.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 40),
      reply.topAnchor.constraint(equalTo: bubble.bottomAnchor, constant: 12),
      reply.leadingAnchor.constraint(equalTo: leadingAnchor),
      reply.trailingAnchor.constraint(equalTo: trailingAnchor),
      reply.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// Draws the sample at `traits`: the chosen size, typeface and weight.
  func show(_ traits: UITraitCollection, animated: Bool) {
    let key = (traits.preferredContentSizeCategory, traits.legibilityWeight, traits[FontDesignTrait.self])
    if let shown, (shown.preferredContentSizeCategory, shown.legibilityWeight, shown[FontDesignTrait.self]) == key {
      return
    }
    shown = traits
    let apply = {
      let body = UIFont.app(.body, traits: traits)
      self.question.font = body
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineSpacing = 2
      let line = NSMutableAttributedString(
        string: "It reads the date in the local time zone. ",
        attributes: [.font: body, .foregroundColor: UIColor.label, .paragraphStyle: paragraph])
      let codeSize = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits).pointSize
      line.append(NSAttributedString(
        string: "parseDate",
        attributes: [
          .font: UIFont.monospacedSystemFont(ofSize: codeSize, weight: traits.legibilityWeight == .bold ? .semibold : .regular),
          .foregroundColor: UIColor.label, .paragraphStyle: paragraph,
        ]))
      line.append(NSAttributedString(
        string: " should use UTC, then the test passes.",
        attributes: [.font: body, .foregroundColor: UIColor.label, .paragraphStyle: paragraph]))
      self.reply.attributedText = line
    }
    if animated {
      UIView.transition(with: self, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply)
    } else {
      apply()
    }
  }
}

/// The system's text size control: a small A, a stepped track, a large A.
private final class SizeSliderView: UIView {
  var onStep: (Int) -> Void = { _ in }
  var step = defaultSizeStep {
    didSet { if Int(slider.value.rounded()) != step { slider.value = Float(step) } }
  }
  private let slider = UISlider()

  override init(frame: CGRect) {
    super.init(frame: frame)
    let small = UIImageView(image: Tabler.image("text-decrease", size: 15))
    let large = UIImageView(image: Tabler.image("text-increase", size: 24))
    for icon in [small, large] {
      icon.tintColor = .secondaryLabel
      icon.setContentHuggingPriority(.required, for: .horizontal)
    }
    slider.minimumValue = 0
    slider.maximumValue = Float(textSizeSteps.count - 1)
    slider.minimumTrackTintColor = .label
    slider.addAction(UIAction { [weak self] _ in self?.moved() }, for: .valueChanged)
    let row = UIStackView(arrangedSubviews: [small, slider, large])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 14
    addPinned(row, insets: UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0))
    isAccessibilityElement = true
    accessibilityLabel = "Text size"
    accessibilityTraits = .adjustable
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var accessibilityValue: String? {
    get { "\(step + 1) of \(textSizeSteps.count)" }
    set {}
  }

  override func accessibilityIncrement() { set(step + 1) }
  override func accessibilityDecrement() { set(step - 1) }

  /// Snaps to the nearest step as it moves, as a stepped slider does.
  private func moved() {
    let next = Int(slider.value.rounded())
    slider.value = Float(next)
    set(next)
  }

  private func set(_ next: Int) {
    let value = clamped(next)
    guard value != step else { return }
    step = value
    UISelectionFeedbackGenerator().selectionChanged()
    onStep(value)
  }
}

/// The four typefaces side by side, each shown in itself.
private final class FontRowView: UIView {
  var onPick: (FontChoice) -> Void = { _ in }
  var selected = FontChoice.standard {
    didSet {
      guard selected != oldValue else { return }
      UIView.animate(withDuration: 0.2) { self.paint() }
    }
  }
  private var tiles: [(choice: FontChoice, view: UIControl, title: UILabel)] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 8
    row.distribution = .fillEqually
    for choice in FontChoice.allCases {
      let tile = UIControl()
      tile.layer.cornerRadius = 12
      tile.layer.cornerCurve = .continuous
      let sample = UILabel()
      sample.text = "Aa"
      sample.textColor = .label
      let base = UIFont.systemFont(ofSize: 26, weight: .regular)
      sample.font = choice.systemDesign.flatMap { base.fontDescriptor.withDesign($0) }.map { UIFont(descriptor: $0, size: 26) } ?? base
      let title = UILabel()
      title.text = choice.title
      title.font = .preferredFont(forTextStyle: .caption1)
      let column = UIStackView(arrangedSubviews: [sample, title])
      column.axis = .vertical
      column.alignment = .center
      column.spacing = 6
      column.isUserInteractionEnabled = false
      tile.addPinned(column, insets: UIEdgeInsets(top: 12, left: 0, bottom: 12, right: 0))
      tile.addAction(UIAction { [weak self] _ in
        guard let self, self.selected != choice else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        self.selected = choice
        self.onPick(choice)
      }, for: .touchUpInside)
      tile.isAccessibilityElement = true
      tile.accessibilityLabel = choice.title
      row.addArrangedSubview(tile)
      tiles.append((choice, tile, title))
    }
    addPinned(row)
    paint()
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (row: FontRowView, _: UITraitCollection) in
      row.paint()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func paint() {
    for tile in tiles {
      let on = tile.choice == selected
      tile.view.backgroundColor = on ? .tertiarySystemFill : .clear
      tile.view.layer.borderWidth = 1.5
      tile.view.layer.borderColor = UIColor.label.withAlphaComponent(on ? 0.5 : 0).resolvedColor(with: traitCollection).cgColor
      tile.title.textColor = on ? .label : .secondaryLabel
      tile.view.accessibilityTraits = on ? [.button, .selected] : .button
    }
  }
}
