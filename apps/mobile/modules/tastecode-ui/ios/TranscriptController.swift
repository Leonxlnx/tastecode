import UIKit

/// Rows' heights for the layout, from whoever owns the rows.
@MainActor
protocol TranscriptLayoutSource: AnyObject {
  func row(at index: Int) -> (height: CGFloat, after: CGFloat)
  /// The row held at the top after sending; the layout leaves room under it.
  var pinnedIndex: Int? { get }
  var viewport: CGFloat { get }
}

/// One column of rows at the heights the source gives: no estimates, no self-sizing.
final class TranscriptLayout: UICollectionViewLayout {
  weak var source: TranscriptLayoutSource?
  static let top: CGFloat = 14
  static let bottom: CGFloat = 24
  static let side: CGFloat = 20
  static let spacing: CGFloat = 22

  private var frames: [UICollectionViewLayoutAttributes] = []
  private var height: CGFloat = 0
  private var inserted: Set<IndexPath> = []
  private var deleted: Set<IndexPath> = []
  /// The frames were worked out when the layout was invalidated, ahead of `prepare`.
  private var placed = false

  override func prepare() {
    super.prepare()
    if placed {
      placed = false
      return
    }
    place()
  }

  /// Rows that changed in place move only themselves and the rows below them;
  /// the list is told how much taller it got, since it does not ask again.
  override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
    if !context.invalidateEverything, !context.invalidateDataSourceCounts, context.invalidatedItemIndexPaths != nil {
      let old = height
      place()
      placed = true
      context.contentSizeAdjustment = CGSize(width: 0, height: height - old)
    } else {
      placed = false
    }
    super.invalidateLayout(with: context)
  }

  private func place() {
    frames.removeAll(keepingCapacity: true)
    guard let collectionView, let source, collectionView.numberOfSections > 0 else {
      height = 0
      return
    }
    let count = collectionView.numberOfItems(inSection: 0)
    let width = max(0, collectionView.bounds.width - Self.side * 2)
    var y = Self.top
    for index in 0..<count {
      let row = source.row(at: index)
      let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
      attributes.frame = CGRect(x: Self.side, y: y, width: width, height: row.height)
      frames.append(attributes)
      y += row.height
      if index < count - 1 { y += Self.spacing + row.after }
    }
    y += Self.bottom
    if let pinned = source.pinnedIndex, pinned < frames.count {
      // Room under a pinned message's turn, so it can reach the top while the reply is short.
      y += max(0, source.viewport - (y - frames[pinned].frame.minY))
    }
    height = y
  }

  override var collectionViewContentSize: CGSize {
    CGSize(width: collectionView?.bounds.width ?? 0, height: height)
  }

  override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
    // The rows are in order down the column: find the first one in the rect, then walk.
    var low = 0
    var high = frames.count
    while low < high {
      let mid = (low + high) / 2
      if frames[mid].frame.maxY < rect.minY { low = mid + 1 } else { high = mid }
    }
    var result: [UICollectionViewLayoutAttributes] = []
    var index = low
    while index < frames.count, frames[index].frame.minY <= rect.maxY {
      result.append(frames[index])
      index += 1
    }
    return result
  }

  override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    indexPath.item < frames.count ? frames[indexPath.item] : nil
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
    newBounds.width != collectionView?.bounds.width
  }

  override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
    super.prepare(forCollectionViewUpdates: updateItems)
    inserted = Set(updateItems.compactMap { $0.updateAction == .insert ? $0.indexPathAfterUpdate : nil })
    deleted = Set(updateItems.compactMap { $0.updateAction == .delete ? $0.indexPathBeforeUpdate : nil })
  }

  override func finalizeCollectionViewUpdates() {
    super.finalizeCollectionViewUpdates()
    inserted = []
    deleted = []
  }

  override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard let attributes = layoutAttributesForItem(at: itemIndexPath)?.copy() as? UICollectionViewLayoutAttributes
    else { return nil }
    if inserted.contains(itemIndexPath) {
      attributes.alpha = 0
      attributes.transform = CGAffineTransform(translationX: 0, y: 8)
    }
    return attributes
  }

  override func finalLayoutAttributesForDisappearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard let attributes = super.finalLayoutAttributesForDisappearingItem(at: itemIndexPath)?.copy()
      as? UICollectionViewLayoutAttributes
    else { return nil }
    if deleted.contains(itemIndexPath) { attributes.alpha = 0 }
    return attributes
  }
}

