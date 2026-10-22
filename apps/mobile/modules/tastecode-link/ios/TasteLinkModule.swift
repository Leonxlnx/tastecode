import ExpoModulesCore
import Foundation
import Network

struct ConnectOptions: Record {
  /// The computer's static key from the pairing code, base64url.
  @Field var key: String = ""
  @Field var hosts: [String] = []
  @Field var port: Int = 0
  /// The first message's JSON payload: version, phone name and, once, the pairing secret.
  @Field var hello: String = ""
}

public final class TasteLinkModule: Module {
  private let client = LinkClient()
  private let monitor = NWPathMonitor()
  private var monitoring = false

  public func definition() -> ModuleDefinition {
    Name("TasteLink")

    Events("onLinkState", "onLinkFrames", "onPathChange")

    OnCreate {
      self.client.onState = { [weak self] event in
        self?.sendEvent("onLinkState", event)
      }
      self.client.onFrames = { [weak self] attempt, frames in
        self?.sendEvent("onLinkFrames", ["attempt": attempt, "frames": frames])
      }
    }

    OnStartObserving {
      guard !self.monitoring else { return }
      self.monitoring = true
      self.monitor.pathUpdateHandler = { [weak self] path in
        self?.sendEvent("onPathChange", [
          "satisfied": path.status == .satisfied,
          "wifi": path.usesInterfaceType(.wifi),
          "expensive": path.isExpensive,
        ])
      }
      self.monitor.start(queue: DispatchQueue(label: "dev.tastecode.link.path"))
    }

    OnDestroy {
      self.client.close()
      self.monitor.cancel()
    }

    /// This phone's public key, created on first use.
    Function("deviceKey") { () -> String in
      try LinkStore.deviceKey().publicKey.rawRepresentation.base64URLEncodedString()
    }

    Function("readPairing") { () -> String? in
      LinkStore.pairing()
    }

    Function("writePairing") { (json: String) in
      try LinkStore.setPairing(json)
    }

    /// Forgets the computer and this phone's key, so a new pairing starts as a new phone.
    Function("forgetPairing") {
      self.client.close()
      LinkStore.clearPairing()
      LinkStore.resetDeviceKey()
    }

    Function("connect") { (options: ConnectOptions) -> Int in
      guard let key = Data(base64URLEncoded: options.key), key.count == 32 else {
        throw Exception(name: "InvalidKey", description: "The pairing code does not hold a valid computer key")
      }
      return try self.client.connect(
        serverKey: key,
        hosts: options.hosts,
        port: UInt16(clamping: options.port),
        hello: Data(options.hello.utf8)
      )
    }

    Function("send") { (frame: String) -> Bool in
      self.client.send(frame)
    }

    Function("close") {
      self.client.close()
    }

    Function("readPreference") { (key: String) -> String? in
      UserDefaults.standard.string(forKey: "tastecode.\(key)")
    }

    Function("writePreference") { (key: String, value: String?) in
      if let value {
        UserDefaults.standard.set(value, forKey: "tastecode.\(key)")
      } else {
        UserDefaults.standard.removeObject(forKey: "tastecode.\(key)")
      }
    }
  }
}

extension Data {
  init?(base64URLEncoded value: String) {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }

  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
