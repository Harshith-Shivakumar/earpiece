import AVFoundation

/// Receives microphone buffers on the audio thread.
protocol AudioInputSink: AnyObject {
    func append(_ buffer: AVAudioPCMBuffer)
}

enum AudioEngineError: LocalizedError {
    case noInput

    var errorDescription: String? {
        switch self {
        case .noInput: return "No microphone input is available."
        }
    }
}

/// One AVAudioEngine for both directions (SPEC 8 "Echo"): the input node has voice processing
/// (echo cancellation) enabled, and TTS plus earcons play through player nodes on the same engine,
/// so Claude's voice is cancelled from the mic signal.
///
/// Control methods are called on the main thread. The input tap runs on the audio thread and only
/// touches `sink` (lock-protected). Events are delivered on the main thread.
final class AudioEngine: @unchecked Sendable {
    /// Fixed format for the player nodes. The main mixer converts it to whatever the current route
    /// needs (48 kHz speaker, 16 kHz HFP, ...), so TTS buffers never need to change format mid-drive.
    let playerFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!

    private(set) var engine = AVAudioEngine()
    private(set) var ttsPlayer = AVAudioPlayerNode()
    private(set) var earconPlayer = AVAudioPlayerNode()

    // Events (main thread).
    var onInterruptionBegan: (() -> Void)?
    /// The engine is running again after an interruption, a configuration change or a reset.
    var onResumed: ((String) -> Void)?
    var onRouteChange: ((String) -> Void)?
    var onFailure: ((String) -> Void)?
    /// Media services were reset: every audio object is about to be replaced. Stop using them now.
    var onWillReset: (() -> Void)?

    private let lock = NSLock()
    private weak var _sink: AudioInputSink?
    var sink: AudioInputSink? {
        get { lock.lock(); defer { lock.unlock() }; return _sink }
        set { lock.lock(); _sink = newValue; lock.unlock() }
    }

    private var wantsRunning = false
    private(set) var isInterrupted = false
    private var observers: [NSObjectProtocol] = []
    private var resumeAttempts = 0
    private var resumeWork: DispatchWorkItem?
    private var restartWork: DispatchWorkItem?
    private var watchdog: Timer?
    private var tapFormat: AVAudioFormat?
    private lazy var tickBuffer: AVAudioPCMBuffer? = makeTick()

    var isRunning: Bool { engine.isRunning }

    // MARK: Start / stop

    func start() throws {
        wantsRunning = true
        isInterrupted = false
        observeNotifications()  // before starting, so a change during HFP bring-up is not missed
        try configureSession()
        try buildGraphAndStart()
        startWatchdog()
    }

    func stop() {
        wantsRunning = false
        resumeWork?.cancel()
        resumeWork = nil
        restartWork?.cancel()
        restartWork = nil
        watchdog?.invalidate()
        watchdog = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        teardownEngine()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
    }

    private func buildGraphAndStart() throws {
        let input = engine.inputNode
        if !input.isVoiceProcessingEnabled {
            try input.setVoiceProcessingEnabled(true)
        }
        // Keep other apps' audio (navigation prompts) as loud as possible while we hold the mic.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: true, duckingLevel: .min)

        if ttsPlayer.engine == nil { engine.attach(ttsPlayer) }
        if earconPlayer.engine == nil { engine.attach(earconPlayer) }
        engine.connect(ttsPlayer, to: engine.mainMixerNode, format: playerFormat)
        engine.connect(earconPlayer, to: engine.mainMixerNode, format: playerFormat)

        try installTap()
        engine.prepare()
        try engine.start()
    }