/// The conversation, newest at the bottom: rows are laid out off the main
/// thread at their exact height, and a streaming reply redraws only the
/// block that grew. It follows the reply while you are at the bottom, holds
/// still while you read further up, and pins what you just sent to the top.
@MainActor
final class TranscriptController: UIViewController, UICollectionViewDelegate, TranscriptLayoutSource,
  TranscriptContext
{
  private enum Special {
    static let older = "§older"
    static let working = "§working"
    static let plan = "§plan"
    static let placeholder = "§placeholder"
  }

  private struct Anchor {
    let key: String?
    let offset: CGFloat
    let bottom: Bool
  }

  private let model: AppModel
  private let store: ThreadStore
  private let flow = TranscriptLayout()
  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private let topFade = EdgeFadeView(edge: .top)
  private let bottomFade = EdgeFadeView(edge: .bottom)
  private let jumpButton = UIButton(configuration: .glass())

  private var layouts: [String: RowLayout] = [:]
  private var items: [String] = []
  private(set) var style: TranscriptStyle
  private var width: CGFloat = 0
  private var scale: CGFloat = 3
  private let queue = DispatchQueue(label: "tastecode.transcript.layout", qos: .userInitiated)
  private var laying = false
  private var dirty: Set<String> = []
  private var dirtyAll = true
  private var metaDirty = true
  private var folding = false

  /// The first rows arrive after the screen appears; they open at the newest message.
  private var placed = false
  private var atBottom = true
  /// After sending, the new message is held at the top with its reply below, as on the desktop.
  private var pinned: String?
  private var awaitingPin = false
  private var pinScroll = false
  private var scrollingToPin = false
  private var jumpToken: Int
  private var askedForOlder = false
  private var loadingImages: Set<String> = []
  /// Where the text ahead of the reader was last drawn from.
  private var prefetchedAt = CGFloat.nan
  /// What each extra row (older history, working, plan, placeholder) was last built from.
  private var extras: [String: ThreadMetaView] = [:]

  init(model: AppModel, store: ThreadStore, jumpToken: Int) {
    self.model = model
    self.store = store
    self.jumpToken = jumpToken
    style = TranscriptStyle(traits: UITraitCollection.current)
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    flow.source = self
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: flow)
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .clear
    collectionView.contentInsetAdjustmentBehavior = .always
    collectionView.keyboardDismissMode = .interactive
    collectionView.alwaysBounceVertical = true
    collectionView.delegate = self
    // The title bar fades the messages under it rather than cutting them off.
    collectionView.topEdgeEffect.isHidden = true
    for type in [
      AssistantCell.self, UserCell.self, StepsCell.self, NoticeCell.self, ErrorCell.self, WorkingCell.self,
      PlanCell.self, OlderCell.self, PlaceholderCell.self,
    ] as [TranscriptCell.Type] {
      collectionView.register(type, forCellWithReuseIdentifier: String(describing: type))
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) {
      [unowned self] collectionView, indexPath, key in
      let layout = self.layouts[key] ?? RowLayout(content: .older(loading: false), height: 0)
      let cell =
        collectionView.dequeueReusableCell(withReuseIdentifier: Self.reuse(layout), for: indexPath) as! TranscriptCell
      cell.key = key
      cell.context = self
      cell.apply(layout, animated: false)
      return cell
    }
    view.addSubview(collectionView)
    view.addSubview(topFade)
    view.addSubview(bottomFade)

    var jump = UIButton.Configuration.glass()
    jump.image = Tabler.image("arrow-down", size: 18)
    jump.cornerStyle = .capsule
    jumpButton.configuration = jump
    jumpButton.accessibilityLabel = "Scroll to the newest message"
    jumpButton.addTarget(self, action: #selector(jumpToBottom), for: .touchUpInside)
    jumpButton.alpha = 0
    jumpButton.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
    view.addSubview(jumpButton)

    store.onChange = { [weak self] change in self?.storeChanged(change) }
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLegibilityWeight.self, FontDesignTrait.self,
    ]) { (controller: TranscriptController, _: UITraitCollection) in
      controller.style = TranscriptStyle(traits: controller.traitCollection)
      controller.dirtyAll = true
      controller.schedule()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    topFade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: view.safeAreaInsets.top + 36)
    // From a little above the composer down to the screen's edge.
    let bottom = collectionView.adjustedContentInset.bottom + 20
    bottomFade.frame = CGRect(x: 0, y: view.bounds.height - bottom, width: view.bounds.width, height: bottom)
    jumpButton.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
    jumpButton.center = CGPoint(
      x: view.bounds.midX, y: view.bounds.height - collectionView.adjustedContentInset.bottom - 30)
    scale = max(traitCollection.displayScale, 1)
    if style.key != TranscriptStyle.key(traitCollection) {
      // Built before the screen knew its type; the rows are laid out again in it.
      style = TranscriptStyle(traits: traitCollection)
      dirtyAll = true
    }
    let next = max(0, collectionView.bounds.width - TranscriptLayout.side * 2)
    if next > 0, next != width {
      width = next
      dirtyAll = true
    }
    schedule()
  }

  private static func reuse(_ layout: RowLayout) -> String {
    switch layout.content {
    case .assistant: return "AssistantCell"
    case .user: return "UserCell"
    case .steps: return "StepsCell"
    case .notice: return "NoticeCell"
    case .error: return "ErrorCell"
    case .working: return "WorkingCell"
    case .plan: return "PlanCell"
    case .older: return "OlderCell"
    case .placeholder: return "PlaceholderCell"
    }
  }

  // MARK: Sent messages

  func jump(_ token: Int) {
    guard token != jumpToken else { return }
    jumpToken = token
    // The message just sent arrives as a new row; it is pinned when it does.
    awaitingPin = true
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(4))
      self?.awaitingPin = false
    }
  }

  func bottomBar(_ height: CGFloat) {
    guard isViewLoaded, collectionView.contentInset.bottom != height else { return }
    let follow = !placed || isAtBottom
    collectionView.contentInset.bottom = height
    collectionView.verticalScrollIndicatorInsets.bottom = height
    view.setNeedsLayout()
    view.layoutIfNeeded()
    if follow && placed && pinned == nil {
      collectionView.contentOffset.y = maxOffset
    }
  }

  @objc private func jumpToBottom() {
    pinned = nil
    flow.invalidateLayout()
    collectionView.layoutIfNeeded()
    collectionView.setContentOffset(CGPoint(x: 0, y: maxOffset), animated: true)
  }

  // MARK: Layout pipeline

  private func storeChanged(_ change: ThreadChange) {
    dirty.formUnion(change.rows)
    if change.reset { dirtyAll = true }
    if change.orderChanged || change.metaChanged { metaDirty = true }
    if change.folding { folding = true }
    schedule()
  }

  /// Lays out what changed on the layout queue, one batch at a time; changes
  /// that arrive meanwhile wait for the next batch, so a fast stream coalesces.
  private func schedule() {
    guard isViewLoaded, width > 0, !laying else { return }
    guard dirtyAll || !dirty.isEmpty || metaDirty else { return }
    var keys = dirtyAll ? Set(store.order) : dirty.intersection(store.order)
    for key in store.order where layouts[key] == nil { keys.insert(key) }
    let everything = dirtyAll
    dirty.removeAll()
    dirtyAll = false
    metaDirty = false
    let animate = folding
    folding = false
    let order = store.order
    let meta = store.meta
    var inputs: [(String, RowView, RowUI)] = []
    for key in keys {
      guard let row = store.rows[key] else { continue }
      inputs.append((key, row.row, RowUI(expanded: row.expanded, openRuns: row.openRuns)))
    }
    guard !inputs.isEmpty else {
      finish([:], inputs: [], order: order, meta: meta, animate: animate, everything: everything)
      return
    }
    laying = true
    let width = width
    let style = style
    let images = imageSizes()
    let scale = scale
    queue.async { [weak self] in
      var made: [String: RowLayout] = [:]
      made.reserveCapacity(inputs.count)
      for (key, row, ui) in inputs {
        made[key] = RowLayouts.make(row, ui: ui, width: width, style: style, images: images, scale: scale)
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.laying = false
        if width != self.width || style !== self.style {
          self.dirtyAll = true
        } else {
          self.finish(made, inputs: inputs, order: order, meta: meta, animate: animate, everything: everything)
        }
        self.schedule()
      }
    }
  }

  private func finish(
    _ made: [String: RowLayout], inputs: [(String, RowView, RowUI)], order: [String], meta: ThreadMetaView?,
    animate: Bool, everything: Bool
  ) {
    var changed: Set<String> = []
    for (key, _, ui) in inputs {
      guard let layout = made[key] else { continue }
      // A fold opened or shut while this was laid out: its own layout is newer.
      if let row = store.rows[key], RowUI(expanded: row.expanded, openRuns: row.openRuns) != ui {
        dirty.insert(key)
        continue
      }
      layouts[key] = layout
      changed.insert(key)
    }

    var next: [String] = []
    /// Builds an extra row again only when what it shows changed, so it does
    /// not count as a changed row, and move the list, on every update.
    func extra(_ key: String, _ meta: ThreadMetaView, same: (ThreadMetaView) -> Bool, make: () -> RowLayout) {
      next.append(key)
      if !everything, layouts[key] != nil, let previous = extras[key], same(previous) { return }
      layouts[key] = make()
      extras[key] = meta
      changed.insert(key)
    }
    if let meta {
      if meta.hasOlder {
        extra(Special.older, meta, same: { $0.loadingOlder == meta.loadingOlder }) {
          RowLayouts.older(loading: meta.loadingOlder)
        }
        if !meta.loadingOlder && order != items.filter({ !$0.hasPrefix("§") }) { askedForOlder = false }
      }
    }
    next.append(contentsOf: order)
    if let meta {
      if meta.waiting {
        extra(Special.working, meta, same: { _ in true }) { RowLayouts.working("Working", style: style, scale: scale) }
      }
      if !meta.plan.isEmpty {
        extra(Special.plan, meta, same: { $0.plan == meta.plan }) {
          RowLayouts.plan(meta.plan, width: width, style: style, scale: scale)
        }
      }
      if order.isEmpty && meta.status != .ready {
        extra(Special.placeholder, meta, same: { $0 == meta }) {
          RowLayouts.placeholder(meta, width: width, style: style, scale: scale)
        }
      }
    }

    let lastUser = order.last { store.rows[$0]?.row.kind == .user }
    if awaitingPin, let lastUser, lastUser != pinned, !items.contains(lastUser) {
      awaitingPin = false
      pinned = lastUser
      pinScroll = true
    } else if let current = pinned, !order.contains(current) {
      // The sent message came back from the computer under its own id.
      pinned = lastUser
    }

    let anchor = captureAnchor()
    if next != items {
      let before = items
      var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
      snapshot.appendSections([0])
      snapshot.appendItems(next)
      let existing = Set(before)
      snapshot.reconfigureItems(changed.filter { existing.contains($0) && next.contains($0) })
      let prepended = Self.prepends(before, next)
      items = next
      let animated = placed && !before.isEmpty && !prepended && !everything && UIView.areAnimationsEnabled
      if animated && animate {
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
          self.dataSource.apply(snapshot, animatingDifferences: true)
        }
      } else {
        dataSource.apply(snapshot, animatingDifferences: animated)
      }
    } else {
      var first = Int.max
      for key in changed {
        guard let indexPath = dataSource.indexPath(for: key) else { continue }
        first = min(first, indexPath.item)
        guard let cell = collectionView.cellForItem(at: indexPath) as? TranscriptCell, let layout = layouts[key]
        else { continue }
        if cell.reuseIdentifier == Self.reuse(layout) {
          cell.apply(layout, animated: false)
        } else {
          var snapshot = dataSource.snapshot()
          snapshot.reloadItems([key])
          dataSource.apply(snapshot, animatingDifferences: false)
        }
      }
      if first < items.count {
        // Only the rows that changed and those below them move: a streaming
        // reply is the last row, so the list re-places one or two cells.
        let context = UICollectionViewLayoutInvalidationContext()
        context.invalidateItems(at: (first..<items.count).map { IndexPath(item: $0, section: 0) })
        flow.invalidateLayout(with: context)
      }
    }
    collectionView.layoutIfNeeded()
    restore(anchor)
    revealVisible()
    prefetchText()
    let kept = Set(items)
    if layouts.count > kept.count + 8 {
      layouts = layouts.filter { kept.contains($0.key) }
    }
    updateJumpButton()
  }

  /// Whether rows arrived above the ones already shown: older history loading in.
  private static func prepends(_ before: [String], _ after: [String]) -> Bool {
    guard let first = before.first(where: { !$0.hasPrefix("§") }) else { return false }
    let old = Set(before)
    return after.prefix { $0 != first }.contains { !$0.hasPrefix("§") && !old.contains($0) }
  }

  // MARK: Where the reader is

  private var maxOffset: CGFloat {
    let inset = collectionView.adjustedContentInset
    return max(-inset.top, flow.collectionViewContentSize.height + inset.bottom - collectionView.bounds.height)
  }

  private var isAtBottom: Bool {
    // The bottom of what is readable: the visible rect less the composer over it.
    let inset = collectionView.adjustedContentInset
    return collectionView.contentOffset.y + collectionView.bounds.height - inset.bottom
      >= flow.collectionViewContentSize.height - 48
  }

  var viewport: CGFloat {
    let inset = collectionView.adjustedContentInset
    return collectionView.bounds.height - inset.top - inset.bottom
  }

  var pinnedIndex: Int? {
    pinned.flatMap { dataSource.indexPath(for: $0)?.item }
  }

  func row(at index: Int) -> (height: CGFloat, after: CGFloat) {
    guard let key = dataSource.itemIdentifier(for: IndexPath(item: index, section: 0)), let layout = layouts[key] else {
      return (0, 0)
    }
    return (layout.height, layout.after)
  }

  private func frame(of key: String) -> CGRect? {
    guard let indexPath = dataSource.indexPath(for: key) else { return nil }
    return flow.layoutAttributesForItem(at: indexPath)?.frame
  }

  private func captureAnchor() -> Anchor {
    let bottom = placed && isAtBottom
    let offset = collectionView.contentOffset.y
    if let pinned, let frame = frame(of: pinned) {
      return Anchor(key: pinned, offset: frame.minY - offset, bottom: false)
    }
    let top = offset + collectionView.adjustedContentInset.top
    for (index, key) in items.enumerated() {
      guard let frame = flow.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { continue }
      if frame.maxY > top { return Anchor(key: key, offset: frame.minY - offset, bottom: bottom) }
    }
    return Anchor(key: nil, offset: 0, bottom: bottom)
  }

  private func restore(_ anchor: Anchor) {
    guard !items.isEmpty else { return }
    if !placed {
      guard !store.order.isEmpty else { return }
      placed = true
      collectionView.contentOffset.y = maxOffset
      return
    }
    if pinScroll, let pinned, let frame = frame(of: pinned) {
      pinScroll = false
      scrollingToPin = true
      let target = min(frame.minY - collectionView.adjustedContentInset.top - 8, maxOffset)
      collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: true)
      return
    }
    // A finger on the list or a scroll to a pinned message wins over following.
    guard !collectionView.isTracking, !scrollingToPin else { return }
    if anchor.bottom && pinned == nil {
      collectionView.contentOffset.y = maxOffset
    } else if let key = anchor.key, let frame = frame(of: key) {
      let target = frame.minY - anchor.offset
      if abs(target - collectionView.contentOffset.y) > 0.5 {
        collectionView.contentOffset.y = min(max(target, -collectionView.adjustedContentInset.top), max(maxOffset, target))
      }
    }
  }

  private func updateJumpButton() {
    let hidden = atBottom || items.allSatisfy { $0.hasPrefix("§") }
    let visible = jumpButton.alpha > 0.5
    guard hidden == visible else { return }
    UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0) {
      self.jumpButton.alpha = hidden ? 0 : 1
      self.jumpButton.transform = hidden ? CGAffineTransform(scaleX: 0.6, y: 0.6) : .identity
    }
  }

  /// Tells the replies on screen which part of them is in view.
  private func revealVisible() {
    let visible = collectionView.bounds
    for case let cell as TranscriptCell in collectionView.visibleCells {
      cell.reveal(visible, in: collectionView)
    }
  }

  /// Draws, in the background, the text a screen and a half above and below,
  /// so rows scrolling in show it at once instead of drawing it on the way.
  private func prefetchText() {
    let visible = collectionView.bounds
    guard visible.height > 0, !(abs(visible.minY - prefetchedAt) < visible.height / 4) else { return }
    prefetchedAt = visible.minY
    let region = visible.insetBy(dx: 0, dy: -visible.height * 1.5)
    let traits = traitCollection
    for attributes in flow.layoutAttributesForElements(in: region) ?? [] {
      guard let key = dataSource.itemIdentifier(for: attributes.indexPath), let layout = layouts[key],
        store.rows[key]?.row.streaming != true
      else { continue }
      let doc: DocLayout
      switch layout.content {
      case .assistant(let reply): doc = reply
      case .user(let user): doc = user.doc
      default: continue
      }
      let local = region.offsetBy(dx: -attributes.frame.minX, dy: -attributes.frame.minY)
      for piece in DocumentView.texts(in: doc, within: local) {
        TextRenderer.shared.prefetch(TextImageKey(text: piece.text, size: piece.size, traits: traits))
      }
    }
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    revealVisible()
    prefetchText()
    let bottom = isAtBottom
    if bottom != atBottom {
      atBottom = bottom
      updateJumpButton()
    }
  }

  /// The keyboard or the composer changed how much of the list they cover:
  /// a reader at the bottom stays at the bottom.
  func scrollViewDidChangeAdjustedContentInset(_ scrollView: UIScrollView) {
    guard placed, atBottom, pinned == nil, !scrollView.isTracking else { return }
    scrollView.contentOffset.y = maxOffset
    view.setNeedsLayout()
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    scrollingToPin = false
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    scrollingToPin = false
  }

  func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    (cell as? TranscriptCell)?.reveal(collectionView.bounds, in: collectionView)
    guard dataSource.itemIdentifier(for: indexPath) == Special.older, !askedForOlder,
      store.meta?.loadingOlder != true
    else { return }
    askedForOlder = true
    model.send(["type": "thread.loadOlder", "threadId": store.id])
  }

  func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool { false }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool { false }

  // MARK: Context

  func image(for key: String) -> UIImage? {
    model.images[key] ?? RemoteImages.shared.image(key)
  }

  func imageMissing(_ key: String) -> Bool {
    model.missingImages.contains(key) || RemoteImages.shared.failed(key)
  }

  func loadImage(_ image: ImageLayout) {
    let key = image.key
    guard !loadingImages.contains(key), self.image(for: key) == nil, !imageMissing(key) else { return }
    loadingImages.insert(key)
    if let url = URL(string: key), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      RemoteImages.shared.load(url) { [weak self] in self?.imageArrived(key) }
    } else {
      Task { [weak self, model, store] in
        await model.loadImage(threadId: store.id, path: key)
        self?.imageArrived(key)
      }
    }
  }

  private func imageArrived(_ key: String) {
    loadingImages.remove(key)
    for (row, layout) in layouts where layout.images.contains(key) {
      dirty.insert(row)
    }
    schedule()
  }

  private func imageSizes() -> ImageSizes {
    var sizes = ImageSizes()
    for (key, image) in model.images { sizes.loaded[key] = image.size }
    for (key, size) in RemoteImages.shared.sizes() { sizes.loaded[key] = size }
    sizes.missing = model.missingImages.union(RemoteImages.shared.failures())
    return sizes
  }

  func openImage(_ image: UIImage) {
    present(ImageViewer(image: image), animated: true)
  }

  func openLink(_ url: URL) {
    guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
    UIApplication.shared.open(url)
  }

  func retryOpen() {
    model.send(["type": "thread.open", "threadId": store.id])
  }

  /// Opens or shuts a fold where it is: the row keeps its place and the rows
  /// below move with it.
  func toggle(row key: String, part: String?) {
    guard let row = store.rows[key] else { return }
    if let part {
      if row.openRuns.contains(part) { row.openRuns.remove(part) } else { row.openRuns.insert(part) }
    } else {
      row.expanded.toggle()
    }
    let opening = part == nil ? row.expanded : row.openRuns.contains(part!)
    let layout = RowLayouts.make(
      row.row, ui: RowUI(expanded: row.expanded, openRuns: row.openRuns), width: width, style: style,
      images: imageSizes(), scale: scale)
    layouts[key] = layout
    let cell = dataSource.indexPath(for: key).flatMap { collectionView.cellForItem(at: $0) as? TranscriptCell }
    let anchor = captureAnchor()
    UIView.animate(
      withDuration: opening ? 0.38 : 0.26, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
      options: [.allowUserInteraction, .beginFromCurrentState]
    ) {
      // The collection view's own animated relayout moves every row in step with the fold.
      self.collectionView.performBatchUpdates(nil)
      cell?.apply(layout, animated: true)
      if self.collectionView.contentOffset.y > self.maxOffset {
        self.collectionView.contentOffset.y = self.maxOffset
      } else if anchor.key != key, let anchored = anchor.key, let frame = self.frame(of: anchored), !anchor.bottom {
        self.collectionView.contentOffset.y = frame.minY - anchor.offset
      }
    }
    revealVisible()
  }

  // MARK: Copying and selecting

  func collectionView(
    _ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let indexPath = indexPaths.first, let key = dataSource.itemIdentifier(for: indexPath),
      let row = store.rows[key]?.row, let text = row.text, !text.isEmpty
    else { return nil }
    guard [.assistant, .user, .error, .notice].contains(row.kind) else { return nil }
    return UIContextMenuConfiguration(identifier: key as NSString, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [
        UIAction(title: "Copy", image: Tabler.image("copy")) { _ in
          UIPasteboard.general.string = text
        },
        UIAction(title: "Select Text", image: Tabler.image("cursor-text")) { _ in
          self?.selectText(key)
        },
      ])
    }
  }

  private func selectText(_ key: String) {
    guard let layout = layouts[key] else { return }
    let text: NSAttributedString
    switch layout.content {
    case .assistant(let doc): text = DocumentView.selectable(doc)
    case .user(let user): text = user.text ?? NSAttributedString()
    case .notice(let value), .error(let value, _): text = value
    default: return
    }
    let controller = SelectTextController(text: text)
    present(UINavigationController(rootViewController: controller), animated: true)
  }
}

