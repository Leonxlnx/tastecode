import PhotosUI
import UIKit

/// What the composer changes: a chat's setup, or the next new chat's.
struct SetupActions {
  var model: (_ sourceKey: String, _ model: String) -> Void
  var effort: (_ effort: String) -> Void
  /// A faster routing the model offers, or nil for the standard one.
  var tier: (_ tier: String?) -> Void
  var access: (_ mode: String) -> Void
}

/// A picture on its way to the computer, shown in the composer until it is sent.
struct PendingImage: Identifiable {
  let id = UUID()
  let image: UIImage
  var path: String?
  var failed = false
}

/// What the composer shows, as a chat or the new chat hands it over.
struct ComposerState: Equatable {
  var placeholder: String
  var setup: SetupView
  var running = false
  var enabled = false
  var queue: [QueuedView] = []
  var canSteer = false
}

/// The input: what you type, what you attach, where it goes (the model and its
/// reasoning in one chip, access) and the button that sends or stops. It sits
/// on the bar's glass.
final class ComposerView: UIView, UITextViewDelegate {
  private let model = AppModel.shared
  /// Where what is typed is kept while it is not sent.
  var draftKey: String
  private let actions: SetupActions
  /// Sends text and the saved pictures' paths; throws to give the text back.
  private let onSend: (String, [String]) async throws -> Void
  var onStop: () -> Void = {}
  var onSteer: (String) -> Void = { _ in }
  var onUnqueue: (String) -> Void = { _ in }
  var onReorder: (String, _ index: Int) -> Void = { _, _ in }
  /// Takes a queued prompt out of the queue, for the composer to hold again.
  var onEdit: ((String) async throws -> TakenPrompt)? {
    didSet { queueView.canEdit = onEdit != nil }
  }
  /// The screen it sits on, to present pickers, the setup panel and problems from.
  weak var host: UIViewController?
  /// The setup as it is now, for the panel to follow while it is open.
  var liveSetup: () -> SetupView = { .empty }

  private var state: ComposerState
  private var images: [PendingImage] = []
  private var sending = false

  private let queueView = QueueView()
  private let queueBox = UIView()
  private let strip = ImageStripView()
  private let stripBox = UIView()
  private let field = UITextView()
  private let placeholder = UILabel()
  private let attach = UIButton(type: .system)
  private let chip = SetupChip()
  private let access = UIButton(type: .system)
  private let sendButton = PressableButton(type: .custom)
  private var fieldHeight: NSLayoutConstraint!
  private lazy var photos = PhotoSource(composer: self)

