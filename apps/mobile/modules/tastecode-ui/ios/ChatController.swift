import SwiftUI
import UIKit

/// One chat: the transcript, the composer (or the decision the agent waits
/// for) over its bottom edge, and the title's menu to rename, pin or archive it.
final class ChatController: UIViewController {
  private let model = AppModel.shared
  private let threadId: String
  private let store: ThreadStore
  private let transcript: TranscriptController
  private var bar: ChatBarView!
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

    bar = ChatBarView(store: store) { [weak self] in self?.sent() }
    bar.host = self
    bar.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      // Above the keyboard when it is up, above the home indicator when not.
      bar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
    ])

    navigationItem.titleMenuProvider = { [weak self] _ in self?.titleMenu() }
    changes.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.present(ChangesSheet(threadId: self.threadId), animated: true)
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
    let covered = view.bounds.height - view.safeAreaInsets.bottom - bar.frame.minY
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
  private let model = AppModel.shared
  private let project: String?
  private let bar = GlassBar()
  private var composer: ComposerView!
  private let picker = ProjectPicker()
  private let sent = SentMessage()
  /// What was sent, shown while the chat starts.
  private var pending: String? {
    didSet { setNeedsUpdateProperties() }
  }
  private var applied: (chat: NewChatView, projects: [ProjectView], link: LinkView?, pending: String?)?

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
    model.send(["type": "newChat.open", "projectPath": project.map { $0 as Any } ?? NSNull()])

    let model = model
    composer = ComposerView(
      draftKey: "new:\(model.newChat.projectPath ?? "")",
      state: ComposerState(placeholder: "Message", setup: model.newChat.setup),
      actions: SetupActions(
        model: { source, picked in model.send(["type": "newChat.set", "sourceKey": source, "model": picked]) },
        effort: { effort in model.send(["type": "newChat.set", "effort": effort]) },
        tier: { tier in model.send(["type": "newChat.set", "tier": tier.map { $0 as Any } ?? NSNull()]) },
        access: { mode in model.send(["type": "newChat.set", "access": mode]) }
      ),
      onSend: { [weak self] text, attachments in
        self?.pending = text
        do {
          let chat = try await model.request(
            StartedChat.self, ["type": "newChat.start", "text": text, "attachments": attachments])
          self?.started(chat.threadId)
        } catch {
          self?.pending = nil
          throw error
        }
      })
    composer.host = self
    composer.liveSetup = { model.newChat.setup }
    bar.show(composer, animated: false)

    picker.onAddProject = { [weak self] in self?.addProject() }
    sent.isHidden = true
    let room = UILayoutGuide()
    view.addLayoutGuide(room)
    for part in [picker, sent, bar] as [UIView] {
      part.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(part)
    }
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
      bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
      bar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -6),
      picker.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
      picker.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
      // In the middle of the space between the title bar and the composer.
      room.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      room.bottomAnchor.constraint(equalTo: bar.topAnchor),
      picker.centerYAnchor.constraint(equalTo: room.centerYAnchor),
      sent.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      sent.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      sent.topAnchor.constraint(equalTo: view.topAnchor),
      sent.bottomAnchor.constraint(equalTo: bar.topAnchor),
    ])
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(true, animated: animated)
  }

  /// UIKit runs this again whenever the new chat's setup, the projects or the link change.
  override func updateProperties() {
    super.updateProperties()
    let chat = model.newChat
    let projects = model.chats.projects
    let link = model.link
    if let applied, applied.chat == chat, applied.projects == projects, applied.link == link,
      applied.pending == pending
    {
      return
    }
    applied = (chat, projects, link, pending)
    composer.draftKey = "new:\(chat.projectPath ?? "")"
    composer.show(
      ComposerState(
        placeholder: chat.projectName.map { "Ask anything in \($0)" } ?? "Message",
        setup: chat.setup,
        enabled: link?.phase == .open && pending == nil && chat.projectPath != nil))
    picker.show(chat, projects: projects, computer: link?.computerName ?? "your computer")
    picker.isHidden = pending != nil
    sent.isHidden = pending == nil
    if let pending { sent.show(pending) }
  }

  private func addProject() {
    weak var presented: UIViewController?
    let browser = FolderBrowser { [model] path in
      presented?.dismiss(animated: true)
      model.send(["type": "newChat.set", "projectPath": path])
    }
    presented = browser
    present(browser, animated: true)
  }

  private func started(_ threadId: String) {
    guard let navigation = navigationController else { return }
    var stack = navigation.viewControllers
    guard let index = stack.firstIndex(of: self) else { return }
    stack[index] = ChatController(threadId: threadId)
    navigation.setViewControllers(stack, animated: false)
  }
}

