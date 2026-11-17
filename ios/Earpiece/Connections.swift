import Foundation

// SPEC 11.4 and 12.6: saved connections on the phone.

/// One saved bridge. `id` is the bridge_id; a connection migrated from the v1 single setting (or added
/// by hand) has a placeholder id until /health or welcome tells us the real one. A connection has the
/// relay (`relay` + `bridgeKey`, from a v2 link), direct URLs plus a token, or both. Tokens and the
/// one-time pairing secret live in the Keychain.
struct SavedConnection: Codable, Equatable, Identifiable {
    static let placeholderPrefix = "pending-"

    var id: String
    var name: String
    /// ws:// URLs as typed or paired, in priority order.
    var urls: [String]
    /// The URL that last answered with the right bridge_id.
    var lastURL: String?
    /// True while `name` is our own guess (a host name), so the bridge's name may replace it.
    var nameIsDefault: Bool = false
    /// SPEC 12: relay base URL (ws/wss) and the bridge's X25519 public key (base64url).
    var relay: String?
    var bridgeKey: String?
    /// "relay" or "direct": the path that last worked.
    var lastPath: String?

    var hasKnownID: Bool { !id.hasPrefix(Self.placeholderPrefix) }
    var hasRelay: Bool { relay != nil && bridgeKey.flatMap(Base64URL.decode)?.count == 32 }

    static func placeholderID() -> String { placeholderPrefix + UUID().uuidString }

    /// The URLs that parse, normalized, without duplicates.
    var webSocketURLs: [URL] {
        var out: [URL] = []
        for raw in urls {
            if let url = ServerAddress.webSocketURL(from: raw), !out.contains(url) { out.append(url) }
        }
        return out
    }
}

/// Pure operations on the saved list (unit-tested; the store persists the results).
enum ConnectionList {
    /// The v1 app kept one server URL and one token. Turn them into the first saved connection.
    static func migrateLegacy(serverURL: String, token: String?, id: String = SavedConnection.placeholderID()) -> SavedConnection? {
        guard let url = ServerAddress.webSocketURL(from: serverURL) else { return nil }
        _ = token  // the token moves to the new key in the Keychain; it does not live in the struct
        return SavedConnection(id: id, name: url.host ?? "Bridge", urls: [url.absoluteString], lastURL: nil, nameIsDefault: true)
    }

    /// Add or update from a pairing link. An existing id gets its name, URLs and token replaced (not
    /// duplicated). A placeholder connection that shares a URL with the pairing is the same bridge:
    /// it is replaced too. Returns the new list and the ids that were replaced.
    static func upsert(_ list: [SavedConnection], pairing: PairingInfo) -> (list: [SavedConnection], replaced: [String]) {
        let pairedURLs = Set(pairing.urls)
        var out: [SavedConnection] = []
        var replaced: [String] = []
        var insertAt: Int?
        for item in list {
            let overlaps = !Set(item.webSocketURLs).isDisjoint(with: pairedURLs)
            if item.id == pairing.id || (!item.hasKnownID && overlaps) {
                if insertAt == nil { insertAt = out.count }
                if item.id != pairing.id { replaced.append(item.id) }
                continue
            }
            out.append(item)
        }
        let previous = list.first { $0.id == pairing.id }
        let replacedPlaceholder = list.first { replaced.contains($0.id) }
        // A v2 link may carry no direct URLs: keep the ones already saved.
        let urlStrings = pairing.urls.isEmpty
            ? (previous?.urls ?? replacedPlaceholder?.urls ?? [])
            : pairing.urls.map(\.absoluteString)
        let keepLast = previous?.lastURL.flatMap { urlStrings.contains($0) ? $0 : nil }
        var entry = SavedConnection(id: pairing.id, name: pairing.name, urls: urlStrings, lastURL: keepLast, nameIsDefault: false)
        entry.relay = pairing.relay?.absoluteString ?? previous?.relay
        entry.bridgeKey = pairing.bridgeKey.map(Base64URL.encode) ?? previous?.bridgeKey
        entry.lastPath = previous?.lastPath
        out.insert(entry, at: insertAt ?? out.count)
        return (out, replaced)
    }