  init(
    draftKey: String, state: ComposerState, actions: SetupActions,
    onSend: @escaping (String, [String]) async throws -> Void
  ) {
    self.draftKey = draftKey
    self.state = state
    self.actions = actions
    self.onSend = onSend
    super.init(frame: .zero)
    build()
    field.text = model.drafts[draftKey] ?? ""
    show(state, force: true)
    textChanged()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (composer: ComposerView, _: UITraitCollection) in
      composer.applyFonts()
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (composer: ComposerView, _: UITraitCollection) in
      composer.sendShown = nil
      composer.refreshSend()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// The round buttons' and the model capsule's height.
  static let control: CGFloat = 36

  private var trimmed: String { field.text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var uploading: Bool { images.contains { $0.path == nil && !$0.failed } }
  private var canSend: Bool {
    state.enabled && !sending && !uploading && (!trimmed.isEmpty || images.contains { $0.path != nil })
  }
  private var showsStop: Bool { state.running && trimmed.isEmpty && images.isEmpty }

  // MARK: Building

  private func build() {
    queueView.onSteer = { [weak self] in self?.onSteer($0) }
    queueView.onUnqueue = { [weak self] in self?.onUnqueue($0) }
    queueView.onReorder = { [weak self] in self?.onReorder($0, $1) }
    queueView.onEdit = { [weak self] in self?.edit($0) }
    queueBox.addPinned(queueView, insets: UIEdgeInsets(top: 14, left: 16, bottom: 0, right: 16))

    strip.onRemove = { [weak self] id in
      self?.images.removeAll { $0.id == id }
      self?.imagesChanged()
    }
    stripBox.addPinned(strip, insets: UIEdgeInsets(top: 12, left: 12, bottom: 0, right: 12))
    strip.heightAnchor.constraint(equalToConstant: 64).isActive = true

    field.backgroundColor = .clear
    field.textContainerInset = .zero
    field.textContainer.lineFragmentPadding = 0
    field.isScrollEnabled = false
    field.delegate = self
    field.adjustsFontForContentSizeCategory = false
    placeholder.textColor = .placeholderText
    placeholder.isUserInteractionEnabled = false
    let fieldBox = UIView()
    fieldBox.addPinned(field, insets: UIEdgeInsets(top: 16, left: 14, bottom: 14, right: 14))
    fieldBox.addSubview(placeholder)
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    fieldHeight = field.heightAnchor.constraint(equalToConstant: 22)
    NSLayoutConstraint.activate([
      fieldHeight,
      placeholder.leadingAnchor.constraint(equalTo: field.leadingAnchor),
      placeholder.trailingAnchor.constraint(lessThanOrEqualTo: field.trailingAnchor),
      placeholder.topAnchor.constraint(equalTo: field.topAnchor),
    ])

    attach.setImage(Tabler.image("plus", size: 22), for: .normal)
    attach.showsMenuAsPrimaryAction = true
    attach.preferredMenuElementOrder = .fixed
    attach.accessibilityLabel = "Attach"
    attach.menu = UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.attachMenu() ?? []) }
    ])

    chip.addAction(UIAction { [weak self] _ in self?.openSetup() }, for: .touchUpInside)

    access.showsMenuAsPrimaryAction = true
    access.preferredMenuElementOrder = .fixed
    access.menu = UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.accessMenu() ?? []) }
    ])

    // Round buttons on a faint fill at either end, the send button the only solid one.
    for button in [attach, access] {
      button.tintColor = .label
      button.backgroundColor = .quaternarySystemFill
      button.layer.cornerRadius = Self.control / 2
    }
    sendButton.layer.cornerRadius = Self.control / 2
    sendButton.addAction(UIAction { [weak self] _ in self?.sendOrStop() }, for: .touchUpInside)

    let spacer = UIView()
    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    spacer.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    let row = UIStackView(arrangedSubviews: [attach, chip, spacer, access, sendButton])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 8
    NSLayoutConstraint.activate([
      attach.widthAnchor.constraint(equalToConstant: Self.control),
      attach.heightAnchor.constraint(equalToConstant: Self.control),
      chip.heightAnchor.constraint(equalToConstant: Self.control),
      access.widthAnchor.constraint(equalToConstant: Self.control),
      access.heightAnchor.constraint(equalToConstant: Self.control),
      sendButton.widthAnchor.constraint(equalToConstant: Self.control),
      sendButton.heightAnchor.constraint(equalToConstant: Self.control),
      spacer.widthAnchor.constraint(greaterThanOrEqualToConstant: 0),
    ])
    let rowBox = UIView()
    rowBox.addPinned(row, insets: UIEdgeInsets(top: 0, left: 8, bottom: 8, right: 8))

    let column = UIStackView(arrangedSubviews: [queueBox, stripBox, fieldBox, rowBox])
    column.axis = .vertical
    addPinned(column)
    queueBox.isHidden = true
    stripBox.isHidden = true
    applyFonts()
  }

  private func applyFonts() {
    let font = UIFont.app(.body, traits: traitCollection)
    field.font = font
    field.textColor = .label
    placeholder.font = font
    chip.applyFonts(traitCollection)
    queueView.applyFonts(traitCollection)
    textChanged()
  }

  // MARK: State

  /// Takes what the chat or new chat says now.
  func show(_ next: ComposerState, force: Bool = false) {
    guard force || next != state else { return }
    let queueChanged = next.queue != state.queue || next.canSteer != state.canSteer
    state = next
    placeholder.text = next.placeholder
    attach.isHidden = !next.setup.images
    refreshChip()
    refreshAccess()
    if queueChanged || force {
      let animate = window != nil && !force
      queueView.show(next.queue, canSteer: next.canSteer, animated: animate)
      let hidden = next.queue.isEmpty
      if queueBox.isHidden != hidden {
        if animate {
          queueBox.alpha = hidden ? 1 : 0
          UIView.animate(springDuration: 0.32, bounce: 0) {
            self.queueBox.isHidden = hidden
            self.queueBox.alpha = hidden ? 0 : 1
            self.window?.layoutIfNeeded()
          }
        } else {
          queueBox.isHidden = hidden
        }
      }
    }
    refreshSend()
  }

  /// UIKit runs this again when the catalog changes: the chip names the
  /// model's levels and the access menu its modes from it.
  override func updateProperties() {
    super.updateProperties()
    _ = model.catalog
    refreshChip()
  }

  private func refreshChip() {
    let setup = state.setup
    let efforts = model.catalog.source(setup.sourceKey)?.models.first { $0.id == setup.model }?.efforts ?? []
    let name = setup.modelName ?? setup.sourceName
    let title = name.map { ([$0] + [setup.tierName].compactMap { $0 }).joined(separator: " · ") } ?? "Model"
    chip.show(name: title, effort: efforts.isEmpty ? nil : setup.effortLabel)
    chip.accessibilityLabel = [title, setup.effortLabel].compactMap { $0 }.joined(separator: ", ")
  }

  private func refreshAccess() {
    let symbol: String
    switch state.setup.access {
    case "ask": symbol = "hand-stop"
    case "auto", "auto-review": symbol = "shield-check"
    case "full": symbol = "shield-exclamation"
    default: symbol = "shield"
    }
    access.setImage(Tabler.image(symbol, size: 20), for: .normal)
    access.accessibilityLabel = "Access: \(state.setup.accessTitle)"
  }

  private var sendShown: (stop: Bool, active: Bool)?

  private func refreshSend() {
    let stop = showsStop
    let active = stop || canSend
    // Not disabled, which would dim it: it simply takes no touch until it can act.
    sendButton.isUserInteractionEnabled = active
    sendButton.accessibilityTraits = active ? .button : [.button, .notEnabled]
    sendButton.accessibilityLabel = stop ? "Stop" : "Send"
    guard sendShown?.stop != stop || sendShown?.active != active else { return }
    let first = sendShown == nil
    sendShown = (stop, active)
    // Fixed colours, the glyph drawn in its own: on the glass, tinted ones turn into muted vibrancy.
    let traits = traitCollection
    let glyph = Tabler.image(stop ? "player-stop-filled" : "arrow-up", size: stop ? 14 : 19)
      .withTintColor((active ? UIColor.systemBackground : .tertiaryLabel).resolvedColor(with: traits), renderingMode: .alwaysOriginal)
    let apply = {
      self.sendButton.setImage(glyph, for: .normal)
      self.sendButton.backgroundColor = active ? .label : .quaternarySystemFill
    }
    if first || window == nil {
      apply()
    } else {
      UIView.animate(springDuration: 0.22, bounce: 0.15, animations: apply)
    }
  }

  // MARK: Typing

  func textViewDidChange(_ textView: UITextView) {
    model.drafts[draftKey] = field.text
    textChanged()
  }

  private var laidOutWidth: CGFloat = 0

  override func layoutSubviews() {
    super.layoutSubviews()
    if field.bounds.width != laidOutWidth {
      laidOutWidth = field.bounds.width
      textChanged()
    }
  }

  /// One to seven lines tall; past seven it scrolls.
  private func textChanged() {
    placeholder.isHidden = !field.text.isEmpty
    refreshSend()
    guard let font = field.font else { return }
    let width = field.bounds.width > 0 ? field.bounds.width : 300
    let fits = ceil(field.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    let line = ceil(font.lineHeight)
    let most = ceil(font.lineHeight * 7)
    let height = min(max(fits, line), most)
    field.isScrollEnabled = fits > most
    if fieldHeight.constant != height {
      fieldHeight.constant = height
      if window != nil {
        UIView.animate(withDuration: 0.15) { self.window?.layoutIfNeeded() }
      }
    }
  }

  func focus() {
    field.becomeFirstResponder()
  }

  // MARK: Sending

  private func sendOrStop() {
    if showsStop {
      UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
      onStop()
    } else {
      send()
    }
  }

  private func send() {
    guard canSend else { return }
    let value = trimmed
    let kept = images
    let paths = kept.compactMap(\.path)
    for image in kept {
      if let path = image.path { model.images[path] = image.image }
    }
    sending = true
    setText("")
    images = []
    imagesChanged()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    Task {
      do {
        try await onSend(value, paths)
      } catch {
        // Nothing is lost: the prompt goes back into the field.
        setText(value)
        images = kept
        imagesChanged()
        problem(error.localizedDescription)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
      sending = false
      refreshSend()
    }
  }

  private func setText(_ text: String) {
    field.text = text
    model.drafts[draftKey] = text
    textChanged()
  }

  /// Brings a queued prompt back into the input, ahead of anything typed since.
  private func edit(_ id: String) {
    guard let onEdit else { return }
    Task {
      do {
        let taken = try await onEdit(id)
        let typed = trimmed
        setText(typed.isEmpty ? taken.text : "\(taken.text)\n\n\(field.text ?? "")")
        let placeholder = Tabler.image("photo")
        for path in taken.attachments where !images.contains(where: { $0.path == path }) {
          images.append(PendingImage(image: model.images[path] ?? placeholder, path: path))
        }
        imagesChanged()
        focus()
      } catch {
        problem(error.localizedDescription)
      }
    }
  }

  private func problem(_ message: String) {
    host?.showProblem(message)
  }

  // MARK: Pictures

  private func attachMenu() -> [UIMenuElement] {
    var items = [
      UIAction(title: "Photo Library", image: Tabler.image("photo")) { [weak self] _ in self?.photos.pickFromLibrary() }
    ]
    if UIImagePickerController.isSourceTypeAvailable(.camera) {
      items.append(UIAction(title: "Take Photo", image: Tabler.image("camera")) { [weak self] _ in self?.photos.takePhoto() })
    }
    return items
  }

  fileprivate func add(_ image: UIImage) {
    let pending = PendingImage(image: image)
    images.append(pending)
    imagesChanged()
    Task {
      do {
        guard let data = image.scaledForUpload().jpegData(compressionQuality: 0.8) else {
          throw ActionError(message: "That picture could not be prepared.")
        }
        let saved = try await model.request(
          SavedImage.self,
          ["type": "attach", "mimeType": "image/jpeg", "data": data.base64EncodedString()]
        )
        if let index = images.firstIndex(where: { $0.id == pending.id }) {
          images[index].path = saved.path
        }
      } catch {
        images.removeAll { $0.id == pending.id }
        problem(error.localizedDescription)
      }
      imagesChanged()
    }
  }

  fileprivate func couldNotRead() {
    problem("That picture could not be read.")
  }

  private func imagesChanged() {
    strip.show(images)
    let hidden = images.isEmpty
    if stripBox.isHidden != hidden {
      stripBox.isHidden = hidden
      if window != nil {
        UIView.animate(springDuration: 0.3, bounce: 0) { self.window?.layoutIfNeeded() }
      }
    }
    refreshSend()
  }

  // MARK: Setup

  private func openSetup() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
    // The keyboard goes away before the panel covers it.
    endEditing(true)
    host?.present(SetupPanelController(setup: liveSetup, actions: actions), animated: false)
  }

  private func accessMenu() -> [UIMenuElement] {
    let setup = state.setup
    let levels = model.catalog.source(setup.sourceKey)?.access ?? []
    let items = levels.map { level in
      let action = UIAction(title: level.title, state: setup.access == level.mode ? .on : .off) { [weak self] _ in
        self?.actions.access(level.mode)
      }
      action.subtitle = level.detail
      return action
    }
    return [UIMenu(title: "Access", options: .displayInline, children: items)]
  }
}