/// The project name, large, as the menu that changes it, and where the chat will run.
private final class ProjectPicker: UIView {
  var onAddProject: () -> Void = {}
  private let model = AppModel.shared
  private let empty = UILabel()
  private let add = UIButton(configuration: .glass())
  private let button = UIButton(type: .custom)
  private let name = UILabel()
  private let chevron = UIImageView(image: Tabler.image("chevron-down", size: 15))
  private let place = UILabel()
  private var chat = NewChatView.empty
  private var projects: [ProjectView] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    empty.text = "Add a project to start"
    empty.textAlignment = .center
    empty.numberOfLines = 0
    add.configuration?.title = "Add Project"
    add.configuration?.baseForegroundColor = .label
    add.addAction(UIAction { [weak self] _ in self?.onAddProject() }, for: .touchUpInside)

    name.textColor = .label
    name.lineBreakMode = .byTruncatingTail
    chevron.tintColor = .tertiaryLabel
    chevron.setContentHuggingPriority(.required, for: .horizontal)
    let line = UIStackView(arrangedSubviews: [name, chevron])
    line.axis = .horizontal
    line.alignment = .center
    line.spacing = 6
    line.isUserInteractionEnabled = false
    line.translatesAutoresizingMaskIntoConstraints = false
    button.addSubview(line)
    NSLayoutConstraint.activate([
      line.topAnchor.constraint(equalTo: button.topAnchor),
      line.bottomAnchor.constraint(equalTo: button.bottomAnchor),
      line.leadingAnchor.constraint(equalTo: button.leadingAnchor),
      line.trailingAnchor.constraint(equalTo: button.trailingAnchor),
    ])
    button.showsMenuAsPrimaryAction = true
    button.preferredMenuElementOrder = .fixed
    button.menu = UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.menu() ?? []) }
    ])
    // As tall as the name, not a button's usual minimum.
    button.setContentCompressionResistancePriority(.init(1), for: .vertical)
    place.textColor = .secondaryLabel
    place.textAlignment = .center
    place.numberOfLines = 0

    let column = UIStackView(arrangedSubviews: [empty, add, button, place])
    column.axis = .vertical
    column.alignment = .center
    column.spacing = 6
    column.setCustomSpacing(14, after: empty)
    addPinned(column)
    applyFonts()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (picker: ProjectPicker, _: UITraitCollection) in
      picker.applyFonts()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func applyFonts() {
    let title = UIFont.app(.title2, weight: .semibold, traits: traitCollection)
    empty.font = title
    name.font = title
    place.font = .app(.subheadline, traits: traitCollection)
  }

  func show(_ chat: NewChatView, projects: [ProjectView], computer: String) {
    self.chat = chat
    self.projects = projects
    let none = projects.isEmpty
    empty.isHidden = !none
    add.isHidden = !none
    button.isHidden = none
    place.isHidden = none
    name.text = chat.projectName ?? "Choose a project"
    place.text = chat.isolate ? "In a private checkout on \(computer)" : "On \(computer)"
    button.accessibilityLabel = "Project: \(chat.projectName ?? "none")"
  }

  private func menu() -> [UIMenuElement] {
    let model = model
    let picks = projects.map { project in
      UIAction(title: project.name, state: project.path == chat.projectPath ? .on : .off) { _ in
        model.send(["type": "newChat.set", "projectPath": project.path])
      }
    }
    let isolate = !chat.isolate
    return [
      UIMenu(options: [.displayInline, .singleSelection], children: picks),
      UIMenu(options: .displayInline, children: [
        UIAction(title: "Private Checkout", image: Tabler.image("git-branch"), state: chat.isolate ? .on : .off) { _ in
          model.send(["type": "newChat.set", "isolate": isolate])
        },
        UIAction(title: "Add Project…", image: Tabler.image("folder-plus")) { [weak self] _ in self?.onAddProject() },
      ]),
    ]
  }
}

