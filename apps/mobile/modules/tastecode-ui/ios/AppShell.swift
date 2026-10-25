import ExpoModulesCore
import SwiftUI
import UIKit

/// The whole interface, as one native view the React root fills the screen
/// with. It holds the app's root view controller, so the screens are UIKit
/// controllers with real navigation, not views inside a SwiftUI host.
final class TasteAppView: ExpoView {
  private let root = RootController()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .systemBackground
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, root.parent == nil, let parent = owningController else { return }
    parent.addChild(root)
    root.view.frame = bounds
    root.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(root.view)
    root.didMove(toParent: parent)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    root.view.frame = bounds
  }

  /// The React Native controller this view sits in.
  private var owningController: UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }
}

/// Picks the screen for the link's state, pairing or the chats, and applies
/// the appearance chosen in Settings to everything under it.
final class RootController: UIViewController {
  private let model = AppModel.shared
  private var current: UIViewController?
  private var shown: Screen?

  private enum Screen: Equatable { case blank, pairing, chats }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.tintColor = .label
    applyAppearance()
    NotificationCenter.default.addObserver(
      self, selector: #selector(defaultsChanged), name: UserDefaults.didChangeNotification, object: nil)
  }

  /// UIKit runs this again whenever the model's link changes.
  override func updateProperties() {
    super.updateProperties()
    let screen: Screen = model.link.map { $0.paired ? .chats : .pairing } ?? .blank
    guard screen != shown else { return }
    shown = screen
    switch screen {
    case .blank: show(nil)
    case .pairing: show(Hosted { PairingRoot() })
    case .chats: show(Hosted { ChatsScreen() })
    }
  }

  private func show(_ next: UIViewController?) {
    if let current {
      current.willMove(toParent: nil)
      current.view.removeFromSuperview()
      current.removeFromParent()
    }
    current = next
    guard let next else { return }
    addChild(next)
    next.view.frame = view.bounds
    next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(next.view)
    next.didMove(toParent: self)
  }

  @objc private func defaultsChanged() {
    applyAppearance()
  }

  /// Text size, weight and typeface as traits, so UIKit's fonts and hosted
  /// SwiftUI both follow them.
  private func applyAppearance() {
    let appearance = AppearanceChoice.current
    if let size = appearance.contentSize {
      traitOverrides.preferredContentSizeCategory = size
    } else {
      traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
    }
    if appearance.bold {
      traitOverrides.legibilityWeight = .bold
    } else {
      traitOverrides.remove(UITraitLegibilityWeight.self)
    }
    traitOverrides[FontDesignTrait.self] = appearance.font
  }
}

/// The pairing screen, given the link once it is known.
private struct PairingRoot: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if let link = model.link { PairingScreen(link: link) }
  }
}

/// A SwiftUI screen not yet rewritten in UIKit, with what every screen expects
/// around it: the model, the chosen appearance and the app's tint.
final class Hosted<Content: View>: UIHostingController<HostedRoot<Content>> {
  init(@ViewBuilder _ content: () -> Content) {
    super.init(rootView: HostedRoot(content: content()))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

struct HostedRoot<Content: View>: View {
  let content: Content
  @State private var model = AppModel.shared

  var body: some View {
    content
      .modifier(AppearanceModifier())
      .tint(.primary)
      .environment(model)
  }
}
