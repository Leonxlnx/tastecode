import ExpoModulesCore

public final class TasteUIModule: Module {
  private static let reading = DispatchQueue(label: "tastecode.ui.reading", qos: .userInitiated)

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

    // Both keep the order the logic sent them in: through one serial queue,
    // where state is read from its JSON, then one hop to the main queue each.
    Function("update") { (key: String, json: String) in
      Self.reading.async {
        guard let update = AppModel.decode(key, json) else { return }
        DispatchQueue.main.async {
          MainActor.assumeIsolated { AppModel.shared.apply(update) }
        }
      }
    }

    Function("resolve") { (id: String, json: String?, error: String?) in
      Self.reading.async {
        DispatchQueue.main.async {
          MainActor.assumeIsolated { AppModel.shared.resolve(id, json, error) }
        }
      }
    }

    View(TasteAppView.self) {}
  }
}
