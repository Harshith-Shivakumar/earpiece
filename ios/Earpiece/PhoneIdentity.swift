import CryptoKit
import Foundation
import UIKit

/// SPEC 12.1: the phone's X25519 static key (`phone_key`) and a random `phone_id`, created once per
/// install and kept in the Keychain (this device only, readable after first unlock).
@MainActor
final class PhoneIdentity {
    static let shared = PhoneIdentity()

    private enum Account {
        static let key = "phone.noise_key"
        static let id = "phone.id"
    }

    let phoneID: String
    let staticKey: Curve25519.KeyAgreement.PrivateKey

    var publicKey: Data { staticKey.publicKey.rawRepresentation }

    /// Shown to the bridge (`npm run phones`). Without the device-name entitlement iOS returns a
    /// generic name such as "iPhone".
    var name: String {
        let device = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return device.isEmpty ? "iPhone" : device
    }

    private init() {
        if let stored = Keychain.read(account: Account.key).flatMap(Base64URL.decode),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: stored) {
            staticKey = key
        } else {
            let key = Curve25519.KeyAgreement.PrivateKey()
            Keychain.save(Base64URL.encode(key.rawRepresentation), account: Account.key)
            staticKey = key
        }
        if let id = Keychain.read(account: Account.id), !id.isEmpty {
            phoneID = id
        } else {
            let id = UUID().uuidString.lowercased()
            Keychain.save(id, account: Account.id)
            phoneID = id
        }
    }
}