    private func installTap() throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        // installTap raises an uncatchable exception when the tap rate differs from the hardware
        // rate (seen briefly while switching to Bluetooth HFP). Throw instead so the retry runs.
        let hardware = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              hardware.sampleRate == format.sampleRate else { throw AudioEngineError.noInput }
        tapFormat = format
        let downmixer = MonoDownmixer(from: format)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let sink = self?.sink else { return }
            if let downmixer {
                if let mono = downmixer.convert(buffer) { sink.append(mono) }
            } else {
                sink.append(buffer)
            }
        }
    }

    private func teardownEngine() {
        ttsPlayer.stop()
        earconPlayer.stop()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    // MARK: Playback

    /// Make sure the TTS player is playing (it is stopped by barge-in). Returns false when the engine is down.
    @discardableResult
    func prepareTTSPlayer() -> Bool {
        guard engine.isRunning else { return false }
        if !ttsPlayer.isPlaying { ttsPlayer.play() }
        return true
    }

    func stopTTSPlayer() {
        ttsPlayer.stop()
    }

    /// A short soft tick: "your turn was captured and sent".
    func playEarcon() {
        guard engine.isRunning, let tick = tickBuffer else { return }
        earconPlayer.scheduleBuffer(tick, at: nil, options: .interrupts, completionHandler: nil)
        if !earconPlayer.isPlaying { earconPlayer.play() }
    }

    private func makeTick() -> AVAudioPCMBuffer? {
        let rate = playerFormat.sampleRate
        let frames = AVAudioFrameCount(rate * 0.05)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: frames),
              let data = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = frames
        for i in 0..<Int(frames) {
            let t = Double(i) / rate
            let attack = min(1.0, t / 0.002)
            let envelope = attack * exp(-t * 80)
            let tone = 0.7 * sin(2 * .pi * 1500 * t) + 0.3 * sin(2 * .pi * 3000 * t)
            data[i] = Float(0.2 * envelope * tone)
        }
        return buffer
    }

    // MARK: Interruptions, route changes, resets

    private func observeNotifications() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
            self?.handleRouteChange(note)
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            self?.handleMediaServicesReset()
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            guard let self, (note.object as? AVAudioEngine) === self.engine else { return }
            self.scheduleRestart(reason: "Audio configuration changed")
        })
    }

    private func handleInterruption(_ note: Notification) {
        guard wantsRunning,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            isInterrupted = true
            resumeWork?.cancel()
            teardownEngine()
            onInterruptionBegan?()
        case .ended:
            // Resume even without .shouldResume: this is a drive session, and navigation prompts
            // and Siri often end without that flag.
            resumeAttempts = 0
            attemptResume(reason: "Interruption ended")
        @unknown default:
            break
        }
    }

    /// Also called when the app becomes active, in case an "ended" notification never came.
    func recoverIfNeeded() {
        guard wantsRunning, !engine.isRunning else { return }
        resumeAttempts = 0
        attemptResume(reason: "Recovering audio")
    }

    private func attemptResume(reason: String) {
        guard wantsRunning else { return }
        resumeWork?.cancel()
        resumeWork = nil
        do {
            try configureSession()
            teardownEngine()
            try buildGraphAndStart()
            isInterrupted = false
            resumeAttempts = 0
            onResumed?(reason)
        } catch {
            resumeAttempts += 1
            if resumeAttempts == 1 || resumeAttempts % 10 == 0 {
                onFailure?("Audio could not resume (\(error.localizedDescription)). Retrying.")
            }
            let work = DispatchWorkItem { [weak self] in self?.attemptResume(reason: reason) }
            resumeWork = work
            let delay = min(2.0, 0.5 * Double(resumeAttempts))
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard wantsRunning else { return }
        onRouteChange?(Self.routeDescription())
        // A route change usually also posts AVAudioEngineConfigurationChange, which rebuilds the
        // graph. If the engine stopped without it, the watchdog restarts it.
    }

    private func handleMediaServicesReset() {
        guard wantsRunning else { return }
        // Everything is invalid: start over with new objects. The controller first stops and
        // recreates the speaker and listener so nothing keeps using the old nodes.
        onWillReset?()
        teardownEngine()
        engine = AVAudioEngine()
        ttsPlayer = AVAudioPlayerNode()
        earconPlayer = AVAudioPlayerNode()
        resumeAttempts = 0
        attemptResume(reason: "Audio services were reset")
    }

    private func scheduleRestart(reason: String) {
        guard wantsRunning, !isInterrupted else { return }
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.wantsRunning, !self.isInterrupted else { return }
            // Only rebuild when it is actually needed, so our own session calls cannot loop.
            let currentInput = self.engine.inputNode.outputFormat(forBus: 0)
            guard !self.engine.isRunning || currentInput != self.tapFormat else { return }
            self.resumeAttempts = 0
            self.attemptResume(reason: reason)
        }
        restartWork = work
        // Debounce: a route switch often posts several changes in a row.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private func startWatchdog() {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.wantsRunning, !self.isInterrupted, !self.engine.isRunning else { return }
            if self.resumeWork == nil {
                self.scheduleRestart(reason: "Audio engine stopped")
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    static func routeDescription() -> String {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        guard let first = outputs.first else { return "No audio output" }
        switch first.portType {
        case .builtInSpeaker: return "Speaker"
        case .builtInReceiver: return "Receiver"
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "Bluetooth: \(first.portName)"
        case .carAudio: return "CarPlay: \(first.portName)"
        case .headphones, .headsetMic: return "Headphones"
        default: return first.portName
        }
    }
}

/// Some voice-processing inputs report more than one channel; the recognizer wants mono.
private final class MonoDownmixer {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat

    init?(from format: AVAudioFormat) {
        guard format.channelCount > 1,
              let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: out) else { return nil }
        converter.downmix = true
        self.converter = converter
        self.outFormat = out
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: buffer.frameLength) else { return nil }
        do {
            try converter.convert(to: out, from: buffer)
            return out
        } catch {
            return nil
        }
    }
}
