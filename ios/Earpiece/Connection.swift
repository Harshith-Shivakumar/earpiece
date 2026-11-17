import Foundation

/// The phone's link to one bridge (SPEC 1, 8, 11.4, 12.6).
/// - Protocol: hello (+ last_seq), welcome, JSON ping every 20 s, reconnect with backoff 1, 2, 4, 8,
///   then 15 s.
/// - Paths: a saved connection may have the relay (Noise IK end to end), direct URLs plus a token,
///   or both. With both, each attempt starts the relay handshake and races the direct health checks
///   (1.5 s); a direct URL answering with the right bridge_id first wins. With direct only, URLs are
///   tried in order (last good one first) with a 2 s health check each.
@MainActor
final class Connection {
    enum Status: Equatable {
        case offline
        case connecting
        case connected
        case retrying(in: Int)
        /// Relay: connected to the relay, but the computer is not.
        case bridgeOffline

        var label: String {
            switch self {
            case .offline: return "Offline"
            case .connecting: return "Connecting"
            case .connected: return "Connected"
            case .retrying(let s): return "Retrying in \(s) s"
            case .bridgeOffline: return "Computer offline"
            }
        }
    }

    static let backoff: [TimeInterval] = [1, 2, 4, 8, 15]
    static let pingInterval: TimeInterval = 20
    /// No frame at all (not even a pong) for this long means the link is dead.
    static let silenceLimit: TimeInterval = 50
    /// After the transport is ready, the welcome must arrive within this long.
    static let handshakeLimit: TimeInterval = 10
    /// A whole attempt (health checks, relay handshake) must become ready within this long.
    static let attemptLimit: TimeInterval = 20
    static let raceTimeout: TimeInterval = 1.5

