import AVFoundation

/// SPEC 8 text-to-speech: AVSpeechSynthesizer.write(_:toBufferCallback:) renders PCM, which is
/// converted to the player node's format and scheduled on the shared engine (so voice processing
/// can cancel it from the mic). One utterance at a time; the controller owns the queue.
@MainActor
final class Speaker {
    nonisolated static let defaultRate: Float = 0.53  // slightly above AVSpeechUtteranceDefaultSpeechRate (0.5)

    var voiceIdentifier: String = "" {
        didSet { if voiceIdentifier != oldValue { cachedVoice = nil } }
    }
    var rate: Float = Speaker.defaultRate

    private(set) var isSpeaking = false

    private let audio: AudioEngine
    private let synthesizer = AVSpeechSynthesizer()
    private let synthDelegate = SynthDelegate()
    private var stream: TTSStream?
    private var completion: ((Bool) -> Void)?
    private var generation = 0
    private var watchdog: Timer?
    private var cachedVoice: AVSpeechSynthesisVoice?
    private var currentUtteranceID: ObjectIdentifier?

    init(audio: AudioEngine) {
        self.audio = audio
        synthesizer.usesApplicationAudioSession = true
        synthesizer.delegate = synthDelegate
        synthDelegate.onFinish = { [weak self] finishedID in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    // Ignore a late didFinish from an utterance that was already stopped.
                    guard let self, finishedID == self.currentUtteranceID else { return }
                    self.stream?.markInputDone()
                }
            }
        }
    }

    /// Speak one line. `completion(true)` when it finished playing, `(false)` if it failed.
    /// Not called after `stop()`. Returns false (and does nothing) when audio is not running.
    @discardableResult
    func speak(_ text: String, completion: @escaping (Bool) -> Void) -> Bool {
        guard audio.prepareTTSPlayer() else { return false }
        if isSpeaking { stop() }

        generation += 1
        let gen = generation
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = resolvedVoice()
        utterance.rate = rate
        utterance.prefersAssistiveTechnologySettings = false

        let stream = TTSStream(player: audio.ttsPlayer, format: audio.playerFormat) { [weak self] completed in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.streamFinished(generation: gen, completed: completed) }
            }
        }
        self.stream = stream
        self.completion = completion
        currentUtteranceID = ObjectIdentifier(utterance)
        isSpeaking = true
        Self.write(utterance, synthesizer: synthesizer, into: stream)
        startWatchdog(generation: gen)
        return true
    }

    /// Stop immediately (barge-in, pause, interruption). The pending completion is dropped.
    func stop() {
        generation += 1
        watchdog?.invalidate()
        watchdog = nil
        stream?.cancel()
        stream = nil
        completion = nil
        currentUtteranceID = nil
        synthesizer.stopSpeaking(at: .immediate)
        audio.stopTTSPlayer()
        isSpeaking = false
    }

    /// Created outside the main actor so the buffer callback is not actor-isolated (it runs on
    /// the synthesizer's own thread).
    private nonisolated static func write(_ utterance: AVSpeechUtterance, synthesizer: AVSpeechSynthesizer, into stream: TTSStream) {
        synthesizer.write(utterance) { buffer in
            stream.consume(buffer)
        }
    }

    private func streamFinished(generation gen: Int, completed: Bool) {
        guard gen == generation, isSpeaking else { return }
        watchdog?.invalidate()
        watchdog = nil
        isSpeaking = false
        stream = nil
        let done = completion
        completion = nil
        // Stopping the player (engine teardown) also fires buffer completions; a line whose engine
        // is down did not really finish.
        done?(completed && audio.isRunning)
    }

    /// If the synthesizer goes quiet (no buffers rendered or played for 6 s), give up on the line
    /// so the queue cannot stall.
    private func startWatchdog(generation gen: Int) {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, gen == self.generation, let stream = self.stream else { return }
                if stream.secondsIdle > 6 {
                    self.audio.stopTTSPlayer()
                    stream.cancel()
                    self.streamFinished(generation: gen, completed: false)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    private func resolvedVoice() -> AVSpeechSynthesisVoice? {
        if let cachedVoice { return cachedVoice }
        let voice = Self.voice(for: voiceIdentifier)
        cachedVoice = voice
        return voice
    }

    // MARK: Voice selection

    nonisolated static func voice(for identifier: String) -> AVSpeechSynthesisVoice? {
        if !identifier.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: identifier) {
            return voice
        }
        return bestVoice()
    }

    /// Installed English voices, best first: premium > enhanced > default, then the phone's own
    /// English region, then en-US.
    nonisolated static func englishVoices() -> [AVSpeechSynthesisVoice] {
        let preferred = preferredLanguageTag()
        return AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .filter { !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice) }
            .sorted { a, b in
                let qa = qualityRank(a.quality), qb = qualityRank(b.quality)
                if qa != qb { return qa > qb }
                let la = languageRank(a.language, preferred: preferred), lb = languageRank(b.language, preferred: preferred)
                if la != lb { return la > lb }
                return a.name < b.name
            }
    }

    nonisolated static func bestVoice() -> AVSpeechSynthesisVoice? {
        englishVoices().first ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    nonisolated static func qualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Default"
        }
    }

    private nonisolated static func qualityRank(_ quality: AVSpeechSynthesisVoiceQuality) -> Int {
        switch quality {
        case .premium: return 3
        case .enhanced: return 2
        default: return 1
        }
    }

    private nonisolated static func languageRank(_ language: String, preferred: String) -> Int {
        if language == preferred { return 2 }
        if language == "en-US" { return 1 }
        return 0
    }

    private nonisolated static func preferredLanguageTag() -> String {
        let locale = Locale.current
        guard locale.language.languageCode?.identifier == "en",
              let region = locale.region?.identifier else { return "en-US" }
        return "en-\(region)"
    }
}

