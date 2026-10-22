import ExpoModulesCore
import ExpoUI
import SwiftUI

final class ChatScaffoldProps: UIBaseViewProps {}

/// A chat screen: the transcript fills the screen and the composer floats over
/// its bottom edge in Liquid Glass. `safeAreaBar` lets the transcript scroll
/// under the composer with the system's edge effect, and keeps the composer
/// above the keyboard.
struct ChatScaffoldView: ExpoSwiftUI.View {
  @ObservedObject var props: ChatScaffoldProps

  init(props: ChatScaffoldProps) {
    self.props = props
  }

  var body: some View {
    let children = props.children ?? []
    let content = children.filter { !($0.childView is ChatBarView) }
    let bars = children.filter { $0.childView is ChatBarView }
    ZStack {
      ForEach(content, id: \.id) { child in
        let view: any View = child.childView
        AnyView(view)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .safeAreaBar(edge: .bottom, spacing: 0) {
      ForEach(bars, id: \.id) { child in
        let view: any View = child.childView
        AnyView(view)
      }
    }
  }
}

final class ChatBarProps: ExpoSwiftUI.ViewProps {}

/// The scaffold's bottom bar, marked by its type.
struct ChatBarView: ExpoSwiftUI.View {
  @ObservedObject var props: ChatBarProps

  init(props: ChatBarProps) {
    self.props = props
  }

  var body: some View {
    Children()
  }
}
