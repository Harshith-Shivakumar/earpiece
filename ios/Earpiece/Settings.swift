import Foundation
import Security

/// User preferences in UserDefaults. Bridges (addresses and tokens) are saved connections; see
/// ConnectionStore, which also migrates the v1 single server URL and token.
@MainActor
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    private enum Key {
        static let contextualWords = "contextualWords"
        static let voiceIdentifier = "voiceIdentifier"
        static let speechRate = "speechRate"
        static let silenceTimeout = "silenceTimeout"
    }

    static let defaultWords = """
    Claude
    Claude Code
    Earpiece
    GitHub
    pull request
    commit
    branch
    npm
    TypeScript
    README
    """

    private let defaults = UserDefaults.standard

    /// One word or phrase per line (commas also work).
    @Published var contextualWordsText: String {
        didSet { defaults.set(contextualWordsText, forKey: Key.contextualWords) }
    }
    /// Empty means "best available".
    @Published var voiceIdentifier: String {
        didSet { defaults.set(voiceIdentifier, forKey: Key.voiceIdentifier) }
    }
    @Published var speechRate: Float {
        didSet { defaults.set(speechRate, forKey: Key.speechRate) }
    }
    /// Seconds without a new partial result that end a turn.
    @Published var silenceTimeout: Double {
        didSet { defaults.set(silenceTimeout, forKey: Key.silenceTimeout) }
    }

    private init() {
        contextualWordsText = defaults.string(forKey: Key.contextualWords) ?? Self.defaultWords
        voiceIdentifier = defaults.string(forKey: Key.voiceIdentifier) ?? ""
        speechRate = defaults.object(forKey: Key.speechRate) as? Float ?? Speaker.defaultRate
        silenceTimeout = defaults.object(forKey: Key.silenceTimeout) as? Double ?? 1.2
    }

    var contextualWords: [String] {
        contextualWordsText
            .components(separatedBy: CharacterSet(charactersIn: "\n,"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

enum Keychain {
    private static var service: String { Bundle.main.bundleIdentifier ?? "earpiece" }

    static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String, account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        // Readable while the phone is locked (reconnects happen with the screen off).
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
