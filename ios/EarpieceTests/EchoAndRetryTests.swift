import Foundation
import Testing
@testable import Earpiece

struct EchoFilterTests {
    @Test func overlapCountsHeardWordsFoundInSpokenLine() {
        let spoken = "Claude wants to run: npm test. Allow?"
        #expect(EchoFilter.overlap(heard: "wants to run npm test", spoken: spoken) == 1.0)
        #expect(EchoFilter.overlap(heard: "stop reading", spoken: "Reading upload.ts.") == 0.5)
        #expect(EchoFilter.overlap(heard: "", spoken: spoken) == 0)
        #expect(EchoFilter.overlap(heard: "Allow!", spoken: spoken) == 1.0)
    }

    @Test func echoNeedsMoreThanSixtyPercent() {
        let spoken = "I fixed the upload timeout and the tests pass."
        #expect(EchoFilter.isLikelyEcho(heard: "the upload timeout and the tests", spoken: spoken))
        #expect(EchoFilter.isLikelyEcho(heard: "the tests pass", spoken: spoken))
        // Real driver speech that shares a few words with the line.
        #expect(!EchoFilter.isLikelyEcho(heard: "now commit the fix and push", spoken: spoken))
        #expect(!EchoFilter.isLikelyEcho(heard: "yes", spoken: ""))
    }

    @Test func stopwordsDoNotCount() {
        // Content words {stop, tests}: 1 of 2 = 0.5, not echo. Without the stopword rule "the" made it 0.67.
        #expect(EchoFilter.overlap(heard: "stop the tests", spoken: "Running the tests now.") == 0.5)
        #expect(!EchoFilter.isLikelyEcho(heard: "stop the tests", spoken: "Running the tests now."))
        // Only stopwords heard: fall back to all words.
        #expect(EchoFilter.overlap(heard: "to the", spoken: "Go to the folder.") == 1.0)
    }

    @Test func timingWindow() {
        let now = Date()
        #expect(EchoFilter.timing(now: now, ttsPlaying: true, ttsEndedAt: nil) == .duringTTS)
        #expect(EchoFilter.timing(now: now, ttsPlaying: false, ttsEndedAt: nil) == .notNear)
        #expect(EchoFilter.timing(now: now, ttsPlaying: false, ttsEndedAt: now.addingTimeInterval(-0.5)) == .justAfterTTS)
        #expect(EchoFilter.timing(now: now, ttsPlaying: false, ttsEndedAt: now.addingTimeInterval(-1.0)) == .notNear)
    }

    @Test func numberAnswers() {
        for answer in ["two", "Two.", "the second one", "option 3", "number three", "1"] {
            #expect(EchoFilter.isNumberAnswer(answer), "\(answer)")
        }
        for answer in ["option", "two fixes", "yes", "number"] {
            #expect(!EchoFilter.isNumberAnswer(answer), "\(answer)")
        }
    }
}

/// SPEC 10.5 answer flows: quick answers to the switch question, the recently-active guard and
/// AskUserQuestion must reach the bridge as utterances, not be dropped as echo or taken as commands.
struct ChatAnswerFlowTests {
    let switchQuestion = "Recent chats. One: fix upload timeouts, 10 minutes ago. Two: add retry to the uploader, 2 hours ago. Three: release notes, yesterday. Or say new chat."
    let guardQuestion = "This chat was active 1 minute ago on this machine. Continue it anyway?"
    let optionQuestion = "Which fix should I use? Option one: Retry. Option two: Bigger timeout."
    let permission = "Claude wants to run: npm test. Allow?"

    private func passes(_ heard: String, after spoken: String, _ timing: EchoFilter.Timing, state: BridgeState = .waitingForYou) -> Bool {
        guard !EchoFilter.isLikelyEcho(heard: heard, spoken: spoken, timing: timing) else { return false }
        return CommandMatcher.match(heard, state: state) == .utterance(heard.trimmingCharacters(in: .whitespaces))
    }

    @Test func switchQuestionAnswersGetThrough() {
        for answer in ["one", "Two.", "three", "the second one", "stay", "cancel", "never mind", "release notes"] {
            #expect(passes(answer, after: switchQuestion, .justAfterTTS), "\(answer)")
            #expect(passes(answer, after: switchQuestion, .notNear), "\(answer)")
        }
        // "new chat" answers the switch question: an utterance while waiting, a command otherwise.
        #expect(passes("new chat", after: switchQuestion, .notNear))
        #expect(CommandMatcher.match("new chat", state: .idle) == .command(.newChat))
    }

    @Test func guardQuestionAnswersGetThrough() {
        for answer in ["yes", "no", "yeah", "nope", "go ahead"] {
            #expect(passes(answer, after: guardQuestion, .justAfterTTS), "\(answer)")
        }
    }

    @Test func optionNumbersGetThrough() {
        for answer in ["one", "two", "option two", "the first one"] {
            #expect(passes(answer, after: optionQuestion, .justAfterTTS), "\(answer)")
        }
    }

    @Test func echoOfTheLineEndIsStillDropped() {
        // The self-approval case the filter exists for.
        #expect(EchoFilter.isLikelyEcho(heard: "Allow?", spoken: permission, timing: .justAfterTTS))
        #expect(EchoFilter.isLikelyEcho(heard: "or say new chat", spoken: switchQuestion, timing: .justAfterTTS))
        #expect(EchoFilter.isLikelyEcho(heard: "add retry to the uploader", spoken: switchQuestion, timing: .duringTTS))
        // Later than the window, the same words are the driver's.
        #expect(!EchoFilter.isLikelyEcho(heard: "Allow", spoken: permission, timing: .notNear))
    }
}

struct RetryDecisionTests {
    @Test func completedLinesAreNotRetried() {
        #expect(SpeechQueue.retry(SpeechItem(text: "Done.", kind: .reply, seq: 1), completed: true) == nil)
    }

    @Test func progressIsNeverRetried() {
        #expect(SpeechQueue.retry(SpeechItem(text: "Reading a.ts.", kind: .progress, seq: 1), completed: false) == nil)
    }

    @Test func cutLinesAreRetriedAtMostTwice() throws {
        let first = try #require(SpeechQueue.retry(SpeechItem(text: "Allow?", kind: .question, seq: 4), completed: false))
        #expect(first.attempts == 1)
        #expect(first.text == "Allow?")
        let second = try #require(SpeechQueue.retry(first, completed: false))
        #expect(second.attempts == 2)
        #expect(SpeechQueue.retry(second, completed: false) == nil)
    }

    @Test func localNoticesAreRetriedToo() {
        let notice = SpeechItem(text: "Reconnected.", kind: .notice, seq: nil)
        #expect(SpeechQueue.retry(notice, completed: false)?.attempts == 1)
    }
}
