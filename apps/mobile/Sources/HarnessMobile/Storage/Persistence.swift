import Foundation
import Security

struct KeychainStore: Sendable {
  private let service: String

  init(service: String = "com.blueemi.Harness") {
    self.service = service
  }

  func read(account: String) throws -> Data? {
    try read(service: service, account: account)
  }

  func read(service: String, account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainFailure(status: status) }
    return item as? Data
  }

  func write(_ data: Data, account: String) throws {
    let identity: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw KeychainFailure(status: updateStatus) }
    var insertion = identity
    insertion.merge(attributes) { _, new in new }
    let addStatus = SecItemAdd(insertion as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw KeychainFailure(status: addStatus) }
  }

  func delete(account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainFailure(status: status)
    }
  }
}

struct KeychainFailure: LocalizedError {
  let status: OSStatus
  var errorDescription: String? { "Keychain operation failed (\(status))." }
}

struct CredentialVault: Sendable {
  private let keychain = KeychainStore()
  private let account = "environments.v1"

  func load() throws -> [PairedEnvironment] {
    let decoder = JSONDecoder()
    if let data = try keychain.read(account: account),
      let environments = try? decoder.decode([PairedEnvironment].self, from: data)
    {
      return environments
    }

    let services = [
      "com.blueemi.Harness",
      "com.blueemi.Harness.pairing",
      "app.personalharness.mobile",
      "app.personalharness.mobile.pairing",
    ]
    let accounts = [
      "com.blueemi.Harness.pairing",
      "app.personalharness.mobile.pairing",
      "paired-environment",
      "pairing",
    ]
    for service in services {
      for legacyAccount in accounts {
        guard let data = try? keychain.read(service: service, account: legacyAccount),
          let environment = try? decoder.decode(PairedEnvironment.self, from: data)
        else { continue }
        try save([environment])
        return [environment]
      }
    }
    return []
  }

  func save(_ environments: [PairedEnvironment]) throws {
    if environments.isEmpty {
      try keychain.delete(account: account)
    } else {
      try keychain.write(JSONEncoder().encode(environments), account: account)
    }
  }
}

struct PreferencesStore: Sendable {
  private let key = "com.blueemi.Harness.preferences.v3"

  func load() -> AppPreferences {
    guard let data = UserDefaults.standard.data(forKey: key),
      let value = try? JSONDecoder().decode(AppPreferences.self, from: data)
    else {
      return AppPreferences()
    }
    return value
  }

  func save(_ preferences: AppPreferences) {
    guard let data = try? JSONEncoder().encode(preferences) else { return }
    UserDefaults.standard.set(data, forKey: key)
  }

  func clear() {
    UserDefaults.standard.removeObject(forKey: key)
  }
}
