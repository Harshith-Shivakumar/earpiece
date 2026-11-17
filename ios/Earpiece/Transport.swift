import CryptoKit
import Foundation

// SPEC 12: the phone reaches the bridge over the relay (Noise IK end to end) or directly (11.4).
// Both are a Transport that carries plaintext protocol JSON (hello, welcome, say, ...).

enum ConnectionPath: String, Codable, Equatable {
    case relay
    case direct

    var label: String { self == .relay ? "via relay" : "direct" }
}

enum TransportEvent: Equatable {
    /// Ready to carry protocol messages (direct: socket opened; relay: Noise handshake done).
    case ready
    case text(String)
    /// Relay only: the computer is not connected to the relay. The relay socket stays open.
    case bridgeOffline
    case bridgeOnline
    /// Relay only: message 2 said ok:true (the bridge knows this phone now).
    case paired(name: String?, bridgeID: String?)
    /// Relay only: message 2 said ok:false.
    case notPaired(reason: String)
    case closed(reason: String)
    case log(String)
}

@MainActor
protocol Transport: AnyObject {
    var path: ConnectionPath { get }
    var onEvent: ((TransportEvent) -> Void)? { get set }
    func start()
    @discardableResult func send(_ text: String) -> Bool
    func close()
}

// MARK: - Relay framing (SPEC 12.2, phone side)

enum RelayFrame: Equatable {
    case data(Data)
    case bridgeOffline
    case bridgeOnline
    case pong
    case other(String)

    private struct Raw: Codable {
        var t: String
        var d: String?
    }

    /// nil for frames that are not JSON or have no `t`, and for data frames with bad base64url.
    static func decode(_ text: String) -> RelayFrame? {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: Data(text.utf8)) else { return nil }
        switch raw.t {
        case "data":
            guard let d = raw.d, let bytes = Base64URL.decode(d) else { return nil }
            return .data(bytes)
        case "bridge_offline": return .bridgeOffline
        case "bridge_online": return .bridgeOnline
        case "pong": return .pong
        default: return .other(raw.t)
        }
    }

    /// App-level relay keepalive (a hibernating Durable Object may not count WebSocket ping frames).
    static let ping = #"{"t":"ping"}"#

    /// Data frames: `{"d":"<base64url>","t":"data"}`.
    static func encodeData(_ bytes: Data) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(Raw(t: "data", d: Base64URL.encode(bytes)))) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

/// Handshake payloads (SPEC 12.3).
enum HandshakePayload {
    /// Message 1: `{phone_id, name, pair_secret?}`.
    static func message1(phoneID: String, name: String, pairSecret: String?) -> Data {
        var object: [String: String] = ["phone_id": phoneID, "name": name]
        if let pairSecret, !pairSecret.isEmpty { object["pair_secret"] = pairSecret }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }

    /// Message 2: `{ok:true, name, bridge_id}` or `{ok:false, reason}`.
    struct Reply: Equatable {
        var ok: Bool
        var name: String?
        var bridgeID: String?
        var reason: String?
    }

    static func reply(_ data: Data) -> Reply {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return Reply(ok: false, reason: "bad_reply")
        }
        return Reply(ok: (object["ok"] as? Bool) ?? false,
                     name: object["name"] as? String,
                     bridgeID: object["bridge_id"] as? String,
                     reason: object["reason"] as? String)
    }
}

/// Relay base URL (`relay=` in the link) to the phone socket `<relay>/v1/phone/<bridge_id>`.
enum RelayAddress {
    /// Normalizes a relay base URL to ws/wss, or nil if it is not one.
    static func base(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        if lower.hasPrefix("https://") { text = "wss://" + text.dropFirst(8) }
        else if lower.hasPrefix("http://") { text = "ws://" + text.dropFirst(7) }
        guard var comps = URLComponents(string: text),
              let scheme = comps.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              let host = comps.host, !host.isEmpty else { return nil }
        comps.scheme = scheme
        var path = comps.path
        while path.hasSuffix("/") { path.removeLast() }
        comps.path = path
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }

    static func phoneURL(base raw: String, bridgeID: String) -> URL? {
        guard let base = base(raw), var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        let id = bridgeID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? bridgeID
        comps.percentEncodedPath = comps.percentEncodedPath + "/v1/phone/" + id
        return comps.url
    }
}

// MARK: - Path choice (SPEC 12.6)

