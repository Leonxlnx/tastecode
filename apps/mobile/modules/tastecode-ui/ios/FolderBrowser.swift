import UIKit

/// Choosing a project on the computer's disk, folder by folder.
final class FolderBrowser: UINavigationController {
  init(onAdded: @escaping (String) -> Void) {
    super.init(rootViewController: FolderListController(folder: nil, onAdded: onAdded))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

/// One folder's folders: a row opens it, Add makes a repository a project,
/// and the open folder itself can be added from the bar at the bottom.
private final class FolderListController: UIViewController, UICollectionViewDelegate, UISearchResultsUpdating {
  private let model = AppModel.shared
  private let folder: String?
  private let onAdded: (String) -> Void
  private var listing: BrowseResult?
  private var error: String?
  private var adding: String?
  private var query = ""
  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let search = UISearchController(searchResultsController: nil)
  private let addButton = UIButton(configuration: .prominentGlass())
  private lazy var addItem: UIBarButtonItem = {
    let item = UIBarButtonItem(customView: addButton)
    // Its own glass, not the bar's: on the bar's, its title turns into vibrancy and fades on the white.
    item.hidesSharedBackground = true
    return item
  }()
  private static let truncatedRow = "§truncated"

  init(folder: String?, onAdded: @escaping (String) -> Void) {
    self.folder = folder
    self.onAdded = onAdded
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    navigationItem.largeTitleDisplayMode = .never
    title = "Folders"
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.backgroundColor = .clear
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .clear
    collectionView.delegate = self
    collectionView.keyboardDismissMode = .onDrag
    view.addSubview(collectionView)

    let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, path in
      self?.configure(cell, path)
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, indexPath, path in
      view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: path)
    }

    if folder == nil { navigationItem.leftBarButtonItem = closeItem() }
    search.searchResultsUpdater = self
    search.obscuresBackgroundDuringPresentation = false
    search.searchBar.placeholder = "Search folders"
    navigationItem.hidesSearchBarWhenScrolling = false
    addButton.tintColor = .label
    addButton.addAction(UIAction { [weak self] _ in self?.addOpenFolder() }, for: .touchUpInside)
    load()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setToolbarHidden(listing?.folders.isEmpty != false, animated: animated)
  }

  private func load() {
    Task {
      do {
        listing = try await model.request(
          BrowseResult.self, ["type": "project.browse", "path": folder.map { $0 as Any } ?? NSNull()])
      } catch {
        self.error = error.localizedDescription
      }
      refresh()
    }
  }

  // MARK: State

  /// The open folder is neither home nor already a project.
  private var canAdd: Bool {
    guard let listing else { return false }
    return listing.path != listing.home && !model.chats.projects.contains(where: { $0.path == listing.path })
  }

  private var folderTitle: String {
    guard let listing else { return "Folders" }
    if listing.path == listing.home { return "Home" }
    return listing.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? listing.path
  }

  private var matching: [BrowsedFolder] {
    guard let listing else { return [] }
    let needle = query.trimmingCharacters(in: .whitespaces)
    if needle.isEmpty { return listing.folders }
    return listing.folders.filter { $0.name.localizedStandardContains(needle) }
  }

