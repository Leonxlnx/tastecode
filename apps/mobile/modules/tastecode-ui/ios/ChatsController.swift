import UIKit

/// The app's navigation: the chats, and the chats and new chats pushed from them.
final class AppNavigation: UINavigationController {
  init() {
    super.init(rootViewController: ChatsController())
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func open(_ route: Route) {
    switch route {
    case .chat(let id): pushViewController(ChatController(threadId: id), animated: true)
    case .newChat(let project): pushViewController(NewChatController(project: project), animated: true)
    }
  }
}

/// The app's home: every chat on the computer, pinned ones first, then the
/// ones that need you, then one group per project that folds away. Search and
/// a new chat sit at the bottom where the thumb is.
final class ChatsController: UIViewController, UICollectionViewDelegate, UISearchResultsUpdating {
  private enum Section: Hashable {
    case group(String)
    case archived
  }

  private let model = AppModel.shared
  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Section, String>!
  private let search = UISearchController(searchResultsController: nil)
  private let filterItem = UIBarButtonItem()

  private var query = ""
  private var project: String?
  private var device: String?
  private var source: String?
  private var modelName: String?
  private var status: StatusFilter = .all
  private var showArchived = false
  /// Projects folded away, by name; kept on this phone across launches.
  private var folded: Set<String> = Set(
    (UserDefaults.standard.string(forKey: "foldedProjects") ?? "").split(separator: "\n").map(String.init))

  /// What the list shows now, by section and by chat.
  private var sections: [(section: Section, title: String, chats: [ChatView], foldable: Bool)] = []
  private var chats: [String: ChatView] = [:]

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    navigationItem.largeTitleDisplayMode = .never
    setUpList()
    setUpBars()
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (controller: ChatsController, _: UITraitCollection) in
      controller.reconfigureAll()
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(false, animated: animated)
  }

  /// What the list was last built from.
  private var applied: (chats: ChatsView, link: LinkView?, seen: [String: Double])?

  /// UIKit runs this again whenever what it reads from the model changes, and
  /// also on its own passes: the list is rebuilt only when the model changed.
  override func updateProperties() {
    super.updateProperties()
    let chats = model.chats
    let link = model.link
    let seen = model.seenChats
    if let applied, applied.chats == chats, applied.link == link, applied.seen == seen { return }
    applied = (chats, link, seen)
    reload(animated: view.window != nil)
  }

  // MARK: List

  private func setUpList() {
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.showsSeparators = false
    config.headerMode = .supplementary
    // The header keeps its own space above it.
    config.headerTopPadding = 0
    config.backgroundColor = .systemBackground
    config.leadingSwipeActionsConfigurationProvider = { [weak self] indexPath in self?.leadingSwipe(indexPath) }
    config.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in self?.trailingSwipe(indexPath) }
    let layout = UICollectionViewCompositionalLayout.list(using: config)
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .systemBackground
    collectionView.delegate = self
    collectionView.keyboardDismissMode = .onDrag
    let refresh = UIRefreshControl()
    refresh.addAction(UIAction { [weak self, weak refresh] _ in
      Task {
        _ = try? await self?.model.request(["type": "refresh"])
        refresh?.endRefreshing()
      }
    }, for: .valueChanged)
    collectionView.refreshControl = refresh
    view.addSubview(collectionView)

