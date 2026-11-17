import AVFoundation
import Speech

/// Holds the current recognition request for the audio thread. The engine's input tap appends
/// every mic buffer here; the main thread swaps the request at each turn.
final class RecognitionSink: AudioInputSink, @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let current = request
        lock.unlock()
        current?.append(buffer)
    }
}

/// SPEC 8 speech-to-text: SFSpeechRecognizer fed from the shared engine's input tap.
/// One fresh request per turn. A turn ends after `silenceTimeout` seconds with no new partial result.
@MainActor
final class Listener {
    /// Live transcript of the current turn (used for barge-in).
    var onPartial: ((String) -> Void)?
    /// A finished turn. Filtering (under 2 characters, commands) happens in the controller.
    var onUtterance: ((String) -> Void)?
    /// A turn that had partial text ended without producing an utterance.
    var onTurnAbandoned: (() -> Void)?
    var onLog: ((String) -> Void)?

    var silenceTimeout: TimeInterval = 1.2
    var contextualStrings: [String] = []

    /// Text heard so far in the current turn.
    private(set) var currentText = ""
    var hasSpeech: Bool { !currentText.isEmpty }
    private(set) var isRunning = false

    private let audio: AudioEngine
    private let sink = RecognitionSink()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    /// When the current recognition request started.
    private var turnStartedAt = Date()
    private var silenceTimer: Timer?
    private var recycleTimer: Timer?
    private var restartWork: DispatchWorkItem?
    private var consecutiveErrors = 0
    private var loggedUnavailable = false

    /// Recycle a request that has heard nothing for this long.
    private let idleRecycleInterval: TimeInterval = 20
    /// Hard cap on one request's life: Apple's server recognizer stops at about a minute, and noise
    /// could otherwise keep a turn open forever.
    private let maxRequestAge: TimeInterval = 55
    /// A task that ends sooner than this goes through the error backoff, even with a "benign" code,
    /// so a recognizer that ends every task at once cannot spin.
    private let minHealthyTaskLife: TimeInterval = 1

    private var requestAge: TimeInterval { Date().timeIntervalSince(turnStartedAt) }

    init(audio: AudioEngine) {
        self.audio = audio
    }

    var usesOnDeviceRecognition: Bool { recognizer?.supportsOnDeviceRecognition ?? false }

    func start() {
        guard !isRunning else { return }
        if recognizer == nil { recognizer = Self.makeRecognizer() }
        guard recognizer != nil else {
            onLog?("Speech recognition is not available for English on this phone.")
            return
        }
        isRunning = true
        consecutiveErrors = 0
        audio.sink = sink
        beginTurn()
    }

    func stop() {
        isRunning = false
        restartWork?.cancel()
        restartWork = nil
        let hadSpeech = hasSpeech
        endTask()
        currentText = ""
        audio.sink = nil
        if hadSpeech { onTurnAbandoned?() }
    }

    /// Throw away the current turn and start a new request (after an audio route/format change).
    func restartTurn() {
        guard isRunning else { return }
        let hadSpeech = hasSpeech
        endTask()
        currentText = ""
        if hadSpeech { onTurnAbandoned?() }
        audio.sink = sink
        beginTurn()
    }

    // MARK: Turns

    private func beginTurn() {
        guard isRunning else { return }
        restartWork?.cancel()
        restartWork = nil
        guard let recognizer, recognizer.isAvailable else {
            if !loggedUnavailable {
                loggedUnavailable = true
                onLog?("Speech recognizer unavailable. Retrying.")
            }
            scheduleBeginTurn(after: 2)
            return
        }
        loggedUnavailable = false

        generation += 1
        let gen = generation
        currentText = ""
        turnStartedAt = Date()

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        req.contextualStrings = Array(contextualStrings.prefix(100))
        req.taskHint = .dictation
        req.addsPunctuation = true
        request = req
        sink.set(req)

        task = Self.startTask(recognizer: recognizer, request: req) { [weak self] text, isFinal, failure in
            self?.handle(text: text, isFinal: isFinal, failure: failure, generation: gen)
        }
        armRecycleTimer()
    }

