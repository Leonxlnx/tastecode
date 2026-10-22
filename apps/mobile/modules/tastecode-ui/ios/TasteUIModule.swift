import ExpoModulesCore
import ExpoUI

public final class TasteUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TasteUI")

    Events("onAction")

    OnCreate {
      let emit: (String, String) -> Void = { [weak self] id, action in
        self?.sendEvent("onAction", ["id": id, "action": action])
      }
      DispatchQueue.main.async {
        MainActor.assumeIsolated { AppModel.shared.emit = emit }
      }
    }

    // Both keep the order the logic sent them in: one serial hop to the main queue each.
    Function("update") { (key: String, json: String) in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { AppModel.shared.update(key, json) }
      }
    }

    Function("resolve") { (id: String, json: String?, error: String?) in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { AppModel.shared.resolve(id, json, error) }
      }
    }

    ExpoUIView(TasteAppView.self)
  }
}