  private func refresh() {
    title = folderTitle
    navigationItem.subtitle = listing?.path ?? ""
    if let listing, listing.roots.count > 1 {
      let roots = listing.roots.map { root in
        UIAction(title: root.name) { [weak self] _ in self?.jump(to: root.path) }
      }
      navigationItem.rightBarButtonItem = UIBarButtonItem(image: Tabler.image("server-2", size: 22), menu: UIMenu(children: roots))
    }
    let searchable = listing?.folders.isEmpty == false
    navigationItem.searchController = searchable ? search : nil
    // Beside the Add button a full field would be cut to a few letters.
    navigationItem.preferredSearchBarPlacement = canAdd ? .integratedButton : .integrated
    var items: [UIBarButtonItem] = []
    if searchable { items.append(navigationItem.searchBarPlacementBarButtonItem) }
    if canAdd {
      var button = addButton.configuration ?? .prominentGlass()
      button.attributedTitle = AttributedString(
        adding == nil ? "Add \(folderTitle)" : "Adding…",
        attributes: AttributeContainer([.font: UIFont.app(.body, weight: .semibold, traits: traitCollection)]))
      button.baseForegroundColor = UIColor.systemBackground.resolvedColor(with: traitCollection)
      button.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
      addButton.configuration = button
      addButton.isEnabled = adding == nil
      if !items.isEmpty { items.append(.fixedSpace(0)) }
      items.append(addItem)
    }
    toolbarItems = items
    navigationController?.setToolbarHidden(items.isEmpty, animated: view.window != nil)

    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(matching.map(\.path))
    if listing?.truncated == true && query.isEmpty { snapshot.appendItems([Self.truncatedRow]) }
    snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { dataSource.snapshot().itemIdentifiers.contains($0) })
    dataSource.apply(snapshot, animatingDifferences: false)
    setNeedsUpdateContentUnavailableConfiguration()
  }

  private func configure(_ cell: UICollectionViewListCell, _ path: String) {
    let traits = traitCollection
    if path == Self.truncatedRow {
      var content = UIListContentConfiguration.cell()
      content.text = "Only the first folders are listed."
      content.textProperties.font = .app(.footnote, traits: traits)
      content.textProperties.color = .secondaryLabel
      cell.contentConfiguration = content
      cell.accessories = []
      return
    }
    guard let entry = listing?.folders.first(where: { $0.path == path }) else { return }
    var content = UIListContentConfiguration.cell()
    content.text = entry.name
    content.textProperties.font = .app(.body, traits: traits)
    content.textProperties.numberOfLines = 1
    content.image = Tabler.image("folder", size: 22)
    content.imageProperties.tintColor = .secondaryLabel
    content.imageProperties.reservedLayoutSize = CGSize(width: 22, height: 22)
    content.imageToTextPadding = 12
    cell.contentConfiguration = content
    var accessories: [UICellAccessory] = []
    if entry.added {
      let added = UILabel()
      added.text = "Added"
      added.font = .app(.subheadline, traits: traits)
      added.textColor = .tertiaryLabel
      accessories.append(.customView(configuration: .init(customView: added, placement: .trailing())))
    } else if entry.repository {
      let add = UIButton(type: .system)
      add.setTitle("Add", for: .normal)
      add.titleLabel?.font = .app(.subheadline, weight: .semibold, traits: traits)
      add.tintColor = .label
      add.isEnabled = adding == nil
      add.addAction(UIAction { [weak self] _ in self?.add(entry.path) }, for: .touchUpInside)
      accessories.append(.customView(configuration: .init(customView: add, placement: .trailing())))
    }
    accessories.append(.disclosureIndicator())
    cell.accessories = accessories
  }

  override func updateContentUnavailableConfiguration(using state: UIContentUnavailableConfigurationState) {
    if let error {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("folder-question", size: 48)
      config.text = "Can't Open This Folder"
      config.secondaryText = error
      contentUnavailableConfiguration = config
    } else if listing == nil {
      contentUnavailableConfiguration = UIContentUnavailableConfiguration.loading()
    } else if listing?.folders.isEmpty == true {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("folder", size: 48)
      config.text = "No Folders Inside"
      contentUnavailableConfiguration = config
    } else if matching.isEmpty {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("search", size: 48)
      config.text = "No Results for “\(query)”"
      config.secondaryText = "Check the spelling or try a new search."
      contentUnavailableConfiguration = config
    } else {
      contentUnavailableConfiguration = nil
    }
  }

  func updateSearchResults(for searchController: UISearchController) {
    let next = searchController.searchBar.text ?? ""
    guard next != query else { return }
    query = next
    refresh()
  }

  // MARK: Actions

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    dataSource.itemIdentifier(for: indexPath) != Self.truncatedRow
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let path = dataSource.itemIdentifier(for: indexPath), path != Self.truncatedRow else { return }
    navigationController?.pushViewController(FolderListController(folder: path, onAdded: onAdded), animated: true)
  }

  private func addOpenFolder() {
    guard let listing else { return }
    add(listing.path)
  }

  private func jump(to root: String) {
    guard let navigation = navigationController, let first = navigation.viewControllers.first else { return }
    navigation.setViewControllers([first, FolderListController(folder: root, onAdded: onAdded)], animated: true)
  }

  private func add(_ path: String) {
    adding = path
    refresh()
    Task {
      do {
        _ = try await model.request(["type": "project.add", "path": path])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onAdded(path)
      } catch {
        adding = nil
        self.error = error.localizedDescription
        refresh()
      }
    }
  }
}
