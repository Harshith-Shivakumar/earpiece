import AVFoundation
import Combine
import Speech

/// Coordinates audio, speech-to-text, text-to-speech and the bridge connection.
/// Implements the SPEC 1 speaking rules, SPEC 2 command handling, SPEC 8 app behaviour and the
/// phone side of SPEC 10 (chats) and SPEC 11 (saved connections, pairing, End drive). The connection
/// lives while the app is in the foreground (so chats can be listed before a drive); a drive turns
/// audio on over that same connection.
@MainActor
final class DriveController: ObservableObject {
    static let shared = DriveController()

    struct LogLine: Identifiable, Equatable {
        let id = UUID()
        let time: Date
        let text: String
    }

    // UI state.
    @Published private(set) var isLive = false
    @Published private(set) var isStarting = false
    @Published private(set) var link: Connection.Status = .offline
    @Published private(set) var bridgeState: BridgeState = .idle
    @Published private(set) var cwd = ""
    @Published private(set) var isPaused = false
    @Published private(set) var lastSpoken = ""
    @Published private(set) var liveTranscript = ""
    @Published private(set) var audioRoute = ""
    @Published private(set) var log: [LogLine] = []
    @Published var alert: String?
    // Chats (SPEC 10).
    @Published private(set) var chats: [ChatItem] = []
    @Published private(set) var currentChat: ChatRef?
    @Published private(set) var isRefreshingChats = false
    // Connections and End drive (SPEC 11).
    /// "Can't reach <name>. Is Tailscale on?" while no saved address answers.
    @Published private(set) var connectionProblem: String?
    /// "via relay" or "direct" while connected (SPEC 12.6).
    @Published private(set) var linkPath: ConnectionPath?
    /// The Continue at your desk card, from `drive_ended`. Stays until dismissed or a new drive starts.
    @Published private(set) var deskCard: DriveEnded?
    /// End drive was sent; waiting for `drive_ended` (audio stays on, at most 70 s).
    @Published private(set) var isEndingDrive = false
    /// The bridge answered End drive with `busy`: ask "Stop and end" / "Keep driving".
    @Published var showEndDriveBusy = false
    /// A pairing link waiting for "Add <name>?".
    @Published var pendingPairing: PairingInfo?

    enum ChatAction: Equatable {
        case open(id: String)
        case new
    }

    let settings = SettingsStore.shared
    let connections = ConnectionStore.shared

    private let audio = AudioEngine()
    private let connection = Connection()
    private lazy var speaker = Speaker(audio: audio)
    private lazy var listener = Listener(audio: audio)

    private var queue = SpeechQueue()
    private var current: SpeechItem?
    private var lastReplyOrQuestion: SpeechItem?
    /// After a local repeat, the bridge also re-sends the line; skip that copy (see report).
    private var repeatSuppression: (text: String, until: Date)?
    private var endDriveRequestedAt: Date?
    /// Finish the drive once the speech queue is empty.
    private var endingDrive = false
    private var settingsObserver: AnyCancellable?

    /// A chat tapped before the drive was live; sent once audio is on and the bridge has welcomed us.
    private var pendingChatAction: ChatAction?
    private var appIsActive = false
    /// The bridge rejected the token; do not reconnect on our own until the app is reopened or Settings change.
    private var authRejected = false
    /// What the connection was last pointed at.
    private var activeTarget: Connection.Target?
    private var endDriveTimer: DispatchWorkItem?
    private var endDriveFromButton = false
    private var bridgeOfflineSpoken = false
    /// Increments per drive, so delayed work from an ended drive cannot touch the next one.
    private var driveGeneration = 0

    // Echo guard for the current turn (see EchoFilter).
    private var turnInProgress = false
    private var turnTiming: EchoFilter.Timing = .notNear
    private var turnHeardOtherAudio = false
    /// The line being spoken, or the last one spoken.
    private var ttsText = ""
    private var ttsEndedAt: Date?

