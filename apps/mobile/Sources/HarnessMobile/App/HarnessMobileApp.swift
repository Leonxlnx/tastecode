import SwiftUI

@main
struct HarnessMobileApp: App {
  @StateObject private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
        .preferredColorScheme(.dark)
        .tint(.white)
        .task { await model.bootstrap() }
        .onOpenURL { model.receive(url: $0) }
    }
  }
}