    /// Built outside the main actor so the recognizer's callback closure is not actor-isolated.
    /// Results are delivered on the recognizer's queue (main by default) and hopped to the main actor.
    private nonisolated static func startTask(
        recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest,
        handler: @escaping @MainActor (String?, Bool, RecognitionFailure?) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failure = error.map { RecognitionFailure($0 as NSError) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { handler(text, isFinal, failure) }
            }
        }
    }

    private func handle(text: String?, isFinal: Bool, failure: RecognitionFailure?, generation gen: Int) {
        guard gen == generation, isRunning else { return }

        if let text, !text.isEmpty, text != currentText {
            consecutiveErrors = 0
            currentText = text
            onPartial?(text)
            armSilenceTimer()
            if requestAge > maxRequestAge {
                finishTurn(restartDelay: 0)
                return
            }
        }

        let shortLived = requestAge < minHealthyTaskLife
        if isFinal {
            if shortLived && currentText.isEmpty {
                finishAfterError("Recognition ended immediately")
            } else {
                finishTurn(restartDelay: 0)
            }
        } else if let failure {
            // The task ended on its own (silence limit, recognizer hiccup, ...).
            if failure.isBenign && !shortLived {
                finishTurn(restartDelay: 0.1)
            } else {
                finishAfterError("Speech recognition error \(failure.code): \(failure.message)")
            }
        }
    }

    /// Exponential backoff (0.25 s doubling to 5 s) before the next request.
    private func finishAfterError(_ message: String) {
        consecutiveErrors += 1
        let delay = min(5.0, 0.25 * pow(2.0, Double(consecutiveErrors - 1)))
        if consecutiveErrors == 1 || consecutiveErrors % 5 == 0 {
            onLog?("\(message). Restarting.")
        }
        finishTurn(restartDelay: delay)
    }

    private func armSilenceTimer() {
        silenceTimer?.invalidate()
        let timer = Timer(timeInterval: silenceTimeout, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finishTurn(restartDelay: 0) }
        }
        RunLoop.main.add(timer, forMode: .common)
        silenceTimer = timer
    }

    private func armRecycleTimer() {
        recycleTimer?.invalidate()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isRunning else { return }
                if !self.hasSpeech, self.requestAge >= self.idleRecycleInterval {
                    self.endTask()
                    self.beginTurn()
                } else if self.hasSpeech, self.requestAge > self.maxRequestAge {
                    self.finishTurn(restartDelay: 0)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        recycleTimer = timer
    }

    /// End the current turn: emit what was heard, then start a fresh request.
    private func finishTurn(restartDelay: TimeInterval) {
        let text = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        endTask()
        currentText = ""
        if !text.isEmpty {
            onUtterance?(text)
        }
        guard isRunning else { return }
        if restartDelay <= 0 {
            beginTurn()
        } else {
            scheduleBeginTurn(after: restartDelay)
        }
    }

    private func scheduleBeginTurn(after delay: TimeInterval) {
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.beginTurn() }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func endTask() {
        generation += 1  // ignore late callbacks from the old task
        silenceTimer?.invalidate()
        silenceTimer = nil
        recycleTimer?.invalidate()
        recycleTimer = nil
        sink.set(nil)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    // MARK: Recognizer choice

    /// Prefer the phone's own English locale; fall back to en-US. Prefer a locale with on-device support.
    private static func makeRecognizer() -> SFSpeechRecognizer? {
        var candidates: [Locale] = []
        if Locale.current.language.languageCode?.identifier == "en" {
            candidates.append(Locale.current)
        }
        candidates.append(Locale(identifier: "en-US"))
        let recognizers = candidates.compactMap { SFSpeechRecognizer(locale: $0) }
        let recognizer = recognizers.first(where: { $0.supportsOnDeviceRecognition }) ?? recognizers.first
        recognizer?.defaultTaskHint = .dictation
        return recognizer
    }
}

/// Sendable summary of a recognizer error.
struct RecognitionFailure: Sendable {
    let domain: String
    let code: Int
    let message: String

    init(_ error: NSError) {
        domain = error.domain
        code = error.code
        message = error.localizedDescription
    }

    /// "No speech detected" (1110) and cancellations (216, 301) are routine. The same codes appear
    /// under kAFAssistantErrorDomain (server) and kLSRErrorDomain (on-device).
    var isBenign: Bool {
        [1110, 216, 301].contains(code)
    }
}
