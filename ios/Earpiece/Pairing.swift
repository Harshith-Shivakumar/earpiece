import Foundation

/// Pairing links.
/// - v1 (SPEC 11.3): `earpiece://pair?v=1&name=&id=&token=&url=&url=...` (direct only, token required).
/// - v2 (SPEC 12.4): `earpiece://pair?v=2&name=&id=&relay=<wss url>&key=<bridge noise pub>&secret=<pair_secret>&url=...`
///   (relay with Noise; direct URLs optional; no token).
struct PairingInfo: Equatable, Identifiable {
    var version: Int
    /// The bridge_id.
    var id: String
    var name: String
    /// v1 only (v2 links carry no token; a direct path then needs one entered by hand).
    var token: String?
    /// Normalized direct ws:// URLs, in the bridge's priority order.
    var urls: [URL]
    /// v2: the relay base URL (ws/wss), the bridge's X25519 public key, and the one-time secret.
    var relay: URL?
    var bridgeKey: Data?
    var pairSecret: String?

    var hasRelay: Bool { relay != nil && bridgeKey != nil }

    init(version: Int = 1, id: String, name: String, token: String?, urls: [URL],
         relay: URL? = nil, bridgeKey: Data? = nil, pairSecret: String? = nil) {
        self.version = version
        self.id = id
        self.name = name
        self.token = token
        self.urls = urls
        self.relay = relay
        self.bridgeKey = bridgeKey
        self.pairSecret = pairSecret
    }
}

enum PairingError: Error, Equatable {
    case notPairingLink
    case unsupportedVersion
    case missingID
    case missingToken
    case noURLs
    case missingRelay
    case badKey

    var message: String {
        switch self {
        case .notPairingLink: return "That is not an Earpiece pairing code."
        case .unsupportedVersion: return "This pairing code is from a newer bridge. Update the app."
        case .missingID: return "The pairing link has no bridge id."
        case .missingToken: return "The pairing link has no token."
        case .noURLs: return "The pairing link has no usable address."
        case .missingRelay: return "The pairing link has no relay address."
        case .badKey: return "The pairing link has an invalid key. Run npm run pair again."
        }
    }
}

enum Pairing {
    static func parse(_ text: String) -> Result<PairingInfo, PairingError> {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .failure(.notPairingLink)
        }
        return parse(url)
    }

    static func parse(_ url: URL) -> Result<PairingInfo, PairingError> {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.scheme?.lowercased() == "earpiece",
              (comps.host?.lowercased() == "pair" || comps.path.lowercased() == "pair")
        else { return .failure(.notPairingLink) }

        // Decode values ourselves: "+" means space in form encoding, which URLComponents leaves alone.
        var values: [String: [String]] = [:]
        for item in comps.percentEncodedQueryItems ?? [] {
            let raw = (item.value ?? "").replacingOccurrences(of: "+", with: "%20")
            let value = raw.removingPercentEncoding ?? raw
            values[item.name.lowercased(), default: []].append(value)
        }
        func first(_ key: String) -> String {
            (values[key]?.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let versionText = first("v")
        let version: Int
        switch versionText {
        case "", "1": version = 1
        case "2": version = 2
        default: return .failure(.unsupportedVersion)
        }

        let id = first("id")
        guard !id.isEmpty else { return .failure(.missingID) }

        var urls: [URL] = []
        for raw in values["url"] ?? [] {
            guard let ws = ServerAddress.webSocketURL(from: raw), !urls.contains(ws) else { continue }
            urls.append(ws)
        }
        let token = first("token")

        if version == 1 {
            guard !token.isEmpty else { return .failure(.missingToken) }
            guard let firstURL = urls.first else { return .failure(.noURLs) }
            var name = first("name")
            if name.isEmpty { name = firstURL.host ?? "Bridge" }
            return .success(PairingInfo(version: 1, id: id, name: name, token: token, urls: urls))
        }

        // v2
        guard let relay = RelayAddress.base(first("relay")) else { return .failure(.missingRelay) }
        guard let key = Base64URL.decode(first("key")), key.count == 32 else { return .failure(.badKey) }
        let secret = first("secret")
        var name = first("name")
        if name.isEmpty { name = "Computer" }
        return .success(PairingInfo(version: 2, id: id, name: name, token: token.isEmpty ? nil : token,
                                    urls: urls, relay: relay, bridgeKey: key,
                                    pairSecret: secret.isEmpty ? nil : secret))
    }
}