    /// The bridge told us its real id. Re-key the placeholder; if a connection with that id already
    /// exists, merge into it (its URLs gain the placeholder's, the placeholder goes away).
    static func rekey(_ list: [SavedConnection], from oldID: String, to newID: String, bridgeName: String?) -> [SavedConnection] {
        guard oldID != newID, let index = list.firstIndex(where: { $0.id == oldID }) else { return list }
        var moving = list[index]
        var out = list
        if let existing = out.firstIndex(where: { $0.id == newID }) {
            var target = out[existing]
            for url in moving.urls where !target.urls.contains(url) { target.urls.append(url) }
            if target.lastURL == nil { target.lastURL = moving.lastURL }
            out[existing] = target
            out.remove(at: index)
            return out
        }
        moving.id = newID
        if moving.nameIsDefault, let bridgeName, !bridgeName.isEmpty {
            moving.name = bridgeName
            moving.nameIsDefault = false
        }
        out[index] = moving
        return out
    }
}

/// Order in which to try a connection's URLs, and the message when none answers.
enum ConnectionOrder {
    /// `lastURL` first (if it is still saved), then the rest in saved order.
    static func order(urls: [URL], lastURL: URL?) -> [URL] {
        var out: [URL] = []
        if let lastURL, urls.contains(lastURL) { out.append(lastURL) }
        for url in urls where !out.contains(url) { out.append(url) }
        return out
    }

    static func unreachableMessage(name: String, urls: [URL]) -> String {
        let tailscale = urls.contains { ServerAddress.isTailscaleHost($0.host ?? "") }
        return tailscale ? "Can't reach \(name). Is Tailscale on?" : "Can't reach \(name)."
    }
}

// MARK: - /health

struct HealthInfo: Equatable, Decodable, Sendable {
    var ok: Bool
    var state: String?
    var name: String?
    var bridgeID: String?

    init(ok: Bool, state: String? = nil, name: String? = nil, bridgeID: String? = nil) {
        self.ok = ok
        self.state = state
        self.name = name
        self.bridgeID = bridgeID
    }

    private enum CodingKeys: String, CodingKey {
        case ok, state, name
        case bridgeID = "bridge_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        bridgeID = try? c.decodeIfPresent(String.self, forKey: .bridgeID)
    }
}

enum HealthCheck {
    static let timeout: TimeInterval = 2

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout + 1
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// Accept a URL only if it answers with the expected bridge_id. With no expected id (a migrated or
    /// hand-added connection whose id we have not learned yet) any healthy bridge is accepted.
    static func accepts(_ info: HealthInfo, expectedBridgeID: String?) -> Bool {
        guard info.ok else { return false }
        guard let expectedBridgeID else { return true }
        return info.bridgeID == expectedBridgeID
    }

    static func check(_ webSocketURL: URL, timeout: TimeInterval = HealthCheck.timeout) async -> Result<HealthInfo, Error> {
        guard let url = ServerAddress.healthURL(from: webSocketURL) else {
            return .failure(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return .failure(URLError(.badServerResponse))
            }
            return .success(try JSONDecoder().decode(HealthInfo.self, from: data))
        } catch {
            return .failure(error)
        }
    }
}

// MARK: - Store

/// Saved connections in UserDefaults; tokens in the Keychain keyed by connection id.
@MainActor
final class ConnectionStore: ObservableObject {
    static let shared = ConnectionStore()

    private enum Key {
        static let list = "connections.v1"
        static let selected = "selectedConnectionID"
        static let legacyURL = "serverURL"
        static let legacyToken = "token"
        static let legacySeq = "lastSeq"
    }

    @Published private(set) var connections: [SavedConnection] = []
    @Published private(set) var selectedID: String?

    private let defaults = UserDefaults.standard

    private init() {
        load()
        migrateIfNeeded()
    }

    var selected: SavedConnection? {
        guard let selectedID else { return nil }
        return connections.first { $0.id == selectedID }
    }

    func connection(id: String) -> SavedConnection? {
        connections.first { $0.id == id }
    }

    func token(for id: String) -> String {
        Keychain.read(account: Self.tokenAccount(id)) ?? ""
    }

    func setToken(_ token: String, for id: String) {
        Keychain.save(token.trimmingCharacters(in: .whitespacesAndNewlines), account: Self.tokenAccount(id))
    }

    /// The one-time pairing secret from a v2 link, until the bridge has accepted this phone.
    func pairSecret(for id: String) -> String? {
        let secret = Keychain.read(account: Self.secretAccount(id)) ?? ""
        return secret.isEmpty ? nil : secret
    }

    /// The bridge accepted this phone (message 2 ok:true): the secret is used up.
    func pairingCompleted(for id: String) {
        Keychain.save("", account: Self.secretAccount(id))
    }

