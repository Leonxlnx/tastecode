import UIKit

/// A page of grouped rows like the system's Settings, under optional headers
/// and footers. A page describes its rows in `sections()`; a row is drawn
/// again when what it shows changes.
class FormController: UIViewController, UICollectionViewDelegate {
  struct Section {
    var id: String
    var header: String?
    var footer: String?
    var rows: [Row]
  }

  struct Row {
    var id: String
    /// What the row shows, to tell when it needs drawing again.
    var key: String
    var configure: (UICollectionViewListCell, UITraitCollection) -> Void
    /// What a tap does; a row without one does not highlight.
    var action: (() -> Void)?
  }

  let model = AppModel.shared
  private(set) var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, String>!
  private var current: [Section] = []

  /// The page's rows as they should be now.
  func sections() -> [Section] { [] }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    navigationItem.largeTitleDisplayMode = .never
    let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
      var config = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
      config.backgroundColor = .clear
      let section = self.flatMap { index < $0.current.count ? $0.current[index] : nil }
      config.headerMode = section?.header == nil ? .none : .supplementary
      config.footerMode = section?.footer == nil ? .none : .supplementary
      return .list(using: config, layoutEnvironment: environment)
    }
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .clear
    collectionView.delegate = self
    view.addSubview(collectionView)

    let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, indexPath, _ in
      guard let self, let row = self.row(at: indexPath) else { return }
      cell.accessories = []
      row.configure(cell, self.traitCollection)
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, indexPath, id in
      view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: id)
    }
    let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
      elementKind: UICollectionView.elementKindSectionHeader
    ) { [weak self] view, _, indexPath in
      guard let self, indexPath.section < self.current.count else { return }
      var content = UIListContentConfiguration.header()
      content.text = self.current[indexPath.section].header
      content.textProperties.font = content.textProperties.font.designed(self.traitCollection)
      view.contentConfiguration = content
    }
    let footer = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
      elementKind: UICollectionView.elementKindSectionFooter
    ) { [weak self] view, _, indexPath in
      guard let self, indexPath.section < self.current.count else { return }
      var content = UIListContentConfiguration.footer()
      content.text = self.current[indexPath.section].footer
      content.textProperties.font = content.textProperties.font.designed(self.traitCollection)
      view.contentConfiguration = content
    }
    dataSource.supplementaryViewProvider = { view, kind, indexPath in
      kind == UICollectionView.elementKindSectionHeader
        ? view.dequeueConfiguredReusableSupplementary(using: header, for: indexPath)
        : view.dequeueConfiguredReusableSupplementary(using: footer, for: indexPath)
    }
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (page: FormController, _: UITraitCollection) in
      page.reload(force: true)
    }
  }

  /// UIKit runs this again whenever what `sections()` reads changes, and on
  /// its own passes too, a touch on a switch among them.
  override func updateProperties() {
    super.updateProperties()
    reload()
  }

  /// Takes the rows from `sections()` and draws again only what changed:
  /// drawing a row again mid-touch would take its switch from under the finger.
  func reload(force: Bool = false) {
    guard isViewLoaded else { return }
    let next = sections()
    let before = Dictionary(current.flatMap(\.rows).map { ($0.id, $0.key) }, uniquingKeysWith: { first, _ in first })
    let shape = { (sections: [Section]) in
      sections.map { "\($0.id)|\($0.header ?? "-")|\($0.footer ?? "-")|\($0.rows.map(\.id))" }
    }
    let reshaped = shape(next) != shape(current)
    let hadSupplements = current.map { [$0.header != nil, $0.footer != nil] }
    let changed = next.flatMap(\.rows).filter { force || before[$0.id] != $0.key }.map(\.id)
    current = next
    guard force || reshaped || !changed.isEmpty else { return }
    var snapshot = NSDiffableDataSourceSnapshot<String, String>()
    for section in next {
      snapshot.appendSections([section.id])
      snapshot.appendItems(section.rows.map(\.id), toSection: section.id)
    }
    let kept = Set(dataSource.snapshot().itemIdentifiers)
    snapshot.reconfigureItems(changed.filter(kept.contains))
    if next.map({ [$0.header != nil, $0.footer != nil] }) != hadSupplements {
      collectionView.collectionViewLayout.invalidateLayout()
    }
    dataSource.apply(snapshot, animatingDifferences: view.window != nil)
    for kind in [UICollectionView.elementKindSectionHeader, UICollectionView.elementKindSectionFooter] {
      for indexPath in collectionView.indexPathsForVisibleSupplementaryElements(ofKind: kind) {
        guard indexPath.section < next.count,
          let view = collectionView.supplementaryView(forElementKind: kind, at: indexPath) as? UICollectionViewListCell,
          var content = view.contentConfiguration as? UIListContentConfiguration
        else { continue }
        let section = next[indexPath.section]
        content.text = kind == UICollectionView.elementKindSectionHeader ? section.header : section.footer
        content.textProperties.font = (kind == UICollectionView.elementKindSectionHeader
          ? UIListContentConfiguration.header() : UIListContentConfiguration.footer()).textProperties.font
          .designed(traitCollection)
        view.contentConfiguration = content
      }
    }
  }

  private func row(at indexPath: IndexPath) -> Row? {
    guard indexPath.section < current.count, indexPath.item < current[indexPath.section].rows.count else { return nil }
    return current[indexPath.section].rows[indexPath.item]
  }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    row(at: indexPath)?.action != nil
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    row(at: indexPath)?.action?()
  }

  // MARK: Rows

  /// A name, with its icon in the text's colour and what it holds on the
  /// right; with an action, a row that opens something.
  func row(
    _ id: String, _ title: String, icon: String? = nil, value: String? = nil, mono: Bool = false,
    disclosure: Bool = false, action: (() -> Void)? = nil
  ) -> Row {
    Row(id: id, key: "\(title)|\(icon ?? "")|\(value ?? "")|\(mono)|\(disclosure)", configure: { cell, traits in
      var content = UIListContentConfiguration.valueCell()
      content.text = title
      content.textProperties.font = .app(.body, traits: traits)
      if let icon {
        content.image = Tabler.image(icon)
        content.imageProperties.tintColor = .label
        // Where a SwiftUI label in a form puts its icon and title.
        content.directionalLayoutMargins.leading += 2
        content.imageToTextPadding += 2
      }
      content.secondaryText = value
      content.secondaryTextProperties.font =
        mono
        ? .monospacedSystemFont(
          ofSize: UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits).pointSize, weight: .regular)
        : .app(.body, traits: traits)
      content.secondaryTextProperties.color = .secondaryLabel
      cell.contentConfiguration = content
      if disclosure { cell.accessories = [.disclosureIndicator()] }
    }, action: action)
  }

  /// A name over a line of detail, opening something.
  func subtitleRow(
    _ id: String, _ title: String, detail: String, detailColor: UIColor = .secondaryLabel, action: @escaping () -> Void
  ) -> Row {
    Row(id: id, key: "\(title)|\(detail)|\(detailColor)", configure: { cell, traits in
      var content = UIListContentConfiguration.subtitleCell()
      content.text = title
      content.textProperties.font = .app(.body, traits: traits)
      content.secondaryText = detail
      content.secondaryTextProperties.font = .app(.subheadline, traits: traits)
      content.secondaryTextProperties.color = detailColor
      content.textToSecondaryTextVerticalPadding = 2
      content.directionalLayoutMargins.top += 2
      content.directionalLayoutMargins.bottom += 2
      cell.contentConfiguration = content
      cell.accessories = [.disclosureIndicator()]
    }, action: action)
  }

  /// A button as a row: the accent colour, or red when it destroys something.
  func buttonRow(_ id: String, _ title: String, destructive: Bool = false, action: @escaping () -> Void) -> Row {
    Row(id: id, key: "\(title)|\(destructive)", configure: { cell, traits in
      var content = UIListContentConfiguration.cell()
      content.text = title
      content.textProperties.font = .app(.body, traits: traits)
      content.textProperties.color = destructive ? .systemRed : .label
      cell.contentConfiguration = content
    }, action: action)
  }

  /// A line of small print inside a section.
  func noteRow(_ id: String, _ text: String) -> Row {
    Row(id: id, key: text, configure: { cell, traits in
      var content = UIListContentConfiguration.cell()
      content.text = text
      content.textProperties.font = .app(.footnote, traits: traits)
      content.textProperties.color = .secondaryLabel
      cell.contentConfiguration = content
    })
  }

  /// A switch beside a name.
  func toggleRow(_ id: String, _ title: String, toggle: UISwitch) -> Row {
    Row(id: id, key: title, configure: { cell, traits in
      var content = UIListContentConfiguration.cell()
      content.text = title
      content.textProperties.font = .app(.body, traits: traits)
      cell.contentConfiguration = content
      cell.accessories = [.customView(configuration: .init(customView: toggle, placement: .trailing()))]
    })
  }

  /// A row that holds a view of the page's own; a new `version` measures it again.
  func viewRow(_ id: String, _ content: UIView, insets: NSDirectionalEdgeInsets, version: String = "") -> Row {
    Row(id: id, key: version, configure: { cell, _ in
      cell.contentConfiguration = EmbeddedConfiguration(view: content, insets: insets)
    })
  }

  func push(_ page: UIViewController) {
    navigationController?.pushViewController(page, animated: true)
  }
}

