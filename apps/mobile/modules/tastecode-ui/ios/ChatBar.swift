import UIKit

/// One piece of glass along the bottom of a chat. It holds the composer, or
/// the decision the agent waits for in its place, and reshapes from one to
/// the other.
final class GlassBar: UIView {
  private let glass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
  private(set) var content: UIView?
  private var pins: [ObjectIdentifier: [NSLayoutConstraint]] = [:]

  override init(frame: CGRect) {
    super.init(frame: frame)
    glass.cornerConfiguration = .corners(radius: .fixed(26))
    glass.clipsToBounds = true
    addPinned(glass)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// Puts `next` on the glass. Animated, the old content fades as the glass
  /// takes the new one's height.
  func show(_ next: UIView, animated: Bool) {
    guard next !== content else { return }
    let old = content
    content = next
    let box = glass.contentView
    let animate = animated && window != nil && old != nil
    if animate { window?.layoutIfNeeded() }
    // The old content lets go of the top and stays on the bottom edge while it fades.
    if let old { pins[ObjectIdentifier(old)]?.first?.isActive = false }
    if let held = pins[ObjectIdentifier(next)] { NSLayoutConstraint.deactivate(held) }
    next.translatesAutoresizingMaskIntoConstraints = false
    if next.superview !== box { box.addSubview(next) }
    let constraints = [
      next.topAnchor.constraint(equalTo: box.topAnchor),
      next.leadingAnchor.constraint(equalTo: box.leadingAnchor),
      next.trailingAnchor.constraint(equalTo: box.trailingAnchor),
      next.bottomAnchor.constraint(equalTo: box.bottomAnchor),
    ]
    NSLayoutConstraint.activate(constraints)
    pins[ObjectIdentifier(next)] = constraints
    guard animate, let old else {
      if let old { drop(old) }
      next.alpha = 1
      return
    }
    // The new content starts out laid out at its own size, on the bottom edge, so only the glass moves.
    let width = box.bounds.width
    let height = next.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
    ).height
    UIView.performWithoutAnimation {
      next.frame = CGRect(x: 0, y: box.bounds.height - height, width: width, height: height)
      next.layoutIfNeeded()
    }
    next.alpha = 0
    UIView.animate(springDuration: 0.35, bounce: 0, options: .allowUserInteraction) {
      next.alpha = 1
      old.alpha = 0
      self.window?.layoutIfNeeded()
    } completion: { _ in
      guard old !== self.content else { return }
      self.drop(old)
    }
  }

  private func drop(_ view: UIView) {
    view.removeFromSuperview()
    view.alpha = 1
    pins[ObjectIdentifier(view)] = nil
  }

  /// The content changed its own height; the glass follows on a spring.
  func resize() {
    guard window != nil else { return }
    UIView.animate(springDuration: 0.3, bounce: 0, options: .allowUserInteraction) {
      self.window?.layoutIfNeeded()
    }
  }
}

/// The bottom of a chat: the composer, or the decision the agent waits for.
final class ChatBarView: UIView {
  private let model = AppModel.shared
  private let store: ThreadStore
  private let bar = GlassBar()
  private var composer: ComposerView!
  private var panel: (key: String, view: UIView)?
  /// The chat's screen, to present from.
  weak var host: UIViewController? {
    didSet {
      composer.host = host
      (panel?.view as? ApprovalPanelView)?.host = host
      (panel?.view as? QuestionPanelView)?.host = host
    }
  }

  init(store: ThreadStore, onSent: @escaping () -> Void) {
    self.store = store
    super.init(frame: .zero)
    let threadId = store.id
    let model = model
    composer = ComposerView(
      draftKey: threadId, state: ComposerState(placeholder: "Message", setup: .empty),
      actions: SetupActions(
        model: { [weak self] source, picked in
          self?.perform(["type": "thread.setModel", "threadId": threadId, "sourceKey": source, "model": picked])
        },
        effort: { [weak self] effort in
          self?.perform(["type": "thread.setEffort", "threadId": threadId, "effort": effort])
        },
        tier: { [weak self] tier in
          self?.perform(["type": "thread.setTier", "threadId": threadId, "tier": tier.map { $0 as Any } ?? NSNull()])
        },
        access: { [weak self] mode in
          self?.perform(["type": "thread.setAccess", "threadId": threadId, "access": mode])
        }
      ),
      onSend: { text, attachments in
        onSent()
        _ = try await model.request([
          "type": "thread.send", "threadId": threadId, "text": text, "attachments": attachments,
        ])
      })
    composer.liveSetup = { [store] in store.meta?.setup ?? .empty }
    composer.onStop = { [weak self] in self?.perform(["type": "thread.stop", "threadId": threadId]) }
    composer.onSteer = { [weak self] id in
      self?.perform(["type": "thread.steer", "threadId": threadId, "queuedId": id])
    }
    composer.onUnqueue = { [weak self] id in
      self?.perform(["type": "thread.unqueue", "threadId": threadId, "queuedId": id])
    }
    composer.onReorder = { [weak self] id, index in
      self?.perform(["type": "thread.reorderQueued", "threadId": threadId, "queuedId": id, "index": index])
    }
    composer.onEdit = { id in
      try await model.request(TakenPrompt.self, ["type": "thread.editQueued", "threadId": threadId, "queuedId": id])
    }
    addPinned(bar, insets: UIEdgeInsets(top: 0, left: 10, bottom: 6, right: 10))
    bar.show(composer, animated: false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func perform(_ action: [String: Any]) {
    model.perform(action) { [weak self] message in self?.host?.showProblem(message) }
  }

  /// UIKit runs this again whenever the chat's state or the link changes.
  override func updateProperties() {
    super.updateProperties()
    let meta = store.meta
    let running = meta?.running ?? false
    composer.show(
      ComposerState(
        placeholder: running ? "Add to the queue" : "Message",
        setup: meta?.setup ?? .empty,
        running: running,
        enabled: model.link?.phase == .open && meta != nil,
        queue: meta?.queue ?? [],
        canSteer: meta?.canSteer ?? false))
    let animated = window != nil
    if let approval = meta?.approval {
      let key = "approval:\(approval.id)"
      guard panel?.key != key else { return }
      let view = ApprovalPanelView(threadId: store.id, request: approval)
      view.host = host
      showPanel(key, view, animated: animated)
    } else if let questions = meta?.questions {
      let key = "questions:\(questions.id)"
      guard panel?.key != key else { return }
      let view = QuestionPanelView(threadId: store.id, request: questions)
      view.host = host
      view.onResize = { [weak self] in self?.bar.resize() }
      showPanel(key, view, animated: animated)
    } else if panel != nil {
      panel = nil
      bar.show(composer, animated: animated)
    }
  }

  private func showPanel(_ key: String, _ view: UIView, animated: Bool) {
    composer.endEditing(true)
    panel = (key, view)
    bar.show(view, animated: animated)
  }
}