/// Start the relay handshake and, in parallel, health-check the direct URLs. A direct URL that
/// answers with the right bridge_id before the relay handshake finishes wins; otherwise the relay.
/// The first decision is final for this attempt.
struct PathRace: Equatable {
    enum Decision: Equatable {
        case undecided
        case relay
        case direct(URL)
        case failed
    }

    let hasRelay: Bool
    let hasDirect: Bool
    private(set) var decision: Decision = .undecided
    private var relayFailed: Bool
    private var relayWaiting = false
    private var directFailed: Bool

    init(hasRelay: Bool, hasDirect: Bool) {
        self.hasRelay = hasRelay
        self.hasDirect = hasDirect
        relayFailed = !hasRelay
        directFailed = !hasDirect
        if !hasRelay && !hasDirect { decision = .failed }
    }

    /// The relay handshake finished.
    mutating func relayReady() -> Decision {
        relayWaiting = false
        if decision == .undecided { decision = .relay }
        return decision
    }

    /// The relay says the computer is offline. Commit to the relay (and wait there) once no direct
    /// URL can win.
    mutating func relayBridgeOffline() -> Decision {
        relayWaiting = true
        if decision == .undecided && directFailed { decision = .relay }
        return decision
    }

    mutating func relayFailedNow() -> Decision {
        relayFailed = true
        relayWaiting = false
        if decision == .undecided && directFailed { decision = .failed }
        return decision
    }

    mutating func directAnswered(_ url: URL) -> Decision {
        if decision == .undecided { decision = .direct(url) }
        return decision
    }

    mutating func directFailedNow() -> Decision {
        directFailed = true
        if decision == .undecided {
            if relayFailed { decision = .failed }
            else if relayWaiting { decision = .relay }
        }
        return decision
    }
}

// MARK: - Direct transport (WebSocket to the bridge, token in hello)

@MainActor
final class DirectTransport: Transport {
    let path: ConnectionPath = .direct
    var onEvent: ((TransportEvent) -> Void)?
    let url: URL

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var closed = false

    init(url: URL, session: URLSession) {
        self.url = url
        self.session = session
    }

    func start() {
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        self.task = task
        task.resume()
        receiveLoop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    let frame = try await task.receive()
                    guard let self, !self.closed else { return }
                    switch frame {
                    case .string(let s): self.emit(.text(s))
                    case .data(let d): self.emit(.text(String(decoding: d, as: UTF8.self)))
                    @unknown default: break
                    }
                } catch {
                    guard let self, !self.closed else { return }
                    self.fail(task.closeCode != .invalid ? "Closed by server (\(task.closeCode.rawValue))" : error.localizedDescription)
                    return
                }
            }
        }
        emit(.ready)  // sends are queued until the socket opens
    }

    func send(_ text: String) -> Bool {
        guard !closed, let task else { return false }
        task.send(.string(text)) { [weak self] error in
            guard let error else { return }
            let description = error.localizedDescription
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.fail("Send failed: \(description)") }
            }
        }
        return true
    }

    func close() {
        closed = true
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func emit(_ event: TransportEvent) {
        guard !closed else { return }
        onEvent?(event)
    }

    private func fail(_ reason: String) {
        guard !closed else { return }
        let handler = onEvent
        close()
        handler?(.closed(reason: reason))
    }
}

// MARK: - Relay transport (Noise IK over the relay's JSON framing)

@MainActor
final class RelayTransport: Transport {
    /// Send `{"t":"ping"}` this often; no `{"t":"pong"}` for `pongTimeout` means the socket is dead.
    nonisolated static let pingInterval: TimeInterval = 25
    nonisolated static let pongTimeout: TimeInterval = 60

    let path: ConnectionPath = .relay
    var onEvent: ((TransportEvent) -> Void)?

    private(set) var isReady = false
    private(set) var isBridgeOffline = false

    private let url: URL
    private let bridgeKey: Curve25519.KeyAgreement.PublicKey
    private let staticKey: Curve25519.KeyAgreement.PrivateKey
    private let phoneID: String
    private let phoneName: String
    private let pairSecret: String?
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var pingTimer: Timer?
    private var initiator: NoiseIKInitiator?
    private var noise: NoiseTransport?
    private var closed = false
    private var lastPingSent = Date()
    private var lastPong = Date()

