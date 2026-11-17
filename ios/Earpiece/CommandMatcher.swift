import Foundation

// SPEC section 2: voice commands, matched on the phone before anything is sent.

enum VoiceCommand: Equatable, CaseIterable {
    case pause
    case resume
    case repeatLast
    case status
    case stop
    case cancel
    case endDrive
    // SPEC 10.5
    case switchChat
    case newChat
    case whichChat

    var control: ControlAction {
        switch self {
        case .pause: return .pause
        case .resume: return .resume
        case .repeatLast: return .repeat
        case .status: return .status
        case .stop: return .stop
        case .cancel: return .cancel
        case .endDrive: return .endDrive
        case .switchChat: return .switchChat
        case .newChat: return .newChat
        case .whichChat: return .whichChat
        }
    }
}

enum CommandMatch: Equatable {
    /// Under 2 characters (or nothing but punctuation): not a turn.
    case ignore
    case command(VoiceCommand)
    /// Not a local command: send as `utterance` with the original text.
    case utterance(String)
}

enum CommandMatcher {
    /// Phrases in normalized form (lowercased, apostrophes removed, other punctuation removed).
    /// The only additions to SPEC 2 are spelling variants of the same words that speech-to-text
    /// produces ("nevermind", "ear piece").
    static let phrases: [VoiceCommand: [String]] = [
        .pause: ["pause", "hold on", "be quiet"],
        .resume: ["im back", "resume", "continue talking"],
        .repeatLast: ["repeat that", "say that again", "what did you say"],
        .status: ["what are you doing", "status", "where are we"],
        .stop: ["stop", "stop the task", "stop working", "abort"],
        .cancel: ["cancel", "no", "wait", "never mind", "nevermind"],
        .endDrive: ["end drive", "thats all for today", "goodbye earpiece", "goodbye ear piece"],
        .switchChat: ["switch chat", "change chat", "other chats", "list chats", "show chats"],
        .newChat: ["new chat", "start a new chat", "fresh chat"],
        .whichChat: ["which chat", "what chat is this", "which chat am i in"],
        // "stay" is deliberately not a command: it answers the bridge's switch question.
    ]

    private static let lookup: [String: VoiceCommand] = {
        var table: [String: VoiceCommand] = [:]
        for (command, list) in phrases {
            for phrase in list { table[phrase] = command }
        }
        return table
    }()

    /// Lowercase, drop apostrophes (so "I'm" == "im"), turn every other punctuation or symbol
    /// into a space, collapse whitespace.
    static func normalize(_ text: String) -> String {
        let apostrophes: Set<Unicode.Scalar> = ["'", "\u{2019}", "\u{2018}", "`", "\u{02BC}"]
        var out = String.UnicodeScalarView()
        for scalar in text.lowercased().unicodeScalars {
            if apostrophes.contains(scalar) { continue }
            if CharacterSet.punctuationCharacters.contains(scalar)
                || CharacterSet.symbols.contains(scalar)
                || CharacterSet.whitespacesAndNewlines.contains(scalar) {
                out.append(" ")
            } else {
                out.append(scalar)
            }
        }
        return String(out).split(separator: " ").joined(separator: " ")
    }

    /// Whole-utterance match. Cancel words count as a command only while the bridge is holding;
    /// in every other state they are sent as a normal utterance (e.g. "no" answers a yes/no question).
    /// New-chat words are sent as an utterance while the bridge waits for an answer, because
    /// "new chat" is one of the answers to the switch question (SPEC 10.5) and `control:new_chat`
    /// is only accepted while idle (SPEC 10.3).
    static func match(_ text: String, state: BridgeState) -> CommandMatch {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < 2 { return .ignore }
        let normalized = normalize(trimmed)
        if normalized.isEmpty { return .ignore }
        if let command = lookup[normalized] {
            if command == .cancel && state != .holding {
                return .utterance(trimmed)
            }
            if command == .newChat && state == .waitingForYou {
                return .utterance(trimmed)
            }
            return .command(command)
        }
        return .utterance(trimmed)
    }

    static func wordCount(_ text: String) -> Int {
        normalize(text).split(separator: " ").count
    }
}
