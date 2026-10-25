import SwiftUI
import UIKit

/// One chat: the transcript, the composer (or the decision the agent waits
/// for) over its bottom edge, and the title's menu to rename, pin or archive it.
final class ChatController: UIViewController {
  private let model = AppModel.shared
  private let threadId: String
  private let store: ThreadStore
  private let transcript: TranscriptController
  private var bar: UIViewController!
  private var jumpToken = 0
  private let changes = UIButton(type: .system)
  private lazy var changesItem = UIBarButtonItem(customView: changes)

  init(threadId: String) {
    self.threadId = threadId
    store = AppModel.shared.thread(threadId)
    transcript = TranscriptController(model: AppModel.shared, store: store, jumpToken: 0)
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    navigationItem.largeTitleDisplayMode = .never
    // The title sits by the back button, with room for its menu and the changes.
    navigationItem.style = .editor

    addChild(transcript)
    transcript.view.frame = view.bounds
    transcript.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(transcript.view)
    transcript.didMove(toParent: self)

    let store = store
    let host = Hosted { ChatBarHost(store: store) { [weak self] in self?.sent() } }
    host.sizingOptions = [.intrinsicContentSize]
    host.view.backgroundColor = .clear
    bar = host
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      // Above the keyboard when it is up, above the home indicator when not.
      host.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
    ])
    host.didMove(toParent: self)

    navigationItem.titleMenuProvider = { [weak self] _ in self?.titleMenu() }
    changes.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.present(Hosted { ChangesSheet(threadId: self.threadId) }, animated: true)
    }, for: .touchUpInside)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(true, animated: animated)
    if isMovingToParent {
      model.openThread(threadId)
      model.markSeen(threadId)
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Only when the chat is left: a panel over it does not close it.
    guard isMovingFromParent else { return }
    // Whatever happened while it was open was seen too.
    model.markSeen(threadId)
    model.closeThread(threadId)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    // The transcript scrolls under the composer and stops short of hiding behind it.
    let covered = view.bounds.height - view.safeAreaInsets.bottom - bar.view.frame.minY
    transcript.bottomBar(max(0, covered))
  }

  /// What the bars were last drawn from.
  private var applied: (meta: ThreadMetaView?, open: Bool)?

  /// UIKit runs this again whenever the chat's setup or the link changes, and
  /// on its own passes: the bars change only when those did.
  override func updateProperties() {
    super.updateProperties()
    let meta = store.meta
    let open = model.link?.phase == .open
    if let applied, applied.meta == meta, applied.open == open { return }
    applied = (meta, open)
    title = meta?.title ?? ""
    navigationItem.subtitle = open ? meta?.projectName ?? "" : "Reconnecting…"
    if let counts = meta?.changes {
      let font = UIFont.app(.subheadline, weight: .medium, traits: traitCollection)
      let text = NSMutableAttributedString(
        string: "+\(counts.added)", attributes: [.font: font, .foregroundColor: UIColor.systemGreen])
      text.append(
        NSAttributedString(string: " −\(counts.removed)", attributes: [.font: font, .foregroundColor: UIColor.systemRed]))
      var button = UIButton.Configuration.plain()
      button.attributedTitle = AttributedString(text)
      button.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)
      changes.configuration = button
      changes.accessibilityLabel = "Changes: \(counts.files) files"
      changes.sizeToFit()
      navigationItem.rightBarButtonItem = changesItem
    } else {
      navigationItem.rightBarButtonItem = nil
    }
  }

  private func sent() {
    jumpToken += 1
    transcript.jump(jumpToken)
  }

  private func titleMenu() -> UIMenu? {
    guard let meta = store.meta else { return nil }
    let id = threadId
    return UIMenu(children: [
      UIAction(title: "Rename…", image: Tabler.image("pencil")) { [weak self] _ in self?.rename(meta.title) },
      UIAction(title: meta.pinned ? "Unpin" : "Pin", image: Tabler.image(meta.pinned ? "pinned-off" : "pin")) {
        [weak self] _ in self?.perform(["type": "thread.pin", "threadId": id, "pinned": !meta.pinned])
      },
      meta.archived
        ? UIAction(title: "Restore", image: Tabler.image("restore")) { [weak self] _ in
          self?.perform(["type": "thread.restore", "threadId": id])
        }
        : UIAction(title: "Archive", image: Tabler.image("archive")) { [weak self] _ in
          self?.perform(["type": "thread.archive", "threadId": id])
        },
    ])
  }

  private func rename(_ current: String) {
    let alert = UIAlertController(title: "Rename Chat", message: nil, preferredStyle: .alert)
    alert.addTextField { field in
      field.text = current
      field.placeholder = "Title"
      field.clearButtonMode = .whileEditing
    }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Rename", style: .default) { [weak self, weak alert] _ in
      guard let self else { return }
      let title = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !title.isEmpty else { return }
      self.perform(["type": "thread.rename", "threadId": self.threadId, "title": title])
    })
    present(alert, animated: true)
  }

  private func perform(_ action: [String: Any]) {
    model.perform(action) { [weak self] message in self?.showProblem(message) }
  }
}

/// A chat that does not exist yet: the project it will start in, and the
/// composer every chat has. Once started it gives its place to the chat.
final class NewChatController: UIViewController {
  private let project: String?

  init(project: String?) {
    self.project = project
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "New Chat"
    navigationItem.largeTitleDisplayMode = .never
    let project = project
    let host = Hosted { NewChatBody(project: project) { [weak self] id in self?.started(id) } }
    host.view.backgroundColor = .clear
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(true, animated: animated)
  }

  private func started(_ threadId: String) {
    guard let navigation = navigationController else { return }
    var stack = navigation.viewControllers
    guard let index = stack.firstIndex(of: self) else { return }
    stack[index] = ChatController(threadId: threadId)
    navigation.setViewControllers(stack, animated: false)
  }
}