/// A content configuration that shows one view the page keeps.
struct EmbeddedConfiguration: UIContentConfiguration {
  let view: UIView
  let insets: NSDirectionalEdgeInsets

  func makeContentView() -> UIView & UIContentView {
    EmbeddedContentView(configuration: self)
  }

  func updated(for state: UIConfigurationState) -> EmbeddedConfiguration { self }
}

private final class EmbeddedContentView: UIView, UIContentView {
  var configuration: UIContentConfiguration {
    didSet { embed() }
  }

  init(configuration: EmbeddedConfiguration) {
    self.configuration = configuration
    super.init(frame: .zero)
    embed()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func embed() {
    guard let embedded = configuration as? EmbeddedConfiguration else { return }
    guard embedded.view.superview !== self else { return }
    subviews.forEach { $0.removeFromSuperview() }
    embedded.view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(embedded.view)
    let insets = embedded.insets
    NSLayoutConstraint.activate([
      embedded.view.leadingAnchor.constraint(equalTo: leadingAnchor, constant: insets.leading),
      embedded.view.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -insets.trailing),
      embedded.view.topAnchor.constraint(equalTo: topAnchor, constant: insets.top),
      embedded.view.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -insets.bottom),
    ])
  }
}

extension UIFont {
  /// The same font in the typeface chosen in Settings.
  func designed(_ traits: UITraitCollection) -> UIFont {
    guard let design = traits[FontDesignTrait.self].systemDesign,
      let descriptor = fontDescriptor.withDesign(design)
    else { return self }
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

extension UIViewController {
  /// The cross that closes a sheet, as a bar button.
  func closeItem() -> UIBarButtonItem {
    let item = UIBarButtonItem(image: Tabler.image("x", size: 22), primaryAction: UIAction { [weak self] _ in
      self?.dismiss(animated: true)
    })
    item.accessibilityLabel = "Close"
    return item
  }
}

/// Settings, as a list of pages like the system's: the paired devices
/// first, then the app itself.
final class SettingsController: FormController {
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Settings"
    navigationItem.rightBarButtonItem = closeItem()
  }

  override func sections() -> [Section] {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    return [
      Section(id: "connections", header: "Connections", rows: [
        row("devices", "Devices", icon: "device-laptop", value: model.link == nil ? "" : "1", disclosure: true) {
          [weak self] in self?.push(DevicesController())
        }
      ]),
      Section(id: "interface", header: "Interface", rows: [
        row("appearance", "Appearance", icon: "text-size", disclosure: true) { [weak self] in
          self?.push(AppearanceController())
        }
      ]),
      Section(id: "app", header: "App", rows: [
        row("about", "About", icon: "info-circle", value: version, disclosure: true) { [weak self] in
          self?.push(AboutController())
        }
      ]),
    ]
  }
}

/// How the link to the computer stands, in a few words.
private func computerStatus(_ link: LinkView?) -> String {
  switch link?.phase {
  case .open: return link?.host.map { "Connected · \($0)" } ?? "Connected"
  case .connecting, .idle, nil: return "Connecting…"
  case .waiting: return "Not reachable"
  case .refused: return "Needs pairing again"
  }
}

/// The computers this phone is paired with, one row each. A phone pairs
/// with one computer today; the list is ready for more.
private final class DevicesController: FormController {
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Devices"
  }