/// The model and how hard it thinks, in a capsule: the model's name and the
/// reasoning level's. It opens the panel that changes both.
private final class SetupChip: UIControl {
  private let name = UILabel()
  private let effort = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    name.textColor = .label
    name.lineBreakMode = .byTruncatingTail
    name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    effort.textColor = .secondaryLabel
    effort.setContentCompressionResistancePriority(.required, for: .horizontal)
    effort.setContentHuggingPriority(.required, for: .horizontal)
    let row = UIStackView(arrangedSubviews: [name, effort])
    row.axis = .horizontal
    row.alignment = .firstBaseline
    row.spacing = 5
    row.isUserInteractionEnabled = false
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      row.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    backgroundColor = .quaternarySystemFill
    layer.cornerRadius = ComposerView.control / 2
    layer.cornerCurve = .continuous
    setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityHint = "Changes the model and how hard it thinks"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// `traits` come from the composer: inside its trait change, this view's own are not updated yet.
  func applyFonts(_ traits: UITraitCollection) {
    let font = UIFont.app(.subheadline, traits: traits)
    name.font = font
    effort.font = font
  }

  func show(name text: String, effort level: String?) {
    name.text = text
    effort.text = level
    effort.isHidden = level == nil
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.05 : 0.2) { self.alpha = self.isHighlighted ? 0.5 : 1 }
    }
  }
}

