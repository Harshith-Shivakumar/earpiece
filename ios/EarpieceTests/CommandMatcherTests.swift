import Testing
@testable import Earpiece

struct CommandMatcherTests {
    private func cmd(_ text: String, _ state: BridgeState = .idle) -> CommandMatch {
        CommandMatcher.match(text, state: state)
    }

    @Test func everySpecPhraseMatches() {
        let table: [(String, VoiceCommand)] = [
            ("pause", .pause), ("hold on", .pause), ("be quiet", .pause),
            ("I'm back", .resume), ("resume", .resume), ("continue talking", .resume),
            ("repeat that", .repeatLast), ("say that again", .repeatLast), ("what did you say", .repeatLast),
            ("what are you doing", .status), ("status", .status), ("where are we", .status),
            ("stop", .stop), ("stop the task", .stop), ("stop working", .stop), ("abort", .stop),
            ("end drive", .endDrive), ("that's all for today", .endDrive), ("goodbye earpiece", .endDrive),
        ]
        for (phrase, expected) in table {
            #expect(cmd(phrase) == .command(expected), "\(phrase)")
        }
    }

    @Test func caseAndPunctuationAreIgnored() {
        #expect(cmd("Pause.") == .command(.pause))
        #expect(cmd("  Hold on!  ") == .command(.pause))
        #expect(cmd("I\u{2019}m back.") == .command(.resume))
        #expect(cmd("Im back") == .command(.resume))
        #expect(cmd("What did you say?") == .command(.repeatLast))
        #expect(cmd("That's all for today.") == .command(.endDrive))
        #expect(cmd("Goodbye, Earpiece!") == .command(.endDrive))
        #expect(cmd("STOP") == .command(.stop))
    }

    @Test func wholeUtteranceOnly() {
        #expect(cmd("stop the tests from running") == .utterance("stop the tests from running"))
        #expect(cmd("please pause") == .utterance("please pause"))
        #expect(cmd("status of the build") == .utterance("status of the build"))
    }

    @Test func cancelWordsOnlyWhileHolding() {
        for word in ["cancel", "No.", "wait", "never mind", "Nevermind"] {
            #expect(cmd(word, .holding) == .command(.cancel), "\(word)")
            #expect(cmd(word, .idle) == .utterance(word), "\(word)")
            #expect(cmd(word, .working) == .utterance(word), "\(word)")
            #expect(cmd(word, .waitingForYou) == .utterance(word), "\(word)")
        }
    }

    @Test func otherCommandsWorkInEveryState() {
        for state in [BridgeState.idle, .holding, .working, .waitingForYou] {
            #expect(cmd("stop", state) == .command(.stop))
            #expect(cmd("status", state) == .command(.status))
        }
    }

    @Test func shortResultsAreIgnored() {
        #expect(cmd("") == .ignore)
        #expect(cmd("a") == .ignore)
        #expect(cmd(" ? ") == .ignore)
        #expect(cmd("...") == .ignore)
        #expect(cmd("ok") == .utterance("ok"))
    }

    @Test func utteranceKeepsOriginalText() {
        #expect(cmd("Fix the upload timeout, please.") == .utterance("Fix the upload timeout, please."))
        #expect(cmd("  yes  ", .waitingForYou) == .utterance("yes"))
    }

    @Test func controlActionsMapToWire() {
        #expect(VoiceCommand.repeatLast.control.rawValue == "repeat")
        #expect(VoiceCommand.endDrive.control.rawValue == "end_drive")
        #expect(VoiceCommand.cancel.control.rawValue == "cancel")
    }

    @Test func chatCommands() {
        let table: [(String, VoiceCommand)] = [
            ("switch chat", .switchChat), ("Change chat.", .switchChat), ("other chats", .switchChat),
            ("list chats", .switchChat), ("Show chats!", .switchChat),
            ("new chat", .newChat), ("Start a new chat.", .newChat), ("fresh chat", .newChat),
            ("which chat", .whichChat), ("What chat is this?", .whichChat), ("Which chat am I in?", .whichChat),
        ]
        for state in [BridgeState.idle, .holding, .working] {
            for (phrase, expected) in table {
                #expect(cmd(phrase, state) == .command(expected), "\(phrase) in \(state.wire)")
            }
        }
        #expect(VoiceCommand.switchChat.control.rawValue == "switch_chat")
        #expect(VoiceCommand.newChat.control.rawValue == "new_chat")
        #expect(VoiceCommand.whichChat.control.rawValue == "which_chat")
    }

    @Test func chatCommandsWhileWaitingForAnswer() {
        // "new chat" answers the switch question, so it goes to the bridge as an utterance.
        for phrase in ["new chat", "Start a new chat.", "fresh chat"] {
            #expect(cmd(phrase, .waitingForYou) == .utterance(phrase))
        }
        #expect(cmd("switch chat", .waitingForYou) == .command(.switchChat))
        #expect(cmd("which chat", .waitingForYou) == .command(.whichChat))
    }

    @Test func switchAnswersAreUtterances() {
        // "stay" is not a local command, and number words / yes / no are answers.
        for answer in ["stay", "Stay.", "one", "two", "three", "yes", "no", "cancel", "never mind"] {
            #expect(cmd(answer, .waitingForYou) == .utterance(answer), "\(answer)")
        }
        #expect(cmd("stay", .idle) == .utterance("stay"))
        #expect(cmd("stay", .holding) == .utterance("stay"))
    }

    @Test func noCommandPhraseIsDuplicated() {
        var seen: [String: VoiceCommand] = [:]
        for (command, list) in CommandMatcher.phrases {
            for phrase in list {
                #expect(seen[phrase] == nil, "\(phrase) used twice")
                seen[phrase] = command
            }
        }
    }

    @Test func wordCountForBargeIn() {
        #expect(CommandMatcher.wordCount("") == 0)
        #expect(CommandMatcher.wordCount("hey") == 1)
        #expect(CommandMatcher.wordCount("hey, wait") == 2)
        #expect(CommandMatcher.wordCount("I'm back now") == 3)
    }
}