    init?(phoneURL: URL, bridgeKey: Data, staticKey: Curve25519.KeyAgreement.PrivateKey,
          phoneID: String, phoneName: String, pairSecret: String?, session: URLSession) {
        guard let key = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: bridgeKey) else { return nil }
        url = phoneURL
        self.bridgeKey = key
        self.staticKey = staticKey
        self.phoneID = phoneID
        self.phoneName = phoneName
        self.pairSecret = pairSecret
        self.session = session
    }

    func start() {
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        self.task = task
        task.resume()
        receiveLoop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    let frame = try await task.receive()
                    guard let self, !self.closed else { return }
                    switch frame {
                    case .string(let s): self.handleFrame(s)
                    case .data(let d): self.handleFrame(String(decoding: d, as: UTF8.self))
                    @unknown default: break
                    }
                } catch {
                    guard let self, !self.closed else { return }
                    self.fail(task.closeCode != .invalid ? "Relay closed the connection (\(task.closeCode.rawValue))" : error.localizedDescription)
                    return
                }
            }
        }
        lastPingSent = Date()
        lastPong = Date()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepalive() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pingTimer = timer
        beginHandshake()
    }

    func send(_ text: String) -> Bool {
        guard !closed, isReady, var noise else { return false }
        do {
            let ciphertext = try noise.encrypt(Data(text.utf8))
            self.noise = noise
            sendFrame(ciphertext)
            return true
        } catch {
            fail("Could not encrypt a message: \(error)")
            return false
        }
    }

    func close() {
        closed = true
        isReady = false
        pingTimer?.invalidate()
        pingTimer = nil
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        noise = nil
        initiator = nil
    }

    private func keepalive() {
        guard !closed, let task else { return }
        let now = Date()
        if now.timeIntervalSince(lastPong) > Self.pongTimeout {
            fail("No pong from the relay for \(Int(Self.pongTimeout)) s")
            return
        }
        if now.timeIntervalSince(lastPingSent) >= Self.pingInterval {
            lastPingSent = now
            task.send(.string(RelayFrame.ping)) { _ in }  // a broken socket surfaces in receive()
        }
    }

    // MARK: Handshake

    private func beginHandshake() {
        isReady = false
        noise = nil
        var handshake = NoiseIKInitiator(localStatic: staticKey, remoteStatic: bridgeKey)
        let payload = HandshakePayload.message1(phoneID: phoneID, name: phoneName, pairSecret: pairSecret)
        do {
            let message1 = try handshake.writeMessage1(payload: payload)
            initiator = handshake
            sendFrame(message1)
        } catch {
            fail("Could not start the encrypted session: \(error)")
        }
    }

    private func handleFrame(_ text: String) {
        guard let frame = RelayFrame.decode(text) else {
            emit(.log("Relay sent a frame Earpiece does not understand."))
            return
        }
        switch frame {
        case .data(let bytes):
            handleData(bytes)
        case .bridgeOffline:
            // Any session with the old bridge connection is gone; a new one starts on bridge_online.
            isBridgeOffline = true
            isReady = false
            noise = nil
            initiator = nil
            emit(.bridgeOffline)
        case .bridgeOnline:
            let wasOffline = isBridgeOffline
            isBridgeOffline = false
            emit(.bridgeOnline)
            if wasOffline || (!isReady && initiator == nil) { beginHandshake() }
        case .pong:
            lastPong = Date()
        case .other(let type):
            emit(.log("Relay: \(type)"))
        }
    }

    private func handleData(_ bytes: Data) {
        if var session = noise {
            do {
                let plaintext = try session.decrypt(bytes)
                noise = session
                emit(.text(String(decoding: plaintext, as: UTF8.self)))
            } catch {
                fail("Could not decrypt a message from the bridge")  // SPEC 12.3: close on failure
            }
            return
        }
        guard var handshake = initiator else { return }
        do {
            let (payload, transport) = try handshake.readMessage2(bytes)
            initiator = nil
            let reply = HandshakePayload.reply(payload)
            guard reply.ok else {
                let handler = onEvent
                close()
                handler?(.notPaired(reason: reply.reason ?? "not_paired"))
                return
            }
            noise = transport
            isReady = true
            emit(.paired(name: reply.name, bridgeID: reply.bridgeID))
            emit(.ready)
        } catch {
            fail("The encrypted handshake failed")
        }
    }

    private func sendFrame(_ bytes: Data) {
        guard let task else { return }
        task.send(.string(RelayFrame.encodeData(bytes))) { [weak self] error in
            guard let error else { return }
            let description = error.localizedDescription
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.fail("Send to relay failed: \(description)") }
            }
        }
    }

    private func emit(_ event: TransportEvent) {
        guard !closed else { return }
        onEvent?(event)
    }

    private func fail(_ reason: String) {
        guard !closed else { return }
        let handler = onEvent
        close()
        handler?(.closed(reason: reason))
    }
}
