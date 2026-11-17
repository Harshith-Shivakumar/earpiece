import CryptoKit
import Foundation
import Testing
@testable import Earpiece

private final class BundleToken {}

private extension Data {
    init?(hex: String) {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let byte = UInt8(String(decoding: chars[i..<i + 2], as: UTF8.self), radix: 16) else { return nil }
            out.append(byte)
            i += 2
        }
        self = out
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// SPEC 12.3 interop: reproduce the bridge's deterministic vectors (spec/noise-vectors.json, bundled
/// into the test target) byte for byte.
struct NoiseVectorTests {
    struct Vectors: Decodable {
        struct Message: Decodable {
            let direction: String
            let nonce: UInt64
            let plaintext: String
            let ciphertext: String
        }

        let protocol_name: String
        let prologue: String
        let prologue_hex: String
        let phone_static_private: String
        let phone_static_public: String
        let phone_static_public_b64url: String
        let phone_ephemeral_private: String
        let phone_ephemeral_public: String
        let bridge_static_public: String
        let bridge_static_public_b64url: String
        let msg1_payload: String
        let msg1: String
        let msg2_payload: String
        let msg2: String
        let handshake_hash: String
        let phone_to_bridge_key: String
        let bridge_to_phone_key: String
        let transport: [Message]
    }

    private func load() throws -> Vectors {
        let url = try #require(Bundle(for: BundleToken.self).url(forResource: "noise-vectors", withExtension: "json"),
                               "noise-vectors.json is not in the test bundle")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func key(_ hex: String) throws -> Data { try #require(Data(hex: hex)) }

    @Test func reproducesBridgeVectorsByteForByte() throws {
        let v = try load()
        #expect(v.protocol_name == Noise.protocolName)
        #expect(Data(v.prologue.utf8) == Noise.prologue)
        #expect(Noise.prologue.hex == v.prologue_hex)

        let phoneStatic = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try key(v.phone_static_private))
        let phoneEphemeral = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try key(v.phone_ephemeral_private))
        let bridgeStatic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try key(v.bridge_static_public))
        #expect(phoneStatic.publicKey.rawRepresentation.hex == v.phone_static_public)
        #expect(phoneEphemeral.publicKey.rawRepresentation.hex == v.phone_ephemeral_public)
        #expect(Base64URL.encode(phoneStatic.publicKey.rawRepresentation) == v.phone_static_public_b64url)
        #expect(Base64URL.decode(v.bridge_static_public_b64url)?.hex == v.bridge_static_public)

        var initiator = NoiseIKInitiator(prologue: Noise.prologue, localStatic: phoneStatic,
                                         remoteStatic: bridgeStatic, ephemeral: phoneEphemeral)
        let message1 = try initiator.writeMessage1(payload: Data(v.msg1_payload.utf8))
        #expect(message1.hex == v.msg1)

        let (payload, transportStart) = try initiator.readMessage2(try key(v.msg2))
        #expect(String(decoding: payload, as: UTF8.self) == v.msg2_payload)
        #expect(initiator.handshakeHash?.hex == v.handshake_hash)
        #expect(transportStart.send.keyData?.hex == v.phone_to_bridge_key)
        #expect(transportStart.receive.keyData?.hex == v.bridge_to_phone_key)

        var transport = transportStart
        #expect(v.transport.count == 6)
        for message in v.transport {
            switch message.direction {
            case "phone_to_bridge":
                #expect(transport.send.counter == message.nonce)
                let ciphertext = try transport.encrypt(Data(message.plaintext.utf8))
                #expect(ciphertext.hex == message.ciphertext, "phone_to_bridge nonce \(message.nonce)")
            case "bridge_to_phone":
                #expect(transport.receive.counter == message.nonce)
                let plaintext = try transport.decrypt(try key(message.ciphertext))
                #expect(String(decoding: plaintext, as: UTF8.self) == message.plaintext, "bridge_to_phone nonce \(message.nonce)")
            default:
                Issue.record("unknown direction \(message.direction)")
            }
        }
    }

    @Test func handshakePayloadsDecodeAsTheBridgeSendsThem() throws {
        let v = try load()
        let reply = HandshakePayload.reply(Data(v.msg2_payload.utf8))
        #expect(reply == HandshakePayload.Reply(ok: true, name: "Test Bridge", bridgeID: "00000000-0000-0000-0000-0000000000b1", reason: nil))
        // Our message 1 payload carries the same fields (key order may differ; the bridge parses JSON).
        let ours = HandshakePayload.message1(phoneID: "00000000-0000-0000-0000-000000000001", name: "Test iPhone", pairSecret: "AAAAAAAAAAAAAAAAAAAAAA")
        let a = try #require(JSONSerialization.jsonObject(with: ours) as? NSDictionary)
        let b = try #require(JSONSerialization.jsonObject(with: Data(v.msg1_payload.utf8)) as? NSDictionary)
        #expect(a == b)
    }
}

