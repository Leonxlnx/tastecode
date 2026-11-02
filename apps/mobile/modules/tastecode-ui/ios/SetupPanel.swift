import UIKit

/// Over the blurred chat, in its middle: the model's name, which opens every
/// model, speed and provider, and right under it the reasoning slider and the
/// level's name. The X, a tap on the blur or a swipe down puts it away.
///
/// The chat goes out of focus as the panel rises into it, sharp all the way;
/// putting it away reverses both at once.
final class SetupPanelController: UIViewController, UIGestureRecognizerDelegate {
  private let model = AppModel.shared
  private let setup: () -> SetupView
  private let actions: SetupActions
  private let blur = UIVisualEffectView(effect: nil)
  private let closeButton = UIButton(type: .system)
  private let column = UIStackView()
  private let modelTitle = ModelTitle()
  private let slider = EffortSlider()
  private let levelName = SlidingLabel()
  private let noLevels = UILabel()
  private var closing = false
  private var applied: (setup: SetupView, catalog: CatalogView)?

  init(setup: @escaping () -> SetupView, actions: SetupActions) {
    self.setup = setup
    self.actions = actions
    super.init(nibName: nil, bundle: nil)
    // It draws its own entrance over the chat, so it is shown without UIKit's slide.
    modalPresentationStyle = .overFullScreen
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    blur.frame = view.bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    blur.accessibilityElementsHidden = true
    view.addSubview(blur)
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    tap.delegate = self
    view.addGestureRecognizer(tap)
    let swipe = UIPanGestureRecognizer(target: self, action: #selector(swiped(_:)))
    swipe.delegate = self
    view.addGestureRecognizer(swipe)

    modelTitle.menuItems = { [weak self] in self?.menu() ?? [] }
    slider.onPick = { [weak self] in self?.actions.effort($0) }
    slider.onLevel = { [weak self] in
      guard let self else { return }
      self.levelName.set($0, animated: self.view.window != nil)
    }
    noLevels.text = "This model has no reasoning levels."
    noLevels.textColor = .secondaryLabel
    noLevels.textAlignment = .center
    noLevels.numberOfLines = 0
    column.axis = .vertical
    column.spacing = 12
    column.alignment = .fill
    for row in [modelTitle, slider, noLevels, levelName] { column.addArrangedSubview(row) }
    column.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(column)
    let wide = column.widthAnchor.constraint(equalTo: view.widthAnchor, constant: -64)
    wide.priority = .defaultHigh
    NSLayoutConstraint.activate([
      column.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
      column.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      column.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
      wide,
    ])

    var close = UIButton.Configuration.glass()
    close.image = Tabler.image("x", size: 19)
    close.cornerStyle = .capsule
    close.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 7, bottom: 7, trailing: 7)
    closeButton.configuration = close
    closeButton.accessibilityLabel = "Close"
    closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(closeButton)
    NSLayoutConstraint.activate([
      closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
      closeButton.widthAnchor.constraint(equalToConstant: 44),
      closeButton.heightAnchor.constraint(equalToConstant: 44),
    ])

    applyFonts()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (panel: SetupPanelController, _: UITraitCollection) in
      panel.applyFonts()
    }
    // Where the entrance starts from.
    column.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
    for row in column.arrangedSubviews { sink(row) }
    closeButton.alpha = 0
    closeButton.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
  }

  private func applyFonts() {
    modelTitle.applyFonts(traitCollection)
    noLevels.font = .app(.subheadline, traits: traitCollection)
    levelName.font = .app(.subheadline, weight: .semibold, traits: traitCollection)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // One frame on screen first, so the entrance animates from its start.
    DispatchQueue.main.async { self.enter() }
  }

  /// UIKit runs this again when the setup or the catalog changes, as a model
  /// or level is picked.
  override func updateProperties() {
    super.updateProperties()
    let setup = setup()
    let catalog = model.catalog
    if let applied, applied.setup == setup, applied.catalog == catalog { return }
    applied = (setup, catalog)
    let current = catalog.source(setup.sourceKey)?.models.first { $0.id == setup.model }
    let efforts = current?.efforts ?? []
    modelTitle.show(
      name: setup.modelName ?? "Choose a Model",
      detail: [setup.sourceName, setup.tierName].compactMap { $0 }.joined(separator: " · "),
      animated: view.window != nil)
    slider.update(efforts: efforts, selected: setup.effort)
    slider.isHidden = efforts.isEmpty
    levelName.isHidden = efforts.isEmpty
    noLevels.isHidden = !efforts.isEmpty
  }

  // MARK: Coming and going

  /// A row a little low and clear, where it rises from and sinks back to.
  private func sink(_ row: UIView) {
    row.transform = CGAffineTransform(translationX: 0, y: 12)
    row.alpha = 0
  }

  private func enter() {
    guard !closing else { return }
    UIView.animate(withDuration: 0.4, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
      self.blur.effect = UIBlurEffect(style: .systemUltraThinMaterial)
    }
    UIView.animate(springDuration: 0.44, bounce: 0.16, options: .allowUserInteraction) {
      self.column.transform = .identity
    }
    // Each row a beat after the one above it.
    for (order, row) in column.arrangedSubviews.filter({ !$0.isHidden }).enumerated() {
      UIView.animate(springDuration: 0.44, bounce: 0.16, delay: 0.04 * Double(order), options: .allowUserInteraction) {
        row.transform = .identity
        row.alpha = 1
      }
    }
    // Hidden rows are ready for when the model changes and shows them.
    for row in column.arrangedSubviews where row.isHidden {
      row.transform = .identity
      row.alpha = 1
    }
    UIView.animate(springDuration: 0.44, bounce: 0.16, delay: 0.06, options: .allowUserInteraction) {
      self.closeButton.transform = .identity
      self.closeButton.alpha = 1
    }
  }

  private func close() {
    guard !closing else { return }
    closing = true
    UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
      self.blur.effect = nil
    }
    // All of them leave together.
    UIView.animate(withDuration: 0.14, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
      for row in self.column.arrangedSubviews { self.sink(row) }
      self.closeButton.alpha = 0
      self.closeButton.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
    }
    UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
      self.column.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
      self.dismiss(animated: false)
    }
  }

  @objc private func tapped() {
    close()
  }

  @objc private func swiped(_ pan: UIPanGestureRecognizer) {
    if pan.state == .ended && pan.translation(in: view).y > 60 { close() }
  }

  /// The blur takes taps and swipes; the title, the slider and the X keep their own.
  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let touched = touch.view else { return true }
    return ![modelTitle, slider, closeButton].contains { touched.isDescendant(of: $0) }
  }

  // MARK: Menu

  /// The provider's models, the model's speeds, and the other providers.
  private func menu() -> [UIMenuElement] {
    let setup = setup()
    let catalog = model.catalog
    let actions = actions
    let source = catalog.source(setup.sourceKey)
    let tiers = source?.models.first { $0.id == setup.model }?.tiers ?? []
    let others = catalog.sources.filter { $0.key != setup.sourceKey && !$0.models.isEmpty }
    var items: [UIMenuElement] = []
    if let source {
      items.append(Self.models(source, selected: setup.model, actions: actions))
    }
    if !tiers.isEmpty {
      let options = [("Standard", String?.none)] + tiers.map { ($0.name, Optional($0.id)) }
      let speed = UIMenu(
        title: "Speed", image: Tabler.image("bolt"), options: .singleSelection,
        children: options.map { option in
          UIAction(title: option.0, state: setup.tier == option.1 ? .on : .off) { _ in actions.tier(option.1) }
        })
      speed.subtitle = setup.tierName ?? "Standard"
      items.append(speed)
    }
    if setup.switchable && !others.isEmpty {
      items.append(
        UIMenu(
          title: "Other Providers", options: .displayInline,
          children: others.map { other in
            UIMenu(title: other.name, children: [Self.models(other, selected: nil, actions: actions)])
          }))
    }
    return items
  }

  /// One provider's models under its name, the rarely used ones in a submenu.
  private static func models(_ source: SourceView, selected: String?, actions: SetupActions) -> UIMenu {
    func pick(_ models: [ModelView]) -> [UIMenuElement] {
      models.map { entry in
        UIAction(title: entry.name, state: selected == entry.id ? .on : .off) { _ in
          actions.model(source.key, entry.id)
        }
      }
    }
    var children: [UIMenuElement] = []
    if source.models.isEmpty {
      children.append(
        UIAction(title: source.status == .loading ? "Loading models…" : "No models", attributes: .disabled) { _ in })
    }
    children += pick(source.models.filter { !$0.more })
    let more = source.models.filter(\.more)
    if !more.isEmpty {
      children.append(UIMenu(title: "More Models", children: pick(more)))
    }
    return UIMenu(title: source.name, options: .displayInline, children: children)
  }
}