/// Changes to an open chat, as the transcript needs them.
struct ThreadChange {
  /// Rows that are new or changed.
  var rows: Set<String> = []
  var orderChanged = false
  var metaChanged = false
  /// Rows went away because a turn folded its work under "Worked for".
  var folding = false
  var reset = false
}

/// A message's text to select any part of, in a sheet.
final class SelectTextController: UIViewController {
  private let text: NSAttributedString

  init(text: NSAttributedString) {
    self.text = text
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Select Text"
    view.backgroundColor = .systemBackground
    let textView = UITextView(frame: view.bounds)
    textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    textView.isEditable = false
    textView.isSelectable = true
    textView.attributedText = text
    textView.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 32, right: 16)
    textView.backgroundColor = .clear
    view.addSubview(textView)
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
  }
}

/// A progressive blur at an edge of the list: under the title bar, strongest at
/// the top; under the composer, strongest at the bottom. Messages fade into the
/// bars rather than being cut off by them.
final class EdgeFadeView: UIView {
  private let edge: UIRectEdge
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
  private let blurMask = GradientView()
  private let tint = GradientView()

  init(edge: UIRectEdge) {
    self.edge = edge
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    blurMask.gradient.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
    blurMask.gradient.locations = [0, 0.7, 1]
    if edge == .bottom {
      blurMask.gradient.startPoint = CGPoint(x: 0.5, y: 1)
      blurMask.gradient.endPoint = CGPoint(x: 0.5, y: 0)
      tint.gradient.startPoint = CGPoint(x: 0.5, y: 1)
      tint.gradient.endPoint = CGPoint(x: 0.5, y: 0)
    }
    blur.mask = blurMask
    addSubview(blur)
    addSubview(tint)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: EdgeFadeView, _: UITraitCollection) in
      view.updateTint()
    }
    updateTint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func updateTint() {
    let background = UIColor.systemBackground.resolvedColor(with: traitCollection)
    tint.gradient.colors = [0.94, 0.86, 0].map { background.withAlphaComponent($0).cgColor }
    tint.gradient.locations = [0, 0.68, 1]
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    blur.frame = bounds
    blurMask.frame = blur.bounds
    tint.frame = bounds
  }
}