/// Forwards synthesizer delegate callbacks without making the @MainActor Speaker conform to an
/// Objective-C delegate protocol.
private final class SynthDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    var onFinish: ((ObjectIdentifier) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish?(ObjectIdentifier(utterance))
    }
}

/// One utterance's audio on its way to the player node. Runs on the synthesizer's thread
/// (consume) and the audio thread (playback completions); all state is lock-protected.
final class TTSStream: @unchecked Sendable {
    private let lock = NSLock()
    private let convertLock = NSLock()
    private let player: AVAudioPlayerNode
    private let format: AVAudioFormat
    private let onFinished: (Bool) -> Void

    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    private var scheduled = 0
    private var played = 0
    private var inputDone = false
    private var finished = false
    private var cancelled = false
    private var lastActivity = Date()
    /// Estimated time the audio scheduled so far finishes playing.
    private var playbackEnds = Date.distantPast

    init(player: AVAudioPlayerNode, format: AVAudioFormat, onFinished: @escaping (Bool) -> Void) {
        self.player = player
        self.format = format
        self.onFinished = onFinished
    }

    /// Seconds since the last rendered or played buffer, not counting audio still scheduled to play.
    var secondsIdle: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        if playbackEnds > now { return 0 }
        return now.timeIntervalSince(max(lastActivity, playbackEnds))
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    /// Synthesizer buffer callback. A zero-length buffer marks the end of the utterance.
    func consume(_ buffer: AVAudioBuffer) {
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        guard isLive(touch: true) else { return }
        if pcm.frameLength == 0 {
            // End-of-utterance marker. Ignore an empty buffer before any audio; the delegate's
            // didFinish (or the watchdog) covers an utterance that renders nothing.
            if hasScheduledAudio { markInputDone() }
            return
        }
        convertLock.lock()
        let out = convert(pcm)
        convertLock.unlock()
        if let out { schedule(out) }
    }

    /// End of input (zero-length buffer or the delegate's didFinish, whichever comes first).
    func markInputDone() {
        lock.lock()
        if inputDone || cancelled || finished { lock.unlock(); return }
        inputDone = true
        lock.unlock()

        convertLock.lock()
        let tail = flush()
        convertLock.unlock()
        if let tail { schedule(tail) }
        checkFinished()
    }

    private var hasScheduledAudio: Bool {
        lock.lock(); defer { lock.unlock() }
        return scheduled > 0
    }

    private func isLive(touch: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if touch { lastActivity = Date() }
        return !cancelled && !finished
    }

    private func schedule(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        if cancelled || finished { lock.unlock(); return }
        scheduled += 1
        let duration = Double(buffer.frameLength) / buffer.format.sampleRate
        playbackEnds = max(playbackEnds, Date()).addingTimeInterval(duration)
        lock.unlock()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.didPlay()
        }
    }

    private func didPlay() {
        lock.lock()
        played += 1
        lastActivity = Date()
        lock.unlock()
        checkFinished()
    }

    private func checkFinished() {
        lock.lock()
        let done = inputDone && played >= scheduled && !finished && !cancelled
        if done { finished = true }
        lock.unlock()
        if done { onFinished(true) }
    }

    // MARK: Conversion (synth format, often 22.05 kHz Int16 -> player format 48 kHz Float32 mono)

    private func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if input.format == format { return input }
        if converter == nil || converterInput != input.format {
            converter = AVAudioConverter(from: input.format, to: format)
            converterInput = input.format
        }
        guard let converter else { return nil }
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        let feed = InputFeed(input)
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if let buffer = feed.take() {
                outStatus.pointee = .haveData
                return buffer
            }
            outStatus.pointee = .noDataNow
            return nil
        }
        if status == .error || out.frameLength == 0 { return nil }
        return out
    }

    private func flush() -> AVAudioPCMBuffer? {
        guard let converter, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else { return nil }
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            outStatus.pointee = .endOfStream
            return nil
        }
        if status == .error || out.frameLength == 0 { return nil }
        return out
    }
}

/// Hands one buffer to AVAudioConverter's (Sendable) input block exactly once.
private final class InputFeed: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func take() -> AVAudioPCMBuffer? {
        defer { buffer = nil }
        return buffer
    }
}