    let cell = UICollectionView.CellRegistration<ChatCell, String> { [weak self] cell, _, id in
      guard let self, let chat = self.chats[id] else { return }
      cell.show(chat, showsProject: self.showsProject(chat))
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, id in
      collectionView.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: id)
    }
    let header = UICollectionView.SupplementaryRegistration<GroupHeaderView>(
      elementKind: UICollectionView.elementKindSectionHeader
    ) { [weak self] header, _, indexPath in
      guard let self, indexPath.section < self.sections.count else { return }
      let entry = self.sections[indexPath.section]
      header.show(
        title: entry.title, count: entry.chats.count, foldable: entry.foldable,
        folded: entry.foldable && self.isFolded(entry.title))
      header.onToggle = { [weak self] in self?.toggleFold(entry.title) }
    }
    dataSource.supplementaryViewProvider = { collectionView, _, indexPath in
      collectionView.dequeueConfiguredReusableSupplementary(using: header, for: indexPath)
    }
  }

  private func isFolded(_ project: String) -> Bool {
    folded.contains(project) && query.isEmpty
  }

  /// Rebuilds the sections from the model and the filters, and moves the rows.
  private func reload(animated: Bool) {
    let all = model.chats.chats
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    let matching = all.filter { chat in
      (project == nil || chat.projectPath == project)
        && (source == nil || chat.sourceName == source)
        && (modelName == nil || chat.modelName == modelName)
        && status.includes(chat)
        && (needle.isEmpty || chat.title.lowercased().contains(needle)
          || chat.projectName.lowercased().contains(needle))
    }
    let active = matching.filter { !$0.archived }
    let archived = matching.filter(\.archived)
    var next = ChatGroup.groups(active, seen: { [model] in model.seen($0) }).map {
      (section: Section.group($0.title), title: $0.title, chats: $0.chats, foldable: $0.foldable)
    }
    if showArchived && !archived.isEmpty {
      next.append((section: .archived, title: "Archived", chats: archived, foldable: false))
    }
    let previous = chats
    sections = next
    chats = Dictionary(matching.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

    var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
    for entry in next {
      snapshot.appendSections([entry.section])
      if !(entry.foldable && isFolded(entry.title)) {
        snapshot.appendItems(entry.chats.map(\.id), toSection: entry.section)
      }
    }
    // Rows that stay but changed are drawn again where they are.
    let changed = snapshot.itemIdentifiers.filter { id in previous[id].map { $0 != chats[id] } ?? false }
    snapshot.reconfigureItems(changed)
    dataSource.apply(snapshot, animatingDifferences: animated)
    refreshHeaders()

    title = project.flatMap { path in model.chats.projects.first { $0.path == path }?.name } ?? ""
    filterItem.image = Tabler.image(filtering ? "filter-filled" : "filter", size: 22)
    setNeedsUpdateContentUnavailableConfiguration()
  }

  private func reconfigureAll() {
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(snapshot.itemIdentifiers)
    dataSource.apply(snapshot, animatingDifferences: false)
    refreshHeaders()
  }

  /// Headers carry a count and a fold: the ones on screen take the new values
  /// in place, so a fold animates instead of the section being rebuilt.
  private func refreshHeaders() {
    let kind = UICollectionView.elementKindSectionHeader
    for indexPath in collectionView.indexPathsForVisibleSupplementaryElements(ofKind: kind) {
      guard indexPath.section < sections.count,
        let header = collectionView.supplementaryView(forElementKind: kind, at: indexPath) as? GroupHeaderView
      else { continue }
      let entry = sections[indexPath.section]
      header.show(
        title: entry.title, count: entry.chats.count, foldable: entry.foldable,
        folded: entry.foldable && isFolded(entry.title))
      header.onToggle = { [weak self] in self?.toggleFold(entry.title) }
    }
  }

  /// In a group that is not its project's: pinned, archived or needing you.
  private func showsProject(_ chat: ChatView) -> Bool {
    chat.pinned || chat.archived || chat.state.waitsForYou || (chat.state == .failed && !model.seen(chat))
  }

  private func toggleFold(_ name: String) {
    if folded.contains(name) { folded.remove(name) } else { folded.insert(name) }
    UserDefaults.standard.set(folded.sorted().joined(separator: "\n"), forKey: "foldedProjects")
    reload(animated: true)
  }

  // MARK: Rows

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    (navigationController as? AppNavigation)?.open(.chat(id))
  }

  private func chat(at indexPath: IndexPath) -> ChatView? {
    dataSource.itemIdentifier(for: indexPath).flatMap { chats[$0] }
  }

  private func leadingSwipe(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard let chat = chat(at: indexPath) else { return nil }
    let pin = UIContextualAction(style: .normal, title: chat.pinned ? "Unpin" : "Pin") { [weak self] _, _, done in
      self?.togglePin(chat)
      done(true)
    }
    pin.image = Tabler.image(chat.pinned ? "pinned-off" : "pin-filled")
    pin.backgroundColor = .systemOrange
    return UISwipeActionsConfiguration(actions: [pin])
  }

  private func trailingSwipe(_ indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard let chat = chat(at: indexPath) else { return nil }
    let action = UIContextualAction(style: .normal, title: chat.archived ? "Restore" : "Archive") {
      [weak self] _, _, done in
      if chat.archived { self?.restore(chat) } else { self?.archive(chat) }
      done(true)
    }
    action.image = Tabler.image(chat.archived ? "restore" : "archive-filled")
    action.backgroundColor = .systemIndigo
    let configuration = UISwipeActionsConfiguration(actions: [action])
    configuration.performsFirstActionWithFullSwipe = true
    return configuration
  }

  func collectionView(
    _ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let indexPath = indexPaths.first, let chat = chat(at: indexPath) else { return nil }
    return UIContextMenuConfiguration(identifier: indexPath as NSIndexPath, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      return UIMenu(children: [
        UIAction(title: chat.pinned ? "Unpin" : "Pin", image: Tabler.image(chat.pinned ? "pinned-off" : "pin")) {
          _ in self.togglePin(chat)
        },
        UIAction(title: "Rename", image: Tabler.image("pencil")) { _ in self.rename(chat) },
        chat.archived
          ? UIAction(title: "Restore", image: Tabler.image("restore")) { _ in self.restore(chat) }
          : UIAction(title: "Archive", image: Tabler.image("archive")) { _ in self.archive(chat) },
      ])
    }
  }

  /// Held, a row lifts as a rounded piece of the list.
  func collectionView(
    _ collectionView: UICollectionView, contextMenuConfiguration configuration: UIContextMenuConfiguration,
    highlightPreviewForItemAt indexPath: IndexPath
  ) -> UITargetedPreview? {
    guard let cell = collectionView.cellForItem(at: indexPath) else { return nil }
    let parameters = UIPreviewParameters()
    parameters.visiblePath = UIBezierPath(roundedRect: cell.bounds.insetBy(dx: 10, dy: 0), cornerRadius: 16)
    parameters.backgroundColor = .secondarySystemBackground
    return UITargetedPreview(view: cell, parameters: parameters)
  }

  /// Closing, the lifted row fades where it is rather than sliding back on its platter.
  func collectionView(
    _ collectionView: UICollectionView, contextMenuConfiguration configuration: UIContextMenuConfiguration,
    dismissalPreviewForItemAt indexPath: IndexPath
  ) -> UITargetedPreview? {
    nil
  }

  private func togglePin(_ chat: ChatView) {
    perform(["type": "thread.pin", "threadId": chat.id, "pinned": !chat.pinned])
    UISelectionFeedbackGenerator().selectionChanged()
  }

  private func archive(_ chat: ChatView) {
    perform(["type": "thread.archive", "threadId": chat.id])
  }

  private func restore(_ chat: ChatView) {
    perform(["type": "thread.restore", "threadId": chat.id])
  }

  private func rename(_ chat: ChatView) {
    let alert = UIAlertController(title: "Rename Chat", message: nil, preferredStyle: .alert)
    alert.addTextField { field in
      field.text = chat.title
      field.placeholder = "Title"
      field.returnKeyType = .done
      field.clearButtonMode = .whileEditing
    }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Rename", style: .default) { [weak self, weak alert] _ in
      let title = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !title.isEmpty, title != chat.title else { return }
      self?.perform(["type": "thread.rename", "threadId": chat.id, "title": title])
    })
    present(alert, animated: true)
  }

  private func perform(_ action: [String: Any]) {
    model.perform(action) { [weak self] message in self?.showProblem(message) }
  }

  // MARK: Bars

  private func setUpBars() {
    let settings = UIBarButtonItem(image: Tabler.image("settings", size: 22), primaryAction: UIAction { [weak self] _ in
      self?.presentSheet(UINavigationController(rootViewController: SettingsController()), height: 560)
    })
    settings.accessibilityLabel = "Settings"
    navigationItem.leftBarButtonItem = settings

    filterItem.image = Tabler.image("filter", size: 22)
    filterItem.accessibilityLabel = "Filter"
    filterItem.menu = UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.filterMenu() ?? []) }
    ])
    navigationItem.rightBarButtonItem = filterItem

    search.searchResultsUpdater = self
    search.obscuresBackgroundDuringPresentation = false
    search.hidesNavigationBarDuringPresentation = false
    search.searchBar.placeholder = "Search chats"
    navigationItem.searchController = search
    navigationItem.hidesSearchBarWhenScrolling = false
    navigationItem.searchBarPlacementAllowsToolbarIntegration = true

    let compose = UIBarButtonItem(image: Tabler.image("edit", size: 22), primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      (self.navigationController as? AppNavigation)?.open(.newChat(project: self.project))
    })
    compose.accessibilityLabel = "New Chat"
    toolbarItems = [navigationItem.searchBarPlacementBarButtonItem, .fixedSpace(0), compose]
  }

  func updateSearchResults(for searchController: UISearchController) {
    let next = searchController.searchBar.text ?? ""
    guard next != query else { return }
    query = next
    reload(animated: false)
  }

  private var filtering: Bool {
    project != nil || device != nil || source != nil || modelName != nil || status != .all
  }

  private func clearFilters() {
    project = nil
    device = nil
    source = nil
    modelName = nil
    status = .all
    reload(animated: true)
  }

  /// The values the chats carry for one field, each once, in name order.
  private func distinct(_ field: (ChatView) -> String?) -> [String] {
    Set(model.chats.chats.compactMap(field)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
  }

  /// One choice of several, as a submenu that names the current one.
  private func picker<Value: Equatable>(
    _ title: String, icon: String, current: Value, options: [(String, Value)], set: @escaping (Value) -> Void
  ) -> UIMenu {
    let children = options.map { option in
      UIAction(title: option.0, state: option.1 == current ? .on : .off) { [weak self] _ in
        set(option.1)
        self?.reload(animated: true)
      }
    }
    let menu = UIMenu(title: title, image: Tabler.image(icon), options: .singleSelection, children: children)
    menu.subtitle = options.first { $0.1 == current }?.0
    return menu
  }

  private func filterMenu() -> [UIMenuElement] {
    let projects = [("All Projects", String?.none)] + model.chats.projects.map { ($0.name, Optional($0.path)) }
    let devices = [("All Devices", String?.none)] + (model.link?.computerName.map { [($0, Optional($0))] } ?? [])
    let agents = [("All Agents", String?.none)] + distinct { $0.sourceName }.map { ($0, Optional($0)) }
    let models = [("All Models", String?.none)] + distinct { $0.modelName }.map { ($0, Optional($0)) }
    let filters = UIMenu(options: .displayInline, children: [
      picker("Project", icon: "folder", current: project, options: projects) { [weak self] in self?.project = $0 },
      // One computer today; the list is ready for more.
      picker("Device", icon: "device-laptop", current: device, options: devices) { [weak self] in self?.device = $0 },
      picker("Agent", icon: "terminal-2", current: source, options: agents) { [weak self] in self?.source = $0 },
      picker("Model", icon: "cpu", current: modelName, options: models) { [weak self] in self?.modelName = $0 },
      picker("Status", icon: "circle-dashed", current: status, options: StatusFilter.allCases.map { ($0.title, $0) }) {
        [weak self] in self?.status = $0
      },
    ])
    var view: [UIMenuElement] = [
      UIAction(title: "Show Archived", image: Tabler.image("archive"), state: showArchived ? .on : .off) {
        [weak self] _ in
        guard let self else { return }
        self.showArchived.toggle()
        self.reload(animated: true)
      }
    ]
    if filtering {
      view.append(UIAction(title: "Clear Filters", image: Tabler.image("x")) { [weak self] _ in self?.clearFilters() })
    }
    let add = UIAction(title: "Add Project…", image: Tabler.image("folder-plus")) { [weak self] _ in self?.addProject() }
    return [
      filters, UIMenu(options: .displayInline, children: view), UIMenu(options: .displayInline, children: [add]),
    ]
  }

  private func addProject() {
    weak var presented: UIViewController?
    let browser = FolderBrowser { [weak self] path in
      presented?.dismiss(animated: true)
      self?.project = path
      self?.reload(animated: true)
    }
    presented = browser
    present(browser, animated: true)
  }

  // MARK: Empty states

  override func updateContentUnavailableConfiguration(using state: UIContentUnavailableConfigurationState) {
    let empty = sections.allSatisfy { $0.chats.isEmpty }
    guard empty else {
      contentUnavailableConfiguration = nil
      return
    }
    let status = model.chats.status
    if !query.isEmpty {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("search", size: 48)
      config.text = "No Results for “\(query)”"
      config.secondaryText = "Check the spelling or try a new search."
      contentUnavailableConfiguration = config
    } else if let link = model.link, link.phase == .waiting || link.phase == .refused, status != .ready {
      contentUnavailableConfiguration = emptyState(
        "Can't reach \(link.computerName ?? "your computer")", link.error ?? "",
        action: link.phase == .waiting
          ? ("Try Again", { [weak self] in self?.model.send(["type": "reconnect"]) })
          : ("Pair Again", { [weak self] in self?.model.send(["type": "forget"]) }))
    } else if status == .idle || status == .loading {
      contentUnavailableConfiguration = UIContentUnavailableConfiguration.loading()
    } else if filtering {
      contentUnavailableConfiguration = emptyState(
        "No matching chats", "No chat matches these filters.",
        action: ("Clear Filters", { [weak self] in self?.clearFilters() }))
    } else if model.chats.projects.isEmpty {
      contentUnavailableConfiguration = emptyState(
        "No projects yet", "Add a folder on your computer to start chatting in it.",
        action: ("Add Project", { [weak self] in self?.addProject() }))
    } else {
      contentUnavailableConfiguration = emptyState(
        "No chats yet", "Start one here or on your computer. It shows up in both places.",
        action: ("New Chat", { [weak self] in
          guard let self else { return }
          (self.navigationController as? AppNavigation)?.open(.newChat(project: self.project))
        }))
    }
  }

  private func emptyState(
    _ text: String, _ detail: String, action: (title: String, run: () -> Void)
  ) -> UIContentUnavailableConfiguration {
    var config = UIContentUnavailableConfiguration.empty()
    config.text = text
    config.secondaryText = detail
    var button = UIButton.Configuration.glass()
    button.title = action.title
    config.button = button
    config.buttonProperties.primaryAction = UIAction { _ in action.run() }
    return config
  }
}