/// A button that gives a little under the finger, as iOS's own buttons do.
final class PressableButton: UIButton {
  override var isHighlighted: Bool {
    didSet {
      UIView.animate(springDuration: 0.18, bounce: 0) {
        self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
      }
    }
  }
}

/// The photo library and the camera, handing the composer what was picked.
@MainActor
private final class PhotoSource: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate,
  UINavigationControllerDelegate
{
  private weak var composer: ComposerView?

  init(composer: ComposerView) {
    self.composer = composer
  }

  func pickFromLibrary() {
    var configuration = PHPickerConfiguration()
    configuration.selectionLimit = 4
    configuration.filter = .images
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    composer?.host?.present(picker, animated: true)
  }

  func takePhoto() {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = self
    picker.modalPresentationStyle = .fullScreen
    composer?.host?.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    for result in results {
      let provider = result.itemProvider
      guard provider.canLoadObject(ofClass: UIImage.self) else {
        composer?.couldNotRead()
        continue
      }
      provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
        let image = object as? UIImage
        Task { @MainActor in
          guard let composer = self?.composer else { return }
          if let image { composer.add(image) } else { composer.couldNotRead() }
        }
      }
    }
  }

  func imagePickerController(
    _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    if let image = info[.originalImage] as? UIImage { composer?.add(image) }
    picker.dismiss(animated: true)
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
  }
}