    func setLastPath(_ path: ConnectionPath, for id: String) {
        guard let index = connections.firstIndex(where: { $0.id == id }),
              connections[index].lastPath != path.rawValue else { return }
        connections[index].lastPath = path.rawValue
        save()
    }

    func select(_ id: String?) {
        selectedID = id
        save()
    }

    /// Save a new or edited connection (manual add / edit screen).
    func save(_ connection: SavedConnection, token: String) {
        if let index = connections.firstIndex(where: { $0.id == connection.id }) {
            connections[index] = connection
        } else {
            connections.append(connection)
        }
        setToken(token, for: connection.id)
        if selectedID == nil { selectedID = connection.id }
        save()
    }

    /// Also "Forget this computer": the connection, its token and pairing secret are removed. The
    /// phone cannot revoke itself on the bridge (npm run unpair does that there).
    func delete(_ id: String) {
        connections.removeAll { $0.id == id }
        Keychain.save("", account: Self.tokenAccount(id))
        Keychain.save("", account: Self.secretAccount(id))
        if selectedID == id { selectedID = connections.first?.id }
        save()
    }

    func apply(pairing: PairingInfo) {
        let result = ConnectionList.upsert(connections, pairing: pairing)
        connections = result.list
        if let token = pairing.token {
            setToken(token, for: pairing.id)
        }
        if let secret = pairing.pairSecret {
            Keychain.save(secret, account: Self.secretAccount(pairing.id))
        }
        for old in result.replaced {
            // A v2 link has no token: keep the replaced connection's, so its direct path still works.
            let oldToken = token(for: old)
            if pairing.token == nil, token(for: pairing.id).isEmpty, !oldToken.isEmpty {
                setToken(oldToken, for: pairing.id)
            }
            Keychain.save("", account: Self.tokenAccount(old))
            Keychain.save("", account: Self.secretAccount(old))
            if selectedID == old { selectedID = pairing.id }
        }
        if selectedID == nil { selectedID = pairing.id }
        save()
    }

    func setLastURL(_ url: URL, for id: String) {
        guard let index = connections.firstIndex(where: { $0.id == id }),
              connections[index].lastURL != url.absoluteString else { return }
        connections[index].lastURL = url.absoluteString
        save()
    }

    /// Re-key a placeholder connection once the bridge tells us its id. Returns the id to use from now on.
    @discardableResult
    func learnIdentity(of id: String, bridgeID: String, name: String?) -> String {
        guard let current = connection(id: id), !current.hasKnownID, !bridgeID.isEmpty else { return id }
        let token = token(for: id)
        connections = ConnectionList.rekey(connections, from: id, to: bridgeID, bridgeName: name)
        setToken(token, for: bridgeID)
        Keychain.save("", account: Self.tokenAccount(id))
        if selectedID == id { selectedID = bridgeID }
        save()
        return bridgeID
    }

    static func tokenAccount(_ id: String) -> String { "token.\(id)" }
    static func secretAccount(_ id: String) -> String { "pairsecret.\(id)" }

    // MARK: Persistence

    private func load() {
        if let data = defaults.data(forKey: Key.list),
           let list = try? JSONDecoder().decode([SavedConnection].self, from: data) {
            connections = list
        }
        selectedID = defaults.string(forKey: Key.selected)
        if let selectedID, !connections.contains(where: { $0.id == selectedID }) {
            self.selectedID = connections.first?.id
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(connections) {
            defaults.set(data, forKey: Key.list)
        }
        defaults.set(selectedID, forKey: Key.selected)
    }

    /// v1 -> v1.2: the single server URL and token become the first saved connection.
    private func migrateIfNeeded() {
        guard connections.isEmpty,
              let legacy = defaults.string(forKey: Key.legacyURL), !legacy.isEmpty,
              let migrated = ConnectionList.migrateLegacy(serverURL: legacy, token: nil) else { return }
        connections = [migrated]
        selectedID = migrated.id
        if let token = Keychain.read(account: Key.legacyToken) {
            setToken(token, for: migrated.id)
            Keychain.save("", account: Key.legacyToken)
        }
        if defaults.object(forKey: Key.legacySeq) != nil {
            defaults.set(defaults.integer(forKey: Key.legacySeq), forKey: "lastSeq.\(migrated.id)")
        }
        defaults.removeObject(forKey: Key.legacyURL)
        save()
    }
}
