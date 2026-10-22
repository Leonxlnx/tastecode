import CryptoKit
import Foundation

/// Noise_IK_25519_ChaChaPoly_SHA256, the phone's side of the TasteCode link.
///
///   <- s
///   ...
///   -> e, es, s, ss
///   <- e, ee, se
///
/// The computer's static key comes from the pairing code, so the first message
/// is readable only by that computer and the phone's own key travels encrypted.
/// The server half lives in `apps/server/src/phone-noise.ts`; both reproduce the
/// cacophony test vector for this protocol name.
enum NoiseError: Error {
  case messageTooShort
  case invalidKey
  case authenticationFailed
  case nonceExhausted
}

let noiseProtocolName = "Noise_IK_25519_ChaChaPoly_SHA256"
let linkPrologue = Data("tastecode-link/1".utf8)
private let keyBytes = 32
private let tagBytes = 16

private func nonce(_ counter: UInt64) throws -> ChaChaPoly.Nonce {
  var bytes = Data(count: 4)
  withUnsafeBytes(of: counter.littleEndian) { bytes.append(contentsOf: $0) }
  return try ChaChaPoly.Nonce(data: bytes)
}

private func seal(_ key: SymmetricKey, _ counter: UInt64, _ ad: Data, _ plaintext: Data) throws -> Data {
  let box = try ChaChaPoly.seal(plaintext, using: key, nonce: nonce(counter), authenticating: ad)
  return box.ciphertext + box.tag
}

private func open(_ key: SymmetricKey, _ counter: UInt64, _ ad: Data, _ message: Data) throws -> Data {
  guard message.count >= tagBytes else { throw NoiseError.messageTooShort }
  let body = message.prefix(message.count - tagBytes)
  let tag = message.suffix(tagBytes)
  do {
    let box = try ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: body, tag: tag)
    return try ChaChaPoly.open(box, using: key, authenticating: ad)
  } catch {
    throw NoiseError.authenticationFailed
  }
}

private func hmac(_ key: Data, _ data: Data) -> Data {
  Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
}

private func hkdf(_ chainingKey: Data, _ input: Data) -> (Data, Data) {
  let temp = hmac(chainingKey, input)
  let first = hmac(temp, Data([1]))
  let second = hmac(temp, first + Data([2]))
  return (first, second)
}

private func dh(_ privateKey: Curve25519.KeyAgreement.PrivateKey, _ publicKey: Data) throws -> Data {
  guard publicKey.count == keyBytes,
    let remote = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
  else { throw NoiseError.invalidKey }
  let shared = try privateKey.sharedSecretFromKeyAgreement(with: remote)
  let bytes = shared.withUnsafeBytes { Data($0) }
  // A low-order point yields all zeroes; such a key contributes nothing secret.
  guard bytes.contains(where: { $0 != 0 }) else { throw NoiseError.invalidKey }
  return bytes
}

/// One direction of an established link. Messages must be read in the order sent.
final class NoiseCipher {
  private let key: SymmetricKey
  private var counter: UInt64 = 0

  init(key: Data) {
    self.key = SymmetricKey(data: key)
  }

  func encrypt(_ plaintext: Data) throws -> Data {
    try seal(key, next(), Data(), plaintext)
  }

  func decrypt(_ message: Data) throws -> Data {
    try open(key, next(), Data(), message)
  }

  private func next() throws -> UInt64 {
    guard counter < UInt64.max else { throw NoiseError.nonceExhausted }
    defer { counter += 1 }
    return counter
  }
}

private struct SymmetricState {
  var chainingKey: Data
  var hash: Data
  var key: SymmetricKey?
  var counter: UInt64 = 0

  init(prologue: Data) {
    let name = Data(noiseProtocolName.utf8)
    // Exactly HASHLEN bytes, so the name itself is the initial hash.
    hash = name.count == keyBytes ? name : Data(SHA256.hash(data: name))
    chainingKey = hash
    mixHash(prologue)
  }

  mutating func mixHash(_ data: Data) {
    hash = Data(SHA256.hash(data: hash + data))
  }

  mutating func mixKey(_ input: Data) {
    let (nextChainingKey, nextKey) = hkdf(chainingKey, input)
    chainingKey = nextChainingKey
    key = SymmetricKey(data: nextKey)
    counter = 0
  }

  mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
    guard let key else {
      mixHash(plaintext)
      return plaintext
    }
    let ciphertext = try seal(key, counter, hash, plaintext)
    counter += 1
    mixHash(ciphertext)
    return ciphertext
  }

  mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
    guard let key else {
      mixHash(ciphertext)
      return ciphertext
    }
    let plaintext = try open(key, counter, hash, ciphertext)
    counter += 1
    mixHash(ciphertext)
    return plaintext
  }

  func split() -> (NoiseCipher, NoiseCipher) {
    let (first, second) = hkdf(chainingKey, Data())
    return (NoiseCipher(key: first), NoiseCipher(key: second))
  }
}

struct NoiseSession {
  let send: NoiseCipher
  let receive: NoiseCipher
  let handshakeHash: Data
}

final class NoiseInitiator {
  private var state: SymmetricState
  private let staticKey: Curve25519.KeyAgreement.PrivateKey
  private let ephemeralKey: Curve25519.KeyAgreement.PrivateKey
  private let remoteStatic: Data

  init(
    staticKey: Curve25519.KeyAgreement.PrivateKey,
    remoteStatic: Data,
    ephemeralKey: Curve25519.KeyAgreement.PrivateKey = Curve25519.KeyAgreement.PrivateKey(),
    prologue: Data = linkPrologue
  ) {
    self.staticKey = staticKey
    self.remoteStatic = remoteStatic
    self.ephemeralKey = ephemeralKey
    state = SymmetricState(prologue: prologue)
    state.mixHash(remoteStatic)
  }

  func writeMessage1(payload: Data) throws -> Data {
    let ephemeralPublic = ephemeralKey.publicKey.rawRepresentation
    state.mixHash(ephemeralPublic)
    state.mixKey(try dh(ephemeralKey, remoteStatic))
    let encryptedStatic = try state.encryptAndHash(staticKey.publicKey.rawRepresentation)
    state.mixKey(try dh(staticKey, remoteStatic))
    let encryptedPayload = try state.encryptAndHash(payload)
    return ephemeralPublic + encryptedStatic + encryptedPayload
  }

  func readMessage2(_ message: Data) throws -> (payload: Data, session: NoiseSession) {
    guard message.count >= keyBytes + tagBytes else { throw NoiseError.messageTooShort }
    let remoteEphemeral = Data(message.prefix(keyBytes))
    state.mixHash(remoteEphemeral)
    state.mixKey(try dh(ephemeralKey, remoteEphemeral))
    state.mixKey(try dh(staticKey, remoteEphemeral))
    let payload = try state.decryptAndHash(Data(message.dropFirst(keyBytes)))
    let (send, receive) = state.split()
    return (payload, NoiseSession(send: send, receive: receive, handshakeHash: state.hash))
  }
}