    // Events (main actor).
    var onStatus: ((Status) -> Void)?
    var onPath: ((ConnectionPath?) -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    /// Welcome received. `afterLoss` is true when this ends an outage, false for the first connect.
    var onWelcomed: ((_ afterLoss: Bool) -> Void)?
    /// First failure of an outage. `everConnected` is false when the server was never reached.
    var onDropped: ((_ everConnected: Bool) -> Void)?
    var onAuthFailed: ((String) -> Void)?
    var onLog: ((String) -> Void)?
    /// A direct URL answered /health with the right bridge and is used.
    var onResolved: ((URL, HealthInfo) -> Void)?
    /// No path answered. The message is for the screen ("Can't reach <name>. Is Tailscale on?").
    var onUnreachable: ((String) -> Void)?
    /// Relay: the computer is offline (relay socket stays open and waits).
    var onBridgeOffline: (() -> Void)?
    /// Relay: the bridge accepted this phone (message 2 ok:true).
    var onPaired: ((_ name: String?, _ bridgeID: String?) -> Void)?
    /// Relay: the bridge does not know this phone. Retrying stops.
    var onNotPaired: ((String) -> Void)?

    struct RelayTarget: Equatable {
        var phoneURL: URL
        var bridgeKey: Data
        /// Sent in message 1 until the bridge has accepted this phone once.
        var pairSecret: String?
    }

    /// What to connect to: one saved connection.
    struct Target: Equatable {
        var connectionID: String
        var name: String
        var urls: [URL]
        var lastURL: URL?
        /// nil while the bridge_id is unknown (migrated or hand-added connection).
        var expectedBridgeID: String?
        var token: String
        var relay: RelayTarget?

        var hasDirect: Bool { !urls.isEmpty && !token.isEmpty }
        var isUsable: Bool { relay != nil || hasDirect }

        /// Everything except `lastURL` and the pairing secret, which change on their own.
        func sameEndpoint(as other: Target) -> Bool {
            connectionID == other.connectionID && urls == other.urls
                && expectedBridgeID == other.expectedBridgeID && token == other.token
                && relay?.phoneURL == other.relay?.phoneURL && relay?.bridgeKey == other.relay?.bridgeKey
        }
    }

    /// Supplies `last_seq` for each hello.
    var lastSeqProvider: () -> Int = { 0 }

    private(set) var status: Status = .offline {
        didSet { if status != oldValue { onStatus?(status) } }
    }
    private(set) var path: ConnectionPath? {
        didSet { if path != oldValue { onPath?(path) } }
    }
    private(set) var isWelcomed = false
    private(set) var target: Target?
    /// The URL of the current direct socket.
    private(set) var currentURL: URL?

    private let session: URLSession
    private var transport: Transport?
    private var relayCandidate: RelayTransport?
    private var race: PathRace?
    private var directTask: Task<Void, Never>?
    private var directWinner: (url: URL, info: HealthInfo)?
    private var notPairedReason: String?
    private var tick: Timer?
    private var retryWork: DispatchWorkItem?
    private var wanted = false
    private var attempt = 0
    private var attemptID = 0
    private var attemptStartedAt = Date()
    private var readyAt: Date?
    private var lastReceived = Date()
    private var lastPing = Date()
    private var everWelcomed = false
    private var outageReported = false

    private let clientName = "earpiece-ios/2.0"

    init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    func connect(to target: Target) {
        self.target = target
        wanted = true
        attempt = 0
        everWelcomed = false
        outageReported = false
        open()
    }

    func disconnect() {
        wanted = false
        retryWork?.cancel()
        retryWork = nil
        closeAll()
        status = .offline
    }

    /// The bridge told us its id (placeholder connection re-keyed): expect it from now on.
    func learnedIdentity(connectionID: String, bridgeID: String) {
        target?.connectionID = connectionID
        target?.expectedBridgeID = bridgeID
    }

    /// Sends a message on the live link. Returns false if there is no welcomed connection
    /// (hello is the only message sent before welcome).
    @discardableResult
    func send(_ message: ClientMessage) -> Bool {
        guard let transport else { return false }
        if case .hello = message {} else if !isWelcomed { return false }
        let text: String
        do {
            text = try Wire.encode(message)
        } catch {
            onLog?("Could not encode message: \(error.localizedDescription)")
            return false
        }
        return transport.send(text)
    }

    // MARK: Attempts

    private func open() {
        guard wanted, let target else { return }
        closeAll()
        let id = attemptID
        status = .connecting
        attemptStartedAt = Date()
        notPairedReason = nil
        directWinner = nil
        race = PathRace(hasRelay: target.relay != nil, hasDirect: target.hasDirect)
        startTick()
        if race?.decision == .failed {
            apply(.failed)
            return
        }
        if let relay = target.relay { startRelay(relay, id: id) }
        if target.hasDirect { startDirectChecks(target, racing: target.relay != nil, id: id) }
    }

    private func startRelay(_ relay: RelayTarget, id: Int) {
        let identity = PhoneIdentity.shared
        guard let candidate = RelayTransport(phoneURL: relay.phoneURL, bridgeKey: relay.bridgeKey,
                                             staticKey: identity.staticKey, phoneID: identity.phoneID,
                                             phoneName: identity.name, pairSecret: relay.pairSecret,
                                             session: session) else {
            onLog?("The saved key for this computer is not valid. Scan its QR code again.")
            update { $0.relayFailedNow() }
            return
        }
        relayCandidate = candidate
        candidate.onEvent = { [weak self, weak candidate] event in
            guard let self, let candidate, id == self.attemptID else { return }
            self.relayEvent(event, from: candidate)
        }
        candidate.start()
    }

    private func startDirectChecks(_ target: Target, racing: Bool, id: Int) {
        let order = ConnectionOrder.order(urls: target.urls, lastURL: target.lastURL)
        let expected = target.expectedBridgeID
        directTask = Task { @MainActor [weak self] in
            var winner: (URL, HealthInfo)?
            if racing {
                // All at once, 1.5 s each: the relay handshake is running in parallel.
                winner = await withTaskGroup(of: (URL, HealthInfo?).self) { group in
                    for url in order {
                        group.addTask {
                            if case .success(let info) = await HealthCheck.check(url, timeout: Connection.raceTimeout),
                               HealthCheck.accepts(info, expectedBridgeID: expected) {
                                return (url, info)
                            }
                            return (url, nil)
                        }
                    }
                    for await (url, info) in group {
                        if let info {
                            group.cancelAll()
                            return (url, info)
                        }
                    }
                    return nil
                }
            } else {
                for url in order {
                    let result = await HealthCheck.check(url)
                    guard let self, id == self.attemptID, !Task.isCancelled else { return }
                    switch result {
                    case .success(let info) where HealthCheck.accepts(info, expectedBridgeID: expected):
                        winner = (url, info)
                    case .success(let info):
                        self.onLog?("\(url.host ?? "?") answered as another bridge (\(info.name ?? info.bridgeID ?? "unknown")).")
                    case .failure(let error):
                        self.onLog?("\(url.host ?? "?") did not answer: \(error.localizedDescription)")
                    }
                    if winner != nil { break }
                }
            }
            guard let self, id == self.attemptID, !Task.isCancelled else { return }
            if let winner {
                self.directWinner = winner
                self.update { $0.directAnswered(winner.0) }
            } else {
                self.update { $0.directFailedNow() }
            }
        }
    }

    private func update(_ change: (inout PathRace) -> PathRace.Decision) {
        guard var current = race else { return }
        let decision = change(&current)
        race = current
        apply(decision)
    }

    /// Act on the race decision once. Later events from a committed transport are handled directly.
    private func apply(_ decision: PathRace.Decision) {
        guard transport == nil, wanted, let target else { return }
        switch decision {
        case .undecided:
            return
        case .relay:
            guard let relay = relayCandidate else { return }
            relayCandidate = nil
            directTask?.cancel()
            transport = relay
            path = .relay
            if relay.isReady {
                transportReady()
            } else if relay.isBridgeOffline {
                bridgeWentOffline()
            }
        case .direct(let url):
            relayCandidate?.close()
            relayCandidate = nil
            if let winner = directWinner, winner.url == url {
                self.target?.lastURL = url
                onResolved?(url, winner.info)
            }
            openDirect(url)
        case .failed:
            relayCandidate?.close()
            relayCandidate = nil
            if let reason = notPairedReason {
                notPaired(reason)
            } else {
                onUnreachable?(ConnectionOrder.unreachableMessage(name: target.name, urls: target.urls))
                fail("No path to \(target.name) answered")
            }
        }
    }

    private func openDirect(_ url: URL) {
        let id = attemptID
        currentURL = url
        let direct = DirectTransport(url: url, session: session)
        transport = direct
        path = .direct
        direct.onEvent = { [weak self] event in
            guard let self, id == self.attemptID else { return }
            switch event {
            case .ready: self.transportReady()
            case .text(let text): self.handleText(text)
            case .closed(let reason): self.fail(reason)
            case .log(let line): self.onLog?(line)
            default: break
            }
        }
        direct.start()
    }

    private func relayEvent(_ event: TransportEvent, from relay: RelayTransport) {
        let committed = transport === relay
        switch event {
        case .ready:
            if committed { transportReady() } else { update { $0.relayReady() } }
        case .text(let text):
            if committed { handleText(text) }
        case .bridgeOffline:
            if committed { bridgeWentOffline() } else { update { $0.relayBridgeOffline() } }
        case .bridgeOnline:
            onLog?("The computer is back on the relay.")
            if committed {
                status = .connecting
                attemptStartedAt = Date()
            }
        case .paired(let name, let bridgeID):
            target?.relay?.pairSecret = nil  // used once; never resend
            onPaired?(name, bridgeID)
        case .notPaired(let reason):
            notPairedReason = reason
            if committed { notPaired(reason) } else { update { $0.relayFailedNow() } }
        case .closed(let reason):
            onLog?("Relay: \(reason)")
            if committed { fail(reason) } else { update { $0.relayFailedNow() } }
        case .log(let line):
            onLog?(line)
        }
    }

    /// The committed transport can carry protocol messages: say hello.
    private func transportReady() {
        guard let target else { return }
        readyAt = Date()
        lastReceived = Date()
        lastPing = Date()
        // Over the relay the Noise session already authenticated this phone: no token (SPEC 12.3).
        let token: String? = path == .direct ? target.token : nil
        send(.hello(token: token, lastSeq: lastSeqProvider(), client: clientName))
    }

    private func bridgeWentOffline() {
        isWelcomed = false
        readyAt = nil
        status = .bridgeOffline
        if everWelcomed { outageReported = true }  // so the next welcome says "Reconnected."
        onBridgeOffline?()
    }

    private func notPaired(_ reason: String) {
        onLog?("The bridge does not know this phone (\(reason)).")
        wanted = false
        retryWork?.cancel()
        closeAll()
        status = .offline
        onNotPaired?(reason)
    }

    private func handleText(_ text: String) {
        lastReceived = Date()
        let message: ServerMessage
        do {
            message = try Wire.decode(text)
        } catch {
            onLog?("Ignored a frame that is not valid JSON: \(text.prefix(120))")
            return
        }

        switch message {
        case .welcome:
            let afterLoss = everWelcomed
            isWelcomed = true
            everWelcomed = true
            attempt = 0
            status = .connected
            let wasOutage = outageReported
            outageReported = false
            onWelcomed?(afterLoss && wasOutage)
            onMessage?(message)
        case .error(let err) where err.code == "auth":
            onMessage?(message)
            wanted = false
            retryWork?.cancel()
            closeAll()
            status = .offline
            onAuthFailed?(err.message)
        default:
            onMessage?(message)
        }
    }

    private func fail(_ reason: String) {
        guard wanted else { return }
        onLog?("Connection lost: \(reason)")
        closeAll()
        if !outageReported {
            outageReported = true
            onDropped?(everWelcomed)
        }
        // onDropped may have called disconnect() (for example after end_drive).
        guard wanted else { return }
        scheduleRetry()
    }

    private func scheduleRetry() {
        let delay = Self.backoff[min(attempt, Self.backoff.count - 1)]
        attempt += 1
        status = .retrying(in: Int(delay))
        retryWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.open() }
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func closeAll() {
        attemptID += 1
        isWelcomed = false
        readyAt = nil
        directTask?.cancel()
        directTask = nil
        relayCandidate?.close()
        relayCandidate = nil
        transport?.close()
        transport = nil
        race = nil
        currentURL = nil
        path = nil
        tick?.invalidate()
        tick = nil
    }

    // MARK: Keepalive and watchdogs

    private func startTick() {
        tick?.invalidate()
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        tick = timer
    }

    private func onTick() {
        guard wanted, status != .bridgeOffline else { return }  // the relay keeps its own socket alive
        let now = Date()
        if !isWelcomed {
            if let readyAt {
                if now.timeIntervalSince(readyAt) > Self.handshakeLimit {
                    fail("No welcome from the bridge within \(Int(Self.handshakeLimit)) s")
                }
            } else if now.timeIntervalSince(attemptStartedAt) > Self.attemptLimit {
                fail("Timed out connecting")
            }
            return
        }
        if now.timeIntervalSince(lastReceived) > Self.silenceLimit {
            fail("Nothing received for \(Int(Self.silenceLimit)) s")
            return
        }
        if now.timeIntervalSince(lastPing) >= Self.pingInterval {
            lastPing = now
            send(.ping)
        }
    }
}
