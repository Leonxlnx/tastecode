import UIKit

/// What the chat changed in its checkout, file by file.
final class ChangesSheet: UINavigationController {
  init(threadId: String) {
    super.init(rootViewController: ChangesController(threadId: threadId))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

private final class ChangesController: UIViewController, UICollectionViewDelegate {
  private let model = AppModel.shared
  private let threadId: String
  private var diff: SessionDiff?
  private var error: String?
  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  init(threadId: String) {
    self.threadId = threadId
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "Changes"
    navigationItem.largeTitleDisplayMode = .never
    navigationItem.rightBarButtonItem = closeItem()
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.backgroundColor = .clear
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .clear
    collectionView.delegate = self
    view.addSubview(collectionView)
    let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, path in
      guard let self, let file = self.diff?.files.first(where: { $0.path == path }) else { return }
      cell.contentConfiguration = FileRowConfiguration(file: file, traits: self.traitCollection)
      cell.accessories = [.disclosureIndicator()]
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, indexPath, path in
      view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: path)
    }
    Task {
      do {
        diff = try await model.request(SessionDiff.self, ["type": "thread.diff", "threadId": threadId])
      } catch {
        self.error = error.localizedDescription
      }
      refresh()
    }
  }

  private func refresh() {
    let files = diff?.files ?? []
    if files.isEmpty {
      navigationItem.subtitle = ""
    } else {
      let added = files.reduce(0) { $0 + $1.added }
      let removed = files.reduce(0) { $0 + $1.removed }
      navigationItem.subtitle = "\(files.count) \(files.count == 1 ? "file" : "files") · +\(added) −\(removed)"
    }
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(files.map(\.path))
    dataSource.apply(snapshot, animatingDifferences: false)
    setNeedsUpdateContentUnavailableConfiguration()
  }

  override func updateContentUnavailableConfiguration(using state: UIContentUnavailableConfigurationState) {
    if let error {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("alert-triangle", size: 48)
      config.text = "No Changes Shown"
      config.secondaryText = error
      contentUnavailableConfiguration = config
    } else if diff == nil {
      contentUnavailableConfiguration = UIContentUnavailableConfiguration.loading()
    } else if diff?.files.isEmpty == true {
      var config = UIContentUnavailableConfiguration.empty()
      config.image = Tabler.image("check", size: 48)
      config.text = "No Changes"
      config.secondaryText = "The checkout this chat works in has no uncommitted changes."
      contentUnavailableConfiguration = config
    } else {
      contentUnavailableConfiguration = nil
    }
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let path = dataSource.itemIdentifier(for: indexPath),
      let file = diff?.files.first(where: { $0.path == path })
    else { return }
    navigationController?.pushViewController(DiffController(file: file), animated: true)
  }
}

private func fileName(_ path: String) -> String {
  path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
}

/// "+12 −3", green and red: the one place a change's size is coloured.
func lineCounts(added: Int, removed: Int, font: UIFont) -> NSAttributedString {
  let text = NSMutableAttributedString()
  let digits = font.monospacedDigits
  if added > 0 || removed == 0 {
    text.append(NSAttributedString(string: "+\(added)", attributes: [.font: digits, .foregroundColor: UIColor.systemGreen]))
  }
  if removed > 0 {
    if text.length > 0 { text.append(NSAttributedString(string: " ", attributes: [.font: digits])) }
    text.append(NSAttributedString(string: "−\(removed)", attributes: [.font: digits, .foregroundColor: UIColor.systemRed]))
  }
  return text
}

/// A changed file: its name over its path, and how many lines it gained and lost.
private struct FileRowConfiguration: UIContentConfiguration {
  let file: DiffFile
  let traits: UITraitCollection

  func makeContentView() -> UIView & UIContentView { FileRowView(configuration: self) }
  func updated(for state: UIConfigurationState) -> FileRowConfiguration { self }
}

private final class FileRowView: UIView, UIContentView {
  private let name = UILabel()
  private let path = UILabel()
  private let counts = UILabel()
  private var withPath: NSLayoutConstraint!
  private var withoutPath: NSLayoutConstraint!

  var configuration: UIContentConfiguration {
    didSet { show() }
  }

  init(configuration: FileRowConfiguration) {
    self.configuration = configuration
    super.init(frame: .zero)
    name.lineBreakMode = .byTruncatingTail
    path.textColor = .secondaryLabel
    path.lineBreakMode = .byTruncatingHead
    counts.setContentCompressionResistancePriority(.required, for: .horizontal)
    counts.setContentHuggingPriority(.required, for: .horizontal)
    for label in [name, path, counts] {
      label.translatesAutoresizingMaskIntoConstraints = false
      addSubview(label)
    }
    // Where a SwiftUI list puts a two-line row's text.
    directionalLayoutMargins = NSDirectionalEdgeInsets(top: 14.5, leading: 16, bottom: 14.5, trailing: 8)
    // Plain constraints, not a baseline-aligned stack: measured for a list
    // cell, such a stack's height has no upper bound.
    let margins = layoutMarginsGuide
    withPath = path.bottomAnchor.constraint(equalTo: margins.bottomAnchor)
    withoutPath = name.bottomAnchor.constraint(equalTo: margins.bottomAnchor)
    NSLayoutConstraint.activate([
      name.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      name.topAnchor.constraint(equalTo: margins.topAnchor),
      name.trailingAnchor.constraint(lessThanOrEqualTo: counts.leadingAnchor, constant: -12),
      path.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
      path.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 2),
      path.trailingAnchor.constraint(lessThanOrEqualTo: counts.leadingAnchor, constant: -12),
      counts.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
      counts.firstBaselineAnchor.constraint(equalTo: name.firstBaselineAnchor),
    ])
    show()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func show() {
    guard let configuration = configuration as? FileRowConfiguration else { return }
    let file = configuration.file
    let traits = configuration.traits
    name.text = fileName(file.path)
    name.font = .app(.body, traits: traits)
    path.text = file.path
    path.font = .app(.footnote, traits: traits)
    path.isHidden = fileName(file.path) == file.path
    withPath.isActive = !path.isHidden
    withoutPath.isActive = path.isHidden
    let small = UIFont.app(.subheadline, traits: traits)
    if file.binary {
      counts.attributedText = NSAttributedString(
        string: "Binary", attributes: [.font: small, .foregroundColor: UIColor.tertiaryLabel])
    } else {
      counts.attributedText = lineCounts(added: file.added, removed: file.removed, font: small)
    }
  }
}

