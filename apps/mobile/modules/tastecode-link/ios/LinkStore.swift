import CryptoKit
import Foundation
import Security

/// What the phone keeps about its link: its own X25519 key and the computer it
/// paired with, both in the Keychain, available after first unlock and never
/// synced or backed up to another device.
enum LinkStore {
  private static let service = "dev.tastecode.mobile.link"
  private static let deviceKeyAccount = "device-key"
  private static let pairingAccount = "pairing"

  static func deviceKey() throws -> Curve25519.KeyAgreement.PrivateKey {
    if let data = read(deviceKeyAccount),
      let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
    {
      return key
    }
    let key = Curve25519.KeyAgreement.PrivateKey()
    try write(deviceKeyAccount, key.rawRepresentation)
    return key
  }

  static func resetDeviceKey() {
    delete(deviceKeyAccount)
  }

  static func pairing() -> String? {
    read(pairingAccount).flatMap { String(data: $0, encoding: .utf8) }
  }

  static func setPairing(_ json: String) throws {
    try write(pairingAccount, Data(json.utf8))
  }

  static func clearPairing() {
    delete(pairingAccount)
  }

  private static func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  private static func read(_ account: String) -> Data? {
    var item = query(account)
    item[kSecReturnData as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  private static func write(_ account: String, _ data: Data) throws {
    let update = [kSecValueData as String: data]
    let status = SecItemUpdate(query(account) as CFDictionary, update as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw LinkStoreError.keychain(status) }
    var item = query(account)
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess else { throw LinkStoreError.keychain(added) }
  }

  private static func delete(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}

enum LinkStoreError: Error, CustomStringConvertible {
  case keychain(OSStatus)

  var description: String {
    switch self {
    case .keychain(let status): return "The Keychain refused the link key (\(status))"
    }
  }
}
