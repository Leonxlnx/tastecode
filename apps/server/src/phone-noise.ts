import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'

/**
 * Noise_IK_25519_ChaChaPoly_SHA256 (noiseprotocol.org, revision 34), the
 * handshake of the phone link:
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 *
 * The phone (initiator) already knows this computer's static key from the
 * pairing code, so the first message is encrypted to it and nobody else can
 * answer. Both sides prove their static keys, the session keys are ephemeral,
 * and the phone's identity is never sent in the clear.
 *
 * After the handshake each WebSocket message is one transport message. Unlike
 * Noise's own framing they may be larger than 65535 bytes; the WebSocket
 * delimits them and ChaCha20-Poly1305 has no practical size limit.
 */

export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256'
export const PHONE_LINK_PROLOGUE = 'tastecode-link/1'
const KEY_BYTES = 32
const TAG_BYTES = 16
const EMPTY = Buffer.alloc(0)
/** 2^64 - 1 is reserved by the spec; a link never gets close. */
const MAX_NONCE = 0xffff_ffff_ffff_fffen

export type NoiseKeyPair = { publicKey: Buffer; privateKey: Buffer }

export class NoiseError extends Error {
  override name = 'NoiseError'
}

/** DER prefixes that wrap a raw 32-byte X25519 key as PKCS#8 and SPKI. */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

function privateKeyObject(privateKey: Buffer): KeyObject {
  if (privateKey.length !== KEY_BYTES) throw new NoiseError('Invalid private key length')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, privateKey]),
    format: 'der',
    type: 'pkcs8',
  })
}

function publicKeyObject(publicKey: Buffer): KeyObject {
  if (publicKey.length !== KEY_BYTES) throw new NoiseError('Invalid public key length')
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519, publicKey]),
    format: 'der',
    type: 'spki',
  })
}

function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length)
}

export function generateNoiseKeyPair(): NoiseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: rawPublicKey(publicKey),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length),
  }
}

/** The public half of a raw X25519 private key. */
export function noisePublicKey(privateKey: Buffer): Buffer {
  // A private key's JWK carries its public half as `x`.
  return Buffer.from(privateKeyObject(privateKey).export({ format: 'jwk' }).x ?? '', 'base64url')
}

function dh(pair: NoiseKeyPair, publicKey: Buffer): Buffer {
  const shared = diffieHellman({
    privateKey: privateKeyObject(pair.privateKey),
    publicKey: publicKeyObject(publicKey),
  })
  // A low-order point yields all zeroes; such a key contributes nothing secret.
  if (shared.every((byte) => byte === 0)) throw new NoiseError('Invalid public key')
  return shared
}

function hash(...parts: Buffer[]): Buffer {
  const digest = createHash('sha256')
  for (const part of parts) digest.update(part)
  return digest.digest()
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

function hkdf(chainingKey: Buffer, input: Buffer): [Buffer, Buffer] {
  const tempKey = hmac(chainingKey, input)
  const first = hmac(tempKey, Buffer.from([1]))
  const second = hmac(tempKey, first, Buffer.from([2]))
  return [first, second]
}

function nonceBytes(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(counter, 4)
  return nonce
}

export function encryptWithKey(
  key: Buffer,
  counter: bigint,
  associatedData: Buffer,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonceBytes(counter), {
    authTagLength: TAG_BYTES,
  })
  cipher.setAAD(associatedData, { plaintextLength: plaintext.length })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

export function decryptWithKey(
  key: Buffer,
  counter: bigint,
  associatedData: Buffer,
  ciphertext: Buffer,
): Buffer {
  if (ciphertext.length < TAG_BYTES) throw new NoiseError('Message too short')
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES)
  const decipher = createDecipheriv('chacha20-poly1305', key, nonceBytes(counter), {
    authTagLength: TAG_BYTES,
  })
  decipher.setAAD(associatedData, { plaintextLength: body.length })
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES))
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new NoiseError('Message failed authentication')
  }
}

/** One direction of an established link. Messages must be read in the order sent. */
export class CipherState {
  #key: Buffer
  #counter = 0n

  constructor(key: Buffer) {
    this.#key = key
  }

