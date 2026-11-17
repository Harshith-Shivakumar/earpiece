import Foundation
import Testing
@testable import Earpiece

struct MessagesTests {
    private func json(_ message: ClientMessage) throws -> [String: Any] {
        let text = try Wire.encode(message)
        return try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    // MARK: Phone -> bridge (exact SPEC 1 shapes)

    @Test func helloShape() throws {
        let object = try json(.hello(token: "abc", lastSeq: 42, client: "earpiece-ios/1.0"))
        #expect(object.count == 4)
        #expect(object["type"] as? String == "hello")
        #expect(object["token"] as? String == "abc")
        #expect(object["last_seq"] as? Int == 42)
        #expect(object["client"] as? String == "earpiece-ios/1.0")
    }

    @Test func utteranceShape() throws {
        let object = try json(.utterance(text: "fix the upload timeout"))
        #expect(object.count == 2)
        #expect(object["type"] as? String == "utterance")
        #expect(object["text"] as? String == "fix the upload timeout")
    }

    @Test func controlShape() throws {
        for action in ControlAction.allCases {
            let object = try json(.control(action: action))
            #expect(object.count == 2)
            #expect(object["type"] as? String == "control")
            #expect(object["action"] as? String == action.rawValue)
        }
        #expect(try json(.control(action: .endDrive))["action"] as? String == "end_drive")
    }

    @Test func pingShape() throws {
        let object = try json(.ping)
        #expect(object.count == 1)
        #expect(object["type"] as? String == "ping")
    }

    @Test func clientRoundTrip() throws {
        let messages: [ClientMessage] = [
            .hello(token: "t", lastSeq: 0, client: "c"),
            .utterance(text: "Hello \"quoted\" / slash"),
            .control(action: .repeat),
            .ping,
        ]
        for message in messages {
            let data = try JSONEncoder().encode(message)
            #expect(try JSONDecoder().decode(ClientMessage.self, from: data) == message)
        }
    }

    // MARK: Bridge -> phone

    @Test func decodeWelcome() throws {
        let message = try Wire.decode(#"{"type":"welcome","drive_id":"2026-11-14_15-08-00","cwd":"/home/me/uploader","state":"waiting_for_you","seq":17}"#)
        #expect(message == .welcome(Welcome(driveID: "2026-11-14_15-08-00", cwd: "/home/me/uploader", state: .waitingForYou, seq: 17)))
    }

    @Test func decodeSay() throws {
        let message = try Wire.decode(#"{"type":"say","seq":5,"text":"Reading upload.ts.","kind":"progress"}"#)
        #expect(message == .say(Say(seq: 5, text: "Reading upload.ts.", kind: .progress)))
        for kind in ["ack", "progress", "reply", "question", "notice", "error"] {
            let decoded = try Wire.decode(#"{"type":"say","seq":1,"text":"x","kind":"\#(kind)"}"#)
            guard case .say(let say) = decoded else { Issue.record("not a say"); continue }
            #expect(say.kind.wire == kind)
            #expect(say.kind != .other(kind))
        }
    }

    @Test func decodeState() throws {
        #expect(try Wire.decode(#"{"type":"state","state":"holding","cwd":"/srv/app"}"#)
                == .state(StateChange(state: .holding, cwd: "/srv/app")))
        #expect(try Wire.decode(#"{"type":"state","state":"working"}"#)
                == .state(StateChange(state: .working, cwd: nil)))
    }

    @Test func decodeErrorAndPong() throws {
        #expect(try Wire.decode(#"{"type":"error","code":"auth","message":"bad token"}"#)
                == .error(ServerError(code: "auth", message: "bad token")))
        #expect(try Wire.decode(#"{"type":"pong"}"#) == .pong)
    }

    @Test func unknownValuesDoNotFail() throws {
        #expect(try Wire.decode(#"{"type":"future_thing","x":1}"#) == .unknown(type: "future_thing"))
        let say = try Wire.decode(#"{"type":"say","seq":3,"text":"hi","kind":"whisper"}"#)
        #expect(say == .say(Say(seq: 3, text: "hi", kind: .other("whisper"))))
        let state = try Wire.decode(#"{"type":"state","state":"thinking","cwd":"/a"}"#)
        #expect(state == .state(StateChange(state: .other("thinking"), cwd: "/a")))
    }

    @Test func serverRoundTrip() throws {
        let messages: [ServerMessage] = [
            .welcome(Welcome(driveID: "d1", cwd: "/a/b", state: .idle, seq: 0)),
            .say(Say(seq: 9, text: "Claude wants to run: npm test. Allow?", kind: .question)),
            .state(StateChange(state: .waitingForYou, cwd: "/a")),
            .error(ServerError(code: "protocol", message: "bad frame")),
            .pong,
        ]
        for message in messages {
            let data = try JSONEncoder().encode(message)
            #expect(try JSONDecoder().decode(ServerMessage.self, from: data) == message)
            let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(object["type"] is String)
        }
        let welcome = try JSONEncoder().encode(ServerMessage.welcome(Welcome(driveID: "d", cwd: "/", state: .waitingForYou, seq: 1)))
        let object = try #require(JSONSerialization.jsonObject(with: welcome) as? [String: Any])
        #expect(object["drive_id"] as? String == "d")
        #expect(object["state"] as? String == "waiting_for_you")
    }

    // MARK: SPEC 10.3 chats

    @Test func chatRequestShapes() throws {
        #expect(try json(.listChats) as NSDictionary == ["type": "list_chats"] as NSDictionary)
        #expect(try json(.openChat(id: "a1b2")) as NSDictionary == ["type": "open_chat", "id": "a1b2"] as NSDictionary)
        #expect(try json(.newChat(cwd: nil)) as NSDictionary == ["type": "new_chat"] as NSDictionary)
        #expect(try json(.newChat(cwd: "/home/me/app")) as NSDictionary == ["type": "new_chat", "cwd": "/home/me/app"] as NSDictionary)
        for action in [ControlAction.switchChat, .newChat, .whichChat] {
            let object = try json(.control(action: action))
            #expect(object["action"] as? String == action.rawValue)
        }
        for message in [ClientMessage.listChats, .openChat(id: "x"), .newChat(cwd: nil), .newChat(cwd: "/a")] {
            let data = try JSONEncoder().encode(message)
            #expect(try JSONDecoder().decode(ClientMessage.self, from: data) == message)
        }
    }

    @Test func decodeChats() throws {
        let text = #"""
        {"type":"chats","items":[
          {"id":"s1","title":"Fix upload timeouts","cwd":"/home/me/uploader","folder":"uploader","source":"cli",
           "updated_at":"2026-11-15T10:20:30.123Z","recently_active":true,"current":false},
          {"id":"s2","title":"","cwd":"/home/me/site","source":"claude-desktop","updated_at":"2026-11-15T09:00:00Z","current":true,"extra":42},
          {"title":"no id, skipped"},
          {"id":"s3"}
        ]}
        """#
        guard case .chats(let list) = try Wire.decode(text) else { Issue.record("not chats"); return }
        #expect(list.items.map(\.id) == ["s1", "s2", "s3"])
        let first = list.items[0]
        #expect(first.title == "Fix upload timeouts")
        #expect(first.folder == "uploader")
        #expect(first.recentlyActive && !first.current)
        #expect(first.updatedAt == ChatItem.parseDate("2026-11-15T10:20:30.123Z"))
        #expect(first.updatedAt != nil)
        let second = list.items[1]
        #expect(second.title == "Untitled chat")
        #expect(second.folder == "site")  // derived from cwd when missing
        #expect(second.current && !second.recentlyActive)
        #expect(second.updatedAt != nil)
        let third = list.items[2]
        #expect(third.title == "Untitled chat" && third.cwd == "" && third.updatedAt == nil)
        #expect(try Wire.decode(#"{"type":"chats"}"#) == .chats(ChatList(items: [])))
    }

    @Test func chatFieldOnWelcomeAndState() throws {
        let withChat = try Wire.decode(#"{"type":"welcome","drive_id":"d","cwd":"/a","state":"idle","seq":1,"chat":{"id":"s1","title":"Fix uploads"}}"#)
        #expect(withChat == .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 1, chat: .chat(ChatRef(id: "s1", title: "Fix uploads")))))
        let nullChat = try Wire.decode(#"{"type":"welcome","drive_id":"d","cwd":"/a","state":"idle","seq":1,"chat":null}"#)
        #expect(nullChat == .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 1, chat: .none)))
        let noChat = try Wire.decode(#"{"type":"welcome","drive_id":"d","cwd":"/a","state":"idle","seq":1}"#)
        #expect(noChat == .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 1, chat: .absent)))

        #expect(try Wire.decode(#"{"type":"state","state":"working","cwd":"/a","chat":{"id":"s2","title":"Docs"}}"#)
                == .state(StateChange(state: .working, cwd: "/a", chat: .chat(ChatRef(id: "s2", title: "Docs")))))
        #expect(try Wire.decode(#"{"type":"state","state":"idle","cwd":"/a","chat":null}"#)
                == .state(StateChange(state: .idle, cwd: "/a", chat: .none)))
        // A malformed chat object is treated as missing, not as an error.
        #expect(try Wire.decode(#"{"type":"state","state":"idle","chat":{"title":"no id"}}"#)
                == .state(StateChange(state: .idle, cwd: nil, chat: .absent)))
    }

    @Test func chatRoundTrips() throws {
        let messages: [ServerMessage] = [
            .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 2, chat: .chat(ChatRef(id: "s", title: "T")))),
            .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 2, chat: .none)),
            .state(StateChange(state: .working, cwd: "/b", chat: .none)),
            .chats(ChatList(items: [ChatItem(id: "s1", title: "One", cwd: "/x/y", folder: "y", source: "cli",
                                             updatedAt: ChatItem.parseDate("2026-11-15T10:20:30.123Z"),
                                             recentlyActive: true, current: true)])),
        ]
        for message in messages {
            let data = try JSONEncoder().encode(message)
            #expect(try JSONDecoder().decode(ServerMessage.self, from: data) == message)
        }
    }

    @Test func invalidJSONThrows() {
        #expect(throws: (any Error).self) { try Wire.decode("not json") }
        #expect(throws: (any Error).self) { try Wire.decode(#"{"no_type":1}"#) }
    }
}