/// What waits behind the running turn, in the order it will run. Drag a
/// prompt by its handle to reorder, tap it to edit, hold it for the rest.
private final class QueueView: UIView, UIContextMenuInteractionDelegate {
  var canSteer = false
  var canEdit = false
  var onSteer: (String) -> Void = { _ in }
  var onUnqueue: (String) -> Void = { _ in }
  var onReorder: (String, _ index: Int) -> Void = { _, _ in }
  var onEdit: (String) -> Void = { _ in }

  private let header = UILabel()
  private let list = UIStackView()
  private let divider = UIView()
  private var items: [QueuedView] = []
  private var rows: [String: QueueRow] = [:]
  /// The order a drop chose, shown until the queue itself arrives in it.
  private var dropped: [String]?
  private var dragging: String?
  private var dragOffset: CGFloat = 0
  private var traits = UITraitCollection.current
  private let spacing: CGFloat = 2

  override init(frame: CGRect) {
    super.init(frame: frame)
    header.textColor = .secondaryLabel
    list.axis = .vertical
    list.spacing = spacing
    divider.backgroundColor = .separator
    let column = UIStackView(arrangedSubviews: [header, list, divider])
    column.axis = .vertical
    column.setCustomSpacing(6, after: header)
    column.setCustomSpacing(10, after: list)
    divider.heightAnchor.constraint(equalToConstant: 1 / max(1, traitCollection.displayScale)).isActive = true
    addPinned(column)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// `traits` come from the composer, whose trait change reaches this view later.
  func applyFonts(_ traits: UITraitCollection) {
    self.traits = traits
    header.font = .app(.caption1, weight: .semibold, traits: traits)
    for row in rows.values { row.applyFonts(traits) }
  }

  private var shown: [QueuedView] {
    guard let dropped else { return items }
    let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    let ordered = dropped.compactMap { byId[$0] }
    return ordered.count == items.count ? ordered : items
  }

  func show(_ next: [QueuedView], canSteer: Bool, animated: Bool) {
    if next.map(\.id) != items.map(\.id) { dropped = nil }
    items = next
    self.canSteer = canSteer
    let order = shown
    header.text = order.count == 1 ? "Up next" : "Up next · \(order.count)"
    let keep = Set(order.map(\.id))
    for (id, row) in rows where !keep.contains(id) {
      rows[id] = nil
      guard animated else {
        row.removeFromSuperview()
        continue
      }
      UIView.animate(springDuration: 0.32, bounce: 0) {
        row.alpha = 0
        row.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
        row.isHidden = true
      } completion: { _ in
        row.removeFromSuperview()
      }
    }
    var inserted: [QueueRow] = []
    for item in order {
      let row = rows[item.id] ?? makeRow(item.id, inserted: &inserted, animated: animated)
      row.show(
        item, canSteer: canSteer && !item.pending, canEdit: canEdit && !item.pending,
        canDrag: !item.pending && order.count > 1)
    }
    // The rows in the queue's order, after any still fading out.
    let live = order.compactMap { rows[$0.id] }
    if list.arrangedSubviews.compactMap({ $0 as? QueueRow }).filter(live.contains) != live {
      for row in live {
        list.removeArrangedSubview(row)
        list.addArrangedSubview(row)
      }
    }
    guard animated, !inserted.isEmpty else { return }
    for row in inserted {
      row.alpha = 0
      row.transform = CGAffineTransform(translationX: 0, y: 10)
    }
    UIView.animate(springDuration: 0.32, bounce: 0) {
      for row in inserted {
        row.isHidden = false
        row.alpha = 1
        row.transform = .identity
      }
      self.window?.layoutIfNeeded()
    }
  }

  private func makeRow(_ id: String, inserted: inout [QueueRow], animated: Bool) -> QueueRow {
    let row = QueueRow()
    row.applyFonts(traits)
    row.onEdit = { [weak self] in self?.onEdit(id) }
    row.onSteer = { [weak self] in self?.onSteer(id) }
    row.onRemove = { [weak self] in self?.onUnqueue(id) }
    row.handle.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragged(_:))))
    row.addInteraction(UIContextMenuInteraction(delegate: self))
    row.queueId = id
    rows[id] = row
    if animated {
      row.isHidden = true
      inserted.append(row)
    }
    return row
  }

  // MARK: Dragging

  @objc private func dragged(_ pan: UIPanGestureRecognizer) {
    guard let row = pan.view?.superview(of: QueueRow.self), let id = row.queueId else { return }
    let order = shown
    switch pan.state {
    case .began:
      dragging = id
      dragOffset = 0
      list.bringSubviewToFront(row)
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      UIView.animate(springDuration: 0.2, bounce: 0) { row.lifted = true }
    case .changed:
      let before = target(of: id, in: order)
      dragOffset = pan.translation(in: self).y
      row.transform = CGAffineTransform(translationX: 0, y: dragOffset).scaledBy(x: 1.02, y: 1.02)
      let after = target(of: id, in: order)
      if after != before {
        UISelectionFeedbackGenerator().selectionChanged()
        UIView.animate(springDuration: 0.25, bounce: 0) { self.stepAside(order) }
      }
    case .ended, .cancelled, .failed:
      let to = target(of: id, in: order)
      let from = order.firstIndex { $0.id == id }
      UIView.animate(springDuration: 0.28, bounce: 0) {
        if to != from { self.reorder(id, to: to, in: order) }
        self.dragging = nil
        self.dragOffset = 0
        for other in self.rows.values { other.transform = .identity }
        row.lifted = false
        self.layoutIfNeeded()
      }
    default:
      break
    }
  }

  private func reorder(_ id: String, to index: Int, in order: [QueuedView]) {
    var ids = order.map(\.id)
    guard let from = ids.firstIndex(of: id) else { return }
    ids.remove(at: from)
    ids.insert(id, at: min(index, ids.count))
    dropped = ids
    for (position, each) in ids.enumerated() {
      guard let row = rows[each] else { continue }
      list.removeArrangedSubview(row)
      list.insertArrangedSubview(row, at: position)
    }
    onReorder(id, index)
  }

  private func height(_ id: String) -> CGFloat {
    (rows[id]?.bounds.height ?? 40) + spacing
  }

  /// Where the dragged prompt would land: past every neighbour it has moved halfway over.
  private func target(of id: String, in order: [QueuedView]) -> Int {
    guard let from = order.firstIndex(where: { $0.id == id }) else { return 0 }
    var index = from
    var left = dragOffset
    if left > 0 {
      while index + 1 < order.count {
        let next = height(order[index + 1].id)
        guard left > next / 2 else { break }
        left -= next
        index += 1
      }
    } else {
      while index > 0 {
        let previous = height(order[index - 1].id)
        guard -left > previous / 2 else { break }
        left += previous
        index -= 1
      }
    }
    return index
  }

  /// The prompts the dragged one passes step aside for it.
  private func stepAside(_ order: [QueuedView]) {
    guard let dragging, let from = order.firstIndex(where: { $0.id == dragging }) else { return }
    let to = target(of: dragging, in: order)
    let gap = height(dragging)
    for (index, item) in order.enumerated() where item.id != dragging {
      let shift: CGFloat = from < index && index <= to ? -gap : to <= index && index < from ? gap : 0
      rows[item.id]?.transform = CGAffineTransform(translationX: 0, y: shift)
    }
  }

  // MARK: Menu

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard dragging == nil, let row = interaction.view as? QueueRow, let id = row.queueId,
      let item = items.first(where: { $0.id == id })
    else { return nil }
    let order = shown
    let position = (order.firstIndex { $0.id == id } ?? 0) + 1
    let count = order.count
    let traits = traits
    return UIContextMenuConfiguration(identifier: id as NSString) {
      QueuePreview(
        title: "Queued \(position) of \(count)", text: item.text.isEmpty ? "Pictures only" : item.text, traits: traits)
    } actionProvider: { [weak self] _ in
      guard let self else { return nil }
      var actions: [UIMenuElement] = []
      if self.canEdit && !item.pending {
        actions.append(UIAction(title: "Edit", image: Tabler.image("pencil")) { _ in self.onEdit(id) })
      }
      if self.canSteer && !item.pending {
        actions.append(UIAction(title: "Send Now", image: Tabler.image("circle-arrow-up")) { _ in self.onSteer(id) })
      }
      if id != order.first?.id && !item.pending {
        actions.append(
          UIAction(title: "Move to Top", image: Tabler.image("arrow-bar-to-up")) { _ in
            UIView.animate(springDuration: 0.28, bounce: 0) {
              self.reorder(id, to: 0, in: self.shown)
              self.layoutIfNeeded()
            }
          })
      }
      actions.append(
        UIAction(
          title: "Remove", image: Tabler.image("trash"), attributes: item.pending ? [.destructive, .disabled] : .destructive
        ) { _ in self.onUnqueue(id) })
      return UIMenu(children: actions)
    }
  }
}