extension UIViewController {
  /// A page that slides up over this one. Given a height, it opens at that
  /// height with a grabber to pull it up to the whole screen.
  func presentSheet(_ sheet: UIViewController, height: CGFloat? = nil) {
    if let height, let presentation = sheet.sheetPresentationController {
      // The sheet's own glass shows while it sits below the top.
      sheet.view.backgroundColor = .clear
      presentation.detents = [.custom(identifier: .opening) { _ in height }, .large()]
      presentation.prefersGrabberVisible = true
    }
    present(sheet, animated: true)
  }

  /// Pulls this sheet up to the whole screen.
  func expandSheet() {
    guard let presentation = sheetPresentationController, presentation.selectedDetentIdentifier != .large else { return }
    presentation.animateChanges { presentation.selectedDetentIdentifier = .large }
  }

  /// A failure the person should read, as an alert with one OK.
  func showProblem(_ message: String) {
    let alert = UIAlertController(title: "Something went wrong", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .cancel))
    present(alert, animated: true)
  }
}

/// A group's name over its chats. A project's name folds it away with a tap,
/// leaving the name and how many chats wait under it.
final class GroupHeaderView: UICollectionReusableView {
  var onToggle: () -> Void = {}
  private let name = UILabel()
  private let count = UILabel()
  private let chevron = UIImageView(image: Tabler.image("chevron-down", size: 15))
  private var foldable = false
  private var folded = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    name.adjustsFontForContentSizeCategory = true
    count.textColor = .tertiaryLabel
    chevron.tintColor = .tertiaryLabel
    chevron.contentMode = .center
    let row = UIStackView(arrangedSubviews: [name, count, UIView(), chevron])
    row.axis = .horizontal
    row.alignment = .firstBaseline
    row.spacing = 6
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 26),
      row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
    ])
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(title: String, count value: Int, foldable: Bool, folded: Bool) {
    self.foldable = foldable
    name.text = title
    name.font = .app(.headline, traits: traitCollection)
    count.text = "\(value)"
    count.font = .app(.subheadline, traits: traitCollection).monospacedDigits
    chevron.isHidden = !foldable
    turnChevron(folded, animated: self.folded != folded && window != nil)
    self.folded = folded
    accessibilityLabel = "\(title), \(value) chats"
    accessibilityValue = foldable ? (folded ? "Folded" : "Open") : nil
    accessibilityTraits = foldable ? [.header, .button] : .header
  }

  private func turnChevron(_ folded: Bool, animated: Bool) {
    let turn = folded ? CGAffineTransform(rotationAngle: -.pi / 2) : .identity
    guard animated else { return chevron.transform = turn }
    UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
      self.chevron.transform = turn
    }
  }

  @objc private func tapped() {
    guard foldable else { return }
    onToggle()
  }
}

