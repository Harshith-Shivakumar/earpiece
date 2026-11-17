import Foundation

/// One line waiting to be spoken. `seq` is nil for lines the phone makes up itself
/// (connection notices, local repeats).
struct SpeechItem: Equatable, Identifiable {
    let id = UUID()
    let text: String
    let kind: SayKind
    let seq: Int?
    /// How many times this line has been put back after failing to play to the end.
    var attempts = 0

    static func == (a: SpeechItem, b: SpeechItem) -> Bool {
        a.text == b.text && a.kind == b.kind && a.seq == b.seq
    }
}

/// SPEC 1 speaking rules, as a pure value type so they are unit-testable.
/// - Lines are spoken in arrival order (the bridge sends them in seq order), one at a time.
/// - A queued `progress` line is dropped when any newer line arrives before it starts.
/// - Barge-in drops queued `progress` lines and keeps everything else.
struct SpeechQueue {
    private(set) var items: [SpeechItem] = []

    var isEmpty: Bool { items.isEmpty }
    var count: Int { items.count }

    mutating func enqueue(_ item: SpeechItem) {
        items.removeAll { $0.kind == .progress }
        items.append(item)
    }

    /// Put a line at the head (a local repeat, or a line that was cut off by an interruption).
    mutating func pushFront(_ item: SpeechItem) {
        items.insert(item, at: 0)
    }

    mutating func next() -> SpeechItem? {
        items.isEmpty ? nil : items.removeFirst()
    }

    /// Barge-in and pause: drop queued progress lines.
    mutating func dropProgress() {
        items.removeAll { $0.kind == .progress }
    }

    /// "stop": the bridge clears its pending question, so a queued question is stale too.
    mutating func dropForStop() {
        items.removeAll { $0.kind == .progress || $0.kind == .question }
    }

    mutating func removeAll() {
        items.removeAll()
    }

    /// A line did not play to the end (engine torn down, synthesizer stalled). Returns the copy to put
    /// back at the head of the queue, or nil. Progress lines are never retried; others at most
    /// `maxRetries` times, so a line that can never play cannot loop.
    static func retry(_ item: SpeechItem, completed: Bool, maxRetries: Int = 2) -> SpeechItem? {
        guard !completed, item.kind != .progress, item.attempts < maxRetries else { return nil }
        var copy = item
        copy.attempts += 1
        return copy
    }
}
