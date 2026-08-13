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
  @State private var path: [MainRoute] = []
  @State private var settingsPresented = false
  @State private var projectPickerPresented = false

  var body: some View {
    NavigationStack(path: $path) {
      ThreadListView(
        openThread: { project, thread in
          model.rememberProject(project)
          path.append(.thread(ThreadRoute(project: project, thread: thread)))
        },
        openSettings: { settingsPresented = true },
        newThread: beginNewThread
      )
      .navigationDestination(for: MainRoute.self) { route in
        switch route {
        case .newThread(let project):
          NewThreadView(project: project) { project, thread in
            let destination = MainRoute.thread(ThreadRoute(project: project, thread: thread))
            if path.isEmpty {
              path.append(destination)
            } else {
              path[path.count - 1] = destination
            }
          }
        case .thread(let threadRoute):
          ThreadView(project: threadRoute.project, thread: threadRoute.thread)
        }
      }
    }
    .sheet(isPresented: $settingsPresented) {
      SettingsView()
        .environmentObject(model)
        .harnessSheetBackground()
    }
    .sheet(isPresented: $projectPickerPresented) {
      ProjectPickerFlow { project in
        projectPickerPresented = false
        path.append(.newThread(project))
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

  private func beginNewThread() {
    if let project = model.preferredProject() {
      model.rememberProject(project)
      path.append(.newThread(project))
    } else {
      projectPickerPresented = true
    }
  }
}

private enum MainRoute: Hashable {
  case newThread(ProjectRecord)
  case thread(ThreadRoute)
}
