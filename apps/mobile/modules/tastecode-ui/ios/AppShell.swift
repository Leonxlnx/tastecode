import ExpoModulesCore
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
    // The app's tint is the text's colour, sheets and alerts included.
    window?.tintColor = .label
    root.appWindow = window
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
/// the appearance chosen in Settings to the whole window.
final class RootController: UIViewController {
  private let model = AppModel.shared
  private var current: UIViewController?
  private var shown: Screen?
  /// The window the app is in, which carries the appearance.
  weak var appWindow: UIWindow? {
    didSet { applyAppearance() }
  }

  private enum Screen: Equatable { case blank, pairing, chats }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.tintColor = .label
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
    case .pairing: show(PairingController())
    case .chats: show(AppNavigation())
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

  /// Text size, weight and typeface as traits, so every screen's fonts follow
  /// them. On the window, not this controller: sheets are presented from the
  /// React root above it and would not see its traits.
  private func applyAppearance() {
    guard let window = appWindow else { return }
    let appearance = AppearanceChoice.current
    if let size = appearance.contentSize {
      window.traitOverrides.preferredContentSizeCategory = size
    } else {
      window.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
    }
    if appearance.bold {
      window.traitOverrides.legibilityWeight = .bold
    } else {
      window.traitOverrides.remove(UITraitLegibilityWeight.self)
    }
    window.traitOverrides[FontDesignTrait.self] = appearance.font
  }
}
