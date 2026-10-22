import ExpoModulesCore
import SwiftUI

/// The line under a navigation title (iOS 26), such as the project a chat belongs to.
struct NavigationSubtitleModifier: ViewModifier, Record {
  @Field var text: String = ""

  func body(content: Content) -> some View {
    content.navigationSubtitle(text)
  }
}

/// Hides the tab bar while a pushed screen, such as a chat, is shown.
struct HideTabBarModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.toolbarVisibility(.hidden, for: .tabBar)
  }
}