  override func sections() -> [Section] {
    guard let link = model.link else { return [Section(id: "devices", rows: [])] }
    return [
      Section(id: "devices", rows: [
        subtitleRow(
          "computer", link.computerName ?? "Computer", detail: computerStatus(link),
          detailColor: link.phase == .refused ? .systemRed : .secondaryLabel
        ) { [weak self] in self?.push(ComputerController()) }
      ])
    ]
  }
}

/// The paired computer: whether it answers, the keys that prove it is the one
/// you paired, and the way to forget it.
private final class ComputerController: FormController {
  override func sections() -> [Section] {
    let link = model.link
    let name = link?.computerName ?? "Computer"
    title = name
    var status = [row("status", "Status", value: link?.phase == .open ? "Connected" : computerStatus(link))]
    if let host = link?.host, link?.phase == .open {
      status.append(row("address", "Address", value: host))
    }
    if let error = link?.error, link?.phase != .open {
      status.append(noteRow("error", error))
    }
    if link?.phase == .waiting {
      status.append(buttonRow("retry", "Try Again") { [weak self] in self?.model.send(["type": "reconnect"]) })
    }
    var keys: [Row] = []
    if let key = link?.computerKey {
      keys.append(row("computerKey", "Computer", value: key, mono: true))
    }
    keys.append(row("phoneKey", "This phone", value: link?.phoneKey ?? "", mono: true))
    return [
      Section(id: "name", rows: [
        row("name", "Name", value: name, disclosure: true) { [weak self] in self?.push(ComputerNameController()) }
      ]),
      Section(id: "status", rows: status),
      Section(
        id: "keys", header: "Keys",
        footer:
          "The link is encrypted end to end and only this computer's key can answer it, over Wi‑Fi or Tailscale. Nothing passes through a server.",
        rows: keys),
      Section(id: "forget", rows: [
        buttonRow("forget", "Forget This Computer", destructive: true) { [weak self] in self?.forget(name) }
      ]),
    ]
  }