/// The model's name over the provider it runs on; it opens the model menu.
private final class ModelTitle: UIButton {
  var menuItems: () -> [UIMenuElement] = { [] }
  private let name = UILabel()
  private let selector = UIImageView(image: Tabler.image("selector", size: 16))
  private let detail = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    name.textColor = .label
    name.lineBreakMode = .byTruncatingTail
    selector.tintColor = .tertiaryLabel
    selector.setContentHuggingPriority(.required, for: .horizontal)
    selector.setContentCompressionResistancePriority(.required, for: .horizontal)
    detail.textColor = .secondaryLabel
    detail.lineBreakMode = .byTruncatingTail
    let line = UIStackView(arrangedSubviews: [name, selector])
    line.axis = .horizontal
    line.alignment = .center
    line.spacing = 6
    let column = UIStackView(arrangedSubviews: [line, detail])
    column.axis = .vertical
    column.alignment = .center
    column.spacing = 3
    column.isUserInteractionEnabled = false
    column.translatesAutoresizingMaskIntoConstraints = false
    addSubview(column)
    NSLayoutConstraint.activate([
      column.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
      column.centerXAnchor.constraint(equalTo: centerXAnchor),
      column.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
      column.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
    ])
    showsMenuAsPrimaryAction = true
    preferredMenuElementOrder = .fixed
    menu = UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.menuItems() ?? []) }
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// `traits` come from the panel: inside its trait change, this view's own are not updated yet.
  func applyFonts(_ traits: UITraitCollection) {
    name.font = .app(.title2, weight: .semibold, traits: traits)
    detail.font = .app(.subheadline, traits: traits)
  }

  func show(name text: String, detail line: String, animated: Bool) {
    accessibilityLabel = [text, line].filter { !$0.isEmpty }.joined(separator: ", ")
    guard name.text != text || detail.text != line else { return }
    guard animated else {
      name.text = text
      detail.text = line
      return
    }
    UIView.transition(with: self, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
      self.name.text = text
      self.detail.text = line
    }
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.05 : 0.2) { self.alpha = self.isHighlighted ? 0.5 : 1 }
    }
  }
}