/// What was sent, while the new chat starts: the message on its quiet fill,
/// right-aligned at the bottom, and a line saying it is starting.
private final class SentMessage: UIScrollView {
  private let bubble = UIView()
  private let text = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let starting = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    alwaysBounceVertical = true
    bubble.backgroundColor = .secondarySystemBackground
    bubble.layer.cornerRadius = 20
    bubble.layer.cornerCurve = .continuous
    text.numberOfLines = 0
    bubble.addPinned(text, insets: UIEdgeInsets(top: 10, left: 15, bottom: 10, right: 15))
    spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
    spinner.startAnimating()
    starting.text = "Starting"
    starting.textColor = .secondaryLabel
    let working = UIStackView(arrangedSubviews: [spinner, starting])
    working.axis = .horizontal
    working.spacing = 8
    // The message on the right with room on its left; the line under it on the left.
    let mine = UIView()
    bubble.translatesAutoresizingMaskIntoConstraints = false
    mine.addSubview(bubble)
    let line = UIView()
    working.translatesAutoresizingMaskIntoConstraints = false
    line.addSubview(working)
    let column = UIStackView(arrangedSubviews: [mine, line])
    column.axis = .vertical
    column.spacing = 22
    column.translatesAutoresizingMaskIntoConstraints = false
    addSubview(column)
    NSLayoutConstraint.activate([
      bubble.topAnchor.constraint(equalTo: mine.topAnchor),
      bubble.bottomAnchor.constraint(equalTo: mine.bottomAnchor),
      bubble.trailingAnchor.constraint(equalTo: mine.trailingAnchor),
      bubble.leadingAnchor.constraint(greaterThanOrEqualTo: mine.leadingAnchor, constant: 48),
      working.topAnchor.constraint(equalTo: line.topAnchor),
      working.bottomAnchor.constraint(equalTo: line.bottomAnchor),
      working.leadingAnchor.constraint(equalTo: line.leadingAnchor),
      working.trailingAnchor.constraint(lessThanOrEqualTo: line.trailingAnchor),
      column.leadingAnchor.constraint(equalTo: contentLayoutGuide.leadingAnchor, constant: 20),
      column.trailingAnchor.constraint(equalTo: contentLayoutGuide.trailingAnchor, constant: -20),
      column.widthAnchor.constraint(equalTo: frameLayoutGuide.widthAnchor, constant: -40),
      column.bottomAnchor.constraint(equalTo: contentLayoutGuide.bottomAnchor),
      column.topAnchor.constraint(greaterThanOrEqualTo: contentLayoutGuide.topAnchor, constant: 14),
      // Short, it sits at the bottom, just above the composer.
      contentLayoutGuide.heightAnchor.constraint(greaterThanOrEqualTo: frameLayoutGuide.heightAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(_ message: String) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 2
    text.attributedText = NSAttributedString(
      string: message,
      attributes: [
        .font: UIFont.app(.body, traits: traitCollection), .foregroundColor: UIColor.label,
        .paragraphStyle: paragraph,
      ])
    bubble.isHidden = message.isEmpty
    starting.font = .app(.subheadline, traits: traitCollection)
  }
}
