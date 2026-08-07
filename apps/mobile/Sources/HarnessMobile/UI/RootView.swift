import SwiftUI

struct RootView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Group {
      if !model.isReady {
        LaunchView()
      } else if model.activeEnvironment == nil {
        PairingWelcomeView()
      } else {
        MainShell()
      }
    }
    .background(HarnessColor.background.ignoresSafeArea())
    .animation(.snappy(duration: 0.35), value: model.activeEnvironment?.id)
    .alert(
      "Harness",
      isPresented: Binding(
        get: { model.errorMessage != nil },
        set: { if !$0 { model.clearError() } }
      ),
      actions: { Button("OK", role: .cancel) { model.clearError() } },
      message: { Text(model.errorMessage ?? "") }
    )
  }
}

private struct LaunchView: View {
  var body: some View {
    VStack(spacing: 18) {
      ProviderGlyph(provider: .codex, size: 42)
      Text("Harness")
        .font(.title2.bold())
      LucideLoader(size: 18)
        .foregroundStyle(HarnessColor.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct MainShell: View {
  @EnvironmentObject private var model: AppModel
  @State private var path: [ThreadRoute] = []
  @State private var settingsPresented = false
  @State private var newThreadPresented = false

  var body: some View {
    NavigationStack(path: $path) {
      ThreadListView(
        openThread: { project, thread in
          path.append(ThreadRoute(project: project, thread: thread))
        },
        openSettings: { settingsPresented = true },
        newThread: { newThreadPresented = true }
      )
      .navigationDestination(for: ThreadRoute.self) { route in
        ThreadView(project: route.project, thread: route.thread)
      }
    }
    .sheet(isPresented: $settingsPresented) {
      SettingsView()
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .sheet(isPresented: $newThreadPresented) {
      NewThreadFlow { project, thread in
        newThreadPresented = false
        path.append(ThreadRoute(project: project, thread: thread))
      }
      .environmentObject(model)
      .harnessSheetBackground()
    }
    .sheet(
      isPresented: Binding(
        get: { model.pairingLink != nil },
        set: { if !$0 { model.pairingLink = nil } }
      )
    ) {
      AddEnvironmentView(initialLink: model.pairingLink ?? "")
        .environmentObject(model)
        .harnessSheetBackground()
    }
  }
}