/// One chat: its provider's mark in a column, the title and time on one line,
/// the model, project and state under it.
final class ChatCell: UICollectionViewListCell {
  private let mark = ProviderMarkView()
  private let title = UILabel()
  private let time = UILabel()
  private let pin = UIImageView(image: Tabler.image("pin-filled", size: 13))
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let detail = UILabel()
  /// What the chat is doing, kept whole while the line before it shortens.
  private let state = UILabel()
  private var chat: ChatView?
  private var clock: Timer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    title.lineBreakMode = .byTruncatingTail
    detail.lineBreakMode = .byTruncatingTail
    detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    state.setContentCompressionResistancePriority(.required, for: .horizontal)
    state.setContentHuggingPriority(.required, for: .horizontal)
    pin.tintColor = .tertiaryLabel
    spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
    spinner.hidesWhenStopped = true
    time.setContentCompressionResistancePriority(.required, for: .horizontal)
    time.setContentHuggingPriority(.required, for: .horizontal)
    title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let trailing = UIStackView(arrangedSubviews: [pin, time, spinner])
    trailing.axis = .horizontal
    trailing.alignment = .center
    trailing.spacing = 5
    let top = UIStackView(arrangedSubviews: [title, trailing])
    top.axis = .horizontal
    top.alignment = .firstBaseline
    top.spacing = 8
    let line = UIStackView(arrangedSubviews: [detail, state, UIView()])
    line.axis = .horizontal
    line.alignment = .firstBaseline
    line.spacing = 0
    let text = UIStackView(arrangedSubviews: [top, line])
    text.axis = .vertical
    text.spacing = 3
    [mark, text].forEach {
      $0.translatesAutoresizingMaskIntoConstraints = false
      contentView.addSubview($0)
    }
    NSLayoutConstraint.activate([
      mark.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
      mark.widthAnchor.constraint(equalToConstant: 18),
      mark.heightAnchor.constraint(equalToConstant: 15),
      // Centred on the title's first line.
      mark.centerYAnchor.constraint(equalTo: title.centerYAnchor),
      text.leadingAnchor.constraint(equalTo: mark.trailingAnchor, constant: 12),
      text.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
      text.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
      text.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
    ])
    accessibilityTraits = .button
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    clock?.invalidate()
    clock = nil
  }

  /// No highlight of its own: a press dims the row and lets go at once.
  override func updateConfiguration(using state: UICellConfigurationState) {
    backgroundConfiguration = UIBackgroundConfiguration.clear()
    let pressed = state.isHighlighted || state.isSelected
    UIView.animate(withDuration: pressed ? 0.06 : 0.2) {
      self.contentView.alpha = pressed ? 0.5 : 1
    }
  }

  func show(_ chat: ChatView, showsProject: Bool) {
    self.chat = chat
    let traits = traitCollection
    mark.mark = chat.mark
    mark.tintColor = chat.unread ? .secondaryLabel : .tertiaryLabel
    title.text = chat.title
    title.font = .app(.callout, weight: chat.unread ? .semibold : .regular, traits: traits)
    let line = Self.detail(chat, showsProject: showsProject, traits: traits)
    detail.attributedText = line.main
    state.attributedText = line.state
    state.isHidden = line.state == nil
    pin.isHidden = !chat.pinned || chat.state.isWorking
    if chat.state.isWorking {
      spinner.startAnimating()
      time.isHidden = true
      clock?.invalidate()
      clock = nil
    } else {
      spinner.stopAnimating()
      time.isHidden = false
      time.font = .app(.footnote, traits: traits).monospacedDigits
      time.textColor = chat.unread ? .label : .tertiaryLabel
      updateTime()
      if clock == nil {
        clock = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
          MainActor.assumeIsolated { self?.updateTime() }
        }
      }
    }
    accessibilityLabel = [chat.title, line.main.string, line.state?.string, time.isHidden ? nil : time.text]
      .compactMap { $0 }.joined(separator: ", ")
  }

  private func updateTime() {
    guard let chat else { return }
    time.text = shortTime(chat.date)
  }

  /// The model, then the project where the group does not name it; then the state.
  private static func detail(
    _ chat: ChatView, showsProject: Bool, traits: UITraitCollection
  ) -> (main: NSAttributedString, state: NSAttributedString?) {
    let font = UIFont.app(.footnote, traits: traits)
    let quiet: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.secondaryLabel]
    let model = chat.modelName ?? chat.sourceName
    let result = NSMutableAttributedString(
      string: showsProject ? "\(model) · \(chat.projectName)" : model, attributes: quiet)
    let state: (String, UIColor)? = {
      switch chat.state {
      case .approval: return ("Needs approval", .systemBlue)
      case .input: return ("Has a question", .systemBlue)
      case .failed: return ("Stopped with an error", .systemRed)
      case .starting, .working, .queued: return ("Working", .secondaryLabel)
      case .idle: return chat.branch.map { ($0, .tertiaryLabel) }
      }
    }()
    guard let (text, color) = state else { return (result, nil) }
    let line = NSMutableAttributedString(string: " · ", attributes: quiet)
    line.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color]))
    return (result, line)
  }
}

extension UIFont {
  /// The same face with figures of one width, so times and counts do not jitter.
  var monospacedDigits: UIFont {
    let descriptor = fontDescriptor.addingAttributes([
      .featureSettings: [
        [UIFontDescriptor.FeatureKey.type: kNumberSpacingType, UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector]
      ]
    ])
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

extension UISheetPresentationController.Detent.Identifier {
  /// The height a sheet opens at before it is pulled up.
  static let opening = Self("opening")
}