final class GradientView: UIView {
  override class var layerClass: AnyClass { CAGradientLayer.self }
  var gradient: CAGradientLayer { layer as! CAGradientLayer }
}

/// Pictures replies show from the web, kept while the app runs.
@MainActor
final class RemoteImages {
  static let shared = RemoteImages()
  private var images: [String: UIImage] = [:]
  private var failed: Set<String> = []
  private var waiting: [String: [() -> Void]] = [:]

  func image(_ key: String) -> UIImage? { images[key] }
  func failed(_ key: String) -> Bool { failed.contains(key) }
  func sizes() -> [String: CGSize] { images.mapValues(\.size) }
  func failures() -> Set<String> { failed }

  func load(_ url: URL, done: @escaping () -> Void) {
    let key = url.absoluteString
    if waiting[key] != nil {
      waiting[key]?.append(done)
      return
    }
    waiting[key] = [done]
    Task {
      let image: UIImage?
      do {
        let (data, _) = try await URLSession.shared.data(from: url)
        image = await Task.detached { UIImage(data: data)?.preparingForDisplay() }.value
      } catch {
        image = nil
      }
      if let image { images[key] = image } else { failed.insert(key) }
      let callbacks = waiting.removeValue(forKey: key) ?? []
      callbacks.forEach { $0() }
    }
  }
}