/// One queued prompt: the handle to drag it by, its words, and its buttons.
private final class QueueRow: UIView {
  var queueId: String?
  var onEdit: () -> Void = {}
  var onSteer: () -> Void = {}
  var onRemove: () -> Void = {}
  let handle = UIImageView(image: Tabler.image("grip-horizontal", size: 17))
  private let text = UILabel()
  private let pictures = UILabel()
  private let body = UIControl()
  private let steer = UIButton(type: .system)
  private let remove = UIButton(type: .system)
  private let ground = UIView()

  /// Picked up and following the finger, on its own ground.
  var lifted = false {
    didSet { ground.alpha = lifted ? 1 : 0 }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    ground.backgroundColor = .systemBackground
    ground.layer.cornerRadius = 12
    ground.layer.cornerCurve = .continuous
    ground.layer.shadowColor = UIColor.black.cgColor
    ground.layer.shadowOpacity = 0.12
    ground.layer.shadowRadius = 10
    ground.layer.shadowOffset = CGSize(width: 0, height: 4)
    ground.alpha = 0
    addPinned(ground)

    handle.tintColor = .tertiaryLabel
    handle.contentMode = .center
    handle.isUserInteractionEnabled = true
    handle.accessibilityLabel = "Reorder"
    text.textColor = .label
    text.numberOfLines = 2
    pictures.textColor = .secondaryLabel
    let words = UIStackView(arrangedSubviews: [text, pictures])
    words.axis = .vertical
    words.spacing = 3
    words.alignment = .leading
    words.isUserInteractionEnabled = false
    body.addPinned(words)
    body.addAction(UIAction { [weak self] _ in self?.onEdit() }, for: .touchUpInside)
    body.accessibilityHint = "Edit"
    steer.setImage(Tabler.image("circle-arrow-up", size: 21), for: .normal)
    steer.tintColor = .secondaryLabel
    steer.accessibilityLabel = "Send now"
    steer.addAction(UIAction { [weak self] _ in self?.onSteer() }, for: .touchUpInside)
    remove.setImage(Tabler.image("x", size: 15), for: .normal)
    remove.tintColor = .tertiaryLabel
    remove.accessibilityLabel = "Remove from the queue"
    remove.addAction(UIAction { [weak self] _ in self?.onRemove() }, for: .touchUpInside)

    let row = UIStackView(arrangedSubviews: [handle, body, steer, remove])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 6
    addPinned(row, insets: UIEdgeInsets(top: 2, left: 0, bottom: 2, right: 4))
    NSLayoutConstraint.activate([
      handle.widthAnchor.constraint(equalToConstant: 28),
      handle.heightAnchor.constraint(equalToConstant: 36),
      steer.widthAnchor.constraint(equalToConstant: 30),
      steer.heightAnchor.constraint(equalToConstant: 30),
      remove.widthAnchor.constraint(equalToConstant: 30),
      remove.heightAnchor.constraint(equalToConstant: 30),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func applyFonts(_ traits: UITraitCollection) {
    text.font = .app(.subheadline, traits: traits)
    pictures.font = .app(.caption1, traits: traits)
  }

  func show(_ item: QueuedView, canSteer: Bool, canEdit: Bool, canDrag: Bool) {
    text.text = item.text
    text.isHidden = item.text.isEmpty
    if item.images > 0 {
      let line = NSMutableAttributedString(attachment: NSTextAttachment(image: Tabler.image("photo", size: 13)))
      line.append(NSAttributedString(string: item.images == 1 ? " 1 picture" : " \(item.images) pictures"))
      pictures.attributedText = line
      pictures.isHidden = false
    } else {
      pictures.isHidden = true
    }
    steer.isHidden = !canSteer
    body.isEnabled = canEdit
    remove.isEnabled = !item.pending
    handle.gestureRecognizers?.forEach { $0.isEnabled = canDrag }
    alpha = item.pending ? 0.5 : 1
  }
}

/// A queued prompt held up on its own, since the row lives on the composer's glass.
private final class QueuePreview: UIViewController {
  private let heading: String
  private let text: String
  /// The chat's, as a preview is drawn outside it.
  private let traits: UITraitCollection

  init(title: String, text: String, traits: UITraitCollection) {
    heading = title
    self.text = text
    self.traits = traits
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let title = UILabel()
    title.text = heading
    title.font = .app(.caption1, weight: .semibold, traits: traits)
    title.textColor = .secondaryLabel
    let body = UILabel()
    body.text = text
    body.font = .app(.subheadline, traits: traits)
    body.numberOfLines = 0
    let column = UIStackView(arrangedSubviews: [title, body])
    column.axis = .vertical
    column.spacing = 4
    view.addPinned(column, insets: UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16))
    let size = view.systemLayoutSizeFitting(
      CGSize(width: 300, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    preferredContentSize = CGSize(width: 300, height: size.height)
  }
}

/// The pictures waiting to go with the message, each with a way to take it back.
private final class ImageStripView: UIScrollView {
  var onRemove: (UUID) -> Void = { _ in }
  private let row = UIStackView()
  private var thumbs: [UUID: ImageThumb] = [:]

  override init(frame: CGRect) {
    super.init(frame: frame)
    showsHorizontalScrollIndicator = false
    alwaysBounceHorizontal = false
    row.axis = .horizontal
    row.spacing = 8
    row.alignment = .bottom
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: contentLayoutGuide.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: contentLayoutGuide.trailingAnchor, constant: -5),
      row.topAnchor.constraint(equalTo: contentLayoutGuide.topAnchor, constant: 5),
      row.bottomAnchor.constraint(equalTo: contentLayoutGuide.bottomAnchor),
      row.heightAnchor.constraint(equalTo: frameLayoutGuide.heightAnchor, constant: -5),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(_ images: [PendingImage]) {
    let keep = Set(images.map(\.id))
    for (id, thumb) in thumbs where !keep.contains(id) {
      thumb.removeFromSuperview()
      thumbs[id] = nil
    }
    for (index, pending) in images.enumerated() {
      let thumb = thumbs[pending.id] ?? {
        let made = ImageThumb()
        made.onRemove = { [weak self] in self?.onRemove(pending.id) }
        thumbs[pending.id] = made
        return made
      }()
      thumb.show(pending)
      if row.arrangedSubviews.firstIndex(of: thumb) != index {
        row.removeArrangedSubview(thumb)
        row.insertArrangedSubview(thumb, at: min(index, row.arrangedSubviews.count))
      }
    }
  }
}

private final class ImageThumb: UIView {
  var onRemove: () -> Void = {}
  private let picture = UIImageView()
  private let veil = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let remove = UIButton(type: .custom)

  override init(frame: CGRect) {
    super.init(frame: frame)
    picture.contentMode = .scaleAspectFill
    picture.clipsToBounds = true
    picture.layer.cornerRadius = 14
    picture.layer.cornerCurve = .continuous
    addPinned(picture)
    veil.layer.cornerRadius = 14
    veil.layer.cornerCurve = .continuous
    veil.clipsToBounds = true
    addPinned(veil)
    spinner.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
    veil.contentView.addPinned(spinner)
    remove.setImage(Tabler.image("x", size: 13, fixed: true), for: .normal)
    remove.tintColor = .white
    remove.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    remove.layer.cornerRadius = 10
    remove.accessibilityLabel = "Remove picture"
    remove.addAction(UIAction { [weak self] _ in self?.onRemove() }, for: .touchUpInside)
    remove.translatesAutoresizingMaskIntoConstraints = false
    addSubview(remove)
    NSLayoutConstraint.activate([
      widthAnchor.constraint(equalToConstant: 58),
      heightAnchor.constraint(equalToConstant: 58),
      remove.widthAnchor.constraint(equalToConstant: 20),
      remove.heightAnchor.constraint(equalToConstant: 20),
      remove.centerXAnchor.constraint(equalTo: trailingAnchor, constant: -5),
      remove.centerYAnchor.constraint(equalTo: topAnchor, constant: 5),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(_ pending: PendingImage) {
    picture.image = pending.image
    let uploading = pending.path == nil
    veil.isHidden = !uploading
    if uploading { spinner.startAnimating() } else { spinner.stopAnimating() }
  }
}

extension UIImage {
  /// At most 2048 points on the long side: plenty for an agent to read, quick to send.
  func scaledForUpload(maxSide: CGFloat = 2048) -> UIImage {
    let longest = max(size.width, size.height)
    guard longest > maxSide else { return self }
    let scale = maxSide / longest
    let target = CGSize(width: size.width * scale, height: size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in
      draw(in: CGRect(origin: .zero, size: target))
    }
  }
}

extension UIView {
  /// Adds `view` filling this one, inset by `insets`.
  func addPinned(_ view: UIView, insets: UIEdgeInsets = .zero) {
    view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: leadingAnchor, constant: insets.left),
      view.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -insets.right),
      view.topAnchor.constraint(equalTo: topAnchor, constant: insets.top),
      view.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -insets.bottom),
    ])
  }

  /// The nearest view of `type` this one sits in, itself included.
  func superview<T: UIView>(of type: T.Type) -> T? {
    var current: UIView? = self
    while let view = current {
      if let match = view as? T { return match }
      current = view.superview
    }
    return nil
  }
}