/// The level's name under the slider, sliding as it changes.
private final class SlidingLabel: UIView {
  var font: UIFont = .preferredFont(forTextStyle: .subheadline) {
    didSet {
      label.font = font
      invalidateIntrinsicContentSize()
    }
  }
  private var label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    style(label)
    addSubview(label)
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func style(_ label: UILabel) {
    label.font = font
    label.textColor = .secondaryLabel
    label.textAlignment = .center
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: ceil(font.lineHeight))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    for case let each as UILabel in subviews {
      each.bounds = CGRect(origin: .zero, size: bounds.size)
      each.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
  }

  func set(_ text: String, animated: Bool) {
    guard label.text != text else { return }
    guard animated, label.text != nil else {
      label.text = text
      return
    }
    let old = label
    let next = UILabel()
    style(next)
    next.text = text
    next.frame = bounds
    next.alpha = 0
    next.transform = CGAffineTransform(translationX: 0, y: 6)
    addSubview(next)
    label = next
    UIView.animate(springDuration: 0.2, bounce: 0.15) {
      old.alpha = 0
      old.transform = CGAffineTransform(translationX: 0, y: -6)
      next.alpha = 1
      next.transform = .identity
    } completion: { _ in
      old.removeFromSuperview()
    }
  }
}

/// How hard the model thinks, drawn like the desktop's slider but bigger: a
/// pill track with a dot per level, filled up to a round thumb. Like iOS's
/// own slider, the thumb is Liquid Glass whenever it moves: held and following
/// the finger, stretching as it moves fast, gliding to a tap elsewhere on the
/// track or to a level the computer picked. It turns solid once it has landed.
private final class EffortSlider: UIControl {
  var onPick: (String) -> Void = { _ in }
  /// The level under the thumb, named while it is dragged.
  var onLevel: (String) -> Void = { _ in }