    private let defaults = UserDefaults.standard
    /// seq numbering is per bridge, so last_seq is kept per connection.
    private var seqKey: String { "lastSeq.\(activeTarget?.connectionID ?? "none")" }
    private var lastSeq: Int {
        get { defaults.integer(forKey: seqKey) }
        set { defaults.set(newValue, forKey: seqKey) }
    }
    private var driveID: String? {
        get { defaults.string(forKey: "driveID.\(activeTarget?.connectionID ?? "none")") }
        set { defaults.set(newValue, forKey: "driveID.\(activeTarget?.connectionID ?? "none")") }
    }

    private init() {
        wireConnection()
        wireAudio()
        wireListener()
        settingsObserver = settings.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.applySettings() }
    }

    // MARK: - Start / stop

    func start() {
        guard !isLive, !isStarting else { return }
        isStarting = true
        Task {
            await startDrive()
            if !isLive { pendingChatAction = nil }
            isStarting = false
        }
    }

    // MARK: - End drive (SPEC 11.5)

    /// The End drive button, after its confirmation. `force` after "Stop and end".
    func endDrive(force: Bool = false) {
        guard isLive else { return }
        showEndDriveBusy = false
        endDriveFromButton = true
        requestEndDrive(force: force, fromButton: true)
    }

    /// "Keep driving" on the busy question.
    func keepDriving() {
        showEndDriveBusy = false
        cancelEndDriveWait()
        addLog("Kept driving.")
    }

    func dismissDeskCard() {
        deskCard = nil
    }

    private func requestEndDrive(force: Bool, fromButton: Bool) {
        endDriveRequestedAt = Date()
        guard connection.send(.control(action: .endDrive, force: force)) else {
            endDriveRequestedAt = nil
            if fromButton {
                // The bridge cannot be told; stop audio here. It ends the drive itself after
                // 30 minutes without a phone.
                stopDrive(reason: "Not connected, so audio stopped here. The bridge ends the drive after 30 minutes without the phone.")
            } else {
                speakLocal("Not connected. Say that again after I reconnect.")
            }
            return
        }
        addLog(force ? "Asked the bridge to stop Claude and end the drive." : "Asked the bridge to end the drive.")
        isEndingDrive = true
        endDriveTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isLive, self.isEndingDrive else { return }
                self.stopDrive(reason: "No drive_ended from the bridge within 70 s; audio stopped.")
            }
        }
        endDriveTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 70, execute: work)
    }

    private func cancelEndDriveWait() {
        endDriveTimer?.cancel()
        endDriveTimer = nil
        isEndingDrive = false
        endDriveRequestedAt = nil
        endDriveFromButton = false
    }

    private func driveEnded(_ ended: DriveEnded) {
        cancelEndDriveWait()
        showEndDriveBusy = false
        deskCard = ended
        addLog("Drive ended. Continue at your desk: \(ended.chats.map(\.title).joined(separator: ", "))")
        guard isLive else { return }
        // Let the closing lines finish (one may still be on its way), then stop audio, with a cap.
        let generation = driveGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isLive, self.driveGeneration == generation else { return }
                self.endingDrive = true
                self.pump()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isLive, self.driveGeneration == generation else { return }
                self.stopDrive(reason: "Drive ended.")
            }
        }
    }

    // MARK: - Connections (SPEC 11.4)

    /// Picker on the main screen. Only without a live drive.
    func selectConnection(_ id: String) {
        guard !isLive, id != connections.selectedID else { return }
        connections.select(id)
        resetForNewBridge()
        connectIfPossible(force: true)
    }

    /// After adding, editing or deleting connections: reconnect if the selected one changed.
    func connectionsDidChange() {
        authRejected = false
        if connections.selected == nil {
            connection.disconnect()
            activeTarget = nil
            resetForNewBridge()
            return
        }
        if let active = activeTarget, active.connectionID != connections.selectedID, !isLive {
            resetForNewBridge()
        }
        connectIfPossible()
    }

    /// /health or welcome gave the bridge_id: re-key a placeholder connection (migrated or added by
    /// hand) and expect that id from now on. A known id that does not match is only logged.
    private func learnIdentity(bridgeID: String, name: String?) {
        guard let active = activeTarget else { return }
        if active.expectedBridgeID == nil {
            let oldKey = seqKey
            let seq = lastSeq
            let newID = connections.learnIdentity(of: active.connectionID, bridgeID: bridgeID, name: name)
            guard newID != active.connectionID else { return }
            activeTarget?.connectionID = newID
            activeTarget?.expectedBridgeID = bridgeID
            activeTarget?.name = connections.connection(id: newID)?.name ?? active.name
            connection.learnedIdentity(connectionID: newID, bridgeID: bridgeID)
            defaults.removeObject(forKey: oldKey)
            if seq > lastSeq { lastSeq = seq }
            addLog("Learned bridge identity: \(name ?? bridgeID).")
        } else if active.expectedBridgeID != bridgeID {
            addLog("Warning: the bridge reports id \(bridgeID), expected \(active.expectedBridgeID ?? "?").")
        }
    }

    private func resetForNewBridge() {
        connection.disconnect()
        activeTarget = nil
        chats = []
        currentChat = nil
        bridgeState = .idle
        cwd = ""
        connectionProblem = nil
    }

    /// `earpiece://pair?...` from the Camera app (onOpenURL) or the in-app scanner.
    func handleOpenURL(_ url: URL) {
        switch Pairing.parse(url) {
        case .success(let info): pendingPairing = info
        case .failure(let error): alert = error.message
        }
    }

    /// "Add <name>?" confirmed.
    func confirmPairing(_ info: PairingInfo) {
        pendingPairing = nil
        connections.apply(pairing: info)
        addLog("Saved connection \(info.name).")
        if !isLive {
            if activeTarget?.connectionID != info.id { resetForNewBridge() }
            connections.select(info.id)
        }
        authRejected = false
        connectIfPossible()
    }

    /// Tapped a chat on screen: start the drive with it, or switch to it during a drive.
    func pick(_ chat: ChatItem) {
        requestChat(.open(id: chat.id), label: chat.title)
    }

    /// Tapped "New chat".
    func pickNewChat() {
        requestChat(.new, label: "New chat")
    }

    private func requestChat(_ action: ChatAction, label: String) {
        addLog("Chosen on screen: \(label)")
        if isLive {
            sendChatAction(action)
        } else {
            pendingChatAction = action
            start()
        }
    }

    private func sendChatAction(_ action: ChatAction) {
        let message: ClientMessage
        switch action {
        case .open(let id): message = .openChat(id: id)
        case .new: message = .newChat(cwd: nil)
        }
        if !connection.send(message) {
            speakLocal("Not connected. Try again after I reconnect.")
        }
    }

    func refreshChats() {
        guard connection.send(.listChats) else { return }
        isRefreshingChats = true
    }

    /// For pull to refresh: ask, then wait (up to 5 s) for the answer. When not connected, retry now
    /// instead of waiting out the backoff.
    func refreshChatsAndWait() async {
        if !connection.isWelcomed {
            authRejected = false
            connectIfPossible(force: true)
            let deadline = Date().addingTimeInterval(5)
            while !connection.isWelcomed && connection.status != .offline && Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        refreshChats()
        let deadline = Date().addingTimeInterval(5)
        while isRefreshingChats && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        isRefreshingChats = false
    }

    func appDidBecomeActive() {
        appIsActive = true
        authRejected = false
        connectIfPossible()
        if isLive { audio.recoverIfNeeded() }
    }

    func appDidEnterBackground() {
        appIsActive = false
        // Without a drive the app is suspended soon; close cleanly instead of leaving a dead socket.
        if !isLive { connection.disconnect() }
    }

    /// The selected saved connection as a connection target, if it is usable.
    private func selectedTarget() -> Connection.Target? {
        guard let saved = connections.selected else { return nil }
        var relay: Connection.RelayTarget?
        if saved.hasRelay, let base = saved.relay, let key = saved.bridgeKey.flatMap(Base64URL.decode),
           let phoneURL = RelayAddress.phoneURL(base: base, bridgeID: saved.id) {
            relay = Connection.RelayTarget(phoneURL: phoneURL, bridgeKey: key, pairSecret: connections.pairSecret(for: saved.id))
        }
        let target = Connection.Target(
            connectionID: saved.id,
            name: saved.name,
            urls: saved.webSocketURLs,
            lastURL: saved.lastURL.flatMap { ServerAddress.webSocketURL(from: $0) },
            expectedBridgeID: saved.hasKnownID ? saved.id : nil,
            token: connections.token(for: saved.id),
            relay: relay)
        return target.isUsable ? target : nil
    }

    /// Connect (hello) to the selected connection unless already connected to it.
    /// `force` also restarts a connection that is waiting to retry.
    private func connectIfPossible(force: Bool = false) {
        guard let target = selectedTarget(), !authRejected else { return }
        let same = activeTarget.map { $0.sameEndpoint(as: target) } ?? false
        if same && (connection.isWelcomed || (!force && connection.status != .offline)) { return }
        activeTarget = target
        connection.connect(to: target)
    }

    private func startDrive() async {
        alert = nil
        guard let saved = connections.selected else {
            alert = "Add a connection first: scan the QR code the bridge prints, or add one in Connections."
            return
        }
        guard selectedTarget() != nil else {
            alert = "\(saved.name) needs an address and a token. Edit it in Connections."
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            alert = "Microphone access is off. Turn it on in the Settings app under Earpiece."
            return
        }
        guard await Self.requestSpeechAuthorization() else {
            alert = "Speech recognition is off. Turn it on in the Settings app under Earpiece."
            return
        }

        // Siri may still hold the audio session right after "Start a drive in Earpiece": retry briefly.
        var lastError: Error?
        for attempt in 0..<8 {
            do {
                try audio.start()
                lastError = nil
                break
            } catch {
                lastError = error
                audio.stop()
                try? await Task.sleep(nanoseconds: UInt64(400_000_000 + attempt * 200_000_000))
            }
        }
        if let lastError {
            alert = "Audio could not start: \(lastError.localizedDescription)"
            return
        }

        applySettings()
        driveGeneration += 1
        isLive = true
        deskCard = nil
        cancelEndDriveWait()
        isPaused = false
        endingDrive = false
        endDriveRequestedAt = nil
        queue.removeAll()
        current = nil
        audioRoute = AudioEngine.routeDescription()
        listener.start()
        if !listener.usesOnDeviceRecognition {
            addLog("On-device speech recognition is not available; Apple's servers will transcribe.")
        }
        addLog("Drive started on \(saved.name).")
        authRejected = false
        connectIfPossible()
        if connection.isWelcomed {
            driveBecameReady(catchUp: true)
        }  // otherwise the welcome handler calls it (and the bridge replays any pending question)
    }

    /// Audio is on and the bridge has welcomed us: greet, catch up, send a chat picked on screen.
    /// `catchUp` only when the connection predates the drive, so state and last question are current.
    private func driveBecameReady(catchUp: Bool) {
        if let action = pendingChatAction {
            pendingChatAction = nil
            sendChatAction(action)  // the bridge speaks "Switching to ..." and the recap
            return
        }
        speakLocal("Earpiece ready.")
        // A question asked before the drive started was only shown, not spoken.
        if catchUp, bridgeState == .waitingForYou, let question = lastReplyOrQuestion, question.kind == .question {
            queue.enqueue(SpeechItem(text: question.text, kind: .question, seq: nil))
            pump()
        }
    }

    private func stopDrive(reason: String) {
        guard isLive else { return }
        isLive = false
        pendingChatAction = nil
        cancelEndDriveWait()
        listener.stop()
        speaker.stop()
        queue.removeAll()
        current = nil
        isPaused = false
        endingDrive = false
        endDriveRequestedAt = nil
        repeatSuppression = nil
        liveTranscript = ""
        resetTurnFlags()
        ttsEndedAt = nil
        audio.stop()
        addLog(reason)
        // The connection outlives the drive while the app is open, so chats can be listed.
        if appIsActive {
            connectIfPossible()
        } else {
            connection.disconnect()
        }
    }

    private func applySettings() {
        listener.silenceTimeout = max(0.4, settings.silenceTimeout)
        listener.contextualStrings = settings.contextualWords
        speaker.voiceIdentifier = settings.voiceIdentifier
        speaker.rate = settings.speechRate
    }

    private static func requestSpeechAuthorization() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .authorized { return true }
        if status != .notDetermined { return false }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }

    // MARK: - Connection events

    private func wireConnection() {
        connection.lastSeqProvider = { [weak self] in self?.lastSeq ?? 0 }
        connection.onStatus = { [weak self] status in self?.link = status }
        connection.onLog = { [weak self] text in self?.addLog(text) }
        connection.onMessage = { [weak self] message in self?.handle(message) }
        connection.onResolved = { [weak self] url, info in
            guard let self, let id = self.activeTarget?.connectionID else { return }
            self.connectionProblem = nil
            self.connections.setLastURL(url, for: id)
            self.activeTarget?.lastURL = url
            if let bridgeID = info.bridgeID { self.learnIdentity(bridgeID: bridgeID, name: info.name) }
        }
        connection.onUnreachable = { [weak self] message in
            self?.connectionProblem = message
        }
        connection.onPath = { [weak self] path in
            self?.linkPath = path
        }
        connection.onBridgeOffline = { [weak self] in
            guard let self else { return }
            let message = "Your computer is offline. I'll keep trying."
            self.connectionProblem = message
            self.addLog(message)
            // Spoken once per outage during a drive (SPEC 12.6).
            if self.isLive && !self.bridgeOfflineSpoken {
                self.bridgeOfflineSpoken = true
                self.speakLocal(message)
            }
        }
        connection.onPaired = { [weak self] name, _ in
            guard let self, let id = self.activeTarget?.connectionID else { return }
            if self.connections.pairSecret(for: id) != nil {
                self.connections.pairingCompleted(for: id)
                self.activeTarget?.relay?.pairSecret = nil
                self.addLog("Paired with \(name ?? "the computer").")
            }
        }
        connection.onNotPaired = { [weak self] _ in
            guard let self else { return }
            let name = self.activeTarget?.name ?? "this computer"
            let message = "This phone is no longer paired with \(name). Scan its QR code again."
            self.authRejected = true  // same as a rejected token: wait for a new pairing
            self.connectionProblem = message
            self.alert = message
            guard self.isLive else { return }
            self.speakLocal(message)
            self.endingDrive = true
            self.pump()
        }
        connection.onWelcomed = { [weak self] afterLoss in
            guard let self else { return }
            self.refreshChats()
            guard self.isLive else { return }
            // Spoken before any replayed lines, which follow the welcome.
            if afterLoss {
                self.speakLocal("Reconnected.")
                if let action = self.pendingChatAction {
                    self.pendingChatAction = nil
                    self.sendChatAction(action)
                }
            } else {
                self.driveBecameReady(catchUp: false)
            }
        }
        connection.onDropped = { [weak self] everConnected in
            guard let self else { return }
            self.isRefreshingChats = false
            guard self.isLive else { return }  // before a drive the screen shows the link state
            if self.endDriveIsPending || self.isEndingDrive {
                // The bridge closed the socket after end_drive: the drive is over.
                self.connection.disconnect()
                self.endingDrive = true
                self.pump()
                return
            }
            self.speakLocal(everConnected
                ? "Lost connection to the server. Retrying."
                : (self.connectionProblem ?? "Can't reach the server.") + " Retrying.")
        }
        connection.onAuthFailed = { [weak self] message in
            guard let self else { return }
            self.authRejected = true
            self.alert = "The server rejected the token. \(message)"
            guard self.isLive else { return }
            self.speakLocal("The server rejected the token. Check the token in settings.")
            self.endingDrive = true
            self.pump()
        }
    }

    private var endDriveIsPending: Bool {
        guard let at = endDriveRequestedAt else { return false }
        return Date().timeIntervalSince(at) < 30
    }

    private func handle(_ message: ServerMessage) {
        switch message {
        case .welcome(let welcome):
            if let previous = driveID, previous != welcome.driveID, !welcome.driveID.isEmpty {
                addLog("New drive \(welcome.driveID).")
            }
            connectionProblem = nil
            bridgeOfflineSpoken = false
            if let id = activeTarget?.connectionID, let path = linkPath {
                connections.setLastPath(path, for: id)
            }
            if let bridgeID = welcome.bridgeID, !bridgeID.isEmpty {
                learnIdentity(bridgeID: bridgeID, name: welcome.name)
            }
            if !welcome.driveID.isEmpty { driveID = welcome.driveID }
            // The bridge restarted (its seq is behind ours): follow its numbering from here.
            if welcome.seq < lastSeq { lastSeq = welcome.seq }
            bridgeState = welcome.state
            cwd = welcome.cwd
            apply(welcome.chat, refresh: false)  // onWelcomed already asked for the list
            addLog("Connected. \(welcome.state.label) in \(Self.basename(welcome.cwd)).")
        case .say(let say):
            receive(say)
        case .state(let change):
            bridgeState = change.state
            if let newCwd = change.cwd, !newCwd.isEmpty { cwd = newCwd }
            apply(change.chat, refresh: true)
        case .chats(let list):
            chats = list.items
            isRefreshingChats = false
        case .driveEnded(let ended):
            driveEnded(ended)
            refreshChats()
        case .error(let error) where error.code == "busy":
            // End drive while Claude works. The bridge also speaks a line.
            addLog("Bridge busy: \(error.message)")
            let askOnScreen = endDriveFromButton && isLive
            cancelEndDriveWait()
            if askOnScreen { showEndDriveBusy = true }
        case .error(let error):
            addLog("Server error \(error.code): \(error.message)")
        case .pong:
            break
        case .unknown(let type):
            addLog("Ignored unknown message type \(type).")
        }
    }

    /// Track the active chat; refresh the list whenever it changes (every switch, by voice or screen).
    private func apply(_ field: ChatField, refresh: Bool) {
        let newChat: ChatRef?
        switch field {
        case .absent: return
        case .none: newChat = nil
        case .chat(let ref): newChat = ref
        }
        let changed = newChat?.id != currentChat?.id
        currentChat = newChat
        if changed {
            if let newChat { addLog("Chat: \(newChat.title)") }
            if refresh { refreshChats() }
        }
    }

    /// SPEC 1 speaking rules for an incoming `say`.
    private func receive(_ say: Say) {
        lastSeq = max(lastSeq, say.seq)
        let item = SpeechItem(text: say.text, kind: say.kind, seq: say.seq)
        let isReplyOrQuestion = say.kind == .reply || say.kind == .question

        if isReplyOrQuestion, let suppression = repeatSuppression {
            repeatSuppression = nil
            if suppression.until > Date(), suppression.text == say.text {
                addLog("Claude (\(say.kind.wire), already repeated): \(say.text)")
                return
            }
        }
        if isReplyOrQuestion { lastReplyOrQuestion = item }

        if endDriveIsPending || isEndingDrive {
            if say.text.hasPrefix("Drive saved") {
                // Older bridges have no drive_ended: finish after this line.
                endingDrive = true
                endDriveRequestedAt = nil
            } else if say.text.hasPrefix("Claude is still working") {
                // Same as the busy error, for bridges that only speak it.
                let askOnScreen = endDriveFromButton && isLive
                cancelEndDriveWait()
                if askOnScreen { showEndDriveBusy = true }
            }
        }

        addLog("Claude (\(say.kind.wire)): \(say.text)")
        guard isLive else { return }  // before a drive, lines are only logged
        if isPaused && say.kind == .progress { return }  // muted while paused
        queue.enqueue(item)
        pump()
    }

    /// A line the phone says on its own (connection notices). Not part of the bridge's seq.
    private func speakLocal(_ text: String) {
        addLog("Earpiece: \(text)")
        queue.enqueue(SpeechItem(text: text, kind: .notice, seq: nil))
        pump()
    }

    // MARK: - Speaking

    /// Start the next queued line when nothing is playing, the driver is not talking and we are not paused.
    private func pump() {
        guard isLive else { return }
        if endingDrive && (!audio.isRunning || (queue.isEmpty && current == nil && !speaker.isSpeaking)) {
            stopDrive(reason: "Drive ended.")
            return
        }
        guard current == nil, !speaker.isSpeaking, !isPaused, !listener.hasSpeech, audio.isRunning else { return }
        guard let item = queue.next() else { return }
        current = item
        lastSpoken = item.text
        ttsText = item.text
        let started = speaker.speak(item.text) { [weak self] completed in
            guard let self else { return }
            self.current = nil
            self.ttsEndedAt = Date()
            if let retry = SpeechQueue.retry(item, completed: completed) {
                self.addLog("Line was cut off; it will be spoken again.")
                self.queue.pushFront(retry)
            }
            self.pump()
        }
        if !started {
            current = nil
            queue.pushFront(item)
        }
    }

    /// Stop the current line. Lines other than progress are put back at the head of the queue
    /// when `requeue` is set (pause and interruptions, not barge-in).
    private func cutSpeech(requeue: Bool) {
        let cut = current
        if speaker.isSpeaking {
            speaker.stop()
            ttsEndedAt = Date()
        }
        current = nil
        if requeue, let cut, cut.kind != .progress {
            queue.pushFront(cut)
        }
    }

    // MARK: - Listening

    private func wireListener() {
        listener.onLog = { [weak self] text in self?.addLog(text) }
        listener.onPartial = { [weak self] text in self?.heardPartial(text) }
        listener.onUtterance = { [weak self] text in self?.heardUtterance(text) }
        listener.onTurnAbandoned = { [weak self] in
            self?.liveTranscript = ""
            self?.resetTurnFlags()
            self?.pump()
        }
    }

    /// SPEC 8 barge-in: 2 or more words while TTS plays stops speech and drops queued progress lines.
    /// Not when the words are mostly the line being spoken (echo) or another app is playing audio.
    private func heardPartial(_ text: String) {
        liveTranscript = text
        if !turnInProgress {
            turnInProgress = true
            turnTiming = EchoFilter.timing(now: Date(), ttsPlaying: speaker.isSpeaking, ttsEndedAt: ttsEndedAt)
        }
        if AVAudioSession.sharedInstance().isOtherAudioPlaying { turnHeardOtherAudio = true }
        guard !isPaused, speaker.isSpeaking, !turnHeardOtherAudio,
              CommandMatcher.wordCount(text) >= 2,
              !EchoFilter.isLikelyEcho(heard: text, spoken: ttsText) else { return }
        if let current { addLog("Barge-in: stopped \"\(current.text.prefix(50))\"") }
        cutSpeech(requeue: false)
        queue.dropProgress()
    }

    private func resetTurnFlags() {
        turnInProgress = false
        turnTiming = .notNear
        turnHeardOtherAudio = false
    }

    private func heardUtterance(_ text: String) {
        liveTranscript = ""
        defer { pump() }
        let timing = turnTiming
        let otherAudio = turnHeardOtherAudio
        resetTurnFlags()
        if otherAudio {
            addLog("Ignored (another app was playing audio): \(text)")
            return
        }
        if EchoFilter.isLikelyEcho(heard: text, spoken: ttsText, timing: timing) {
            addLog("Ignored as echo of the spoken line: \(text)")
            return
        }
        let match = CommandMatcher.match(text, state: bridgeState)

        if isPaused {
            // While paused only the resume words are acted on.
            if case .command(.resume) = match {
                audio.playEarcon()
                addLog("You (command): \(text)")
                perform(.resume)
            } else if match != .ignore {
                addLog("Paused, ignored: \(text)")
            }
            return
        }

        switch match {
        case .ignore:
            return
        case .command(let command):
            audio.playEarcon()
            addLog("You (command): \(text)")
            perform(command)
        case .utterance(let utterance):
            if connection.send(.utterance(text: utterance)) {
                audio.playEarcon()
                addLog("You: \(utterance)")
            } else {
                addLog("Not sent (offline): \(utterance)")
                speakLocal("Not connected. Say that again after I reconnect.")
            }
        }
    }

    private func perform(_ command: VoiceCommand) {
        switch command {
        case .pause:
            isPaused = true
            cutSpeech(requeue: true)
            queue.dropProgress()
            sendControl(.pause, localOnlyOK: true)
        case .resume:
            isPaused = false
            sendControl(.resume, localOnlyOK: true)
        case .repeatLast:
            if let last = lastReplyOrQuestion {
                queue.dropProgress()
                queue.pushFront(SpeechItem(text: last.text, kind: last.kind, seq: nil))
                repeatSuppression = (last.text, Date().addingTimeInterval(10))
            }
            sendControl(.repeat, localOnlyOK: lastReplyOrQuestion != nil)
        case .status:
            sendControl(.status, localOnlyOK: false)
        case .stop:
            cutSpeech(requeue: false)
            queue.dropForStop()
            sendControl(.stop, localOnlyOK: false)
        case .cancel:
            sendControl(.cancel, localOnlyOK: false)
        case .endDrive:
            endDriveFromButton = false
            requestEndDrive(force: false, fromButton: false)
        case .switchChat, .newChat, .whichChat:
            // The bridge answers by voice (SPEC 10.5); the list refreshes when the chat changes.
            sendControl(command.control, localOnlyOK: false)
        }
    }

    private func sendControl(_ action: ControlAction, localOnlyOK: Bool) {
        if connection.send(.control(action: action)) { return }
        if !localOnlyOK {
            if action == .endDrive {
                endDriveRequestedAt = nil
            }
            speakLocal("Not connected. Say that again after I reconnect.")
        }
    }

    // MARK: - Audio events

    private func wireAudio() {
        audio.onInterruptionBegan = { [weak self] in
            guard let self else { return }
            self.addLog("Audio interrupted (call, Siri or navigation). Waiting.")
            self.audioRoute = "Interrupted"
            self.listener.stop()
            self.cutSpeech(requeue: true)
        }
        audio.onResumed = { [weak self] reason in
            guard let self, self.isLive else { return }
            self.addLog("\(reason). Audio running on \(AudioEngine.routeDescription()).")
            self.audioRoute = AudioEngine.routeDescription()
            // The input format may have changed: start a fresh recognition request.
            self.cutSpeech(requeue: true)
            if self.listener.isRunning {
                self.listener.restartTurn()
            } else {
                self.listener.start()
            }
            self.pump()
        }
        audio.onWillReset = { [weak self] in
            guard let self else { return }
            self.addLog("Audio services were reset. Rebuilding audio.")
            self.cutSpeech(requeue: true)
            self.listener.stop()
            self.speaker = Speaker(audio: self.audio)
            self.listener = Listener(audio: self.audio)
            self.wireListener()
            self.applySettings()
            // onResumed starts the new listener once the engine is back.
        }
        audio.onRouteChange = { [weak self] route in
            guard let self else { return }
            if route != self.audioRoute { self.addLog("Audio route: \(route)") }
            self.audioRoute = route
        }
        audio.onFailure = { [weak self] message in
            self?.addLog(message)
        }
    }

    // MARK: - Log

    private func addLog(_ text: String) {
        log.append(LogLine(time: Date(), text: text))
        if log.count > 120 { log.removeFirst(log.count - 120) }
    }

    static func basename(_ path: String) -> String {
        guard !path.isEmpty else { return "?" }
        return (path as NSString).lastPathComponent
    }
}
