import ExpoModulesCore
import ExpoUI

public final class TasteUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TasteUI")

    OnCreate {
      ViewModifierRegistry.register("navigationSubtitle") { params, appContext, _ in
        try NavigationSubtitleModifier(from: params, appContext: appContext)
      }
      ViewModifierRegistry.register("hideTabBar") { params, appContext, _ in
        try HideTabBarModifier(from: params, appContext: appContext)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister("navigationSubtitle")
      ViewModifierRegistry.unregister("hideTabBar")
    }

    ExpoUIView(MarkdownTextView.self)
    ExpoUIView(ChatScaffoldView.self)
    View(ChatBarView.self)
    ExpoUIView(QRScannerView.self)
  }
}