  private var efforts: [EffortView] = []
  private var selectedId: String?
  private var level = 0 {
    didSet {
      if level != oldValue { onLevel(label) }
    }
  }
  /// Where the held thumb is, from 0 on the first level to 1 on the last;
  /// a little past either end while pulled beyond it.
  private var held: CGFloat?
  /// The finger's distance from the thumb's centre when it took hold, so the thumb does not jump.
  private var grip: CGFloat = 0
  /// Until when a thumb called from elsewhere on the track is still gliding to the finger.
  private var glideUntil = Date.distantPast
  /// Whether the let-go thumb is still gliding onto its level.
  private var moving = false
  /// Counts glides, so only the latest one's landing turns the thumb solid.
  private var glides = 0
  private var beyond = false
  private var lastTouch: (x: CGFloat, time: TimeInterval)?
  private var velocity: CGFloat = 0

  private let thumb: CGFloat = 40
  private let inset: CGFloat = 3
  private let face = TrackFace()
  private let knob: Knob

  override init(frame: CGRect) {
    knob = Knob(thumb: thumb, inset: inset)
    super.init(frame: frame)
    face.isUserInteractionEnabled = false
    knob.isUserInteractionEnabled = false
    addSubview(face)
    addSubview(knob)
    isAccessibilityElement = true
    accessibilityLabel = "Effort"
    accessibilityTraits = .adjustable
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (slider: EffortSlider, _: UITraitCollection) in
      slider.paint()
    }
    paint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: thumb + inset * 2)
  }

  private var chosen: Int { efforts.firstIndex { $0.id == selectedId } ?? 0 }
  private var label: String { efforts.indices.contains(level) ? efforts[level].label : "" }
  private var travel: CGFloat { max(1, bounds.width - inset * 2 - thumb) }
  private var thumbCenter: CGFloat { inset + thumb / 2 + (held ?? stop(level)) * travel }

  func update(efforts next: [EffortView], selected now: String?) {
    if next != efforts {
      efforts = next
      selectedId = now
      face.count = next.count
      knob.face.count = next.count
      level = chosen
      onLevel(label)
      setNeedsLayout()
    } else if now != selectedId {
      selectedId = now
      if held == nil && chosen != level { settle { self.level = self.chosen } }
    }
    accessibilityValue = label
  }

  private func paint() {
    let colors = SliderColors(traitCollection.userInterfaceStyle)
    face.paint(colors)
    knob.paint(colors)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    place()
  }

  /// Puts the thumb and the fill where the level or the finger says; inside
  /// an animation, both move on its curve together.
  private func place() {
    face.frame = bounds
    face.place(center: thumbCenter, thumb: thumb, inset: inset, travel: travel)
    knob.place(center: thumbCenter, track: bounds.size, travel: travel)
  }

  private func stop(_ level: Int) -> CGFloat {
    efforts.count > 1 ? CGFloat(level) / CGFloat(efforts.count - 1) : 0
  }

  private func nearest(_ share: CGFloat) -> Int {
    guard efforts.count > 1 else { return 0 }
    return Int((min(max(share, 0), 1) * CGFloat(efforts.count - 1)).rounded())
  }

  /// How far the thumb follows a finger past an end: less the further it goes.
  private func give(_ distance: CGFloat) -> CGFloat {
    let limit: CGFloat = 0.04
    return limit * (1 - 1 / (distance / limit + 1))
  }

  // MARK: Touch

  override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    guard efforts.count >= 2 else { return false }
    let x = touch.location(in: self).x
    // Taking hold of the thumb keeps it where the finger touched it; a touch
    // elsewhere on the track brings it there.
    let offset = x - thumbCenter
    let onThumb = abs(offset) <= thumb / 2 + 8
    grip = onThumb ? offset : 0
    glideUntil = onThumb ? .distantPast : Date().addingTimeInterval(0.22)
    lastTouch = (x, touch.timestamp)
    velocity = 0
    follow(x)
    return true
  }

  override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    let x = touch.location(in: self).x
    if let last = lastTouch, touch.timestamp > last.time {
      let now = (x - last.x) / CGFloat(touch.timestamp - last.time)
      velocity = velocity * 0.5 + now * 0.5
    }
    lastTouch = (x, touch.timestamp)
    follow(x)
    return true
  }

  override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
    letGo()
  }

  override func cancelTracking(with event: UIEvent?) {
    letGo()
  }

  private func follow(_ x: CGFloat) {
    let raw = (x - grip - inset - thumb / 2) / travel
    held = raw < 0 ? -give(-raw) : raw > 1 ? 1 + give(raw - 1) : raw
    knob.glass = true
    if Date() < glideUntil {
      UIView.animate(springDuration: 0.24, bounce: 0.15, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.place()
      }
    } else {
      place()
    }
    let stretch = min(abs(velocity) / 3200, 0.14)
    UIView.animate(springDuration: 0.2, bounce: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.knob.stretch = stretch
    }
    let next = nearest(held ?? 0)
    if next != level {
      level = next
      UISelectionFeedbackGenerator().selectionChanged()
    }
    let past = raw < 0 || raw > 1
    if past && !beyond { UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.7) }
    beyond = past
  }

  private func letGo() {
    settle {
      self.held = nil
      self.knob.stretch = 0
    }
    beyond = false
    lastTouch = nil
    pick()
  }

  /// Glides the thumb on a spring as glass, and turns it solid as it lands.
  /// Timed rather than told by the animation's completion, as the glide can
  /// be overtaken by the next one.
  private func settle(_ change: @escaping () -> Void) {
    moving = true
    knob.glass = true
    glides += 1
    let glide = glides
    change()
    UIView.animate(springDuration: 0.36, bounce: 0.2, options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.place()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      guard self.glides == glide else { return }
      self.moving = false
      self.knob.glass = self.held != nil
    }
  }

  private func pick() {
    accessibilityValue = label
    guard efforts.indices.contains(level), efforts[level].id != selectedId else { return }
    onPick(efforts[level].id)
  }

  override func accessibilityIncrement() {
    step(1)
  }

  override func accessibilityDecrement() {
    step(-1)
  }

  private func step(_ by: Int) {
    let next = level + by
    guard efforts.indices.contains(next) else { return }
    settle { self.level = next }
    pick()
  }
}