  private func forget(_ name: String) {
    let alert = UIAlertController(
      title: "Forget \(name)?", message: "This phone stops connecting and has to be paired again from the computer.",
      preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Forget", style: .destructive) { [weak self] _ in
      guard let self else { return }
      let model = self.model
      self.navigationController?.dismiss(animated: true)
      model.send(["type": "forget"])
    })
    present(alert, animated: true)
  }
}

/// Renames the computer on this phone only; an empty name goes back to the computer's own.
private final class ComputerNameController: FormController, UITextFieldDelegate {
  private let field = UITextField()

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Name"
    field.text = model.link?.computerName ?? ""
    field.placeholder = model.link?.defaultName ?? "Name"
    field.returnKeyType = .done
    field.clearButtonMode = .whileEditing
    field.delegate = self
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    field.becomeFirstResponder()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    let name = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard name != model.link?.computerName else { return }
    model.send(["type": "computer.rename", "name": name == model.link?.defaultName ? "" : name])
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    navigationController?.popViewController(animated: true)
    return false
  }

  override func sections() -> [Section] {
    field.font = .app(.body, traits: traitCollection)
    return [
      Section(
        id: "name",
        footer: model.link?.defaultName.map { "Only this phone uses this name. Leave it empty to use \($0)." },
        rows: [viewRow("field", field, insets: NSDirectionalEdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))])
    ]
  }
}

private final class AboutController: FormController {
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "About"
  }

  override func sections() -> [Section] {
    let info = Bundle.main
    return [
      Section(id: "about", rows: [
        row("version", "Version", value: info.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""),
        row("build", "Build", value: info.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""),
      ])
    ]
  }
}