/// One file's changes, line by line, as a unified diff.
private final class DiffController: UIViewController {
  private let file: DiffFile
  private let scroller = UIScrollView()
  private let lines = DiffLinesView()
  private let more = UILabel()
  private let limit = 1500

  init(file: DiffFile) {
    self.file = file
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = fileName(file.path)
    navigationItem.subtitle = fileName(file.path) == file.path ? "" : file.path
    navigationItem.largeTitleDisplayMode = .never
    scroller.frame = view.bounds
    scroller.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scroller.alwaysBounceVertical = true
    view.addSubview(scroller)
    scroller.addSubview(lines)
    more.textColor = .secondaryLabel
    scroller.addSubview(more)

    var flat: [(kind: String, text: String)] = []
    for hunk in file.hunks {
      flat.append(("header", hunk.header?.isEmpty == false ? hunk.header! : "@@ \(hunk.oldStart) → \(hunk.newStart) @@"))
      for line in hunk.lines {
        flat.append((line.kind, "\(line.kind == "addition" ? "+" : line.kind == "deletion" ? "−" : " ") \(line.text)"))
      }
    }
    lines.show(Array(flat.prefix(limit)))
    if flat.count > limit {
      more.text = "\(flat.count - limit) more lines on the computer"
      more.font = .app(.footnote, traits: traitCollection)
    }
    more.isHidden = flat.count <= limit
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let width = max(lines.contentWidth, scroller.bounds.width)
    lines.frame = CGRect(x: 0, y: 8, width: width, height: lines.contentHeight)
    var bottom = lines.frame.maxY + 8
    if !more.isHidden {
      let size = more.sizeThatFits(CGSize(width: scroller.bounds.width - 32, height: .greatestFiniteMagnitude))
      more.frame = CGRect(x: 16, y: lines.frame.maxY + 16, width: size.width, height: size.height)
      bottom = more.frame.maxY + 16
    }
    scroller.contentSize = CGSize(width: width, height: bottom)
  }
}

/// The diff's lines, drawn a tile at a time as they scroll in, so a long
/// file does not keep one huge picture of itself.
private final class DiffLinesView: UIView {
  private struct Line {
    let kind: String
    let text: NSAttributedString
    let y: CGFloat
    let height: CGFloat
    let pad: CGFloat
  }

  private var entries: [(kind: String, text: String)] = []
  private var rows: [Line] = []
  /// Resolved here: tiles are drawn off the main thread, where the screen's colours are not known.
  private var addition = UIColor.clear.cgColor
  private var deletion = UIColor.clear.cgColor
  private(set) var contentWidth: CGFloat = 0
  private(set) var contentHeight: CGFloat = 0

  override class var layerClass: AnyClass { InstantTiledLayer.self }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isOpaque = false
    (layer as? CATiledLayer)?.tileSize = CGSize(width: 1024, height: 1024)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: DiffLinesView, _: UITraitCollection) in
      view.build()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func show(_ lines: [(kind: String, text: String)]) {
    entries = lines
    build()
  }

  private func build() {
    let traits = traitCollection
    let primary = UIColor.label.resolvedColor(with: traits)
    let secondary = UIColor.secondaryLabel.resolvedColor(with: traits)
    addition = UIColor.systemGreen.withAlphaComponent(0.14).resolvedColor(with: traits).cgColor
    deletion = UIColor.systemRed.withAlphaComponent(0.14).resolvedColor(with: traits).cgColor
    let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    let line = ceil(font.lineHeight)
    var y: CGFloat = 0
    var widest: CGFloat = 0
    rows = entries.map { entry in
      let header = entry.kind == "header"
      let text = NSAttributedString(
        string: entry.text.isEmpty ? " " : entry.text,
        attributes: [.font: font, .foregroundColor: header ? secondary : primary])
      widest = max(widest, ceil(text.size().width))
      let pad: CGFloat = header ? 6 : 1.5
      let row = Line(kind: entry.kind, text: text, y: y, height: line + pad * 2, pad: pad)
      y += row.height
      return row
    }
    contentWidth = widest + 32
    contentHeight = y
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    for row in rows where row.y + row.height >= rect.minY && row.y <= rect.maxY {
      let band = CGRect(x: rect.minX, y: row.y, width: rect.width, height: row.height)
      switch row.kind {
      case "addition":
        context.setFillColor(addition)
        context.fill(band)
      case "deletion":
        context.setFillColor(deletion)
        context.fill(band)
      default:
        break
      }
      row.text.draw(at: CGPoint(x: 16, y: row.y + row.pad))
    }
  }
}

/// Tiles fade in by default; these should simply be there.
private final class InstantTiledLayer: CATiledLayer {
  override class func fadeDuration() -> CFTimeInterval { 0 }
}