/// The track: a pill with a dot per level, filled up to the thumb's centre.
private final class TrackFace: UIView {
  var count = 0 {
    didSet {
      dots.count = count
      lit.count = count
    }
  }
  private let base = UIView()
  private let dots = Dots()
  private let fill = UIView()
  private let litClip = UIView()
  private let lit = Dots()

  override init(frame: CGRect) {
    super.init(frame: frame)
    base.layer.borderWidth = 1
    litClip.clipsToBounds = true
    litClip.addSubview(lit)
    for view in [base, dots, fill, litClip] { addSubview(view) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func paint(_ colors: SliderColors) {
    base.backgroundColor = colors.track
    base.layer.borderColor = colors.line.cgColor
    dots.color = colors.dot
    fill.backgroundColor = colors.fill
    lit.color = colors.lit
  }

  func place(center: CGFloat, thumb: CGFloat, inset: CGFloat, travel: CGFloat) {
    let size = bounds.size
    base.frame = bounds
    base.layer.cornerRadius = size.height / 2
    for each in [dots, lit] {
      each.frame = bounds
      each.start = inset + thumb / 2
      each.travel = travel
    }
    fill.frame = CGRect(x: inset, y: inset, width: max(thumb, center + thumb / 2 - inset), height: thumb)
    fill.layer.cornerRadius = thumb / 2
    litClip.frame = CGRect(x: 0, y: 0, width: max(0, center + thumb / 2), height: size.height)
  }
}

/// One dot per level, centred on the track's middle line.
private final class Dots: UIView {
  var count = 0 { didSet { setNeedsDisplay() } }
  var start: CGFloat = 0 { didSet { if start != oldValue { setNeedsDisplay() } } }
  var travel: CGFloat = 0 { didSet { if travel != oldValue { setNeedsDisplay() } } }
  var color: UIColor = .white { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func draw(_ rect: CGRect) {
    let size: CGFloat = 5
    color.setFill()
    for index in 0..<count {
      let x = start + (count > 1 ? travel * CGFloat(index) / CGFloat(count - 1) : 0)
      UIBezierPath(ovalIn: CGRect(x: x - size / 2, y: bounds.midY - size / 2, width: size, height: size)).fill()
    }
  }
}

/// The thumb: plain and solid at rest. Moving, it grows into a glass lens:
/// the track shows through it sharp and a little magnified, and the glass
/// bends it at the rim.
private final class Knob: UIView {
  /// The lens's copy of the track, lined up with the real one.
  let face = TrackFace()
  private let thumb: CGFloat
  private let inset: CGFloat
  private let stretcher = UIView()
  private let grower = UIView()
  private let glassView = UIVisualEffectView(effect: UIGlassEffect(style: .clear))
  private let lensClip = UIView()
  private let lensHolder = UIView()
  private let solid = UIView()
  private let fade = CAGradientLayer()

  var glass = false {
    didSet {
      guard glass != oldValue else { return }
      // The solid gives way to the glass before it has grown.
      UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
        self.lensClip.alpha = self.glass ? 1 : 0
        self.solid.alpha = self.glass ? 0 : 1
      }
      let grow: CGFloat = glass ? 1.35 : 1
      UIView.animate(springDuration: 0.34, bounce: 0.32, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.grower.transform = CGAffineTransform(scaleX: grow, y: grow)
        // Undoes the growth on the same spring, so the magnification stays put.
        self.lensHolder.transform = CGAffineTransform(scaleX: 1.2 / grow, y: 1.2 / grow)
        self.grower.layer.shadowOpacity = self.glass ? 0.3 : 0
      }
    }
  }

  /// How fast the thumb moves, which stretches the glass along the track.
  var stretch: CGFloat = 0 {
    didSet { stretcher.transform = CGAffineTransform(scaleX: 1 + stretch, y: 1 - stretch * 0.5) }
  }

  init(thumb: CGFloat, inset: CGFloat) {
    self.thumb = thumb
    self.inset = inset
    super.init(frame: CGRect(x: 0, y: 0, width: thumb, height: thumb))
    let box = CGRect(x: 0, y: 0, width: thumb, height: thumb)
    for view in [stretcher, grower, glassView, lensClip, lensHolder, solid] { view.frame = box }
    addSubview(stretcher)
    stretcher.addSubview(grower)
    grower.layer.shadowColor = UIColor.black.cgColor
    grower.layer.shadowRadius = 8
    grower.layer.shadowOffset = CGSize(width: 0, height: 3)
    grower.layer.shadowOpacity = 0
    glassView.cornerConfiguration = .capsule()
    grower.addSubview(glassView)
    // The track seen through the glass: sharp, a fifth larger, giving way to the glass only at the rim.
    fade.type = .radial
    fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
    fade.locations = [0, 0.9, 1]
    fade.startPoint = CGPoint(x: 0.5, y: 0.5)
    fade.endPoint = CGPoint(x: 1, y: 1)
    fade.frame = box
    lensClip.layer.mask = fade
    lensClip.alpha = 0
    glassView.contentView.addSubview(lensClip)
    lensClip.addSubview(lensHolder)
    lensHolder.transform = CGAffineTransform(scaleX: 1.2, y: 1.2)
    lensHolder.addSubview(face)
    solid.layer.cornerRadius = thumb / 2
    solid.layer.shadowColor = UIColor.black.cgColor
    solid.layer.shadowOpacity = 0.24
    solid.layer.shadowRadius = 3
    solid.layer.shadowOffset = CGSize(width: 0, height: 1.5)
    grower.addSubview(solid)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func paint(_ colors: SliderColors) {
    face.paint(colors)
    solid.backgroundColor = colors.thumb
  }

  /// Centres the thumb on the track at `center`, and moves the lens's copy of
  /// the track the other way so the two stay lined up.
  func place(center: CGFloat, track: CGSize, travel: CGFloat) {
    self.center = CGPoint(x: center, y: inset + thumb / 2)
    face.frame = CGRect(
      x: thumb / 2 - center, y: thumb / 2 - track.height / 2, width: track.width, height: track.height)
    face.place(center: center, thumb: thumb, inset: inset, travel: travel)
  }
}

/// The desktop's slider colours: a dark track, grey fill and light thumb in
/// dark mode; a light track, near-black fill and white thumb in light mode.
private struct SliderColors {
  let track: UIColor
  let line: UIColor
  let fill: UIColor
  let dot: UIColor
  let lit: UIColor
  let thumb: UIColor

  init(_ style: UIUserInterfaceStyle) {
    let ink = UIColor(red: 0.153, green: 0.153, blue: 0.165, alpha: 1)
    if style == .dark {
      track = UIColor.black.withAlphaComponent(0.36)
      line = UIColor.white.withAlphaComponent(0.07)
      fill = UIColor.white.withAlphaComponent(0.22)
      dot = UIColor.white.withAlphaComponent(0.28)
      lit = UIColor.white.withAlphaComponent(0.8)
      thumb = .white
    } else {
      track = ink.withAlphaComponent(0.08)
      line = ink.withAlphaComponent(0.1)
      fill = ink
      dot = ink.withAlphaComponent(0.4)
      lit = UIColor.white.withAlphaComponent(0.78)
      thumb = .white
    }
  }
}