  encrypt(plaintext: Buffer): Buffer {
    return encryptWithKey(this.#key, this.#next(), EMPTY, plaintext)
  }

  decrypt(ciphertext: Buffer): Buffer {
    return decryptWithKey(this.#key, this.#next(), EMPTY, ciphertext)
  }

  #next(): bigint {
    if (this.#counter > MAX_NONCE) throw new NoiseError('Link nonce exhausted')
    const counter = this.#counter
    this.#counter += 1n
    return counter
  }
}

class SymmetricState {
  chainingKey: Buffer
  handshakeHash: Buffer
  #key: Buffer | undefined
  #counter = 0n

  constructor(prologue: Buffer) {
    const name = Buffer.from(NOISE_PROTOCOL_NAME)
    // Exactly HASHLEN bytes, so the name itself is the initial hash.
    this.handshakeHash = name.length === KEY_BYTES ? name : hash(name)
    this.chainingKey = this.handshakeHash
    this.mixHash(prologue)
  }

  mixHash(data: Buffer): void {
    this.handshakeHash = hash(this.handshakeHash, data)
  }

  mixKey(input: Buffer): void {
    const [chainingKey, key] = hkdf(this.chainingKey, input)
    this.chainingKey = chainingKey
    this.#key = key
    this.#counter = 0n
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    if (!this.#key) {
      this.mixHash(plaintext)
      return plaintext
    }
    const ciphertext = encryptWithKey(this.#key, this.#counter, this.handshakeHash, plaintext)
    this.#counter += 1n
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    if (!this.#key) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const plaintext = decryptWithKey(this.#key, this.#counter, this.handshakeHash, ciphertext)
    this.#counter += 1n
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, EMPTY)
    return [new CipherState(first), new CipherState(second)]
  }
}

export type NoiseSession = {
  /** Encrypts what this side sends. */
  send: CipherState
  /** Decrypts what the other side sends. */
  receive: CipherState
  /** Binds the session to this exact handshake, for tests and diagnostics. */
  handshakeHash: Buffer
}

/** What the responder learns from the first message. */
export type NoiseHello = { remoteStaticKey: Buffer; payload: Buffer }
/** What the initiator learns from the second message. */
export type NoiseWelcome = { payload: Buffer; session: NoiseSession }
/** The second message and the session it starts. */
export type NoiseReply = { message: Buffer; session: NoiseSession }

/** The phone's side. Used by tests and the headless link client. */
export class NoiseInitiator {
  #state: SymmetricState
  #static: NoiseKeyPair
  #ephemeral: NoiseKeyPair
  #remoteStatic: Buffer

  constructor(options: {
    staticKey: NoiseKeyPair
    remoteStaticKey: Buffer
    /** Only for test vectors. A real handshake always generates a fresh key. */
    ephemeralKey?: NoiseKeyPair
    /** Only for test vectors. */
    prologue?: Buffer
  }) {
    this.#state = new SymmetricState(options.prologue ?? Buffer.from(PHONE_LINK_PROLOGUE))
    this.#static = options.staticKey
    this.#remoteStatic = options.remoteStaticKey
    this.#ephemeral = options.ephemeralKey ?? generateNoiseKeyPair()
    this.#state.mixHash(this.#remoteStatic)
  }

  writeMessage1(payload: Buffer): Buffer {
    const state = this.#state
    state.mixHash(this.#ephemeral.publicKey)
    state.mixKey(dh(this.#ephemeral, this.#remoteStatic))
    const encryptedStatic = state.encryptAndHash(this.#static.publicKey)
    state.mixKey(dh(this.#static, this.#remoteStatic))
    const encryptedPayload = state.encryptAndHash(payload)
    return Buffer.concat([this.#ephemeral.publicKey, encryptedStatic, encryptedPayload])
  }

  readMessage2(message: Buffer): NoiseWelcome {
    if (message.length < KEY_BYTES + TAG_BYTES) throw new NoiseError('Handshake message too short')
    const state = this.#state
    const remoteEphemeral = message.subarray(0, KEY_BYTES)
    state.mixHash(remoteEphemeral)
    state.mixKey(dh(this.#ephemeral, remoteEphemeral))
    state.mixKey(dh(this.#static, remoteEphemeral))
    const payload = state.decryptAndHash(message.subarray(KEY_BYTES))
    const [send, receive] = state.split()
    return { payload, session: { send, receive, handshakeHash: state.handshakeHash } }
  }
}

/** This computer's side. */
export class NoiseResponder {
  #state: SymmetricState
  #static: NoiseKeyPair
  #ephemeral: NoiseKeyPair
  #remoteEphemeral: Buffer | undefined
  #remoteStatic: Buffer | undefined

  constructor(options: {
    staticKey: NoiseKeyPair
    /** Only for test vectors. A real handshake always generates a fresh key. */
    ephemeralKey?: NoiseKeyPair
    /** Only for test vectors. */
    prologue?: Buffer
  }) {
    this.#state = new SymmetricState(options.prologue ?? Buffer.from(PHONE_LINK_PROLOGUE))
    this.#static = options.staticKey
    this.#ephemeral = options.ephemeralKey ?? generateNoiseKeyPair()
    this.#state.mixHash(this.#static.publicKey)
  }

  /** Returns the phone's static key, which the caller checks before answering. */
  readMessage1(message: Buffer): NoiseHello {
    if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) {
      throw new NoiseError('Handshake message too short')
    }
    const state = this.#state
    const remoteEphemeral = message.subarray(0, KEY_BYTES)
    state.mixHash(remoteEphemeral)
    state.mixKey(dh(this.#static, remoteEphemeral))
    const remoteStatic = state.decryptAndHash(
      message.subarray(KEY_BYTES, KEY_BYTES + KEY_BYTES + TAG_BYTES),
    )
    state.mixKey(dh(this.#static, remoteStatic))
    const payload = state.decryptAndHash(message.subarray(KEY_BYTES + KEY_BYTES + TAG_BYTES))
    this.#remoteEphemeral = Buffer.from(remoteEphemeral)
    this.#remoteStatic = Buffer.from(remoteStatic)
    return { remoteStaticKey: this.#remoteStatic, payload }
  }

  writeMessage2(payload: Buffer): NoiseReply {
    const remoteEphemeral = this.#remoteEphemeral
    const remoteStatic = this.#remoteStatic
    if (!remoteEphemeral || !remoteStatic) throw new NoiseError('Read the first message first')
    const state = this.#state
    state.mixHash(this.#ephemeral.publicKey)
    state.mixKey(dh(this.#ephemeral, remoteEphemeral))
    state.mixKey(dh(this.#ephemeral, remoteStatic))
    const encryptedPayload = state.encryptAndHash(payload)
    const [receive, send] = state.split()
    return {
      message: Buffer.concat([this.#ephemeral.publicKey, encryptedPayload]),
      session: { send, receive, handshakeHash: state.handshakeHash },
    }
  }
}
