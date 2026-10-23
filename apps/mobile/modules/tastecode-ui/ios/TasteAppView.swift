import ExpoModulesCore
import ExpoUI
import SwiftUI

final class TasteAppProps: UIBaseViewProps {}

/// The whole interface, in one SwiftUI view the React root hosts.
struct TasteAppView: ExpoSwiftUI.View {
  @ObservedObject var props: TasteAppProps

  init(props: TasteAppProps) {
    self.props = props
  }

  var body: some View {
    RootView()
  }
}

struct RootView: View {
  @State private var model = AppModel.shared

  var body: some View {
    Group {
      if let link = model.link {
        if link.paired {
          ChatsScreen()
        } else {
          PairingScreen(link: link)
        }
      } else {
        Color(.systemBackground)
      }
    }
    .modifier(AppearanceModifier())
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .tint(.primary)
    .environment(model)
  }
}
