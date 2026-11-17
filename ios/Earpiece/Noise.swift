import CryptoKit
import Foundation

// SPEC 12.3: Noise_IK_25519_ChaChaPoly_SHA256, initiator side, per the Noise Protocol Framework
// specification revision 34. Section numbers below refer to that document.
//
//   IK:
//     <- s
//     ...
//     -> e, es, s, ss
//     <- e, ee, se

enum NoiseError: Error, Equatable {
    case decryptFailed
    case badMessage
    case messageTooLong
    case invalidKey
    case nonceExhausted
}

enum Noise {
    static let protocolName = "Noise_IK_25519_ChaChaPoly_SHA256"
    static let prologue = Data("earpiece/2".utf8)
    static let hashLength = 32
    static let dhLength = 32
    static let tagLength = 16
    /// Section 3: every Noise message is at most 65535 bytes.
    static let maxMessageLength = 65535

    /// HMAC-SHA256 (section 4.3, HMAC-HASH).
    static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// Section 4.3 HKDF with two outputs, built from HMAC-HASH (not CryptoKit's HKDF).
    static func hkdf2(chainingKey: Data, inputKeyMaterial: Data) -> (Data, Data) {
        let tempKey = hmac(key: chainingKey, data: inputKeyMaterial)
        let output1 = hmac(key: tempKey, data: Data([0x01]))
        let output2 = hmac(key: tempKey, data: output1 + Data([0x02]))
        return (output1, output2)
    }

    static func hash(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    /// Section 4.1 DH: the raw 32-byte X25519 output.
    static func dh(_ privateKey: Curve25519.KeyAgreement.PrivateKey, _ publicKey: Curve25519.KeyAgreement.PublicKey) throws -> Data {
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        return shared.withUnsafeBytes { Data($0) }
    }

    /// ChaChaPoly nonce (section 12.3): 32 bits of zeros followed by the 64-bit little-endian counter.
    static func nonce(_ counter: UInt64) -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: counter.littleEndian) { bytes.append(contentsOf: $0) }
        return try! ChaChaPoly.Nonce(data: bytes)  // always 12 bytes
    }
}

/// Section 5.1 CipherState.
struct NoiseCipherState {
    /// Raw key bytes (kept for tests that compare derived keys).
    private(set) var keyData: Data?
    private var key: SymmetricKey?
    private(set) var counter: UInt64 = 0

    init(key: Data? = nil) {
        keyData = key
        self.key = key.map { SymmetricKey(data: $0) }
    }

    var hasKey: Bool { key != nil }

    mutating func encrypt(ad: Data, plaintext: Data) throws -> Data {
        guard let key else { return plaintext }
        guard counter < UInt64.max else { throw NoiseError.nonceExhausted }
        let sealed = try ChaChaPoly.seal(plaintext, using: key, nonce: Noise.nonce(counter), authenticating: ad)
        counter += 1
        return sealed.ciphertext + sealed.tag
    }

    /// On an authentication failure the counter is not incremented (section 5.1).
    mutating func decrypt(ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard counter < UInt64.max else { throw NoiseError.nonceExhausted }
        guard ciphertext.count >= Noise.tagLength else { throw NoiseError.decryptFailed }
        let body = Data(ciphertext.prefix(ciphertext.count - Noise.tagLength))
        let tag = Data(ciphertext.suffix(Noise.tagLength))
        do {
            let box = try ChaChaPoly.SealedBox(nonce: Noise.nonce(counter), ciphertext: body, tag: tag)
            let plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad)
            counter += 1
            return plaintext
        } catch {
            throw NoiseError.decryptFailed
        }
    }
}

/// Section 5.2 SymmetricState.
struct NoiseSymmetricState {
    private(set) var ck: Data
    private(set) var h: Data
    private(set) var cipher = NoiseCipherState()

    /// InitializeSymmetric(protocol_name).
    init(protocolName: String) {
        let name = Data(protocolName.utf8)
        if name.count <= Noise.hashLength {
            h = name + Data(count: Noise.hashLength - name.count)
        } else {
            h = Noise.hash(name)
        }
        ck = h
    }

    mutating func mixKey(_ inputKeyMaterial: Data) {
        let (newCK, tempK) = Noise.hkdf2(chainingKey: ck, inputKeyMaterial: inputKeyMaterial)
        ck = newCK
        cipher = NoiseCipherState(key: tempK)  // HASHLEN is 32, so no truncation
    }

    mutating func mixHash(_ data: Data) {
        h = Noise.hash(h + data)
    }

    mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(ad: h, plaintext: plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ad: h, ciphertext: ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    /// Split(): (initiator-to-responder, responder-to-initiator).
    func split() -> (NoiseCipherState, NoiseCipherState) {
        let (k1, k2) = Noise.hkdf2(chainingKey: ck, inputKeyMaterial: Data())
        return (NoiseCipherState(key: k1), NoiseCipherState(key: k2))
    }
}

/// Transport after the handshake: `send` is the initiator-to-responder cipher, `receive` the other.
struct NoiseTransport {
    private(set) var send: NoiseCipherState
    private(set) var receive: NoiseCipherState

    init(send: NoiseCipherState, receive: NoiseCipherState) {
        self.send = send
        self.receive = receive
    }

    mutating func encrypt(_ plaintext: Data) throws -> Data {
        guard plaintext.count + Noise.tagLength <= Noise.maxMessageLength else { throw NoiseError.messageTooLong }
        return try send.encrypt(ad: Data(), plaintext: plaintext)
    }

    mutating func decrypt(_ ciphertext: Data) throws -> Data {
        guard ciphertext.count <= Noise.maxMessageLength else { throw NoiseError.messageTooLong }
        return try receive.decrypt(ad: Data(), ciphertext: ciphertext)
    }
}

/// The phone's side of the IK handshake. The ephemeral key can be injected for test vectors.
struct NoiseIKInitiator {
    private var symmetric: NoiseSymmetricState
    private let localStatic: Curve25519.KeyAgreement.PrivateKey
    private let remoteStatic: Curve25519.KeyAgreement.PublicKey
    private let ephemeral: Curve25519.KeyAgreement.PrivateKey
    private(set) var remoteEphemeral: Curve25519.KeyAgreement.PublicKey?
    /// The handshake hash `h`, available after message 2 (channel binding, test vectors).
    private(set) var handshakeHash: Data?

    init(prologue: Data = Noise.prologue,
         localStatic: Curve25519.KeyAgreement.PrivateKey,
         remoteStatic: Curve25519.KeyAgreement.PublicKey,
         ephemeral: Curve25519.KeyAgreement.PrivateKey = Curve25519.KeyAgreement.PrivateKey()) {
        self.localStatic = localStatic
        self.remoteStatic = remoteStatic
        self.ephemeral = ephemeral
        // Section 5.3 Initialize(): InitializeSymmetric, MixHash(prologue), then the pre-message
        // "<- s": MixHash(rs).
        symmetric = NoiseSymmetricState(protocolName: Noise.protocolName)
        symmetric.mixHash(prologue)
        symmetric.mixHash(remoteStatic.rawRepresentation)
    }

    /// Message 1: -> e, es, s, ss, then the encrypted payload.
    mutating func writeMessage1(payload: Data) throws -> Data {
        var message = Data()
        let e = ephemeral.publicKey.rawRepresentation
        message += e
        symmetric.mixHash(e)
        symmetric.mixKey(try Noise.dh(ephemeral, remoteStatic))                        // es
        message += try symmetric.encryptAndHash(localStatic.publicKey.rawRepresentation) // s
        symmetric.mixKey(try Noise.dh(localStatic, remoteStatic))                      // ss
        message += try symmetric.encryptAndHash(payload)
        guard message.count <= Noise.maxMessageLength else { throw NoiseError.messageTooLong }
        return message
    }

    /// Message 2: <- e, ee, se, then the payload. Returns the payload and the transport ciphers.
    mutating func readMessage2(_ message: Data) throws -> (payload: Data, transport: NoiseTransport) {
        guard message.count >= Noise.dhLength + Noise.tagLength,
              message.count <= Noise.maxMessageLength else { throw NoiseError.badMessage }
        let bytes = Data(message)
        let reBytes = Data(bytes.prefix(Noise.dhLength))
        guard let re = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: reBytes) else {
            throw NoiseError.invalidKey
        }
        remoteEphemeral = re
        symmetric.mixHash(reBytes)                                // e
        symmetric.mixKey(try Noise.dh(ephemeral, re))             // ee
        symmetric.mixKey(try Noise.dh(localStatic, re))           // se (initiator: DH(s, re))
        let payload = try symmetric.decryptAndHash(Data(bytes.dropFirst(Noise.dhLength)))
        handshakeHash = symmetric.h
        let (initiatorToResponder, responderToInitiator) = symmetric.split()
        return (payload, NoiseTransport(send: initiatorToResponder, receive: responderToInitiator))
    }
}

/// base64url without padding (SPEC 12.1: keys on the wire and in links).
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        guard !s.contains("=") || s.hasSuffix("=") else { return nil }
        s = s.replacingOccurrences(of: "=", with: "")
        let remainder = s.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: s)
    }
}
