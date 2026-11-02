import { describe, expect, it } from 'vitest'
import {
  generateNoiseKeyPair,
  NoiseError,
  NoiseInitiator,
  NoiseResponder,
  noisePublicKey,
  type NoiseKeyPair,
} from './phone-noise.js'

const hex = (value: string) => Buffer.from(value, 'hex')
const pair = (privateKey: string): NoiseKeyPair => ({
  privateKey: hex(privateKey),
  publicKey: noisePublicKey(hex(privateKey)),
})

/** The Noise_IK_25519_ChaChaPoly_SHA256 vector from cacophony's published test vectors. */
const vector = {
  prologue: '4a6f686e2047616c74',
  initStatic: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
  initEphemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
  respStatic: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
  respEphemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
  remoteStaticPublic: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
  handshakeHash: '0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7',
  messages: [
    [
      '4c756477696720766f6e204d69736573',
      'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7',
    ],
    [
      '4d757272617920526f746862617264',
      '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5',
    ],
    ['462e20412e20486179656b', '050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8'],
    ['4361726c204d656e676572', '344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667'],
    [
      '4a65616e2d426170746973746520536179',
      '62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4',
    ],
    [
      '457567656e2042f6686d20766f6e2042617765726b',
      '029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024',
    ],
  ],
}

describe('Noise IK', () => {
  it('reproduces the published test vector byte for byte', () => {
    const responderStatic = pair(vector.respStatic)
    expect(responderStatic.publicKey.toString('hex')).toBe(vector.remoteStaticPublic)
    const initiator = new NoiseInitiator({
      staticKey: pair(vector.initStatic),
      remoteStaticKey: responderStatic.publicKey,
      ephemeralKey: pair(vector.initEphemeral),
      prologue: hex(vector.prologue),
    })
    const responder = new NoiseResponder({
      staticKey: responderStatic,
      ephemeralKey: pair(vector.respEphemeral),
      prologue: hex(vector.prologue),
    })
    const [first, second, ...transport] = vector.messages

    const message1 = initiator.writeMessage1(hex(first![0]))
    expect(message1.toString('hex')).toBe(first![1])
    const read1 = responder.readMessage1(message1)
    expect(read1.payload.toString('hex')).toBe(first![0])
    expect(read1.remoteStaticKey).toEqual(pair(vector.initStatic).publicKey)

    const written2 = responder.writeMessage2(hex(second![0]))
    expect(written2.message.toString('hex')).toBe(second![1])
    const read2 = initiator.readMessage2(written2.message)
    expect(read2.payload.toString('hex')).toBe(second![0])
    expect(read2.session.handshakeHash.toString('hex')).toBe(vector.handshakeHash)
    expect(written2.session.handshakeHash.toString('hex')).toBe(vector.handshakeHash)

    transport.forEach(([payload, ciphertext], index) => {
      const [sender, receiver] =
        index % 2 === 0 ? [read2.session, written2.session] : [written2.session, read2.session]
      expect(sender.send.encrypt(hex(payload!)).toString('hex')).toBe(ciphertext)
      expect(receiver.receive.decrypt(hex(ciphertext!)).toString('hex')).toBe(payload)
    })
  })

  it('refuses a first message meant for another computer', () => {
    const phone = generateNoiseKeyPair()
    const computer = generateNoiseKeyPair()
    const other = generateNoiseKeyPair()
    const initiator = new NoiseInitiator({ staticKey: phone, remoteStaticKey: other.publicKey })
    const responder = new NoiseResponder({ staticKey: computer })
    expect(() => responder.readMessage1(initiator.writeMessage1(Buffer.from('{}')))).toThrow(
      NoiseError,
    )
  })

  it('rejects a tampered, replayed or reordered transport message', () => {
    const phone = generateNoiseKeyPair()
    const computer = generateNoiseKeyPair()
    const initiator = new NoiseInitiator({ staticKey: phone, remoteStaticKey: computer.publicKey })
    const responder = new NoiseResponder({ staticKey: computer })
    responder.readMessage1(initiator.writeMessage1(Buffer.alloc(0)))
    const { message, session: server } = responder.writeMessage2(Buffer.alloc(0))
    const { session: client } = initiator.readMessage2(message)

    const first = client.send.encrypt(Buffer.from('first'))
    const tampered = Buffer.from(first)
    tampered[0]! ^= 1
    expect(() => server.receive.decrypt(tampered)).toThrow(NoiseError)

    const second = client.send.encrypt(Buffer.from('second'))
    // The failed attempt used nonce 0, so the honest first message no longer opens.
    expect(() => server.receive.decrypt(first)).toThrow(NoiseError)
    expect(() => server.receive.decrypt(second)).toThrow(NoiseError)
  })

  it('carries large frames in both directions', () => {
    const phone = generateNoiseKeyPair()
    const computer = generateNoiseKeyPair()
    const initiator = new NoiseInitiator({ staticKey: phone, remoteStaticKey: computer.publicKey })
    const responder = new NoiseResponder({ staticKey: computer })
    responder.readMessage1(initiator.writeMessage1(Buffer.alloc(0)))
    const { message, session: server } = responder.writeMessage2(Buffer.alloc(0))
    const { session: client } = initiator.readMessage2(message)
    const large = Buffer.alloc(3 * 1024 * 1024, 7)
    expect(client.receive.decrypt(server.send.encrypt(large)).equals(large)).toBe(true)
    expect(server.receive.decrypt(client.send.encrypt(large)).equals(large)).toBe(true)
  })
})
