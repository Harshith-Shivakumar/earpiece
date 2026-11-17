import Foundation
import Testing
@testable import Earpiece

struct SpeechQueueTests {
    private func item(_ text: String, _ kind: SayKind, _ seq: Int? = nil) -> SpeechItem {
        SpeechItem(text: text, kind: kind, seq: seq)
    }

    @Test func keepsArrivalOrder() {
        var q = SpeechQueue()
        q.enqueue(item("a", .ack, 1))
        q.enqueue(item("b", .reply, 2))
        #expect(q.next()?.text == "a")
        #expect(q.next()?.text == "b")
        #expect(q.next() == nil)
    }

    @Test func newerLineDropsQueuedProgress() {
        var q = SpeechQueue()
        q.enqueue(item("Reading a.ts.", .progress, 1))
        q.enqueue(item("Editing b.ts.", .progress, 2))
        #expect(q.items.map(\.text) == ["Editing b.ts."])
        q.enqueue(item("Done.", .reply, 3))
        #expect(q.items.map(\.text) == ["Done."])
    }

    @Test func bargeInDropsOnlyProgress() {
        var q = SpeechQueue()
        q.enqueue(item("Allow?", .question, 1))
        q.enqueue(item("Done.", .reply, 2))
        q.enqueue(item("Running tests.", .progress, 3))
        q.dropProgress()
        #expect(q.items.map(\.text) == ["Allow?", "Done."])
    }

    @Test func pushFrontGoesNext() {
        var q = SpeechQueue()
        q.enqueue(item("later", .notice))
        q.pushFront(item("again", .reply))
        #expect(q.next()?.text == "again")
    }

    @Test func stopDropsQuestionsAndProgress() {
        var q = SpeechQueue()
        q.enqueue(item("Allow?", .question, 1))
        q.enqueue(item("Heard: x. Starting.", .ack, 2))
        q.pushFront(item("Running.", .progress, 3))
        q.dropForStop()
        #expect(q.items.map(\.text) == ["Heard: x. Starting."])
    }
}

struct ServerAddressTests {
    @Test func normalizesAddresses() {
        #expect(ServerAddress.webSocketURL(from: "ws://192.168.1.20:8787/ws")?.absoluteString == "ws://192.168.1.20:8787/ws")
        #expect(ServerAddress.webSocketURL(from: "192.168.1.20")?.absoluteString == "ws://192.168.1.20:8787/ws")
        #expect(ServerAddress.webSocketURL(from: " 100.64.0.2:9000 ")?.absoluteString == "ws://100.64.0.2:9000/ws")
        #expect(ServerAddress.webSocketURL(from: "http://box.tailnet.ts.net:8787")?.absoluteString == "ws://box.tailnet.ts.net:8787/ws")
        #expect(ServerAddress.webSocketURL(from: "wss://example.com/earpiece/ws")?.absoluteString == "wss://example.com/earpiece/ws")
        #expect(ServerAddress.webSocketURL(from: "") == nil)
        #expect(ServerAddress.webSocketURL(from: "ftp://x") == nil)
    }

    @Test func healthURL() throws {
        let ws = try #require(URL(string: "ws://192.168.1.20:8787/ws"))
        #expect(ServerAddress.healthURL(from: ws)?.absoluteString == "http://192.168.1.20:8787/health")
        let wss = try #require(URL(string: "wss://example.com/ws"))
        #expect(ServerAddress.healthURL(from: wss)?.absoluteString == "https://example.com/health")
    }
}