struct NoisePrimitiveTests {
    @Test func hmacMatchesRFC4231() {
        // RFC 4231 test case 1.
        let mac = Noise.hmac(key: Data(repeating: 0x0b, count: 20), data: Data("Hi There".utf8))
        #expect(mac.hex == "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
    }

    @Test func nonceIsFourZeroBytesThenLittleEndianCounter() {
        #expect(Noise.nonce(0).withUnsafeBytes { Data($0) }.hex == "000000000000000000000000")
        #expect(Noise.nonce(1).withUnsafeBytes { Data($0) }.hex == "000000000100000000000000")
        #expect(Noise.nonce(0x0102030405060708).withUnsafeBytes { Data($0) }.hex == "000000000807060504030201")
    }

    @Test func protocolNameIsTheInitialHash() {
        let state = NoiseSymmetricState(protocolName: Noise.protocolName)
        #expect(Data(Noise.protocolName.utf8).count == 32)
        #expect(state.h == Data(Noise.protocolName.utf8))
        #expect(state.ck == state.h)
    }

    @Test func tamperedTransportMessageFailsWithoutAdvancingTheCounter() throws {
        var a = NoiseCipherState(key: Data(repeating: 7, count: 32))
        var b = NoiseCipherState(key: Data(repeating: 7, count: 32))
        var sealed = try a.encrypt(ad: Data(), plaintext: Data("hello".utf8))
        sealed[sealed.startIndex] ^= 0x01
        #expect(throws: NoiseError.decryptFailed) { try b.decrypt(ad: Data(), ciphertext: sealed) }
        #expect(b.counter == 0)
        sealed[sealed.startIndex] ^= 0x01
        #expect(try b.decrypt(ad: Data(), ciphertext: sealed) == Data("hello".utf8))
        #expect(b.counter == 1)
    }

    @Test func wrongBridgeKeyCannotReadMessage2() throws {
        // A message 2 from a different responder static key must not decrypt.
        let phone = Curve25519.KeyAgreement.PrivateKey()
        let bridge = Curve25519.KeyAgreement.PrivateKey()
        var initiator = NoiseIKInitiator(localStatic: phone, remoteStatic: bridge.publicKey)
        _ = try initiator.writeMessage1(payload: Data("{}".utf8))
        let fake = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation + Data(repeating: 0, count: 40)
        #expect(throws: NoiseError.decryptFailed) { _ = try initiator.readMessage2(fake) }
    }

    @Test func transportRejectsOversizeMessages() {
        var transport = NoiseTransport(send: NoiseCipherState(key: Data(repeating: 1, count: 32)),
                                       receive: NoiseCipherState(key: Data(repeating: 2, count: 32)))
        #expect(throws: NoiseError.messageTooLong) { _ = try transport.encrypt(Data(count: Noise.maxMessageLength)) }
    }

    @Test func base64URLWithoutPadding() {
        #expect(Base64URL.encode(Data([0xfb, 0xff])) == "-_8")
        #expect(Base64URL.decode("-_8") == Data([0xfb, 0xff]))
        #expect(Base64URL.decode("-_8=") == Data([0xfb, 0xff]))
        #expect(Base64URL.encode(Data(repeating: 0, count: 16)) == "AAAAAAAAAAAAAAAAAAAAAA")
        #expect(Base64URL.decode("A") == nil)
        #expect(Base64URL.decode("!!!!") == nil)
    }
}
