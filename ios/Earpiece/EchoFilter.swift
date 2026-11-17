import Foundation

/// Second line of defence against the app hearing its own voice (on top of voice processing),
/// which re-adapts after every engine rebuild and does not cancel other apps' audio.
enum EchoFilter {
    /// Share of heard words that also appear in the spoken line above which a turn counts as echo.
    static let threshold = 0.6
    /// A turn whose first partial arrives up to this long after TTS ends is checked against the end
    /// of the line (echo of the last words arrives late because of recognition latency).
    static let tailWindow: TimeInterval = 0.7
    /// How many trailing words of the line count as "the end of the line".
    static let tailWords = 4

    /// When the turn's first partial arrived relative to TTS.
    enum Timing: Equatable {
        case duringTTS
        case justAfterTTS
        case notNear
    }

    /// Function words that would otherwise make any two sentences look alike.
    static let stopwords: Set<Substring> = [
        "a", "an", "the", "to", "of", "and", "or", "is", "it", "in", "on", "for", "that", "this",
        "i", "you", "me", "my", "be", "are", "was", "with", "at", "so", "do",
    ]

    /// Words a driver uses to pick an option by number ("two", "the second one", "option 3").
    private static let numberWords: Set<Substring> = [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "first", "second", "third", "fourth", "fifth",
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "1st", "2nd", "3rd", "4th", "5th",
    ]
    private static let numberFiller: Set<Substring> = ["the", "option", "number", "one", "please"]

    /// Fraction of the heard words (normalized like voice commands, stopwords ignored unless that
    /// leaves nothing) that occur in `spoken`.
    static func overlap(heard: String, spoken: String) -> Double {
        let allHeard = CommandMatcher.normalize(heard).split(separator: " ")
        let content = allHeard.filter { !stopwords.contains($0) }
        let heardWords = content.isEmpty ? allHeard : content
        guard !heardWords.isEmpty else { return 0 }
        let spokenWords = Set(CommandMatcher.normalize(spoken).split(separator: " "))
        let hits = heardWords.filter { spokenWords.contains($0) }.count
        return Double(hits) / Double(heardWords.count)
    }

    /// Echo check against the whole line (a turn that started while TTS was playing; barge-in).
    static func isLikelyEcho(heard: String, spoken: String) -> Bool {
        !spoken.isEmpty && overlap(heard: heard, spoken: spoken) > threshold
    }

    static func isLikelyEcho(heard: String, spoken: String, timing: Timing) -> Bool {
        switch timing {
        case .notNear:
            return false
        case .duringTTS:
            return isLikelyEcho(heard: heard, spoken: spoken)
        case .justAfterTTS:
            // A number pick ("two") right after "...Option two: Fix it." is the driver answering;
            // echo of the line's end would carry the label words.
            if isNumberAnswer(heard) { return false }
            return isLikelyEcho(heard: heard, spoken: tail(of: spoken))
        }
    }

    static func timing(now: Date, ttsPlaying: Bool, ttsEndedAt: Date?) -> Timing {
        if ttsPlaying { return .duringTTS }
        guard let ended = ttsEndedAt, now.timeIntervalSince(ended) <= tailWindow else { return .notNear }
        return .justAfterTTS
    }

    static func tail(of spoken: String) -> String {
        CommandMatcher.normalize(spoken).split(separator: " ").suffix(tailWords).joined(separator: " ")
    }

    /// Only number words and filler ("the second one", "option two", "3").
    static func isNumberAnswer(_ heard: String) -> Bool {
        let words = CommandMatcher.normalize(heard).split(separator: " ")
        guard !words.isEmpty, words.contains(where: { numberWords.contains($0) }) else { return false }
        return words.allSatisfy { numberWords.contains($0) || numberFiller.contains($0) }
    }
}
