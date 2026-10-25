import SwiftUI
import UIKit

/// A list row's hold menu, from UIKit instead of SwiftUI's `contextMenu`. The
/// row lifts the same way, but UIKit lets the app say how it leaves: SwiftUI's
/// lifted row slides back on a grey platter that stays for most of a second
/// after the menu closes.
///
/// Placed as the row's background, it finds the list cell that shows the row
/// and holds the menu there, so the cell takes the touch as it does any other.
struct RowMenu: UIViewRepresentable {
  struct Item {
    let title: String
    let icon: String
    let action: () -> Void
  }

  let items: [Item]

  func makeUIView(context: Context) -> Anchor {
    Anchor()
  }

  func updateUIView(_ anchor: Anchor, context: Context) {
    anchor.items = items
  }

  /// An empty view that only finds its cell; the cell carries the interaction.
  final class Anchor: UIView {
    var items: [Item] = []

    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
      backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard window != nil else { return }
      var view = superview
      while let current = view, !(current is UICollectionViewCell) { view = current.superview }
      guard let cell = view else { return }
      // One interaction per cell, answering for whichever row the cell shows now.
      if let existing = cell.interactions.lazy.compactMap({ $0 as? Interaction }).first {
        existing.handler.anchor = self
      } else {
        let interaction = Interaction()
        interaction.handler.anchor = self
        cell.addInteraction(interaction)
      }
    }
  }

  final class Interaction: UIContextMenuInteraction {
    /// Kept here, since an interaction holds its delegate weakly.
    let handler: Handler

    init() {
      let handler = Handler()
      self.handler = handler
      super.init(delegate: handler)
    }
  }

  final class Handler: NSObject, UIContextMenuInteractionDelegate {
    weak var anchor: Anchor?

    func contextMenuInteraction(
      _ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
      guard let items = anchor?.items, !items.isEmpty else { return nil }
      return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
        UIMenu(
          children: items.map { item in
            UIAction(title: item.title, image: Tabler.image(item.icon)) { _ in item.action() }
          })
      }
    }

    /// The row as it lifts: the cell, rounded, a little inside the screen's edges.
    func contextMenuInteraction(
      _ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration,
      highlightPreviewForItemWithIdentifier identifier: any NSCopying
    ) -> UITargetedPreview? {
      guard let cell = interaction.view, cell.window != nil else { return nil }
      let parameters = UIPreviewParameters()
      parameters.visiblePath = UIBezierPath(roundedRect: cell.bounds.insetBy(dx: 10, dy: 0), cornerRadius: 16)
      parameters.backgroundColor = .secondarySystemBackground
      return UITargetedPreview(view: cell, parameters: parameters)
    }

    /// No target to slide back to: the lifted row fades where it is, and the
    /// row underneath is already back in place.
    func contextMenuInteraction(
      _ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration,
      dismissalPreviewForItemWithIdentifier identifier: any NSCopying
    ) -> UITargetedPreview? {
      nil
    }

  }
}
